/**
 * Unified TTS API used by the chat panel and voice picker.
 *
 * Routes `speak()` to either the browser SpeechSynthesis engine or the lazy
 * Kokoro chunk based on the current `VoiceConfig`. Kokoro is loaded via
 * dynamic `import()` so its bundle + ONNX weights stay out of the critical
 * path until the user activates them.
 */

import { getVoiceConfig } from './voiceConfig';

type StopFn = () => void;

let activeStop: StopFn | null = null;
let speakingListeners = new Set<(speaking: boolean) => void>();

function setSpeaking(state: boolean): void {
    speakingListeners.forEach((l) => {
        try { l(state); } catch { /* swallow */ }
    });
}

export function subscribeSpeaking(listener: (speaking: boolean) => void): () => void {
    speakingListeners.add(listener);
    return () => { speakingListeners.delete(listener); };
}

export function isSpeaking(): boolean {
    return !!activeStop;
}

/** Cancel any in-flight utterance (Web Speech) or audio playback (Kokoro). */
export function stopSpeaking(): void {
    const stop = activeStop;
    activeStop = null;
    if (stop) {
        try { stop(); } catch { /* ignore */ }
    }
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    setSpeaking(false);
}

// ── Web Speech voices ────────────────────────────────────────────────────────

let cachedWebVoices: SpeechSynthesisVoice[] = [];
const webVoiceListeners = new Set<(voices: SpeechSynthesisVoice[]) => void>();

function refreshWebVoices(): void {
    try {
        const v = window.speechSynthesis.getVoices() ?? [];
        cachedWebVoices = v.slice();
        webVoiceListeners.forEach((l) => {
            try { l(cachedWebVoices); } catch { /* ignore */ }
        });
    } catch { /* SpeechSynthesis may be unavailable */ }
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    refreshWebVoices();
    try {
        window.speechSynthesis.onvoiceschanged = refreshWebVoices;
    } catch { /* older browsers */ }
}

export function getWebSpeechVoices(): SpeechSynthesisVoice[] {
    if (cachedWebVoices.length === 0) refreshWebVoices();
    return cachedWebVoices;
}

export function subscribeWebSpeechVoices(listener: (voices: SpeechSynthesisVoice[]) => void): () => void {
    webVoiceListeners.add(listener);
    listener(getWebSpeechVoices());
    return () => { webVoiceListeners.delete(listener); };
}

// ── Engines ──────────────────────────────────────────────────────────────────

interface EngineOptions {
    voiceId?: string | null;
    rate?: number;
    onEnd?: () => void;
    onError?: (err: unknown) => void;
}

function speakWebSpeech(text: string, opts: EngineOptions): void {
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = opts.rate ?? 1;
    utter.pitch = 1;
    if (opts.voiceId) {
        const voice = getWebSpeechVoices().find((v) => v.voiceURI === opts.voiceId);
        if (voice) utter.voice = voice;
    }
    const finish = () => {
        activeStop = null;
        setSpeaking(false);
        opts.onEnd?.();
    };
    const fail = (e: SpeechSynthesisErrorEvent) => {
        activeStop = null;
        setSpeaking(false);
        opts.onError?.(e);
    };
    utter.onend = finish;
    utter.onerror = fail;
    activeStop = () => {
        try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    };
    setSpeaking(true);
    window.speechSynthesis.speak(utter);
}

async function speakKokoro(text: string, opts: EngineOptions): Promise<void> {
    // Dynamic import → esbuild emits this as a separate chunk.
    const mod = await import('./kokoroEngine');
    if (!mod.isKokoroLoaded()) {
        const err = new Error('Kokoro TTS is not loaded yet.');
        opts.onError?.(err);
        return;
    }
    activeStop = () => mod.stopKokoro();
    setSpeaking(true);
    await mod.kokoroSpeak(text, {
        voice: opts.voiceId ?? undefined,
        onEnd: () => {
            activeStop = null;
            setSpeaking(false);
            opts.onEnd?.();
        },
        onError: (err) => {
            activeStop = null;
            setSpeaking(false);
            opts.onError?.(err);
        },
    });
}

/**
 * Speak `text` using the engine + voice from the current `VoiceConfig`.
 * Cancels any in-flight utterance first so rapid consecutive calls remain
 * snappy.
 */
export async function speak(text: string, opts: { onEnd?: () => void; onError?: (err: unknown) => void } = {}): Promise<void> {
    if (!text.trim()) return;
    stopSpeaking();
    const cfg = getVoiceConfig();
    if (cfg.engine === 'kokoro' && cfg.kokoroActivated) {
        try {
            await speakKokoro(text, { voiceId: cfg.voiceId, rate: cfg.rate, ...opts });
            return;
        } catch (err) {
            // Fall through to Web Speech as a safety net so the chat never
            // goes silent if Kokoro fails after activation.
            opts.onError?.(err);
        }
    }
    speakWebSpeech(text, { voiceId: cfg.voiceId, rate: cfg.rate, ...opts });
}
