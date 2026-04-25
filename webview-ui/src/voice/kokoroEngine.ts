/**
 * Lazy-loaded Kokoro-82M TTS engine wrapper.
 *
 * IMPORTANT: this module is only imported via dynamic `import()` from the
 * TTS manager, so esbuild emits it as a separate chunk. None of its heavy
 * dependencies (`kokoro-js`, `@huggingface/transformers`, ONNX runtime) are
 * pulled into the main webview bundle. The chunk — and the ~80 MB model
 * weights — are fetched only after the user explicitly activates Kokoro TTS.
 */

// `kokoro-js` ships its own type declarations.
import { KokoroTTS, env } from 'kokoro-js';
import { KOKORO_MODEL_ID, KOKORO_DTYPE, DEFAULT_KOKORO_VOICE } from './kokoroVoices';

// Offload ONNX inference to a proxy Web Worker so the React UI never freezes.
// This must be set BEFORE the first KokoroTTS.from_pretrained() call.
try {
    // The kokoro-js `env` export only exposes wasmPaths; the full
    // transformers.js env with backends is available via type cast.
    (env as unknown as { backends: { onnx: { wasm: { proxy: boolean } } } })
        .backends.onnx.wasm.proxy = true;
} catch {
    /* non-critical — falls back to main-thread inference */
}

let ttsInstance: KokoroTTS | null = null;
let loadingPromise: Promise<void> | null = null;

// AudioContext-based playback (supported in VS Code webviews; avoids CSP
// restrictions that can affect HTMLAudioElement).
let currentSource: AudioBufferSourceNode | null = null;
let currentAudioCtx: AudioContext | null = null;

export type ProgressCallback = (info: { phase: string; percent?: number }) => void;

function cleanupAudio(): void {
    if (currentSource) {
        currentSource.onended = null;
        try { currentSource.stop(); } catch { /* already stopped */ }
        currentSource = null;
    }
    if (currentAudioCtx) {
        try { void currentAudioCtx.close(); } catch { /* ignore */ }
        currentAudioCtx = null;
    }
}

async function playWav(
    wav: ArrayBuffer,
    onEnd?: () => void,
    onError?: (err: unknown) => void,
): Promise<void> {
    cleanupAudio();
    try {
        const ctx = new AudioContext();
        currentAudioCtx = ctx;
        // decodeAudioData is async — does not block the main thread.
        const buffer = await ctx.decodeAudioData(wav.slice(0));
        if (!currentAudioCtx) { onEnd?.(); return; } // stopped before decode finished
        const source = ctx.createBufferSource();
        currentSource = source;
        source.buffer = buffer;
        source.connect(ctx.destination);
        return new Promise<void>((resolve) => {
            source.onended = () => {
                cleanupAudio();
                onEnd?.();
                resolve();
            };
            source.start();
        });
    } catch (err) {
        cleanupAudio();
        onError?.(err);
    }
}

export function isKokoroLoaded(): boolean {
    return !!ttsInstance;
}

export async function loadKokoro(onProgress?: ProgressCallback): Promise<void> {
    if (ttsInstance) return;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
        onProgress?.({ phase: 'Initializing Kokoro TTS…' });
        try {
            ttsInstance = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
                dtype: KOKORO_DTYPE as 'q8',
                // transformers.js progress callback shape:
                //   { status, file, progress?, loaded?, total? }
                progress_callback: (info: {
                    status?: string;
                    file?: string;
                    progress?: number;
                    loaded?: number;
                    total?: number;
                }) => {
                    if (!onProgress) return;
                    if (info.status === 'progress' && typeof info.progress === 'number') {
                        onProgress({
                            phase: info.file ? `Downloading ${info.file}` : 'Downloading model…',
                            percent: Math.max(0, Math.min(100, Math.round(info.progress))),
                        });
                    } else if (info.status === 'done' && info.file) {
                        onProgress({ phase: `Cached ${info.file}` });
                    } else if (info.status === 'ready') {
                        onProgress({ phase: 'Model ready' });
                    }
                },
            });
            onProgress?.({ phase: 'Kokoro TTS ready', percent: 100 });
        } catch (err) {
            ttsInstance = null;
            throw err;
        } finally {
            loadingPromise = null;
        }
    })();

    return loadingPromise;
}

export interface KokoroSpeakOptions {
    voice?: string;
    onEnd?: () => void;
    onError?: (err: unknown) => void;
}

export async function kokoroSpeak(text: string, options: KokoroSpeakOptions = {}): Promise<void> {
    if (!ttsInstance) {
        throw new Error('Kokoro TTS is not loaded. Activate it from the Voice settings first.');
    }
    const { voice = DEFAULT_KOKORO_VOICE, onEnd, onError } = options;

    stopKokoro();

    try {
        // generate() runs ONNX inference in the proxy worker — non-blocking.
        const audio = await ttsInstance.generate(text, {
            voice: (voice ?? DEFAULT_KOKORO_VOICE) as NonNullable<Parameters<typeof ttsInstance.generate>[1]>['voice'],
        });
        // toWav() returns an ArrayBuffer; AudioContext.decodeAudioData handles it.
        const wav = audio.toWav() as ArrayBuffer;
        await playWav(wav, onEnd, onError);
    } catch (err) {
        onError?.(err);
        throw err;
    }
}

export function stopKokoro(): void {
    cleanupAudio();
}
