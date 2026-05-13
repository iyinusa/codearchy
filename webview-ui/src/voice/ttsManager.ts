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
import {
    initKokoro,
    isKokoroReady,
    kokoroSpeak,
    kokoroStop,
    kokoroWarm,
    kokoroGenerate,
    playKokoroPcm,
    subscribeVoiceWarmed,
    getWarmedVoices,
    setGpuModelNeededCallback,
    notifyGpuModelReady,
    type KokoroAudio,
    type KokoroInitProgress,
} from './kokoroTTS';
import { subscribeVoiceConfig } from './voiceConfig';
import { DEFAULT_KOKORO_VOICE } from './kokoroVoices';
import { postMessage } from '../vscode';

// ── Activation persistence ──────────────────────────────────────────────────
//
// Once Kokoro loads successfully for the first time we send a message to the
// extension host, which stores a flag in `context.globalState` (persists across
// VS Code restarts). On every subsequent webview load the host injects
// `window.CODEARCHY_KOKORO_ACTIVATED = true` so we can:
//   1. Auto-start immediately (no 1.5 s delay) — the user already opted in.
//   2. Skip the "Activate Kokoro" card in VoiceSelector.
//
// NOTE: We do NOT use localStorage for this because VS Code WebViews get a
// fresh browsing context on every restart — localStorage is ephemeral.

declare global {
    interface Window { CODEARCHY_KOKORO_ACTIVATED?: boolean; }
}

/** Returns true if the extension host injected the "previously activated" flag,
 *  meaning the user has successfully run Kokoro at least once on this machine. */
export function isKokoroEverActivated(): boolean {
    return window.CODEARCHY_KOKORO_ACTIVATED === true;
}

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

// ── Synthesizing state ──────────────────────────────────────
//
// True from the moment speak() is invoked until audio actually starts
// playing (Kokoro: first PCM chunk; Web Speech: utter.onstart). Lets the
// UI show a "voice processing" indicator while the engine is synthesising
// but no sound has been emitted yet.

let activeSynthesizing = false;
const synthListeners = new Set<(s: boolean) => void>();
// Monotonically-increasing token. Each speak() call bumps this so stale
// async callbacks from a previous utterance (e.g. Web Speech's onerror
// firing after ss.cancel()) cannot clear the overlay for a newer speak.
let synthGeneration = 0;

function setSynthesizing(s: boolean): void {
    if (activeSynthesizing === s) return;
    activeSynthesizing = s;
    synthListeners.forEach(l => { try { l(s); } catch { /* ignore */ } });
}

/** Only clear synthesizing if the generation token hasn't been superseded. */
function clearSynthesizingIfCurrent(gen: number): void {
    if (synthGeneration === gen) setSynthesizing(false);
}

export function isSynthesizing(): boolean { return activeSynthesizing; }

/** Directly set the synthesizing overlay state. Used by callers that invoke
 *  synthesizeKokoroAudio() during active playback (e.g. story player on-demand
 *  synth) and need to surface the "Processing voice…" indicator themselves. */
export function notifySynthesizing(s: boolean): void { setSynthesizing(s); }

export function subscribeSynthesizing(listener: (s: boolean) => void): () => void {
    synthListeners.add(listener);
    listener(activeSynthesizing);
    return () => { synthListeners.delete(listener); };
}

// ── Kokoro load state ───────────────────────────────────────────────────────

type KokoroStatus = 'idle' | 'loading' | 'ready' | 'error';
export interface KokoroStatusSnapshot {
    status: KokoroStatus;
    error: string | null;
    /** Init progress 0..100 — only meaningful while status === 'loading'. */
    progress: number;
    /** Human-readable current init stage (e.g. "Loading neural model"). */
    stage: string | null;
    /** Optional file currently being loaded — surfaces granular detail. */
    file: string | null;
}

let kokoroStatus: KokoroStatus = 'idle';
let kokoroError: string | null = null;
let kokoroProgress = 0;
let kokoroStage: string | null = null;
let kokoroFile: string | null = null;
const kokoroListeners = new Set<(s: KokoroStatusSnapshot) => void>();

function snapshotKokoro(): KokoroStatusSnapshot {
    return {
        status: kokoroStatus,
        error: kokoroError,
        progress: kokoroProgress,
        stage: kokoroStage,
        file: kokoroFile,
    };
}

function emitKokoro(): void {
    const snap = snapshotKokoro();
    kokoroListeners.forEach(l => { try { l(snap); } catch { /* ignore */ } });
}

function setKokoroStatus(status: KokoroStatus, error: string | null = null): void {
    kokoroStatus = status;
    kokoroError = error;
    if (status === 'ready') {
        kokoroProgress = 100;
        kokoroStage = 'Voice engine ready';
    } else if (status === 'idle' || status === 'error') {
        kokoroProgress = 0;
        kokoroStage = null;
        kokoroFile = null;
    }
    emitKokoro();
}

function setKokoroProgress(p: KokoroInitProgress): void {
    if (kokoroStatus !== 'loading') return;
    // When in GPU download phase, worker progress maps to 50–100% range so
    // the bar doesn't jump backwards after the download completes.
    const mapped = gpuDownloadPhase ? 50 + Math.round(p.percent * 0.5) : p.percent;
    // Progress is monotonic — never let stale events drag the bar backwards.
    if (mapped < kokoroProgress) return;
    kokoroProgress = mapped;
    kokoroStage = p.stage;
    kokoroFile = p.file ?? null;
    emitKokoro();
}

export function getKokoroStatus(): KokoroStatusSnapshot {
    return snapshotKokoro();
}

export function subscribeKokoroStatus(
    listener: (s: KokoroStatusSnapshot) => void,
): () => void {
    kokoroListeners.add(listener);
    listener(snapshotKokoro());
    return () => { kokoroListeners.delete(listener); };
}

/** Subscribe to per-voice warm-completion events from the Kokoro worker.
 *  Fires once per voice id as background warming completes, so callers can
 *  enable voice UI elements in real time.  Returns an unsubscribe function. */
export { subscribeVoiceWarmed };

/** Snapshot of all voice ids that are currently warm in the worker. */
export function getWarmedKokoroVoices(): ReadonlySet<string> {
    return getWarmedVoices();
}

// ── GPU model on-demand download ────────────────────────────────────────────
//
// When Kokoro detects WebGPU but model.onnx is absent, the worker posts
// `gpuModelNeeded`.  ttsManager intercepts this and fires the registered
// listeners so App.tsx can send a `DownloadGpuModel` message to the extension
// host.  Each listener receives the `notifyWorker(ok)` function it must call
// once the download has succeeded or failed.

/** True while the GPU model is being downloaded (download is phase 1 of init). */
let gpuDownloadPhase = false;

/**
 * Listeners notified when the worker requires a GPU model download.
 * Each listener receives a `notifyWorker(ok: boolean)` function it must call
 * to unblock the worker once the download is complete.
 */
const gpuModelDownloadListeners = new Set<(notifyWorker: (ok: boolean) => void) => void>();

/**
 * Subscribe to GPU model needed events.  Fires when the Kokoro worker detects
 * WebGPU but model.onnx is absent and needs to be downloaded.
 *
 * The listener receives a `notifyWorker(ok)` callback it MUST invoke when the
 * download completes or fails.  Call it with `true` on success and `false` on
 * failure/cancellation to unblock the worker.
 *
 * Returns an unsubscribe function.
 */
export function subscribeGpuModelNeeded(
    listener: (notifyWorker: (ok: boolean) => void) => void,
): () => void {
    gpuModelDownloadListeners.add(listener);
    return () => { gpuModelDownloadListeners.delete(listener); };
}

/**
 * Push a GPU model download progress update into the Kokoro status stream.
 * The existing VoiceSelector progress bar and stage text will reflect the
 * download automatically — no new UI components needed.
 *
 * @param percent    Overall download progress, 0–100.
 * @param receivedMB Bytes received so far, converted to MB.
 * @param totalMB    Total file size in MB (may be 0 if Content-Length unknown).
 */
export function updateGpuDownloadProgress(
    percent: number,
    receivedMB: number,
    totalMB: number,
): void {
    if (kokoroStatus !== 'loading') return;
    gpuDownloadPhase = true;
    // Map download progress to 0–50% of the combined bar.
    kokoroProgress = Math.round(percent * 0.5);
    kokoroStage = totalMB > 0
        ? `Downloading GPU model (${receivedMB.toFixed(0)} / ${totalMB.toFixed(0)}\u00a0MB)`
        : `Downloading GPU model (${receivedMB.toFixed(0)}\u00a0MB)`;
    kokoroFile = 'model.onnx — FP32 WebGPU (~310\u00a0MB)';
    emitKokoro();
}

/**
 * Called by App.tsx after the extension host completes (or fails) the GPU model
 * download.  Updates the status UI and unblocks the worker.
 *
 * On success the worker resumes its GPU init (model loading progress will be
 * shown in the 50–100% range).  On failure the worker falls through to WASM.
 *
 * @param success Whether the download completed successfully.
 * @param error   Optional human-readable error message when success is false.
 */
export function completeGpuModelDownload(success: boolean, error?: string): void {
    if (success) {
        // Keep gpuDownloadPhase = true so subsequent worker initProgress events
        // are mapped to the 50–100% range.  Set bar to 50% and update stage.
        gpuDownloadPhase = true;
        if (kokoroStatus === 'loading') {
            kokoroProgress = 50;
            kokoroStage = 'GPU model ready — loading into VRAM…';
            kokoroFile = null;
            emitKokoro();
        }
    } else {
        // Download failed — worker will fall back to WASM; reset phase flag
        // so WASM progress uses the full 0–100% range.
        gpuDownloadPhase = false;
        if (kokoroStatus === 'loading') {
            kokoroProgress = 0;
            kokoroStage = error
                ? `GPU download failed: ${error} — using CPU mode`
                : 'GPU download failed — falling back to CPU mode';
            kokoroFile = null;
            emitKokoro();
        }
    }
    notifyGpuModelReady(success);
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
    // Reset GPU download phase flag each time we start a fresh init.
    gpuDownloadPhase = false;
    // Register the GPU model needed callback BEFORE starting init so it's in
    // place when the worker posts gpuModelNeeded during its init flow.
    setGpuModelNeededCallback((notifyWorker: (ok: boolean) => void) => {
        if (kokoroStatus === 'loading') {
            // Hold kokoroProgress at 0; show descriptive stage text.
            kokoroStage = 'GPU model not found — preparing download…';
            kokoroFile = 'model.onnx (FP32, ~310 MB)';
            emitKokoro();
        }
        // Propagate to any App.tsx subscriber that will trigger the download.
        gpuModelDownloadListeners.forEach(l => {
            try { l(notifyWorker); } catch { /* ignore */ }
        });
    });
    kokoroProgress = 0;
    kokoroStage = 'Activating';
    kokoroFile = null;
    setKokoroStatus('loading');
    return initKokoro(setKokoroProgress)
        .then(() => {
            setKokoroStatus('ready');
            // Persist activation in the extension host globalState so future VS
            // Code sessions know Kokoro has been activated and can auto-start.
            // Also update the in-memory window flag for the rest of this session.
            window.CODEARCHY_KOKORO_ACTIVATED = true;
            postMessage('persistKokoroActivated');
            // Warm the user's currently-selected voice so their FIRST speak()
            // is instant. The worker also warms af_alloy during init; if the
            // user picked something else we need to warm that one too.
            const cfg = getVoiceConfig();
            const voice = cfg.voiceId ?? DEFAULT_KOKORO_VOICE;
            kokoroWarm(voice);
        })
        .catch(err => {
            setKokoroStatus('error', err instanceof Error ? err.message : String(err));
            throw err;
        });
}

// Whenever the user picks a different Kokoro voice, pre-warm it in the worker
// so switching voices doesn't reintroduce cold-start latency on the next speak.
subscribeVoiceConfig((cfg) => {
    if (cfg.engine !== 'kokoro') return;
    if (!isKokoroReady()) return;
    kokoroWarm(cfg.voiceId ?? DEFAULT_KOKORO_VOICE);
});

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
    setSynthesizing(false);
}

// ── Speak engines ───────────────────────────────────────────────────────────

interface SpeakOpts {
    onEnd?: () => void;
    onError?: (e: unknown) => void;
}

function speakWebSpeech(text: string, opts: SpeakOpts, gen: number): void {
    const ss = window.speechSynthesis;
    if (!ss) { clearSynthesizingIfCurrent(gen); opts.onError?.(new Error('SpeechSynthesis unavailable')); return; }

    const cfg = getVoiceConfig();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = cfg.rate ?? 1;
    if (cfg.voiceId) {
        const v = getWebSpeechVoices().find(v => v.voiceURI === cfg.voiceId);
        if (v) { utter.voice = v; utter.lang = v.lang; }
    }

    let done = false;
    const finish = () => { if (done) return; done = true; setSpeaking(false); clearSynthesizingIfCurrent(gen); opts.onEnd?.(); };
    const fail = (e: SpeechSynthesisErrorEvent | Event) => {
        if (done) return; done = true; setSpeaking(false); clearSynthesizingIfCurrent(gen);
        const err = e as SpeechSynthesisErrorEvent;
        if (err?.error === 'interrupted' || err?.error === 'canceled') opts.onEnd?.();
        else opts.onError?.(e);
    };
    utter.onstart = () => { clearSynthesizingIfCurrent(gen); };
    utter.onend = finish;
    utter.onerror = fail;

    setSpeaking(true);
    try { ss.cancel(); } catch { /* ignore */ }
    setTimeout(() => { if (!done) { try { ss.speak(utter); } catch (e) { fail(e as Event); } } }, 50);
}

async function speakKokoro(text: string, opts: SpeakOpts, gen: number): Promise<void> {
    const cfg = getVoiceConfig();
    setSpeaking(true);
    try {
        await kokoroSpeak(text, {
            voice: cfg.voiceId ?? undefined,
            // Kokoro fires this every time it transitions between
            // "synthesising the next sentence" (true) and "audio playing"
            // (false). Mirror it directly into the synthesizing state so the
            // top-right "Processing voice…" overlay appears during EVERY
            // synthesis gap, not just the first.
            onSynthChange: (synthesizing) => {
                if (synthGeneration !== gen) return;
                setSynthesizing(synthesizing);
            },
            onEnd: () => { setSpeaking(false); clearSynthesizingIfCurrent(gen); opts.onEnd?.(); },
            onError: (e) => { setSpeaking(false); clearSynthesizingIfCurrent(gen); opts.onError?.(e); },
        });
    } catch {
        setSpeaking(false);
        clearSynthesizingIfCurrent(gen);
        throw new Error('Kokoro error');
    }
}

/** Speak text using the active engine. Falls back to Web Speech if Kokoro isn't ready. */
export async function speak(text: string, opts: SpeakOpts = {}): Promise<void> {
    const clean = cleanText(text);
    if (!clean) return;
    stopSpeaking();
    const gen = ++synthGeneration;
    setSynthesizing(true);
    const { engine } = getVoiceConfig();
    if (engine === 'kokoro' && isKokoroReady()) {
        try {
            await speakKokoro(clean, opts, gen);
            return;
        } catch { /* fall through to Web Speech */ }
    }
    speakWebSpeech(clean, opts, gen);
}

// ── Cache-aware Kokoro voice helpers ────────────────────────────────────────
//
// These power the "fluid voice cache" architecture: the chat panel and the
// narrator pre-synthesise audio in the background after each AI response,
// store the PCM in IndexedDB, and replay it from cache. Because cached
// playback is instant, we deliberately do NOT toggle the synthesizing state
// — no "Processing voice…" overlay flashes for cached clips, which makes
// Kokoro feel like a conventional TTS even though synthesis took seconds.

// ── Kokoro synthesis priority queue ─────────────────────────────────────────
//
// Kokoro runs in a single Web Worker → only ONE generate() can be in flight
// at a time. When chat replies and narrator stories race for the engine the
// narrator stalls behind a long message synth. We serialise all callers
// through a tiny priority queue: narrator jobs jump ahead of any pending
// message jobs (without preempting the in-flight one).

export type KokoroJobPriority = 'narrator' | 'message';

interface KokoroJob {
    priority: KokoroJobPriority;
    text: string;
    voiceId: string;
    onProgress?: (done: number, total: number) => void;
    resolve: (value: KokoroAudio | null) => void;
}

const kokoroQueue: KokoroJob[] = [];
let kokoroQueueRunning = false;

function enqueueKokoroJob(job: KokoroJob): void {
    if (job.priority === 'narrator') {
        // Insert before the first 'message' job so narrator stories play
        // through ASAP. Preserves narrator-vs-narrator FIFO order.
        const idx = kokoroQueue.findIndex(j => j.priority === 'message');
        if (idx === -1) kokoroQueue.push(job);
        else kokoroQueue.splice(idx, 0, job);
    } else {
        kokoroQueue.push(job);
    }
    void runKokoroQueue();
}

async function runKokoroQueue(): Promise<void> {
    if (kokoroQueueRunning) return;
    kokoroQueueRunning = true;
    try {
        while (kokoroQueue.length) {
            const job = kokoroQueue.shift()!;
            try {
                const audio = await kokoroGenerate(job.text, job.voiceId, job.onProgress);
                job.resolve(audio);
            } catch (err) {
                console.warn('[CodeArchy] kokoroGenerate failed:', err);
                job.resolve(null);
            }
        }
    } finally {
        kokoroQueueRunning = false;
    }
}

/**
 * Synthesise a complete utterance via Kokoro and return the raw PCM. Callers
 * persist the result so subsequent playbacks bypass the model. Returns null
 * when the input is empty after sanitisation or Kokoro isn't available.
 *
 * `priority` lets narrator-story synths jump ahead of pending chat-message
 * synths so users hear the story without waiting for queued message audio
 * to finish. Defaults to 'message'.
 */
export async function synthesizeKokoroAudio(
    text: string,
    voiceId?: string,
    onProgress?: (done: number, total: number) => void,
    priority: KokoroJobPriority = 'message',
): Promise<KokoroAudio | null> {
    const clean = cleanText(text);
    if (!clean) return null;
    // Kokoro must be explicitly activated by the user from the Voice
    // Configuration modal. Background features (narrator preload, story
    // pre-synth) silently no-op when the engine isn't ready instead of
    // surreptitiously triggering a multi-second download/init.
    if (!isKokoroReady()) return null;
    const target = voiceId ?? getVoiceConfig().voiceId ?? DEFAULT_KOKORO_VOICE;
    return new Promise<KokoroAudio | null>((resolve) => {
        enqueueKokoroJob({ priority, text: clean, voiceId: target, onProgress, resolve });
    });
}

/**
 * Play a previously-cached PCM buffer. Mirrors `speakingState` so existing
 * speaker-icon UI stays in sync, but skips the synthesizing state because
 * playback is instantaneous.
 */
export function playCachedAudio(
    pcm: Float32Array,
    sampleRate: number,
    opts: SpeakOpts = {},
): Promise<void> {
    stopSpeaking();
    // Bump the synth generation so any stale Web-Speech callbacks from a
    // previous speak() can't toggle states underneath us.
    synthGeneration++;
    setSpeaking(true);
    return new Promise<void>((resolve) => {
        playKokoroPcm(pcm, sampleRate, {
            onEnd: () => {
                setSpeaking(false);
                opts.onEnd?.();
                resolve();
            },
            onError: (e) => {
                setSpeaking(false);
                opts.onError?.(e);
                resolve();
            },
        }).catch((e) => {
            setSpeaking(false);
            opts.onError?.(e);
            resolve();
        });
    });
}

/**
 * Returns true when the Kokoro engine is the user's current pick AND the
 * worker is ready to serve generate() calls. Convenience wrapper used by
 * ChatPanel / useStoryPlayer to decide whether to take the cache path.
 */
export function isKokoroActive(): boolean {
    return getVoiceConfig().engine === 'kokoro' && isKokoroReady();
}

/** Resolve the voice id that synthesizeKokoroAudio() will use right now. */
export function getActiveKokoroVoiceId(): string {
    return getVoiceConfig().voiceId ?? DEFAULT_KOKORO_VOICE;
}
