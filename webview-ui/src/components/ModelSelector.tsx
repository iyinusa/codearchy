import React, { useEffect, useState } from 'react';
import { postMessage } from '../vscode';
import type { ModelStatusPayload, ModelOption } from '../types';

interface ModelSelectorProps {
    onClose: () => void;
}

export function ModelSelector({ onClose }: ModelSelectorProps) {
    const [status, setStatus] = useState<ModelStatusPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [selecting, setSelecting] = useState<string | null>(null);

    useEffect(() => {
        postMessage('requestModelStatus');

        const handler = (event: MessageEvent) => {
            const msg = event.data;
            if (msg.type === 'modelStatus') {
                setStatus(msg.payload as ModelStatusPayload);
                setLoading(false);
                setSelecting(null);
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, []);

    const handleSelect = (model: ModelOption) => {
        if (!model.installed) return;
        setSelecting(model.id);
        postMessage('selectModel', { modelId: model.id });
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="model-selector" onClick={(e) => e.stopPropagation()}>
                <div className="model-selector-header">
                    <h2>AI Model Configuration</h2>
                    <button className="modal-close" onClick={onClose}>✕</button>
                </div>

                {loading ? (
                    <div className="model-loading">
                        <div className="spinner" />
                        <span>Checking Ollama status...</span>
                    </div>
                ) : !status?.ollamaRunning ? (
                    <div className="model-notice">
                        <div className="notice-icon">⚠</div>
                        <h3>Ollama Not Detected</h3>
                        <p>CodeArchy requires <strong>Ollama</strong> running locally for AI-powered architecture analysis.</p>
                        <div className="install-steps">
                            <div className="step">
                                <span className="step-num">1</span>
                                <div>
                                    <strong>Install Ollama</strong>
                                    <p>Visit <code>https://ollama.com</code> and download for your platform.</p>
                                </div>
                            </div>
                            <div className="step">
                                <span className="step-num">2</span>
                                <div>
                                    <strong>Start Ollama</strong>
                                    <p>Run <code>ollama serve</code> in your terminal.</p>
                                </div>
                            </div>
                            <div className="step">
                                <span className="step-num">3</span>
                                <div>
                                    <strong>Pull a Gemma model</strong>
                                    <p>Run <code>ollama pull gemma4:e2b</code> or <code>ollama pull gemma4:e4b</code></p>
                                </div>
                            </div>
                        </div>
                        <button className="btn-retry" onClick={() => {
                            setLoading(true);
                            postMessage('requestModelStatus');
                        }}>
                            ↻ Retry Connection
                        </button>
                    </div>
                ) : (
                    <div className="model-list">
                        <p className="model-list-desc">
                            Select a model for AI-powered architecture analysis and conversation.
                        </p>
                        {status.models.map((model) => (
                            <div
                                key={model.id}
                                className={`model-card ${model.installed ? 'available' : 'unavailable'} ${status.selectedModel === model.id ? 'selected' : ''} ${selecting === model.id ? 'selecting' : ''}`}
                                onClick={() => handleSelect(model)}
                            >
                                <div className="model-card-header">
                                    <div className="model-card-title">
                                        <h3>{model.label}</h3>
                                        {status.selectedModel === model.id && (
                                            <span className="model-active-badge">Active</span>
                                        )}
                                    </div>
                                    <div className={`model-status-dot ${model.installed ? 'installed' : 'not-installed'}`} />
                                </div>
                                <p className="model-desc">{model.description}</p>
                                <div className="model-specs">
                                    <span className="spec-tag">{model.paramSize}</span>
                                    <span className="spec-tag">{model.ramRequired}</span>
                                    <span className="spec-tag">{model.diskSize} </span>
                                    <span className={`spec-tag ${model.installed ? 'tag-installed' : 'tag-missing'}`}>
                                        {model.installed ? '✓ Installed' : '✗ Not installed'}
                                    </span>
                                </div>
                                {!model.installed && (
                                    <div className="model-install-hint">
                                        Run: <code>ollama pull {model.ollamaTag}</code>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
