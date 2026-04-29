/**
 * Kokoro TTS worker.
 *
 * Runs `kokoro-js` off the UI thread for lag-free synthesis.
 * The model and voice files are pre-downloaded into webview-ui/dist/kokoro-model/
 * (fully offline). On init we install a fetch shim that rewrites HF URLs to
 * our local webview base URI — no network access ever occurs at runtime.
 *
 * Protocol (main ↔ worker):
 *   init   → { type:'init', modelBase:string, ortBase:string }
 *   ready  ← { type:'ready' }
 *   warm   → { type:'warm', voice:string }
 *   warmed ← { type:'warmed', voice:string }
 *   speak  → { type:'speak', id:number, text:string, voice?:string }
 *   chunk  ← { type:'chunk', id:number, pcm:Float32Array, sampleRate:number }
 *   end    ← { type:'end', id:number }
 *   generate         → { type:'generate', id:number, text:string, voice?:string }
 *   generateProgress ← { type:'generateProgress', id:number, done:number, total:number }
 *   generated        ← { type:'generated', id:number, pcm:Float32Array, sampleRate:number }
 *   stop   → { type:'stop' }
 *   error  ← { type:'error', id?:number, message:string }
 *
 * Latency strategy:
 *   We use kokoro-js stream() + TextSplitterStream so the model produces audio
 *   with natural sentence-level prosody. Each sentence chunk is posted to the
 *   main thread the moment it finishes synthesising, so the AudioContext can
 *   start playing sentence 1 while sentence 2 is still being synthesised.
 *
 *   Critical fetch-shim requirement:
 *   kokoro-js fetches voice .bin files (and model files via transformers.js)
 *   from 'resolve/main/' URLs — NOT 'tree/main/'. Using the wrong prefix means
 *   the shim never intercepts anything → every voice load tries the network →
 *   fails offline → 20-30 s hang per paragraph. The constant below is correct.
 *
 *   Background voice warming:
 *   After the ONNX graph is JIT-compiled by the first warmVoice(), all other
 *   bundled English voices are warmed in parallel (fire-and-forget). Each is
 *   just a ~100 KB local file load at that point — very fast. Voice switches
 *   are instant once the background warming settles.
 */

import { KokoroTTS, TextSplitterStream, env } from 'kokoro-js';

// All English voices bundled in dist/kokoro-model/.../voices/.
const ALL_ENGLISH_VOICES = [
    'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica',
    'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
    'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
    'am_michael', 'am_onyx', 'am_puck', 'am_santa',
    'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
    'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
] as const;

type WorkerMsg =
    | { type: 'init'; modelBase: string; ortBase: string }
    | { type: 'warm'; voice: string }
    | { type: 'speak'; id: number; text: string; voice?: string }
    | { type: 'generate'; id: number; text: string; voice?: string }
    | { type: 'stop' };

function post(data: unknown, transfer?: Transferable[]): void {
    (self as unknown as { postMessage(d: unknown, t?: Transferable[]): void })
        .postMessage(data, transfer ?? []);
}

let tts: KokoroTTS | null = null;
let stopFlag = 0;
const warmedVoices = new Set<string>();
const inflightWarm = new Map<string, Promise<void>>();

// IMPORTANT: kokoro-js voice fetches use resolve/main/ — NOT tree/main/.
const HF_RESOLVE_BASE = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/';

function installFetchShim(localBase: string): void {
    const base = localBase.endsWith('/') ? localBase : localBase + '/';
    const orig = self.fetch.bind(self);
    self.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input
            : input instanceof URL ? input.href
                : (input as Request).url;
        return url.startsWith(HF_RESOLVE_BASE)
            ? orig(base + url.slice(HF_RESOLVE_BASE.length), init)
            : orig(input as RequestInfo, init);
    }) as typeof fetch;
}

async function init(modelBase: string, ortBase: string): Promise<void> {
    installFetchShim(modelBase);

    // Point ORT WASM loader to our local copy (avoids jsdelivr CDN).
    env.wasmPaths = ortBase.endsWith('/') ? ortBase : ortBase + '/';

    tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8',
        device: 'wasm',
    });

    // Phase 1 (blocking): warm default voice.
    // JIT-compiles the ONNX graph, warms phonemizer WASM, loads af_alloy.bin.
    await warmVoice('af_alloy');

    // Phase 2 (background): warm all other bundled voices SEQUENTIALLY.
    // void (async () => {
    //     for (const v of ALL_ENGLISH_VOICES) {
    //         if (v === 'af_alloy') continue;
    //         try { await warmVoice(v); } catch { /* swallow per-voice */ }
    //     }
    // })();
}

/** Run a silent inference for 'voice' so subsequent speak()s are instant. */
async function warmVoice(voice: string): Promise<void> {
    if (!tts) return;
    if (warmedVoices.has(voice)) return;
    const existing = inflightWarm.get(voice);
    if (existing) return existing;
    const p = (async () => {
        try {
            type GenOpts = NonNullable<Parameters<KokoroTTS['generate']>[1]>;
            await tts!.generate('Hi.', { voice } as unknown as GenOpts);
            warmedVoices.add(voice);
        } catch {
            // Voice file missing from bundle — swallow; speak() will surface it.
        } finally {
            inflightWarm.delete(voice);
        }
    })();
    inflightWarm.set(voice, p);
    return p;
}

async function synthesise(id: number, text: string, voice: string): Promise<void> {
    if (!tts) throw new Error('TTS not initialised');
    const myStop = ++stopFlag;

    // Safety net: if background warming for this voice is still in-flight,
    // await it before streaming. Prevents any voice from being cold.
    if (!warmedVoices.has(voice)) {
        const inflight = inflightWarm.get(voice);
        if (inflight) {
            await inflight;
        } else {
            await warmVoice(voice);
        }
        if (stopFlag !== myStop) return;
    }

    // Use TextSplitterStream for natural sentence-level prosody.
    // stream() yields one audio chunk per sentence; each chunk is posted to
    // the main thread immediately so AudioContext plays sentence 1 while
    // sentence 2 is still synthesising.
    // Must call close() before iterating — otherwise the async iterator hangs
    // waiting for more input and no chunks are ever emitted.
    const splitter = new TextSplitterStream();
    splitter.push(text);
    splitter.close();

    type StreamOpts = NonNullable<Parameters<KokoroTTS['stream']>[1]>;
    const gen = tts.stream(splitter, { voice } as unknown as StreamOpts);
    for await (const { audio } of gen) {
        if (stopFlag !== myStop) return;
        const pcm = new Float32Array(audio.audio as Float32Array);
        post({ type: 'chunk', id, pcm, sampleRate: audio.sampling_rate }, [pcm.buffer]);
    }
}

/** Chunked single-shot synthesis used by the cache pre-synth pass.
 *  Splits the text into sentence-sized pieces (Kokoro has a ~512 token
 *  per-call limit) and runs each through `tts.generate()`, concatenating
 *  the resulting PCM into one continuous buffer. Posts a
 *  `generateProgress` event after each piece so the UI can render a
 *  ring-progress indicator around the play button. The final
 *  concatenated buffer is delivered via the `generated` event.
 *
 *  Stays on the same worker thread as `speak` — kokoro-js serialises
 *  generation calls internally, so streaming and caching coexist
 *  cleanly without contention. */
async function generateOnce(
    id: number,
    text: string,
    voice: string,
): Promise<{ pcm: Float32Array; sampleRate: number }> {
    if (!tts) throw new Error('TTS not initialised');
    if (!warmedVoices.has(voice)) {
        const inflight = inflightWarm.get(voice);
        if (inflight) await inflight;
        else await warmVoice(voice);
    }
    const pieces = splitTextForSynthesis(text);
    const total = pieces.length;
    type GenOpts = NonNullable<Parameters<KokoroTTS['generate']>[1]>;
    const buffers: Float32Array[] = [];
    let sampleRate = 24000;
    // Progress 0/total so UI can show the ring immediately at 0 %.
    post({ type: 'generateProgress', id, done: 0, total });
    for (let i = 0; i < total; i++) {
        const piece = pieces[i];
        const audio = await tts.generate(piece, { voice } as unknown as GenOpts);
        const pcm = new Float32Array(audio.audio as Float32Array);
        sampleRate = audio.sampling_rate;
        buffers.push(pcm);
        post({ type: 'generateProgress', id, done: i + 1, total });
    }
    // Concatenate all chunk PCM into a single continuous Float32Array.
    let totalLen = 0;
    for (const b of buffers) totalLen += b.length;
    const out = new Float32Array(totalLen);
    let offset = 0;
    for (const b of buffers) {
        out.set(b, offset);
        offset += b.length;
    }
    return { pcm: out, sampleRate };
}

/** Split text into Kokoro-friendly chunks. Targets sentence boundaries
 *  first; falls back to length-based slicing for runaway sentences so
 *  no single piece blows past the model's input limit. */
function splitTextForSynthesis(text: string): string[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const MAX = 240; // safe under Kokoro's ~512 token cap
    // First pass: sentence split on terminal punctuation, keeping the
    // delimiter so prosody stays natural.
    const sentences = trimmed
        .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/g)
        .map(s => s.trim())
        .filter(Boolean);
    const out: string[] = [];
    for (const s of sentences) {
        if (s.length <= MAX) {
            out.push(s);
            continue;
        }
        // Long sentence — break on commas / semicolons, then hard slice
        // anything still too big. Preserves word boundaries.
        const sub = s.split(/(?<=[,;:])\s+/g);
        let buffer = '';
        for (const piece of sub) {
            if ((buffer + ' ' + piece).trim().length > MAX) {
                if (buffer) out.push(buffer.trim());
                buffer = piece;
            } else {
                buffer = buffer ? buffer + ' ' + piece : piece;
            }
        }
        if (buffer) out.push(buffer.trim());
    }
    // Final guard: hard-slice any monster pieces (e.g. URLs, no spaces).
    const safe: string[] = [];
    for (const p of out) {
        if (p.length <= MAX) safe.push(p);
        else for (let i = 0; i < p.length; i += MAX) safe.push(p.slice(i, i + MAX));
    }
    return safe.length ? safe : [trimmed];
}

self.onmessage = async (ev: MessageEvent<WorkerMsg>) => {
    const msg = ev.data;
    try {
        if (msg.type === 'init') {
            await init(msg.modelBase, msg.ortBase);
            post({ type: 'ready' });
        } else if (msg.type === 'warm') {
            await warmVoice(msg.voice);
            post({ type: 'warmed', voice: msg.voice });
        } else if (msg.type === 'speak') {
            await synthesise(msg.id, msg.text, msg.voice ?? 'af_alloy');
            post({ type: 'end', id: msg.id });
        } else if (msg.type === 'generate') {
            // Background synthesis used by the chat/narrator caches.
            // Internally chunks long text and concatenates PCM so the
            // resulting audio plays back as a single fluid clip; emits
            // progress events so the UI can render readiness state.
            const result = await generateOnce(msg.id, msg.text, msg.voice ?? 'af_alloy');
            post(
                { type: 'generated', id: msg.id, pcm: result.pcm, sampleRate: result.sampleRate },
                [result.pcm.buffer],
            );
        } else if (msg.type === 'stop') {
            stopFlag++;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        post({ type: 'error', id: (msg as { id?: number }).id, message });
    }
};
