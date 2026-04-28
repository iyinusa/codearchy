/**
 * Kokoro TTS — main-thread API.
 *
 * The actual ML inference runs inside kokoroWorker.ts (off the UI thread).
 * This module owns:
 *   • Worker lifecycle (create, init, destroy).
 *   • AudioContext PCM playback — streamed chunk by chunk so audio starts
 *     playing as soon as the first chunk arrives (no full wait).
 *   • Simple sequential speak queue (latest-wins on rapid updates).
 */

import { DEFAULT_KOKORO_VOICE } from './kokoroVoices';

declare global {
    interface Window {
        CODEARCHY_KOKORO_MODEL_BASE_URI?: string;
        CODEARCHY_KOKORO_WORKER_URI?: string;
        CODEARCHY_ORT_BASE_URI?: string;
    }
}

// ── State ──────────────────────────────────────────────────────────────────

let worker: Worker | null = null;
let ready = false;
let readyPromise: Promise<void> | null = null;
let audioCtx: AudioContext | null = null;

// Each speak() call gets a unique ID so chunks can be matched back.
let nextId = 1;
// The ID of the speak request currently being synthesised by the worker.
let activeId: number | null = null;
// Tracks whether the worker is actively synthesising (only one at a time).
let busy = false;
// The latest pending speak request — if busy, held here until worker is free.
let queued: { id: number; text: string; voice: string; resolve: () => void; reject: (e: unknown) => void; onSynthChange?: (synthesizing: boolean) => void } | null = null;
// Active speak resolve/reject so stop() can clean up.
let activeResolve: (() => void) | null = null;
let activeReject: ((e: unknown) => void) | null = null;
// Fired whenever the playback queue transitions between "audio playing" and
// "waiting for the next sentence to be synthesised". The unified TTS manager
// uses this to drive the top-right "Processing voice…" overlay so it appears
// during EVERY synthesis gap, not just the first.
let activeOnSynthChange: ((synthesizing: boolean) => void) | null = null;
// Last value pushed to activeOnSynthChange — avoids redundant fires.
let activeSynthState: boolean | null = null;
// Number of PCM chunks received but not yet finished playing. When this hits
// zero and the worker hasn't sent `end` yet, we are in a synthesis gap.
let pendingPlayCount = 0;
// Set to true once the worker emits `end` for the active speak. Suppresses
// the "back to synthesizing" transition after the final chunk drains.
let endReceived = false;
// Audio source nodes currently scheduled / playing for the active speak.
// Tracked so kokoroStop() can actually silence them — calling source.stop()
// is the only way to interrupt a BufferSource that's already started.
const activeSources = new Set<AudioBufferSourceNode>();
// Chain of PCM playback promises for the active speak — gapless streaming.
let playChain: Promise<void> = Promise.resolve();
let stopFlag = 0;

// Track which voices the worker has already warmed so we don't request the
// same warm twice. Worker echoes a 'warmed' ack so this stays in sync.
const warmedVoices = new Set<string>();

// ── Generate (cache-prefill) state ─────────────────────────────────────────
//
// Independent lane from speak(): used to pre-synthesise audio that will be
// stored in IndexedDB and played back later as cached PCM. Each call to
// kokoroGenerate() reserves a fresh id and resolves once the worker posts
// a matching 'generated' event back. Errors with the same id reject.

interface PendingGen {
    resolve: (audio: KokoroAudio) => void;
    reject: (err: unknown) => void;
    voice: string;
}
const pendingGen = new Map<number, PendingGen>();

// ── AudioContext ───────────────────────────────────────────────────────────

function getAudioCtx(): AudioContext {
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext();
    }
    return audioCtx;
}

async function playPcm(pcm: Float32Array, sampleRate: number, myStop: number): Promise<void> {
    if (stopFlag !== myStop) return;
    const ctx = getAudioCtx();
    return new Promise<void>((resolve) => {
        const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
        buffer.getChannelData(0).set(pcm);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        activeSources.add(source);
        source.onended = () => {
            activeSources.delete(source);
            source.disconnect();
            resolve();
        };
        source.start();
    });
}

/** Push a synth-state transition to the active onSynthChange listener,
 *  guarded so we never re-emit the same value. */
function emitSynthState(synthesizing: boolean): void {
    if (activeSynthState === synthesizing) return;
    activeSynthState = synthesizing;
    const cb = activeOnSynthChange;
    if (!cb) return;
    try { cb(synthesizing); } catch { /* ignore */ }
}

// ── Worker messaging ───────────────────────────────────────────────────────

type WorkerOut =
    | { type: 'ready' }
    | { type: 'warmed'; voice: string }
    | { type: 'chunk'; id: number; pcm: Float32Array; sampleRate: number }
    | { type: 'end'; id: number }
    | { type: 'generated'; id: number; pcm: Float32Array; sampleRate: number }
    | { type: 'error'; id?: number; message: string };

function onWorkerMessage(ev: MessageEvent<WorkerOut>): void {
    const msg = ev.data;

    if (msg.type === 'chunk') {
        const myStop = stopFlag;
        // Ignore stale chunks from a cancelled / superseded speak.
        if (msg.id !== activeId) return;
        pendingPlayCount++;
        const pcm = msg.pcm;
        const sampleRate = msg.sampleRate;
        playChain = playChain.then(async () => {
            if (stopFlag !== myStop) return;
            // About to play this chunk → audio is now flowing, so we are no
            // longer in a "synthesizing" gap.
            emitSynthState(false);
            await playPcm(pcm, sampleRate, myStop);
            if (stopFlag !== myStop) return;
            pendingPlayCount = Math.max(0, pendingPlayCount - 1);
            // If nothing is queued and the worker hasn't finished synthesising
            // yet, we're back in a gap waiting for the next sentence.
            if (pendingPlayCount === 0 && !endReceived) {
                emitSynthState(true);
            }
        });
        return;
    }

    if (msg.type === 'warmed') {
        warmedVoices.add(msg.voice);
        return;
    }

    if (msg.type === 'generated') {
        const pending = pendingGen.get(msg.id);
        if (!pending) return;
        pendingGen.delete(msg.id);
        pending.resolve({ pcm: msg.pcm, sampleRate: msg.sampleRate, voiceId: pending.voice });
        return;
    }

    if (msg.type === 'end') {
        // Ignore end events for speaks that were already cancelled.
        if (msg.id !== activeId) { flushQueued(); return; }
        endReceived = true;
        busy = false;
        activeId = null;
        const resolve = activeResolve;
        activeResolve = null;
        activeReject = null;
        // Wait for all buffered audio to finish, then emit final synth=false
        // (covers the edge case where the gap-state was true) and resolve.
        playChain.then(() => {
            emitSynthState(false);
            activeOnSynthChange = null;
            activeSynthState = null;
            resolve?.();
        });
        // Flush next queued speak if any.
        flushQueued();
        return;
    }

    if (msg.type === 'error') {
        // Reject any pending generate keyed by the same id first — the
        // generate lane is independent from speak, so a generate-side
        // failure must not tear down an unrelated active speak.
        if (msg.id !== undefined) {
            const pending = pendingGen.get(msg.id);
            if (pending) {
                pendingGen.delete(msg.id);
                pending.reject(new Error(msg.message));
                return;
            }
        }
        // Ignore errors for speaks that were already cancelled.
        if (msg.id !== undefined && msg.id !== activeId) { return; }
        busy = false;
        activeId = null;
        const reject = activeReject;
        activeResolve = null;
        activeReject = null;
        emitSynthState(false);
        activeOnSynthChange = null;
        activeSynthState = null;
        pendingPlayCount = 0;
        endReceived = false;
        reject?.(new Error(msg.message));
        flushQueued();
        return;
    }
}

function flushQueued(): void {
    const w = worker;
    if (!queued || busy || !w) return;
    const { id, text, voice, resolve, reject, onSynthChange } = queued;
    queued = null;
    busy = true;
    activeId = id;
    activeResolve = resolve;
    activeReject = reject;
    activeOnSynthChange = onSynthChange ?? null;
    activeSynthState = null;
    pendingPlayCount = 0;
    endReceived = false;
    playChain = Promise.resolve();
    // We are about to send the speak request — caller's UI should reflect a
    // synthesizing state until the first chunk plays.
    emitSynthState(true);
    w.postMessage({ type: 'speak', id, text, voice });
}

// ── Init ───────────────────────────────────────────────────────────────────

export function initKokoro(): Promise<void> {
    if (ready) return Promise.resolve();
    if (readyPromise) return readyPromise;

    const workerUri = window.CODEARCHY_KOKORO_WORKER_URI;
    const modelBase = window.CODEARCHY_KOKORO_MODEL_BASE_URI;
    const ortBase = window.CODEARCHY_ORT_BASE_URI;

    if (!workerUri || !modelBase || !ortBase) {
        return Promise.reject(new Error('Kokoro asset URIs not injected by the extension host.'));
    }

    readyPromise = new Promise<void>((resolve, reject) => {
        // VS Code webview blocks new Worker(vscode-resource://...) directly.
        // Fetch the script, wrap in a Blob URL, instantiate from there.
        fetch(workerUri)
            .then(r => {
                if (!r.ok) throw new Error(`Worker fetch failed: HTTP ${r.status}`);
                return r.blob();
            })
            .then(blob => {
                const blobUrl = URL.createObjectURL(blob);
                const w = new Worker(blobUrl);
                URL.revokeObjectURL(blobUrl);
                worker = w;
                const onInitMsg = (ev: MessageEvent<WorkerOut>) => {
                    if (ev.data.type === 'ready') {
                        ready = true;
                        w.removeEventListener('message', onInitMsg);
                        w.addEventListener('message', onWorkerMessage);
                        resolve();
                    } else if (ev.data.type === 'error') {
                        w.removeEventListener('message', onInitMsg);
                        reject(new Error(ev.data.message));
                    }
                };
                w.addEventListener('message', onInitMsg);
                w.addEventListener('error', (e) => reject(new Error(e.message || 'Worker failed')));
                w.postMessage({ type: 'init', modelBase, ortBase });
            })
            .catch(err => {
                readyPromise = null;
                reject(err);
            });
    });
    return readyPromise;
}

export function isKokoroReady(): boolean {
    return ready;
}

// ── Speak / Stop ───────────────────────────────────────────────────────────

export interface KokoroSpeakOptions {
    voice?: string;
    /**
     * Fired whenever the speak transitions between "synthesising / waiting
     * for next chunk" (true) and "audio actively playing" (false). Called
     * once with `true` right at start, and again every time the playback
     * queue empties before the worker has finished generating audio.
     */
    onSynthChange?: (synthesizing: boolean) => void;
    onEnd?: () => void;
    onError?: (err: unknown) => void;
}

export function kokoroSpeak(text: string, options: KokoroSpeakOptions = {}): Promise<void> {
    if (!ready || !worker) return Promise.reject(new Error('Kokoro not ready'));
    const w = worker; // capture before async boundary — TS can't narrow mutable module vars
    const id = nextId++;
    const voice = options.voice ?? DEFAULT_KOKORO_VOICE;

    // Unlock the AudioContext NOW — we are still inside the user-gesture call
    // stack. Chrome blocks ctx.resume() once the call stack leaves the gesture.
    // Do NOT await — just calling resume() is enough to lift the autoplay block.
    const ctx = getAudioCtx();
    if (ctx.state !== 'running') { ctx.resume().catch(() => { /* ignore */ }); }

    return new Promise<void>((resolve, reject) => {
        const wrappedResolve = () => { options.onEnd?.(); resolve(); };
        const wrappedReject = (e: unknown) => { options.onError?.(e); reject(e); };
        const wrappedOnSynthChange = options.onSynthChange;

        if (busy) {
            // Latest-wins: discard previous queued item.
            if (queued) queued.resolve();
            queued = { id, text, voice, resolve: wrappedResolve, reject: wrappedReject, onSynthChange: wrappedOnSynthChange };
        } else {
            busy = true;
            activeId = id;
            activeResolve = wrappedResolve;
            activeReject = wrappedReject;
            activeOnSynthChange = wrappedOnSynthChange ?? null;
            activeSynthState = null;
            pendingPlayCount = 0;
            endReceived = false;
            playChain = Promise.resolve();
            // We're about to start synthesising — tell the caller.
            emitSynthState(true);
            w.postMessage({ type: 'speak', id, text, voice });
        }
    });
}

export function kokoroStop(): void {
    stopFlag++;
    queued = null;
    busy = false;
    activeId = null;
    activeResolve = null;
    activeReject = null;
    // Hide any "Processing voice…" overlay immediately on user-initiated stop.
    emitSynthState(false);
    activeOnSynthChange = null;
    activeSynthState = null;
    pendingPlayCount = 0;
    endReceived = false;
    playChain = Promise.resolve();
    // Silence audio that is currently playing or scheduled. BufferSource
    // playback can ONLY be interrupted via source.stop() — without this,
    // already-started chunks keep playing to completion even though the
    // worker has stopped emitting new ones.
    activeSources.forEach(src => {
        try { src.onended = null; src.stop(); } catch { /* ignore */ }
        try { src.disconnect(); } catch { /* ignore */ }
    });
    activeSources.clear();
    worker?.postMessage({ type: 'stop' });
}

/**
 * Pre-warm a voice in the worker so the first speak() with it is instant.
 * Idempotent — safe to call repeatedly. No-op if Kokoro isn't ready yet.
 * Fire-and-forget: callers don't need to await unless they want to gate UI.
 */
export function kokoroWarm(voice: string): void {
    if (!ready || !worker) return;
    if (warmedVoices.has(voice)) return;
    // Optimistically mark so we don't spam the worker; the 'warmed' ack will
    // confirm. If the worker fails silently it's still cheap to retry on the
    // next voice change.
    warmedVoices.add(voice);
    worker.postMessage({ type: 'warm', voice });
}

// ── Generate (cache-prefill) ───────────────────────────────────────────────

export interface KokoroAudio {
    pcm: Float32Array;
    sampleRate: number;
    /** The Kokoro voice id this audio was synthesised with. */
    voiceId: string;
}

/**
 * Synthesise a complete utterance in the background and return the full
 * PCM in one go. Independent of the streaming `kokoroSpeak()` lane —
 * intended for the persistence-cache layer that pre-builds audio so
 * later playback is instant.
 *
 * Does NOT play the audio. The caller is responsible for storing it
 * and passing it to `playKokoroPcm()` when the user wants to hear it.
 */
export function kokoroGenerate(text: string, voice?: string): Promise<KokoroAudio> {
    if (!ready || !worker) return Promise.reject(new Error('Kokoro not ready'));
    const w = worker;
    const id = nextId++;
    const v = voice ?? DEFAULT_KOKORO_VOICE;
    return new Promise<KokoroAudio>((resolve, reject) => {
        pendingGen.set(id, { resolve, reject, voice: v });
        w.postMessage({ type: 'generate', id, text, voice: v });
    });
}

// ── Cached PCM playback ────────────────────────────────────────────────────

export interface KokoroPlayOptions {
    onEnd?: () => void;
    onError?: (err: unknown) => void;
}

/**
 * Play a previously-synthesised PCM buffer through the same AudioContext
 * + activeSources tracking that `kokoroSpeak()` uses, so a subsequent
 * `kokoroStop()` can cancel it just the same.
 *
 * Resolves once playback finishes (or is interrupted via stop). Does NOT
 * touch the worker — synthesis already happened.
 */
export function playKokoroPcm(
    pcm: Float32Array,
    sampleRate: number,
    options: KokoroPlayOptions = {},
): Promise<void> {
    // Cancel any in-flight synthesis or prior cached playback so the new
    // buffer is the only audible source. kokoroStop() also unlocks any
    // queued speak waiting on the active id.
    kokoroStop();
    const ctx = getAudioCtx();
    if (ctx.state !== 'running') {
        ctx.resume().catch(() => { /* ignore — gesture may have lapsed */ });
    }
    const myStop = stopFlag;
    return new Promise<void>((resolve) => {
        let buffer: AudioBuffer;
        try {
            buffer = ctx.createBuffer(1, pcm.length, sampleRate);
            buffer.getChannelData(0).set(pcm);
        } catch (e) {
            options.onError?.(e);
            resolve();
            return;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        activeSources.add(source);
        let finished = false;
        const finish = (interrupted: boolean) => {
            if (finished) return;
            finished = true;
            activeSources.delete(source);
            try { source.disconnect(); } catch { /* ignore */ }
            // Only fire onEnd when WE were the active playback at start —
            // a superseded playback has already had its caller notified.
            if (!interrupted && stopFlag === myStop) options.onEnd?.();
            resolve();
        };
        source.onended = () => finish(stopFlag !== myStop);
        try {
            source.start();
        } catch (e) {
            options.onError?.(e);
            finish(true);
        }
    });
}
