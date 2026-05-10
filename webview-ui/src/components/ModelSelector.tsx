import React, { useEffect, useState, useCallback } from 'react';
import { postMessage } from '../vscode';
import type { ModelStatusPayload, ModelOption } from '../types';
import { Icon } from './Icons';

interface ModelSelectorProps {
    onClose: () => void;
}

interface PullProgress {
    status: string;
    completed: number;
    total: number;
}

export function ModelSelector({ onClose }: ModelSelectorProps) {
    const [status, setStatus] = useState<ModelStatusPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [selecting, setSelecting] = useState<string | null>(null);
    // Pull state: ollamaTag currently being downloaded, or null
    const [pulling, setPulling] = useState<string | null>(null);
    const [pullProgress, setPullProgress] = useState<PullProgress | null>(null);
    // Delete confirm: ollamaTag awaiting user confirmation, or null
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    // Deletion in progress
    const [deleting, setDeleting] = useState<string | null>(null);

    const handleMessage = useCallback((event: MessageEvent) => {
        const msg = event.data;
        if (msg.type === 'modelStatus') {
            setStatus(msg.payload as ModelStatusPayload);
            setLoading(false);
            setSelecting(null);
        } else if (msg.type === 'pullModelProgress') {
            const p = msg.payload as { ollamaTag: string; status: string; completed: number; total: number };
            setPullProgress({ status: p.status, completed: p.completed, total: p.total });
        } else if (msg.type === 'pullModelComplete') {
            const p = msg.payload as { ollamaTag: string; success: boolean; cancelled?: boolean; error?: string };
            setPulling(null);
            setPullProgress(null);
            if (!p.success && !p.cancelled && p.error) {
                // Surface error to the user inside the modal
                setStatus(prev => prev ? { ...prev, _pullError: p.error } as ModelStatusPayload & { _pullError?: string } : prev);
            }
            // Status refresh is triggered by the host automatically.
        } else if (msg.type === 'deleteModelResult') {
            const p = msg.payload as { ollamaTag: string; success: boolean; error?: string };
            setDeleting(null);
            setConfirmDelete(null);
            if (!p.success && p.error) {
                setStatus(prev => prev ? { ...prev, _deleteError: p.error } as ModelStatusPayload & { _deleteError?: string } : prev);
            }
        }
    }, []);

    useEffect(() => {
        postMessage('requestModelStatus');
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [handleMessage]);

    const handleSelect = (model: ModelOption) => {
        if (!model.installed) return;
        setSelecting(model.id);
        postMessage('selectModel', { modelId: model.id });
    };

    const handleInstall = (e: React.MouseEvent, model: ModelOption) => {
        e.stopPropagation();
        setPulling(model.ollamaTag);
        setPullProgress({ status: 'Connecting…', completed: 0, total: 0 });
        postMessage('pullModel', { ollamaTag: model.ollamaTag });
    };

    const handleCancelPull = (e: React.MouseEvent) => {
        e.stopPropagation();
        postMessage('cancelPull', {});
    };

    const handleDeleteClick = (e: React.MouseEvent, model: ModelOption) => {
        e.stopPropagation();
        setConfirmDelete(model.ollamaTag);
    };

    const handleDeleteConfirm = (e: React.MouseEvent, ollamaTag: string) => {
        e.stopPropagation();
        setDeleting(ollamaTag);
        setConfirmDelete(null);
        postMessage('deleteModel', { ollamaTag });
    };

    const handleDeleteCancel = (e: React.MouseEvent) => {
        e.stopPropagation();
        setConfirmDelete(null);
    };

    const formatBytes = (bytes: number): string => {
        if (bytes === 0) return '';
        const gb = bytes / (1024 ** 3);
        if (gb >= 1) return `${gb.toFixed(2)} GB`;
        const mb = bytes / (1024 ** 2);
        return `${mb.toFixed(0)} MB`;
    };

    const pullPercent = pullProgress && pullProgress.total > 0
        ? Math.min(100, Math.round((pullProgress.completed / pullProgress.total) * 100))
        : null;

    const statusAny = status as (ModelStatusPayload & { _pullError?: string; _deleteError?: string }) | null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="model-selector" onClick={(e) => e.stopPropagation()}>
                <div className="model-selector-header">
                    <h2>AI Model Configuration</h2>
                    <button className="modal-close" onClick={onClose} title="Close">
                        <Icon name="close" />
                    </button>
                </div>

                {loading ? (
                    <div className="model-loading">
                        <div className="spinner" />
                        <span>Checking Ollama status...</span>
                    </div>
                ) : !status?.ollamaRunning ? (
                    <div className="model-notice">
                        <div className="notice-icon"><Icon name="warning" size="2x" /></div>
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
                            <Icon name="refresh" /> Retry Connection
                        </button>
                    </div>
                ) : (
                    <div className="model-list">
                        <p className="model-list-desc">
                            Select a model for AI-powered architecture analysis and conversation.
                        </p>

                        {statusAny?._pullError && (
                            <div className="model-error-banner">
                                <Icon name="warning" /> Download failed: {statusAny._pullError}
                            </div>
                        )}
                        {statusAny?._deleteError && (
                            <div className="model-error-banner">
                                <Icon name="warning" /> Delete failed: {statusAny._deleteError}
                            </div>
                        )}

                        {status.models.map((model) => {
                            const isPulling = pulling === model.ollamaTag;
                            const isDeleting = deleting === model.ollamaTag;
                            const isConfirming = confirmDelete === model.ollamaTag;
                            const anyPulling = pulling !== null;

                            return (
                                <div
                                    key={model.id}
                                    className={`model-card ${model.installed ? 'available' : 'unavailable'} ${status.selectedModel === model.id ? 'selected' : ''} ${selecting === model.id ? 'selecting' : ''} ${isPulling ? 'pulling' : ''} ${isDeleting ? 'deleting' : ''}`}
                                    onClick={() => !isPulling && !isDeleting && handleSelect(model)}
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
                                        <span className="spec-tag">{model.diskSize}</span>
                                        <span className={`spec-tag ${model.installed ? 'tag-installed' : 'tag-missing'}`}>
                                            {model.installed
                                                ? <><Icon name="installed" /> Installed</>
                                                : <><Icon name="notInstalled" /> Not installed</>}
                                        </span>
                                    </div>

                                    {/* ── Download in progress ── */}
                                    {isPulling && pullProgress && (
                                        <div className="model-pull-progress">
                                            <div className="pull-status-row">
                                                <span className="pull-status-text">
                                                    {pullProgress.status}
                                                    {pullProgress.total > 0 && (
                                                        <span className="pull-bytes">
                                                            {' '}— {formatBytes(pullProgress.completed)} / {formatBytes(pullProgress.total)}
                                                        </span>
                                                    )}
                                                </span>
                                                {pullPercent !== null && (
                                                    <span className="pull-percent">{pullPercent}%</span>
                                                )}
                                            </div>
                                            <div className="pull-bar-track">
                                                <div
                                                    className="pull-bar-fill"
                                                    style={{ width: pullPercent !== null ? `${pullPercent}%` : '100%', animationPlayState: pullPercent === null ? 'running' : 'paused' }}
                                                />
                                            </div>
                                            <button
                                                className="btn-cancel-pull"
                                                onClick={handleCancelPull}
                                                title="Cancel download"
                                            >
                                                <Icon name="close" /> Cancel download
                                            </button>
                                        </div>
                                    )}

                                    {/* ── Delete in progress ── */}
                                    {isDeleting && (
                                        <div className="model-pull-progress">
                                            <div className="pull-status-row">
                                                <span className="pull-status-text">Removing model…</span>
                                            </div>
                                            <div className="pull-bar-track">
                                                <div className="pull-bar-fill indeterminate" />
                                            </div>
                                        </div>
                                    )}

                                    {/* ── Delete confirmation ── */}
                                    {isConfirming && (
                                        <div className="model-delete-confirm" onClick={e => e.stopPropagation()}>
                                            <p className="confirm-text">
                                                <Icon name="warning" /> Remove <strong>{model.label}</strong> ({model.diskSize}) from your system? This cannot be undone.
                                            </p>
                                            <div className="confirm-actions">
                                                <button
                                                    className="btn-confirm-delete"
                                                    onClick={e => handleDeleteConfirm(e, model.ollamaTag)}
                                                >
                                                    Yes, remove
                                                </button>
                                                <button
                                                    className="btn-cancel-delete"
                                                    onClick={handleDeleteCancel}
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    {/* ── Action buttons ── */}
                                    {!isPulling && !isDeleting && !isConfirming && (
                                        <div className="model-actions">
                                            {!model.installed ? (
                                                <button
                                                    className="btn-install-model"
                                                    disabled={anyPulling}
                                                    onClick={e => handleInstall(e, model)}
                                                    title={anyPulling ? 'Another download is in progress' : `Download ${model.label}`}
                                                >
                                                    <Icon name="notInstalled" /> Install ({model.diskSize})
                                                </button>
                                            ) : (
                                                <button
                                                    className="btn-remove-model"
                                                    onClick={e => handleDeleteClick(e, model)}
                                                    title={`Remove ${model.label} from this system`}
                                                >
                                                    <Icon name="close" /> Remove model
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
