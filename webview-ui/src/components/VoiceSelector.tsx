/**
 * VoiceSelector modal — mirrors the look & feel of `ModelSelector` but
 * lets the user pick a TTS engine + specific voice, with a "Test" button
 * for each option. Kokoro TTS is gated behind an explicit "Activate"
 * action; activation is what triggers the lazy import of the engine
 * chunk + the one-time download of the ~80 MB ONNX model weights.
 */

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
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
} from '../voice/ttsManager';

interface VoiceSelectorProps {
    onClose: () => void;
}

interface KokoroLoadState {
    status: 'idle' | 'loading' | 'ready' | 'error';
    phase?: string;
    percent?: number;
    error?: string;
}

export function VoiceSelector({ onClose }: VoiceSelectorProps) {
    const [config, setConfig] = useState<VoiceConfig>(() => getVoiceConfig());
    const [webVoices, setWebVoices] = useState<SpeechSynthesisVoice[]>([]);
    const [kokoroState, setKokoroState] = useState<KokoroLoadState>({
        status: config.kokoroActivated ? 'idle' : 'idle',
    });
    const [testingVoiceId, setTestingVoiceId] = useState<string | null>(null);
    const [activeEngine, setActiveEngine] = useState<VoiceEngineId>(config.engine);

    useEffect(() => subscribeVoiceConfig(setConfig), []);
    useEffect(() => subscribeWebSpeechVoices(setWebVoices), []);
    useEffect(() => {
        return subscribeSpeaking((sp) => {
            if (!sp) setTestingVoiceId(null);
        });
    }, []);

    // Stop any test speech when the modal closes.
    useEffect(() => {
        return () => stopSpeaking();
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

    const handleSelectEngine = (engine: VoiceEngineId) => {
        setActiveEngine(engine);
    };

    const handleSelectVoice = (option: VoiceOption) => {
        if (option.engine === 'kokoro' && !config.kokoroActivated) return;
        setVoiceConfig({ engine: option.engine, voiceId: option.id });
    };

    const previewText = 'Hello! This is how the selected voice sounds when reading the architecture explanation.';

    const handleTest = useCallback(async (option: VoiceOption) => {
        if (testingVoiceId === option.id) {
            stopSpeaking();
            setTestingVoiceId(null);
            return;
        }
        if (option.engine === 'kokoro' && !config.kokoroActivated) return;

        setTestingVoiceId(option.id);
        // Temporarily swap the active config for the preview so `speak()`
        // routes through the right engine + voice without the user having
        // to commit their choice first.
        const prev = getVoiceConfig();
        setVoiceConfig({ engine: option.engine, voiceId: option.id });
        try {
            await speak(previewText, {
                onEnd: () => setTestingVoiceId(null),
                onError: () => setTestingVoiceId(null),
            });
        } finally {
            // Restore the user's persisted choice if they hadn't already
            // selected this voice.
            if (prev.voiceId !== option.id || prev.engine !== option.engine) {
                setVoiceConfig({ engine: prev.engine, voiceId: prev.voiceId });
            }
        }
    }, [testingVoiceId, config.kokoroActivated]);

    const handleActivateKokoro = useCallback(async () => {
        if (kokoroState.status === 'loading') return;
        setKokoroState({ status: 'loading', phase: 'Preparing…' });
        try {
            const mod = await import('../voice/kokoroEngine');
            await mod.loadKokoro((info) => {
                setKokoroState({
                    status: 'loading',
                    phase: info.phase,
                    percent: info.percent,
                });
            });
            setKokoroState({ status: 'ready', percent: 100, phase: 'Ready' });
            setVoiceConfig({
                engine: 'kokoro',
                voiceId: getVoiceConfig().voiceId && KOKORO_VOICES.some((v) => v.id === getVoiceConfig().voiceId)
                    ? getVoiceConfig().voiceId
                    : DEFAULT_KOKORO_VOICE,
                kokoroActivated: true,
            });
            setActiveEngine('kokoro');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setKokoroState({ status: 'error', error: msg });
        }
    }, [kokoroState.status]);

    // Lazily ensure the engine is "ready" if the user previously activated
    // Kokoro and is reopening the modal. We never force a download here —
    // the chunk will be cached by the SW/runtime if it loaded before.
    const reactivateBtnRef = useRef<HTMLButtonElement>(null);

    const renderVoiceList = (engine: VoiceEngineId) => {
        const list: VoiceOption[] = engine === 'kokoro' ? KOKORO_VOICES : webVoiceOptions;
        const disabled = engine === 'kokoro' && !config.kokoroActivated;

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
                            <span>{config.kokoroActivated ? 'Activated · Neural · Offline' : 'Neural · Offline · Requires activation'}</span>
                        </div>
                    </button>
                </div>

                {activeEngine === 'web-speech' ? (
                    <div className="voice-section">
                        <p className="voice-section-desc">
                            Uses your operating system's built-in speech engine. Fast, free,
                            and works fully offline once installed.
                        </p>
                        {renderVoiceList('web-speech')}
                    </div>
                ) : (
                    <div className="voice-section">
                        {!config.kokoroActivated ? (
                            <div className="kokoro-activate-card">
                                <div className="kokoro-activate-header">
                                    <Icon name="aiMagic" size="2x" />
                                    <div>
                                        <h3>Activate Kokoro TTS</h3>
                                        <p>
                                            Kokoro-82M is a high-quality neural text-to-speech model.
                                            Activating it downloads the model weights (~80&nbsp;MB) once,
                                            then runs fully offline.
                                        </p>
                                    </div>
                                </div>
                                <ul className="kokoro-bullets">
                                    <li>12 curated voices · American & British accents</li>
                                    <li>Streaming WASM inference · No cloud calls after install</li>
                                    <li>Chunk loaded on demand — zero impact until activated</li>
                                </ul>
                                {kokoroState.status === 'error' && (
                                    <div className="kokoro-error">
                                        <Icon name="warning" /> {kokoroState.error}
                                    </div>
                                )}
                                {kokoroState.status === 'loading' ? (
                                    <div className="kokoro-progress">
                                        <div className="kokoro-progress-bar">
                                            <div
                                                className="kokoro-progress-fill"
                                                style={{ width: `${kokoroState.percent ?? 5}%` }}
                                            />
                                        </div>
                                        <div className="kokoro-progress-text">
                                            <Icon name="spinner" spin /> {kokoroState.phase ?? 'Loading…'}
                                            {typeof kokoroState.percent === 'number' && ` · ${kokoroState.percent}%`}
                                        </div>
                                    </div>
                                ) : (
                                    <button
                                        ref={reactivateBtnRef}
                                        className="btn-retry kokoro-activate-btn"
                                        onClick={handleActivateKokoro}
                                    >
                                        <Icon name="aiMagic" /> Install &amp; Activate Kokoro TTS
                                    </button>
                                )}
                            </div>
                        ) : (
                            <>
                                <p className="voice-section-desc">
                                    Kokoro TTS is active. Pick a voice and tap <strong>Test</strong> to preview.
                                </p>
                                {kokoroState.status === 'loading' && (
                                    <div className="kokoro-progress">
                                        <div className="kokoro-progress-bar">
                                            <div
                                                className="kokoro-progress-fill"
                                                style={{ width: `${kokoroState.percent ?? 5}%` }}
                                            />
                                        </div>
                                        <div className="kokoro-progress-text">
                                            <Icon name="spinner" spin /> {kokoroState.phase ?? 'Loading…'}
                                        </div>
                                    </div>
                                )}
                                {renderVoiceList('kokoro')}
                            </>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
