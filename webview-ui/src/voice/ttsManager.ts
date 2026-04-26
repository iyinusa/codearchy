/**
 * Unified TTS API — routes speak() to Kokoro (neural, offline) or Web Speech.
 *
 * Public API:
 *   startKokoroEngine()      — boot the worker eagerly so it's warm when needed
 *   speak(text, opts)        — synthesise + play text with the active engine
 *   stopSpeaking()           — cancel any active speech immediately
 *   isSpeaking()             — current playback state
 *   subscribeSpeaking()      — subscribe to speaking state changes
 *   getKokoroStatus()        — { status, error }
 *   subscribeKokoroStatus()  — subscribe to Kokoro load state
 *   getWebSpeechVoices()     — available system voices
 *   subscribeWebSpeechVoices()
 */

import { getVoiceConfig } from './voiceConfig';
import { initKokoro, isKokoroReady, kokoroSpeak, kokoroStop } from './kokoroTTS';

// ── Text sanitiser ──────────────────────────────────────────────────────────

function cleanText(raw: string): string {
    let t = raw;
    t = t.replace(/\$\$[\s\S]*?\$\$/g, '');
    t = t.replace(/\\\[[\s\S]*?\\\]/g, '');
    t = t.replace(/\$[^$\n]+?\$/g, '');
    t = t.replace(/\\\([\s\S]*?\\\)/g, '');
    t = t.replace(/```[\s\S]*?```/g, '');
    t = t.replace(/`[^`\n]+?`/g, '');
    t = t.replace(/!\[[^\]]*?\]\([^)]*?\)/g, '');
    t = t.replace(/\[([^\]]+?)\]\([^)]*?\)/g, '$1');
    t = t.replace(/(\*\*|__)(.*?)\1/gs, '$2');
    t = t.replace(/(\*|_)(.*?)\1/gs, '$2');
    t = t.replace(/~~(.*?)~~/gs, '$1');
    t = t.replace(/^#{1,6}\s+/gm, '');
    t = t.replace(/^\s*>\s?/gm, '');
    t = t.replace(/^[-*_]{3,}\s*$/gm, '.');
    t = t.replace(/^\s*[-*+]\s+/gm, '');
    t = t.replace(/^\s*\d+\.\s+/gm, '');
    t = t.replace(/<[^>]+>/g, '');
    t = t.replace(/&amp;/gi, 'and').replace(/&lt;/gi, '').replace(/&gt;/gi, '')
        .replace(/&nbsp;/gi, ' ').replace(/&[a-z]+;/gi, '');
    t = t.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
    return t.trim();
}

// ── Speaking state ──────────────────────────────────────────────────────────

let activeSpeaking = false;
const speakingListeners = new Set<(s: boolean) => void>();

function setSpeaking(s: boolean): void {
    if (activeSpeaking === s) return;
    activeSpeaking = s;
    speakingListeners.forEach(l => { try { l(s); } catch { /* ignore */ } });
}

export function isSpeaking(): boolean { return activeSpeaking; }

export function subscribeSpeaking(listener: (s: boolean) => void): () => void {
    speakingListeners.add(listener);
    return () => { speakingListeners.delete(listener); };
}

// ── Kokoro load state ───────────────────────────────────────────────────────

type KokoroStatus = 'idle' | 'loading' | 'ready' | 'error';
let kokoroStatus: KokoroStatus = 'idle';
let kokoroError: string | null = null;
const kokoroListeners = new Set<(s: { status: KokoroStatus; error: string | null }) => void>();

function setKokoroStatus(status: KokoroStatus, error: string | null = null): void {
    kokoroStatus = status;
    kokoroError = error;
    kokoroListeners.forEach(l => { try { l({ status, error }); } catch { /* ignore */ } });
}

export function getKokoroStatus(): { status: KokoroStatus; error: string | null } {
    return { status: kokoroStatus, error: kokoroError };
}

export function subscribeKokoroStatus(
    listener: (s: { status: KokoroStatus; error: string | null }) => void,
): () => void {
    kokoroListeners.add(listener);
    listener({ status: kokoroStatus, error: kokoroError });
    return () => { kokoroListeners.delete(listener); };
}

/** Boot the Kokoro worker. Idempotent — safe to call multiple times. */
export function startKokoroEngine(): Promise<void> {
    if (kokoroStatus === 'ready') return Promise.resolve();
    if (kokoroStatus === 'loading') {
        return new Promise<void>((resolve, reject) => {
            const unsub = subscribeKokoroStatus(({ status, error }) => {
                if (status === 'ready') { unsub(); resolve(); }
                else if (status === 'error') { unsub(); reject(new Error(error ?? 'Kokoro failed')); }
            });
        });
    }
    setKokoroStatus('loading');
    return initKokoro()
        .then(() => setKokoroStatus('ready'))
        .catch(err => {
            setKokoroStatus('error', err instanceof Error ? err.message : String(err));
            throw err;
        });
}

// ── Web Speech voices ───────────────────────────────────────────────────────

let webVoices: SpeechSynthesisVoice[] = [];
const webVoiceListeners = new Set<(v: SpeechSynthesisVoice[]) => void>();

function refreshWebVoices(): void {
    try {
        webVoices = window.speechSynthesis.getVoices() ?? [];
        webVoiceListeners.forEach(l => { try { l(webVoices); } catch { /* ignore */ } });
    } catch { /* unavailable */ }
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    refreshWebVoices();
    try { window.speechSynthesis.onvoiceschanged = refreshWebVoices; } catch { /* ignore */ }
}

export function getWebSpeechVoices(): SpeechSynthesisVoice[] {
    if (!webVoices.length) refreshWebVoices();
    return webVoices;
}

export function subscribeWebSpeechVoices(listener: (v: SpeechSynthesisVoice[]) => void): () => void {
    webVoiceListeners.add(listener);
    listener(getWebSpeechVoices());
    return () => { webVoiceListeners.delete(listener); };
}

// ── Stop ────────────────────────────────────────────────────────────────────

export function stopSpeaking(): void {
    kokoroStop();
    try { if (window.speechSynthesis?.speaking) window.speechSynthesis.cancel(); } catch { /* ignore */ }
    setSpeaking(false);
}

// ── Speak engines ───────────────────────────────────────────────────────────

interface SpeakOpts {
    onEnd?: () => void;
    onError?: (e: unknown) => void;
}

function speakWebSpeech(text: string, opts: SpeakOpts): void {
    const ss = window.speechSynthesis;
    if (!ss) { opts.onError?.(new Error('SpeechSynthesis unavailable')); return; }

    const cfg = getVoiceConfig();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = cfg.rate ?? 1;
    if (cfg.voiceId) {
        const v = getWebSpeechVoices().find(v => v.voiceURI === cfg.voiceId);
        if (v) { utter.voice = v; utter.lang = v.lang; }
    }

    let done = false;
    const finish = () => { if (done) return; done = true; setSpeaking(false); opts.onEnd?.(); };
    const fail = (e: SpeechSynthesisErrorEvent | Event) => {
        if (done) return; done = true; setSpeaking(false);
        const err = e as SpeechSynthesisErrorEvent;
        if (err?.error === 'interrupted' || err?.error === 'canceled') opts.onEnd?.();
        else opts.onError?.(e);
    };
    utter.onend = finish;
    utter.onerror = fail;

    setSpeaking(true);
    try { ss.cancel(); } catch { /* ignore */ }
    setTimeout(() => { if (!done) { try { ss.speak(utter); } catch (e) { fail(e as Event); } } }, 50);
}

async function speakKokoro(text: string, opts: SpeakOpts): Promise<void> {
    const cfg = getVoiceConfig();
    setSpeaking(true);
    try {
        await kokoroSpeak(text, {
            voice: cfg.voiceId ?? undefined,
            onEnd: () => { setSpeaking(false); opts.onEnd?.(); },
            onError: (e) => { setSpeaking(false); opts.onError?.(e); },
        });
    } catch {
        setSpeaking(false);
        throw new Error('Kokoro error');
    }
}

/** Speak text using the active engine. Falls back to Web Speech if Kokoro isn't ready. */
export async function speak(text: string, opts: SpeakOpts = {}): Promise<void> {
    const clean = cleanText(text);
    if (!clean) return;
    stopSpeaking();
    const { engine } = getVoiceConfig();
    if (engine === 'kokoro' && isKokoroReady()) {
        try {
            await speakKokoro(clean, opts);
            return;
        } catch { /* fall through to Web Speech */ }
    }
    speakWebSpeech(clean, opts);
}
