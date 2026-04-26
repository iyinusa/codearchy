/**
 * Kokoro TTS worker.
 *
 * Runs `kokoro-js` off the UI thread for lag-free synthesis.
 * The model and voice files are pre-downloaded into webview-ui/dist/kokoro-model/
 * (fully offline). On init we install a fetch shim that rewrites HF URLs to
 * our local webview base URI — no network access ever occurs at runtime.
 *
 * Protocol (main ↔ worker):
 *   init  → { type:'init', modelBase:string, ortBase:string }
 *   ready ← { type:'ready' }
 *   speak → { type:'speak', id:number, text:string, voice?:string }
 *   chunk ← { type:'chunk', id:number, pcm:Float32Array, sampleRate:number }
 *   end   ← { type:'end', id:number }
 *   stop  → { type:'stop' }
 *   error ← { type:'error', id?:number, message:string }
 */

import { KokoroTTS, TextSplitterStream, env } from 'kokoro-js';

type WorkerMsg =
    | { type: 'init'; modelBase: string; ortBase: string }
    | { type: 'speak'; id: number; text: string; voice?: string }
    | { type: 'stop' };

function post(data: unknown, transfer?: Transferable[]): void {
    (self as unknown as { postMessage(d: unknown, t?: Transferable[]): void })
        .postMessage(data, transfer ?? []);
}

let tts: KokoroTTS | null = null;
let stopFlag = 0;

// HF base that kokoro-js and transformers.js use for model/voice file URLs.
const HF_BASE = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/';

function installFetchShim(localBase: string): void {
    const base = localBase.endsWith('/') ? localBase : localBase + '/';
    const orig = self.fetch.bind(self);
    self.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input
            : input instanceof URL ? input.href
                : (input as Request).url;
        return url.startsWith(HF_BASE)
            ? orig(base + url.slice(HF_BASE.length), init)
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

    // Warm-prime: one inference so the first real speak() is instant.
    try { await tts.generate(' ', { voice: 'af_heart' }); } catch { /* ignore */ }
}

async function synthesise(id: number, text: string, voice: string): Promise<void> {
    if (!tts) throw new Error('TTS not initialised');
    const myStop = ++stopFlag;

    // stream() takes a TextSplitterStream. When given a raw string it creates
    // one internally but NEVER calls .close() on it, so the async iterator
    // hangs forever waiting for more text — resulting in zero chunks and silence.
    // We must create the splitter explicitly and close it before iterating.
    const splitter = new TextSplitterStream();
    splitter.push(text);
    splitter.close(); // flush the last sentence into the queue and mark done

    type StreamOpts = NonNullable<Parameters<KokoroTTS['stream']>[1]>;
    const gen = tts.stream(splitter, { voice } as unknown as StreamOpts);
    for await (const { audio } of gen) {
        if (stopFlag !== myStop) return;
        const pcm = new Float32Array(audio.audio as Float32Array);
        post({ type: 'chunk', id, pcm, sampleRate: audio.sampling_rate }, [pcm.buffer]);
    }
}

self.onmessage = async (ev: MessageEvent<WorkerMsg>) => {
    const msg = ev.data;
    try {
        if (msg.type === 'init') {
            await init(msg.modelBase, msg.ortBase);
            post({ type: 'ready' });
        } else if (msg.type === 'speak') {
            await synthesise(msg.id, msg.text, msg.voice ?? 'af_heart');
            post({ type: 'end', id: msg.id });
        } else if (msg.type === 'stop') {
            stopFlag++;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        post({ type: 'error', id: (msg as { id?: number }).id, message });
    }
};
