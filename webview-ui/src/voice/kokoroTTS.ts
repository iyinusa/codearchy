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
// Tracks whether the worker is actively synthesising (only one at a time).
let busy = false;
// The latest pending speak request — if busy, held here until worker is free.
let queued: { id: number; text: string; voice: string; resolve: () => void; reject: (e: unknown) => void } | null = null;
// Active speak resolve/reject so stop() can clean up.
let activeResolve: (() => void) | null = null;
let activeReject: ((e: unknown) => void) | null = null;
// Chain of PCM playback promises for the active speak — gapless streaming.
let playChain: Promise<void> = Promise.resolve();
let stopFlag = 0;

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
        source.onended = () => { source.disconnect(); resolve(); };
        source.start();
    });
}

// ── Worker messaging ───────────────────────────────────────────────────────

type WorkerOut =
    | { type: 'ready' }
    | { type: 'chunk'; id: number; pcm: Float32Array; sampleRate: number }
    | { type: 'end'; id: number }
    | { type: 'error'; id?: number; message: string };

function onWorkerMessage(ev: MessageEvent<WorkerOut>): void {
    const msg = ev.data;

    if (msg.type === 'chunk') {
        const myStop = stopFlag;
        playChain = playChain.then(() => playPcm(msg.pcm, msg.sampleRate, myStop));
        return;
    }

    if (msg.type === 'end') {
        busy = false;
        const resolve = activeResolve;
        activeResolve = null;
        activeReject = null;
        // Wait for all buffered audio to finish, then resolve.
        playChain.then(() => resolve?.());
        // Flush next queued speak if any.
        flushQueued();
        return;
    }

    if (msg.type === 'error') {
        busy = false;
        const reject = activeReject;
        activeResolve = null;
        activeReject = null;
        reject?.(new Error(msg.message));
        flushQueued();
        return;
    }
}

function flushQueued(): void {
    const w = worker;
    if (!queued || busy || !w) return;
    const { id, text, voice, resolve, reject } = queued;
    queued = null;
    busy = true;
    activeResolve = resolve;
    activeReject = reject;
    playChain = Promise.resolve();
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

        if (busy) {
            // Latest-wins: discard previous queued item.
            if (queued) queued.resolve();
            queued = { id, text, voice, resolve: wrappedResolve, reject: wrappedReject };
        } else {
            busy = true;
            activeResolve = wrappedResolve;
            activeReject = wrappedReject;
            playChain = Promise.resolve();
            w.postMessage({ type: 'speak', id, text, voice });
        }
    });
}

export function kokoroStop(): void {
    stopFlag++;
    queued = null;
    busy = false;
    activeResolve = null;
    activeReject = null;
    playChain = Promise.resolve();
    worker?.postMessage({ type: 'stop' });
}
