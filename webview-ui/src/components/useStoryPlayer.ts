import { useCallback, useEffect, useRef, useState } from 'react';
import type { NarratorStep } from '../types';
import {
    speak as ttsSpeak,
    stopSpeaking,
    synthesizeKokoroAudio,
    playCachedAudio,
    isKokoroActive,
    getActiveKokoroVoiceId,
    notifySynthesizing,
} from '../voice/ttsManager';
import { getVoiceConfig } from '../voice/voiceConfig';
import { isKokoroReady } from '../voice/kokoroTTS';
import { arrayBufferToPcm, updateNarratorStepVoice } from '../db';

/**
 * useStoryPlayer — drives a narrator timeline silently in memory.
 *
 * Features:
 *  - Smooth step sequencing with pause/resume and manual step jumps.
 *  - Syncs each step with Web Speech API; advances when utterance ends OR
 *    when a safety timer fires (so silence/unsupported voices never stall).
 *  - Emits an `onStep(step)` callback so the host view can animate node focus.
 *  - Zero lag to UI: uses a single timer + one active utterance at a time.
 */
export interface StoryPlayerState {
    narratorId: number | null;
    stepIndex: number;
    status: 'idle' | 'playing' | 'paused';
}

export interface StoryPlayerApi {
    state: StoryPlayerState;
    activeStep: NarratorStep | null;
    /** Start playing a fresh narrator from step 0. */
    play(narratorId: number, steps: NarratorStep[], options?: { autoSpeak?: boolean }): void;
    /** Resume a paused narrator (or start from 0 if idle). */
    resume(): void;
    pause(): void;
    stop(): void;
    next(): void;
    prev(): void;
    gotoStep(index: number): void;
    /** Whether the given narrator id is the one currently active. */
    isActive(narratorId: number): boolean;
}

export function useStoryPlayer(
    onStep: (step: NarratorStep, index: number) => void,
): StoryPlayerApi {
    const [state, setState] = useState<StoryPlayerState>({
        narratorId: null,
        stepIndex: 0,
        status: 'idle',
    });
    const stepsRef = useRef<NarratorStep[]>([]);
    const statusRef = useRef<StoryPlayerState['status']>('idle');
    const autoSpeakRef = useRef<boolean>(true);
    const timerRef = useRef<number | null>(null);
    const stepIndexRef = useRef<number>(0);
    const narratorIdRef = useRef<number | null>(null);
    const onStepRef = useRef(onStep);
    onStepRef.current = onStep;

    const clearTimer = () => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    };

    const cancelSpeech = () => {
        stopSpeaking();
    };

    const runStep = useCallback((index: number) => {
        const steps = stepsRef.current;
        if (index < 0 || index >= steps.length) {
            // End of timeline — stop gracefully.
            statusRef.current = 'idle';
            setState(s => ({ ...s, status: 'idle' }));
            cancelSpeech();
            clearTimer();
            return;
        }
        stepIndexRef.current = index;
        setState(s => ({ ...s, stepIndex: index, status: 'playing' }));

        const step = steps[index];
        onStepRef.current(step, index);

        // Safety duration — advance even if speech is disabled / unsupported.
        const words = step.narration.split(/\s+/).filter(Boolean).length;
        const estMs = Math.min(14_000, Math.max(step.durationMs ?? 2_600, 300 + words * 280));

        cancelSpeech();
        clearTimer();

        const advance = () => {
            if (statusRef.current !== 'playing') return;
            runStep(stepIndexRef.current + 1);
        };

        if (autoSpeakRef.current) {
            // Cache-first: when Kokoro is the active engine and this step
            // already has a matching cached PCM, play it instantly. Falls
            // back to on-demand synthesis (and persists the result) if the
            // cache is empty or was generated for a different voice.
            const kokoroActive = isKokoroActive();
            const activeVoice = kokoroActive ? getActiveKokoroVoiceId() : null;
            const cached =
                kokoroActive &&
                    step.voice &&
                    step.voiceSampleRate &&
                    step.voiceId === activeVoice
                    ? { pcm: arrayBufferToPcm(step.voice), sampleRate: step.voiceSampleRate }
                    : null;

            if (cached) {
                void playCachedAudio(cached.pcm, cached.sampleRate, {
                    onEnd: () => advance(),
                    onError: () => advance(),
                });
                // Cached playback is instant — keep the safety timer tight.
                timerRef.current = window.setTimeout(advance, estMs * 4);
            } else if (kokoroActive && activeVoice) {
                // On-demand synth + persist + play. We capture the step
                // index and narrator id so a slow synth can't cross-pollute
                // a step the user has since skipped past.
                const myIndex = index;
                const myNarratorId = narratorIdRef.current;
                (async () => {
                    notifySynthesizing(true);
                    const audio = await synthesizeKokoroAudio(step.narration, activeVoice, undefined, 'narrator');
                    notifySynthesizing(false);
                    if (statusRef.current !== 'playing' || stepIndexRef.current !== myIndex) {
                        // Player moved on — drop the result; cache write
                        // would still be nice but the user already paused
                        // or skipped, so skip the write to avoid stomping
                        // a fresher in-flight synth at the new index.
                        return;
                    }
                    if (!audio) {
                        // Synth failed → fall back to streaming so the
                        // narration is still audible.
                        void ttsSpeak(step.narration, {
                            onEnd: () => advance(),
                            onError: () => advance(),
                        });
                        return;
                    }
                    // Persist back to the narrator row so subsequent plays
                    // are instant. Mutate stepsRef in place too — the
                    // hook's local copy isn't reactive but other steps may
                    // still reference voice on their own playback.
                    // Cast: `TypedArray.buffer` is now typed as
                    // `ArrayBuffer | SharedArrayBuffer`; our PCM is
                    // always backed by a non-shared ArrayBuffer.
                    const buffer = audio.pcm.buffer.slice(
                        audio.pcm.byteOffset,
                        audio.pcm.byteOffset + audio.pcm.byteLength,
                    ) as ArrayBuffer;
                    const liveSteps = stepsRef.current.slice();
                    if (liveSteps[myIndex]) {
                        liveSteps[myIndex] = {
                            ...liveSteps[myIndex],
                            voice: buffer,
                            voiceId: audio.voiceId,
                            voiceSampleRate: audio.sampleRate,
                        };
                        stepsRef.current = liveSteps;
                    }
                    if (myNarratorId !== null) {
                        updateNarratorStepVoice(myNarratorId, myIndex, audio).catch(e =>
                            console.error('[CodeArchy] persist step voice failed', e),
                        );
                    }
                    void playCachedAudio(audio.pcm, audio.sampleRate, {
                        onEnd: () => advance(),
                        onError: () => advance(),
                    });
                })();
                // Generous safety: synth can take seconds.
                const safetyMs = Math.max(30_000, estMs * 3);
                timerRef.current = window.setTimeout(advance, safetyMs);
            } else {
                // Web Speech engine — original streaming path, unchanged.
                void ttsSpeak(step.narration, {
                    onEnd: () => advance(),
                    onError: () => advance(),
                });
                const kokoroLegacy = getVoiceConfig().engine === 'kokoro' && isKokoroReady();
                const safetyMs = kokoroLegacy
                    ? Math.max(30_000, estMs * 3)
                    : estMs + 1200;
                timerRef.current = window.setTimeout(advance, safetyMs);
            }
        } else {
            timerRef.current = window.setTimeout(advance, estMs);
        }
    }, []);

    const play = useCallback((narratorId: number, steps: NarratorStep[], options?: { autoSpeak?: boolean }) => {
        stepsRef.current = steps;
        narratorIdRef.current = narratorId;
        autoSpeakRef.current = options?.autoSpeak !== false;
        statusRef.current = 'playing';
        setState({ narratorId, stepIndex: 0, status: 'playing' });
        // Defer the first step until React has flushed the 'playing' state
        // AND the graph view (which may also be switching modes via App's
        // focusNarratedNode) has mounted/settled. A single rAF was racy —
        // sometimes the view ref hadn't attached yet, so the first node
        // pulse + zoom was swallowed. Two rAFs + a small timeout reliably
        // lands after layout & view-mode propagation, while still feeling
        // instant to the user.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                window.setTimeout(() => {
                    if (statusRef.current === 'playing' && stepIndexRef.current === 0) {
                        runStep(0);
                    }
                }, 30);
            });
        });
    }, [runStep]);

    const resume = useCallback(() => {
        if (!stepsRef.current.length) return;
        statusRef.current = 'playing';
        setState(s => ({ ...s, status: 'playing' }));
        runStep(stepIndexRef.current);
    }, [runStep]);

    const pause = useCallback(() => {
        statusRef.current = 'paused';
        cancelSpeech();
        clearTimer();
        setState(s => ({ ...s, status: 'paused' }));
    }, []);

    const stop = useCallback(() => {
        statusRef.current = 'idle';
        stepsRef.current = [];
        stepIndexRef.current = 0;
        narratorIdRef.current = null;
        cancelSpeech();
        clearTimer();
        setState({ narratorId: null, stepIndex: 0, status: 'idle' });
    }, []);

    const next = useCallback(() => {
        if (!stepsRef.current.length) return;
        const target = Math.min(stepsRef.current.length - 1, stepIndexRef.current + 1);
        statusRef.current = 'playing';
        setState(s => ({ ...s, status: 'playing' }));
        runStep(target);
    }, [runStep]);

    const prev = useCallback(() => {
        if (!stepsRef.current.length) return;
        const target = Math.max(0, stepIndexRef.current - 1);
        statusRef.current = 'playing';
        setState(s => ({ ...s, status: 'playing' }));
        runStep(target);
    }, [runStep]);

    const gotoStep = useCallback((index: number) => {
        if (!stepsRef.current.length) return;
        const target = Math.max(0, Math.min(stepsRef.current.length - 1, index));
        statusRef.current = 'playing';
        setState(s => ({ ...s, status: 'playing' }));
        runStep(target);
    }, [runStep]);

    const isActive = useCallback(
        (narratorId: number) => state.narratorId === narratorId && state.status !== 'idle',
        [state.narratorId, state.status],
    );

    // Cleanup on unmount — never leave a dangling utterance behind.
    useEffect(
        () => () => {
            cancelSpeech();
            clearTimer();
        },
        [],
    );

    const activeStep =
        state.status !== 'idle' && stepsRef.current[state.stepIndex]
            ? stepsRef.current[state.stepIndex]
            : null;

    return { state, activeStep, play, resume, pause, stop, next, prev, gotoStep, isActive };
}
