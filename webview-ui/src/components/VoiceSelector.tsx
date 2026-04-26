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
    startKokoroEngine,
} from '../voice/ttsManager';

interface VoiceSelectorProps {
    onClose: () => void;
}

interface KokoroLoadState {
    status: 'idle' | 'loading' | 'ready' | 'error';
    error?: string;
}

export function VoiceSelector({ onClose }: VoiceSelectorProps) {
    const [config, setConfig] = useState<VoiceConfig>(() => getVoiceConfig());
    const [webVoices, setWebVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [kokoroState, setKokoroState] = useState<KokoroLoadState>({ status: 'idle' });
    const [testingVoiceId, setTestingVoiceId] = useState<string | null>(null);
    const [activeEngine, setActiveEngine] = useState<VoiceEngineId>(config.engine);

    useEffect(() => subscribeVoiceConfig(setConfig), []);
    useEffect(() => subscribeWebSpeechVoices(setWebVoices), []);
    useEffect(() => subscribeSpeaking((sp) => { if (!sp) setTestingVoiceId(null); }), []);
    useEffect(() => subscribeKokoroStatus(({ status, error }) =>
        setKokoroState({ status, error: error ?? undefined }),
    ), []);

    // Ensure the engine is warming when the user opens this modal — a no-op
    // if App.tsx already kicked it off on mount.
    useEffect(() => {
        void startKokoroEngine().catch(() => { /* surfaced via subscribeKokoroStatus */ });
    }, []);

    // Stop any test speech when the modal closes.
    useEffect(() => () => stopSpeaking(), []);

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

    const previewText = "Hello, I'm your voice explainer, ready to narrate your system architecture.";

    const handleTest = useCallback(async (option: VoiceOption) => {
        if (testingVoiceId === option.id) {
            stopSpeaking();
            setTestingVoiceId(null);
            return;
        }
        if (option.engine === 'kokoro' && kokoroState.status !== 'ready') return;

        setTestingVoiceId(option.id);
        const prev = getVoiceConfig();
        setVoiceConfig({ engine: option.engine, voiceId: option.id });
        try {
            await speak(previewText, {
                onEnd: () => setTestingVoiceId(null),
                onError: () => setTestingVoiceId(null),
            });
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
        const disabled = engine === 'kokoro' && kokoroState.status !== 'ready';

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
                    return (
                        <div
                            key={`${engine}-${option.id}`}
                            className={`voice-card ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}`}
                            onClick={() => !disabled && handleSelectVoice(option)}
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
                                onClick={(e) => { e.stopPropagation(); handleTest(option); }}
                                disabled={disabled}
                                title={testing ? 'Stop preview' : 'Preview voice'}
                            >
                                <Icon name={testing ? 'stopAction' : 'speakAloud'} />
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
                                        ? 'Initialising voice engine…'
                                        : kokoroState.status === 'error'
                                            ? 'Engine error — see details'
                                            : 'Neural · Offline · Pre-bundled'}
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
                            Kokoro-82M is pre-bundled with the extension. Pick a voice and tap
                            <strong> Test</strong> to preview.
                        </p>
                        {kokoroState.status === 'loading' && (
                            <div className="kokoro-progress">
                                <div className="kokoro-progress-text">
                                    <Icon name="spinner" spin /> Loading neural voice engine…
                                </div>
                                <p className="kokoro-loading-hint">
                                    Test buttons activate once the model is ready.
                                </p>
                            </div>
                        )}
                        {kokoroState.status === 'error' && (
                            <div className="kokoro-error">
                                <Icon name="warning" /> {kokoroState.error}
                            </div>
                        )}
                        {renderVoiceList('kokoro')}
                    </div>
                )}
            </div>
        </div>
    );
}
