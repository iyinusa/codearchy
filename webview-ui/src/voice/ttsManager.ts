/**
 * Unified TTS API used by the chat panel and voice picker.
 *
 * Routes `speak()` to either the browser SpeechSynthesis engine or the lazy
 * Kokoro chunk based on the current `VoiceConfig`. Kokoro is loaded via
 * dynamic `import()` so its bundle + ONNX weights stay out of the critical
 * path until the user activates them.
 */

import { getVoiceConfig } from './voiceConfig';

// ── Markdown / LaTeX sanitiser ───────────────────────────────────────────────

/**
 * Strip markdown and LaTeX markup from text before passing it to any TTS
 * engine so that characters like `**`, `##`, `$`, `\n` etc. are never
 * read aloud verbatim.
 */
function cleanTextForSpeech(raw: string): string {
    let t = raw;

    // 1. Block LaTeX  $$…$$ / \[…\]  →  omit (maths read terribly)
    t = t.replace(/\$\$[\s\S]*?\$\$/g, '');
    t = t.replace(/\\\[[\s\S]*?\\\]/g, '');

    // 2. Inline LaTeX  $…$  / \(…\)  →  omit
    t = t.replace(/\$[^$\n]+?\$/g, '');
    t = t.replace(/\\\([\s\S]*?\\\)/g, '');

    // 3. Fenced code blocks  ```…```  →  omit content, keep nothing
    t = t.replace(/```[\s\S]*?```/g, '');

    // 4. Inline code  `…`  →  omit (symbol names are distracting)
    t = t.replace(/`[^`\n]+?`/g, '');

    // 5. Images  ![alt](url)  →  omit
    t = t.replace(/!\[[^\]]*?\]\([^)]*?\)/g, '');

    // 6. Links  [text](url)  →  keep text
    t = t.replace(/\[([^\]]+?)\]\([^)]*?\)/g, '$1');

    // 7. Bold / italic  **text**, __text__, *text*, _text_  →  text
    t = t.replace(/(\*\*|__)(.*?)\1/gs, '$2');
    t = t.replace(/(\*|_)(.*?)\1/gs, '$2');

    // 8. Strikethrough  ~~text~~  →  text
    t = t.replace(/~~(.*?)~~/gs, '$1');

    // 9. ATX headings  ## Heading  →  Heading
    t = t.replace(/^#{1,6}\s+/gm, '');

    // 10. Blockquotes  >  →  strip marker
    t = t.replace(/^\s*>\s?/gm, '');

    // 11. Horizontal rules  ---  /  ***  /  ___  →  pause
    t = t.replace(/^[-*_]{3,}\s*$/gm, '.');

    // 12. Bullet / numbered list markers
    t = t.replace(/^\s*[-*+]\s+/gm, '');
    t = t.replace(/^\s*\d+\.\s+/gm, '');

    // 13. HTML tags
    t = t.replace(/<[^>]+>/g, '');

    // 14. HTML entities  &amp; &lt; etc.  →  plain equivalents
    t = t.replace(/&amp;/gi, 'and');
    t = t.replace(/&lt;/gi, '');
    t = t.replace(/&gt;/gi, '');
    t = t.replace(/&nbsp;/gi, ' ');
    t = t.replace(/&[a-z]+;/gi, '');

    // 15. Collapse excess whitespace / blank lines
    t = t.replace(/\n{3,}/g, '\n\n');
    t = t.replace(/[ \t]{2,}/g, ' ');

    return t.trim();
}

// ── Cached dynamic import ────────────────────────────────────────────────────
// The promise is stored at module level so `import('./kokoroEngine')` is only
// ever called once — subsequent calls return the cached ES-module object
// immediately, with zero network or disk overhead.

let _kokoroModPromise: Promise<typeof import('./kokoroEngine')> | null = null;

function getKokoroMod(): Promise<typeof import('./kokoroEngine')> {
    if (!_kokoroModPromise) {
        _kokoroModPromise = import('./kokoroEngine');
    }
    return _kokoroModPromise;
}

/**
 * Silently warm up the Kokoro engine in the background.
 * Call this as early as possible (e.g. on app mount) when `kokoroActivated`
 * is true so the model is already loaded by the time the user first speaks.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function warmupKokoro(): void {
    void getKokoroMod().then((mod) => {
        if (!mod.isKokoroLoaded()) {
            // loadKokoro() is idempotent; the promise is cached internally.
            void mod.loadKokoro();
        }
    });
}

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
    // Use the cached import promise — never pays the dynamic-import overhead twice.
    const mod = await getKokoroMod();
    // Auto-reload from cache if weights aren't in memory yet (e.g. fresh webview
    // reload). Weights are served from the browser Cache API so this is fast.
    if (!mod.isKokoroLoaded()) {
        await mod.loadKokoro();
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
 * Markdown/LaTeX syntax is stripped before the text is sent to any engine.
 * Cancels any in-flight utterance first so rapid consecutive calls remain
 * snappy.
 */
export async function speak(text: string, opts: { onEnd?: () => void; onError?: (err: unknown) => void } = {}): Promise<void> {
    const clean = cleanTextForSpeech(text);
    if (!clean.trim()) return;
    stopSpeaking();
    const cfg = getVoiceConfig();
    if (cfg.engine === 'kokoro' && cfg.kokoroActivated) {
        try {
            await speakKokoro(clean, { voiceId: cfg.voiceId, rate: cfg.rate, ...opts });
            return;
        } catch (err) {
            // Fall through to Web Speech as a safety net so the chat never
            // goes silent if Kokoro fails after activation.
            opts.onError?.(err);
        }
    }
    speakWebSpeech(clean, { voiceId: cfg.voiceId, rate: cfg.rate, ...opts });
}
