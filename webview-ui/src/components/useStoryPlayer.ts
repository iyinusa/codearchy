import { useCallback, useEffect, useRef, useState } from 'react';
import type { NarratorStep } from '../types';

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
    const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
    const stepIndexRef = useRef<number>(0);
    const onStepRef = useRef(onStep);
    onStepRef.current = onStep;

    const clearTimer = () => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    };

    const cancelSpeech = () => {
        if (utteranceRef.current) {
            utteranceRef.current.onend = null;
            utteranceRef.current.onerror = null;
            utteranceRef.current = null;
        }
        try {
            window.speechSynthesis.cancel();
        } catch {
            /* no-op */
        }
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

        if (autoSpeakRef.current && 'speechSynthesis' in window) {
            const u = new SpeechSynthesisUtterance(step.narration);
            u.rate = 1.02;
            u.pitch = 1;
            u.onend = () => {
                if (utteranceRef.current === u) utteranceRef.current = null;
                advance();
            };
            u.onerror = () => {
                if (utteranceRef.current === u) utteranceRef.current = null;
                advance();
            };
            utteranceRef.current = u;
            try {
                window.speechSynthesis.speak(u);
            } catch {
                utteranceRef.current = null;
            }
            timerRef.current = window.setTimeout(advance, estMs + 1200);
        } else {
            timerRef.current = window.setTimeout(advance, estMs);
        }
    }, []);

    const play = useCallback((narratorId: number, steps: NarratorStep[], options?: { autoSpeak?: boolean }) => {
        stepsRef.current = steps;
        autoSpeakRef.current = options?.autoSpeak !== false;
        statusRef.current = 'playing';
        setState({ narratorId, stepIndex: 0, status: 'playing' });
        // Defer the first step by one animation frame so React has flushed the
        // 'playing' state and the graph viewport is settled before focusNode is
        // called — without this the first step's zoom/highlight is swallowed.
        requestAnimationFrame(() => runStep(0));
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
