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
import { KokoroTTS } from 'kokoro-js';
import { KOKORO_MODEL_ID, KOKORO_DTYPE, DEFAULT_KOKORO_VOICE } from './kokoroVoices';

let ttsInstance: KokoroTTS | null = null;
let loadingPromise: Promise<void> | null = null;

let currentAudio: HTMLAudioElement | null = null;
let currentObjectUrl: string | null = null;

export type ProgressCallback = (info: { phase: string; percent?: number }) => void;

function cleanupAudio(): void {
    if (currentAudio) {
        try {
            currentAudio.pause();
            currentAudio.src = '';
        } catch { /* ignore */ }
        currentAudio = null;
    }
    if (currentObjectUrl) {
        try { URL.revokeObjectURL(currentObjectUrl); } catch { /* ignore */ }
        currentObjectUrl = null;
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

    let audioBlob: Blob;
    try {
        const audio = await ttsInstance.generate(text, { voice: voice as Parameters<typeof ttsInstance.generate>[1]['voice'] });
        // RawAudio in kokoro-js exposes both toBlob() and toWav(); prefer Blob.
        const maybeBlob = (audio as unknown as { toBlob?: () => Blob }).toBlob?.();
        if (maybeBlob instanceof Blob) {
            audioBlob = maybeBlob;
        } else {
            const wav = (audio as unknown as { toWav: () => ArrayBuffer | Uint8Array }).toWav();
            audioBlob = new Blob([wav as BlobPart], { type: 'audio/wav' });
        }
    } catch (err) {
        onError?.(err);
        throw err;
    }

    currentObjectUrl = URL.createObjectURL(audioBlob);
    currentAudio = new Audio(currentObjectUrl);

    return new Promise<void>((resolve) => {
        if (!currentAudio) { resolve(); return; }
        const finish = () => {
            cleanupAudio();
            onEnd?.();
            resolve();
        };
        const fail = (e: unknown) => {
            cleanupAudio();
            onError?.(e);
            resolve();
        };
        currentAudio.onended = finish;
        currentAudio.onerror = fail;
        currentAudio.play().catch(fail);
    });
}

export function stopKokoro(): void {
    cleanupAudio();
}
