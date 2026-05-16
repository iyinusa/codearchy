/**
 * VoiceSelector modal — pick a TTS engine + specific voice with a "Test"
 * preview button for each option. Kokoro TTS is pre-bundled with the
 * extension and warmed up on app mount, so no install/activate flow is
 * needed; voices simply become testable once the engine reports ready.
 */

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Icon } from './Icons';
import {
    getVoiceConfig,
    setVoiceConfig,
    subscribeVoiceConfig,
    type VoiceConfig,
    type VoiceEngineId,
    type VoiceOption,
} from '../voice/voiceConfig';
import { KOKORO_VOICES, DEFAULT_KOKORO_VOICE } from '../voice/kokoroVoices';
import {
    speak,
    stopSpeaking,
    subscribeWebSpeechVoices,
    subscribeSpeaking,
    subscribeKokoroStatus,
    subscribeVoiceWarmed,
    getWarmedKokoroVoices,
    startKokoroEngine,
    isKokoroEverActivated,
} from '../voice/ttsManager';

interface VoiceSelectorProps {
    onClose: () => void;
}

interface KokoroLoadState {
    status: 'idle' | 'loading' | 'ready' | 'error';
    error?: string;
    progress: number;
    stage: string | null;
    file: string | null;
}

export function VoiceSelector({ onClose }: VoiceSelectorProps) {
    const [config, setConfig] = useState<VoiceConfig>(() => getVoiceConfig());
    const [webVoices, setWebVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [kokoroState, setKokoroState] = useState<KokoroLoadState>({
        status: 'idle', progress: 0, stage: null, file: null,
    });
    const [testingVoiceId, setTestingVoiceId] = useState<string | null>(null);
    const [activeEngine, setActiveEngine] = useState<VoiceEngineId>(config.engine);
    // Tracks which Kokoro voices are warmed in the worker.  Starts with the
    // current snapshot so voices already warmed before the modal opened show
    // immediately as ready; new voices are added one by one as 'warmed' events
    // arrive from the background warm loop.
    const [kokoroWarmed, setKokoroWarmed] = useState<Set<string>>(
        () => new Set(getWarmedKokoroVoices()),
    );


    useEffect(() => subscribeVoiceConfig(setConfig), []);
    useEffect(() => subscribeWebSpeechVoices(setWebVoices), []);
    useEffect(() => subscribeSpeaking((sp) => { if (!sp) setTestingVoiceId(null); }), []);
    useEffect(() => subscribeKokoroStatus((s) =>
        setKokoroState({
            status: s.status,
            error: s.error ?? undefined,
            progress: s.progress,
            stage: s.stage,
            file: s.file,
        }),
    ), []);
    // Add each newly-warmed voice to the set so voice cards enable in real time.
    useEffect(() => subscribeVoiceWarmed((voice) => {
        setKokoroWarmed(prev => {
            if (prev.has(voice)) return prev; // no change — skip re-render
            const next = new Set(prev);
            next.add(voice);
            return next;
        });
    }), []);

    // Stop any test speech when the modal closes.
    useEffect(() => () => stopSpeaking(), []);

    const handleActivateKokoro = useCallback(() => {
        // User-initiated; surfaced errors come back through subscribeKokoroStatus.
        void startKokoroEngine().catch(() => undefined);
    }, []);

    const webVoiceOptions: VoiceOption[] = useMemo(
        () =>
            webVoices
                .filter((v) => v.lang?.toLowerCase().startsWith('en'))
                .concat(webVoices.filter((v) => !v.lang?.toLowerCase().startsWith('en')))
                .map((v) => ({
                    id: v.voiceURI,
                    label: v.name,
                    lang: v.lang,
                    description: v.localService ? 'Local · System voice' : 'Network voice',
                    engine: 'web-speech' as const,
                })),
        [webVoices],
    );

    const handleSelectEngine = (engine: VoiceEngineId) => setActiveEngine(engine);

    const handleSelectVoice = (option: VoiceOption) => {
        if (option.engine === 'kokoro' && kokoroState.status !== 'ready') return;
        setVoiceConfig({ engine: option.engine, voiceId: option.id });
    };

    const previewText = "Hello, I'm your voice explainer, ready to narrate your code architecture.";

    const handleTest = useCallback(async (option: VoiceOption) => {
        if (testingVoiceId === option.id) {
            stopSpeaking();
            setTestingVoiceId(null);
            return;
        }
        if (option.engine === 'kokoro' && kokoroState.status !== 'ready') return;

        setTestingVoiceId(option.id);
        const prev = getVoiceConfig();
        // Set voice config so speak() picks up the correct voice + engine.
        setVoiceConfig({ engine: option.engine, voiceId: option.id });
        try {
            // Use speak() for both engines. For Kokoro, speak() calls kokoroSpeak()
            // synchronously — BEFORE any await — which calls ctx.resume() while
            // still inside the button-click user-gesture stack. This is the only
            // reliable way to unlock Electron’s AudioContext autoplay policy:
            // calling resume() after an await (as the generate path did) causes
            // Electron to ignore it silently, yielding synthesis with no audio.
            await speak(previewText, {
                onEnd: () => setTestingVoiceId(null),
                onError: () => setTestingVoiceId(null),
            });
        } catch {
            setTestingVoiceId(null);
        } finally {
            if (prev.voiceId !== option.id || prev.engine !== option.engine) {
                setVoiceConfig({ engine: prev.engine, voiceId: prev.voiceId });
            }
        }
    }, [testingVoiceId, kokoroState.status]);

    // Auto-default the Kokoro voice once the engine becomes ready and the
    // user is on the Kokoro tab without a Kokoro voice selected.
    useEffect(() => {
        if (kokoroState.status !== 'ready') return;
        const cfg = getVoiceConfig();
        const isKokoroVoice = cfg.engine === 'kokoro' && KOKORO_VOICES.some((v) => v.id === cfg.voiceId);
        if (activeEngine === 'kokoro' && !isKokoroVoice) {
            setVoiceConfig({ engine: 'kokoro', voiceId: DEFAULT_KOKORO_VOICE });
        }
    }, [kokoroState.status, activeEngine]);

    const renderVoiceList = (engine: VoiceEngineId) => {
        const list: VoiceOption[] = engine === 'kokoro' ? KOKORO_VOICES : webVoiceOptions;
        // Engine not yet ready (loading / idle / error) — all cards disabled.
        // Exception: when the user has previously activated Kokoro, the engine is
        // loading silently in the background; keep cards enabled so the user can
        // select a voice immediately and test it the moment loading finishes.
        const engineNotReady = engine === 'kokoro'
            && kokoroState.status !== 'ready'
            && !(kokoroState.status === 'loading' && isKokoroEverActivated());

        if (list.length === 0) {
            return (
                <div className="voice-empty">
                    <Icon name="warning" />
                    <span>No voices detected for this engine.</span>
                </div>
            );
        }

        return (
            <div className="voice-list">
                {list.map((option) => {
                    const selected = config.engine === engine && config.voiceId === option.id;
                    const testing = testingVoiceId === option.id;
                    // A voice is "warming" when the engine is ready but the worker
                    // hasn't yet finished the background warm inference for it.
                    // We gate the Test button to avoid cold-inference slowness while
                    // keeping the card itself fully visible and selectable.
                    const warming = engine === 'kokoro'
                        && kokoroState.status === 'ready'
                        && !kokoroWarmed.has(option.id);
                    // Disabled when engine not ready OR this specific voice is still warming.
                    const isDisabled = engineNotReady || warming;
                    return (
                        <div
                            key={`${engine}-${option.id}`}
                            className={[
                                'voice-card',
                                selected ? 'selected' : '',
                                isDisabled && !warming ? 'disabled' : '',
                            ].filter(Boolean).join(' ')}
                            onClick={() => !isDisabled && handleSelectVoice(option)}
                        >
                            <div className="voice-card-main">
                                <div className="voice-card-title">
                                    <span className="voice-card-name">{option.label}</span>
                                    {selected && <span className="voice-active-badge">Active</span>}
                                </div>
                                {(option.lang || option.description) && (
                                    <div className="voice-card-meta">
                                        {option.lang && <span className="voice-tag">{option.lang}</span>}
                                        {option.description && <span className="voice-desc">{option.description}</span>}
                                    </div>
                                )}
                            </div>
                            <button
                                className={`voice-test-btn ${testing ? 'testing' : ''}`}
                                onClick={(e) => { e.stopPropagation(); if (!isDisabled) handleTest(option); }}
                                disabled={isDisabled}
                                title={warming ? 'Preparing voice…' : (testing ? 'Stop preview' : 'Preview voice')}
                            >
                                <Icon
                                    name={warming ? 'spinner' : (testing ? 'stopAction' : 'speakAloud')}
                                    spin={warming}
                                />
                                <span>{testing ? 'Stop' : 'Test'}</span>
                            </button>
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="model-selector voice-selector" onClick={(e) => e.stopPropagation()}>
                <div className="model-selector-header">
                    <h2>Voice Configuration</h2>
                    <button className="modal-close" onClick={onClose} title="Close">
                        <Icon name="close" />
                    </button>
                </div>

                <div className="voice-engine-tabs">
                    <button
                        className={`voice-engine-tab ${activeEngine === 'web-speech' ? 'active' : ''}`}
                        onClick={() => handleSelectEngine('web-speech')}
                    >
                        <Icon name="speakAloud" fixedWidth />
                        <div className="voice-engine-tab-text">
                            <strong>System Speech</strong>
                            <span>Built-in · Always available</span>
                        </div>
                    </button>
                    <button
                        className={`voice-engine-tab ${activeEngine === 'kokoro' ? 'active' : ''}`}
                        onClick={() => handleSelectEngine('kokoro')}
                    >
                        <Icon name="aiMagic" fixedWidth />
                        <div className="voice-engine-tab-text">
                            <strong>Kokoro TTS</strong>
                            <span>
                                {kokoroState.status === 'ready'
                                    ? 'Neural · Offline · Pre-bundled'
                                    : kokoroState.status === 'loading'
                                        ? isKokoroEverActivated()
                                            ? `Loading in background… ${kokoroState.progress}%`
                                            : `Activating… ${kokoroState.progress}%`
                                        : kokoroState.status === 'error'
                                            ? 'Engine error — see details'
                                            : 'Neural · Offline · Tap Activate'}
                            </span>
                        </div>
                    </button>
                </div>

                {activeEngine === 'web-speech' ? (
                    <div className="voice-section">
                        <p className="voice-section-desc">
                            Uses your operating system's built-in speech engine. Fast, free,
                            and works fully offline.
                        </p>
                        {renderVoiceList('web-speech')}
                    </div>
                ) : (
                    <div className="voice-section">
                        <p className="voice-section-desc">
                            Kokoro-82M is pre-bundled and loads automatically
                            in the background. The first load reads the local model files
                            (~82 MB ONNX) into memory — subsequent activations are near-instant. All processing happens on your machine, fully offline.
                            <p className="voice-section-disclaimer">Speaking process is slow at the moment (takes about 10-25 seconds to process). Still in BETA stage.</p>
                        </p>

                        {kokoroState.status === 'idle' && !isKokoroEverActivated() && (
                            <div className="kokoro-activate-card">
                                <div className="kokoro-activate-header">
                                    <Icon name="aiMagic" />
                                    <div>
                                        <h3>Neural voice engine starting…</h3>
                                        <p>
                                            Kokoro loads automatically. Click below if it
                                            hasn't started yet — or if a previous attempt failed.
                                        </p>
                                    </div>
                                </div>
                                <ul className="kokoro-bullets">
                                    <li>Loads pre-bundled model files (or downloads on first run)</li>
                                    <li>Warms the inference graph for instant speech</li>
                                    <li>Runs entirely offline after first activation</li>
                                </ul>
                                <button
                                    className="kokoro-activate-btn"
                                    onClick={handleActivateKokoro}
                                >
                                    <Icon name="play" /> Start Kokoro
                                </button>
                            </div>
                        )}

                        {kokoroState.status === 'loading' && !isKokoroEverActivated() && (
                            <div className="kokoro-progress" aria-live="polite">
                                <div className="kokoro-progress-bar" role="progressbar"
                                    aria-valuenow={kokoroState.progress}
                                    aria-valuemin={0} aria-valuemax={100}>
                                    <div
                                        className="kokoro-progress-fill"
                                        style={{ width: `${kokoroState.progress}%` }}
                                    />
                                </div>
                                <div className="kokoro-progress-text">
                                    <Icon name="spinner" spin />
                                    <span>
                                        {kokoroState.stage ?? 'Activating'}… {kokoroState.progress}%
                                    </span>
                                </div>
                                {kokoroState.file && (
                                    <div className="kokoro-progress-file" title={kokoroState.file}>
                                        {kokoroState.file}
                                    </div>
                                )}
                            </div>
                        )}

                        {kokoroState.status === 'loading' && isKokoroEverActivated() && (
                            <div className="kokoro-loading-bg" aria-live="polite">
                                <Icon name="spinner" spin />
                                <span>Voice engine loading in background ({kokoroState.progress}%)…</span>
                            </div>
                        )}

                        {kokoroState.status === 'error' && (
                            <div className="kokoro-error-block">
                                <div className="kokoro-error">
                                    <Icon name="warning" /> {kokoroState.error}
                                </div>
                                <button
                                    className="kokoro-retry-btn"
                                    onClick={handleActivateKokoro}
                                >
                                    <Icon name="refresh" /> Retry activation
                                </button>
                            </div>
                        )}

                        {renderVoiceList('kokoro')}
                    </div>
                )}
            </div>
        </div>
    );
}
