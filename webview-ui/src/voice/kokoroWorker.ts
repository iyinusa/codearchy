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
 *   generate  → { type:'generate', id:number, text:string, voice?:string }
 *   generated ← { type:'generated', id:number, pcm:Float32Array, sampleRate:number }
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

/** Single-shot synthesis used by the cache pre-synth pass. Runs the whole
 *  text through tts.generate() and returns one Float32Array PCM buffer.
 *  Does not stream — callers receive the result via the 'generated' event. */
async function generateOnce(text: string, voice: string): Promise<{ pcm: Float32Array; sampleRate: number }> {
    if (!tts) throw new Error('TTS not initialised');
    if (!warmedVoices.has(voice)) {
        const inflight = inflightWarm.get(voice);
        if (inflight) await inflight;
        else await warmVoice(voice);
    }
    type GenOpts = NonNullable<Parameters<KokoroTTS['generate']>[1]>;
    const audio = await tts.generate(text, { voice } as unknown as GenOpts);
    const pcm = new Float32Array(audio.audio as Float32Array);
    return { pcm, sampleRate: audio.sampling_rate };
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
            // Background, non-streaming synthesis. Used by the cache layer:
            // produces one PCM buffer for the whole text and posts it back
            // in a single 'generated' message. Does not interact with the
            // streaming `speak` lane — both can run concurrently from the
            // worker's perspective (kokoro-js serialises internally).
            const result = await generateOnce(msg.text, msg.voice ?? 'af_alloy');
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
