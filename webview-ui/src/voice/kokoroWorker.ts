/**
 * Kokoro TTS worker.
 *
 * Runs `kokoro-js` off the UI thread for lag-free synthesis.
 * Model and voice files are pre-bundled into the extension under
 * webview-ui/dist/kokoro-model/ (populated once by `npm run download-kokoro`).
 *
 * On init a fetch shim is installed that intercepts every HuggingFace model
 * URL constructed by transformers.js / kokoro-js and redirects it to the
 * corresponding pre-bundled local asset served via the VS Code webview
 * resource server.  No network access is ever attempted — Kokoro works
 * completely offline from first activation.
 *
 * The shim uses a generous per-request timeout (60 s) so the ~80 MB ONNX
 * binary can be served even on a cold VS Code start where the webview
 * resource server is still warming up.
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
 *   kokoro-js stream() + TextSplitterStream yields one audio chunk per
 *   sentence; each is posted to the main thread immediately so the
 *   AudioContext can start playing sentence 1 while sentence 2 is still
 *   being synthesised.
 *
 *   Background voice warming:
 *   After the ONNX graph is JIT-compiled by the first warmVoice(), all
 *   other bundled English voices warm in parallel. Voice switches are
 *   instant once settling completes.
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

/** The backend that successfully initialised the model. Sent in 'ready'. */
let activeDevice: 'webgpu' | 'wasm' = 'wasm';

/**
 * Returns true if WebGPU is available in this worker context.
 * Chromium (Electron) workers expose navigator.gpu; we probe for a real
 * adapter so we can distinguish "API present" from "GPU actually usable".
 */
async function detectWebGPU(): Promise<boolean> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gpu = (navigator as any).gpu as { requestAdapter(): Promise<unknown | null> } | undefined;
        if (!gpu) return false;
        const adapter = await gpu.requestAdapter();
        return adapter !== null;
    } catch {
        return false;
    }
}

// HuggingFace base URL for all Kokoro model assets (config, tokenizer, ONNX, voices).
// The fetch shim intercepts every request that starts with this prefix and
// redirects it to the corresponding pre-bundled local asset in dist/kokoro-model/.
// This covers both transformers.js model-file fetches AND kokoro-js's own voice
// loader — keeping the extension fully offline.
const HF_MODEL_URL_PREFIX = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/';

/**
 * Install a minimal fetch shim that redirects every HuggingFace URL for
 * Kokoro model assets to the localhost HTTP server started by the extension
 * host (ArchitecturePanel.startModelServer).
 *
 * Model files (config.json, tokenizer.json, onnx/model_quantized.onnx) are
 * loaded by transformers.js; voice files (voices/*.bin) are loaded by
 * kokoro-js's own internal loader — both hardcode HF URLs so both are covered
 * by this single shim.
 *
 * All requests go to http://127.0.0.1:PORT which is a plain Node.js HTTP
 * server with no size or concurrency limitations.  This completely avoids the
 * HTTP 408 errors that the VS Code webview resource server returns for large
 * binary files (~82 MB ONNX) fetched from a blob: worker context.
 */
function installFetchShim(localModelBase: string): void {
    const modelBase = localModelBase.endsWith('/') ? localModelBase : localModelBase + '/';
    const orig: typeof fetch = (self as typeof globalThis).fetch.bind(self);

    const shimmedFetch: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input
            : input instanceof URL ? input.href
                : (input as Request).url;

        // All Kokoro model + voice files: redirect HF URL → localhost asset server.
        if (url.startsWith(HF_MODEL_URL_PREFIX)) {
            const relativePath = url.slice(HF_MODEL_URL_PREFIX.length); // e.g. "config.json"
            return orig(modelBase + relativePath, init);
        }

        // Block any remaining HuggingFace / CDN traffic (offline-only mode).
        if (url.startsWith('https://huggingface.co/') || url.startsWith('https://cdn-lfs')) {
            return Promise.resolve(new Response(null, { status: 404, statusText: 'Offline-only mode' }));
        }

        return orig(input as RequestInfo, init);
    };

    // Object.defineProperty guarantees the replacement sticks even if self.fetch
    // has a non-writable descriptor in this Electron context.
    try {
        Object.defineProperty(self, 'fetch', { value: shimmedFetch, writable: true, configurable: true });
    } catch {
        (self as typeof globalThis).fetch = shimmedFetch;
    }
}

// ── Init progress reporting ────────────────────────────────────────────────
//
// Progress 0..100 across two phases:
//   load-model   0  → 90   (transformers.js progress_callback per-file)
//   warm-voice  90  → 100  (first inference primes the ONNX graph)

let lastReportedPercent = -1;

function reportProgress(percent: number, stage: string, file?: string): void {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (clamped === lastReportedPercent) return; // coalesce identical updates
    lastReportedPercent = clamped;
    post({ type: 'initProgress', percent: clamped, stage, file });
}

async function init(modelBase: string, ortBase: string): Promise<void> {
    // Install fetch shim before any kokoro-js voice loads (which use a
    // hardcoded HF URL that bypasses transformers.js model loading).
    // modelBase is now http://127.0.0.1:PORT/kokoro-model/onnx-community/…
    installFetchShim(modelBase);

    // ── Configure transformers.js for offline operation. ───────────────────
    //
    // transformers.js builds its normal HuggingFace URLs and calls fetch().
    // The shim intercepts every HF_MODEL_URL_PREFIX request and redirects it
    // to the localhost asset server — no network traffic ever leaves the machine.
    //
    // allowRemoteModels MUST stay true so transformers.js calls fetch() at all.
    // useBrowserCache = false avoids stale Cache API entries.
    const envAny = env as unknown as Record<string, unknown>;
    envAny.allowRemoteModels = true;
    envAny.useBrowserCache = false;

    // ORT WASM is also served from the localhost asset server (ortBase =
    // http://127.0.0.1:PORT/ort/) so fetch() works without any shim handling.
    // We still need to wrap the .jsep.mjs in a blob: URL because Electron
    // won't dynamic-import() an http: URL from inside a blob: worker.
    const wasmBase = ortBase.endsWith('/') ? ortBase : ortBase + '/';
    try {
        const mjsRes = await fetch(wasmBase + 'ort-wasm-simd-threaded.jsep.mjs');
        if (mjsRes.ok) {
            const mjsBuf = await mjsRes.arrayBuffer();
            const mjsBlobUrl = URL.createObjectURL(
                new Blob([mjsBuf], { type: 'text/javascript' }),
            );
            (env as unknown as { wasmPaths: unknown }).wasmPaths = {
                mjs: mjsBlobUrl,
                wasm: wasmBase + 'ort-wasm-simd-threaded.jsep.wasm',
            };
        } else {
            // File missing — fall back to string base; ORT will attempt the
            // import and surface the error naturally.
            (env as unknown as { wasmPaths: unknown }).wasmPaths = wasmBase;
        }
    } catch {
        (env as unknown as { wasmPaths: unknown }).wasmPaths = wasmBase;
    }

    // ── Model loading — per-file byte progress maps to 0..90% ──────────────
    const LOAD_LO = 0, LOAD_HI = 90;

    type ProgressInfo =
        | { status: 'initiate'; name: string; file: string }
        | { status: 'download'; name: string; file: string }
        | { status: 'progress'; name: string; file: string; progress: number; loaded: number; total: number }
        | { status: 'done'; name: string; file: string }
        | { status: 'ready'; task?: string; model?: string };

    // Encapsulates one attempt to load the model with a given dtype/device.
    // fileTotals is reset on each call so retry progress starts clean.
    const loadModel = async (
        dtype: string,
        device: string,
        label: string,
    ): Promise<KokoroTTS> => {
        const fileTotals = new Map<string, { loaded: number; total: number }>();
        lastReportedPercent = -1;

        const aggregate = (): number => {
            let loaded = 0, total = 0, knownAny = false;
            for (const v of fileTotals.values()) {
                if (v.total > 0) { knownAny = true; loaded += v.loaded; total += v.total; }
            }
            if (!knownAny || total === 0) {
                const entries = Array.from(fileTotals.values());
                if (!entries.length) return 0;
                return entries.filter(e => e.loaded > 0 && e.loaded === e.total).length / entries.length;
            }
            return loaded / total;
        };

        const loadPct = (frac: number) => LOAD_LO + (LOAD_HI - LOAD_LO) * Math.max(0, Math.min(1, frac));

        const progressCallback = (info: ProgressInfo): void => {
            if (info.status === 'initiate') {
                if (!fileTotals.has(info.file)) fileTotals.set(info.file, { loaded: 0, total: 0 });
                reportProgress(loadPct(aggregate()), label, info.file);
            } else if (info.status === 'progress') {
                fileTotals.set(info.file, { loaded: info.loaded ?? 0, total: info.total ?? 0 });
                reportProgress(loadPct(aggregate()), label, info.file);
            } else if (info.status === 'done') {
                const cur = fileTotals.get(info.file);
                fileTotals.set(info.file, { loaded: cur?.total || 1, total: cur?.total || 1 });
                reportProgress(loadPct(aggregate()), label, info.file);
            }
        };

        return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
            dtype,
            device,
            progress_callback: progressCallback as unknown as Parameters<typeof KokoroTTS.from_pretrained>[1] extends { progress_callback?: infer P } ? P : never,
        });
    };

    // ── Backend selection: WebGPU first, CPU fallback ─────────────────────
    //
    // WebGPU (device: 'webgpu', dtype: 'q4f16'):
    //   • Uses model_q4f16.onnx — int4 weights with fp16 accumulators (~41 MB).
    //   • Runs entirely on the GPU: lower per-token latency than WASM/SIMD.
    //   • Requires the model_q4f16.onnx asset; if it's missing (not yet
    //     downloaded) or WebGPU adapter unavailable we fall through silently.
    // WASM (device: 'wasm', dtype: 'q8'):
    //   • Uses model_quantized.onnx — q8 quantized (~82 MB). Always present.
    //   • Multi-threaded SIMD, proven offline path.

    // ── Backend selection ─────────────────────────────────────────────────
    //
    // Priority 1: WebGPU + fp32 (model.onnx, ~330 MB)
    //   The officially recommended WebGPU configuration in transformers.js.
    //   All tensor ops are native FP32 on GPU → 3–5× faster than WASM.
    //   Tried and rejected alternatives:
    //     q4f16 + webgpu: ORT WebGPU EP doesn't reliably handle MatMulNBits
    //       (INT4) → silently falls to WASM with broken f16 emulation →
    //       garbled / Chinese-sounding audio output.
    //     q8 + webgpu: ORT WebGPU EP is FP32/FP16 native; INT8 ops are
    //       unsupported → inference produces nothing.
    //   Fails gracefully when model.onnx is absent (404 from local server)
    //   → the catch block discards the error and tries WASM below.
    //   To enable GPU: run `node scripts/download-kokoro.js` which downloads
    //   model.onnx into webview-ui/dist/kokoro-model/.
    //
    // Priority 2: WASM + q8 (model_quantized.onnx, ~88 MB)
    //   Always available; correct audio; used when WebGPU is unavailable
    //   or model.onnx has not been downloaded yet.

    reportProgress(0, 'Detecting hardware backend');
    const gpuAvailable = await detectWebGPU();

    if (gpuAvailable) {
        reportProgress(0, 'Loading neural model (GPU)');
        try {
            tts = await loadModel('fp32', 'webgpu', 'Loading neural model (GPU)');
            activeDevice = 'webgpu';
        } catch {
            // Most likely cause: model.onnx not downloaded yet (HTTP 404 from
            // local model server).  Run download-kokoro.js to enable GPU mode.
            // Falls through to WASM below.
            tts = null;
            lastReportedPercent = -1;
        }
    }

    if (!tts) {
        reportProgress(0, 'Loading neural model (CPU)');
        tts = await loadModel('q8', 'wasm', 'Loading neural model (CPU)');
        activeDevice = 'wasm';
    }

    reportProgress(LOAD_HI, `Neural model loaded (${activeDevice === 'webgpu' ? 'GPU' : 'CPU'})`);

    // Warm default voice — JIT-compiles the ONNX graph + espeak WASM.
    // This happens exactly once per worker lifetime.
    reportProgress(90, 'Warming default voice');
    await warmVoice('af_alloy');
    reportProgress(100, 'Voice engine ready');
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
            post({ type: 'ready', device: activeDevice });
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
