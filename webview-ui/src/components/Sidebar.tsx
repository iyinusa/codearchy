import React, { useMemo, useState } from 'react';
import type { ArchitectureGraph, ProcessingMode } from '../types';
import type { NarratorRecord } from '../db';
import { deleteNarrator, updateNarratorTitle } from '../db';
import { Icon } from './Icons';

interface SidebarProps {
    graph: ArchitectureGraph | null;
    searchTerm: string;
    onSearchChange: (term: string) => void;
    highlightedSubsystem: string | null;
    onSubsystemHighlight: (id: string | null) => void;
    processingMode: ProcessingMode;
    onProcessingModeChange: (mode: ProcessingMode) => void;
    /* Narrator feature */
    narrators: NarratorRecord[];
    activeNarratorId: number | null;
    narratorStatus: 'idle' | 'playing' | 'paused';
    narratorStepIndex: number;
    onNarratorPlay: (narrator: NarratorRecord) => void;
    onNarratorPause: () => void;
    onNarratorResume: () => void;
    onNarratorStop: () => void;
    onNarratorNext: () => void;
    onNarratorPrev: () => void;
    onNarratorGoto: (index: number) => void;
    onNarratorsChanged: () => void;
}

const PROCESSING_MODES: Array<{ id: ProcessingMode; label: string; hint: string }> = [
    { id: 'fast', label: 'Fast', hint: 'Smallest prompt, lowest token budget — fastest responses.' },
    { id: 'moderate', label: 'Moderate', hint: 'Balanced prompt size and depth (default).' },
    { id: 'indepth', label: 'In-depth', hint: 'Largest prompt, full reasoning with thinking tokens — slowest, deepest analysis.' },
];

export function Sidebar({
    graph,
    searchTerm,
    onSearchChange,
    highlightedSubsystem,
    onSubsystemHighlight,
    processingMode,
    onProcessingModeChange,
    narrators,
    activeNarratorId,
    narratorStatus,
    narratorStepIndex,
    onNarratorPlay,
    onNarratorPause,
    onNarratorResume,
    onNarratorStop,
    onNarratorNext,
    onNarratorPrev,
    onNarratorGoto,
    onNarratorsChanged,
}: SidebarProps) {
    const [narratorSearch, setNarratorSearch] = useState('');
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editingTitle, setEditingTitle] = useState('');

    // Active narrator floats to the top; everything else stays in
    // updatedAt-desc order (which is how listNarrators already returns them).
    const filteredNarrators = useMemo(() => {
        const q = narratorSearch.trim().toLowerCase();
        const list = q
            ? narrators.filter(n =>
                n.title.toLowerCase().includes(q) ||
                n.question.toLowerCase().includes(q))
            : narrators;
        if (!activeNarratorId) return list;
        const idx = list.findIndex(n => n.id === activeNarratorId);
        if (idx <= 0) return list;
        const clone = list.slice();
        const [active] = clone.splice(idx, 1);
        clone.unshift(active);
        return clone;
    }, [narrators, narratorSearch, activeNarratorId]);

    const commitTitle = async (id: number) => {
        const trimmed = editingTitle.trim();
        setEditingId(null);
        if (!trimmed) return;
        try {
            await updateNarratorTitle(id, trimmed);
            onNarratorsChanged();
        } catch (e) {
            console.error('[CodeArchy] rename narrator failed', e);
        }
    };

    const handleDelete = async (rec: NarratorRecord) => {
        if (rec.id === undefined) return;
        // eslint-disable-next-line no-alert
        if (!window.confirm(`Delete narration "${rec.title}"?`)) return;
        try {
            if (activeNarratorId === rec.id) onNarratorStop();
            await deleteNarrator(rec.id);
            onNarratorsChanged();
        } catch (e) {
            console.error('[CodeArchy] delete narrator failed', e);
        }
    };
    return (
        <div className="sidebar">
            <div className="sidebar-header">
                {/* HEADER */}
                <h2>
                    {window.CODEARCY_ICON_URI && (
                        <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 28,
                            height: 28,
                            borderRadius: '50%',
                            background: '#fff',
                            marginRight: 8,
                            flexShrink: 0,
                            verticalAlign: 'middle',
                        }}>
                            <img
                                src={window.CODEARCY_ICON_URI}
                                alt="CodeArchy"
                                style={{ width: 20, height: 20, borderRadius: '50%', display: 'block' }}
                            />
                        </span>
                    )}
                    CodeArchy
                </h2>

                {/* SEARCH */}
                <input
                    type="text"
                    className="search-input"
                    placeholder="Filter modules..."
                    value={searchTerm}
                    onChange={(e) => onSearchChange(e.target.value)}
                />
            </div>

            {/* SUBSYSTEM LIST */}
            <div className="subsystem-list">
                {!graph || graph.subsystems.length === 0 ? (
                    <div className="empty-state">
                        {graph ? 'No subsystems detected' : 'Run analysis to begin'}
                    </div>
                ) : (
                    graph.subsystems.map((sub) => (
                        <div
                            key={sub.id}
                            className={`subsystem-item ${highlightedSubsystem === sub.id ? 'active' : ''}`}
                            onClick={() => {
                                onSubsystemHighlight(
                                    highlightedSubsystem === sub.id ? null : sub.id
                                );
                            }}
                        >
                            <div
                                className="subsystem-dot"
                                style={{ background: sub.color }}
                            />
                            <span className="subsystem-name">{sub.name}</span>
                            <span className="subsystem-count">{sub.nodeIds.length}</span>
                        </div>
                    ))
                )}
            </div>

            {/* NARRATIONS */}
            <div className="narrator-section">
                <div className="narrator-section-header">
                    <Icon name="narrator" />
                    <span>NARRATIONS</span>
                    <span className="narrator-section-count">{narrators.length}</span>
                </div>
                {narrators.length > 0 && (
                    <div className="narrator-search-wrap">
                        <Icon name="search" />
                        <input
                            type="text"
                            className="narrator-search"
                            placeholder="Search narrations..."
                            value={narratorSearch}
                            onChange={(e) => setNarratorSearch(e.target.value)}
                        />
                    </div>
                )}
                <div className="narrator-list">
                    {narrators.length === 0 ? (
                        <div className="narrator-empty">
                            Ask the AI a question — a visual narration of its answer will appear here.
                        </div>
                    ) : filteredNarrators.length === 0 ? (
                        <div className="narrator-empty">No matches.</div>
                    ) : (
                        filteredNarrators.map((rec) => {
                            const isActive = activeNarratorId === rec.id;
                            const isPlaying = isActive && narratorStatus === 'playing';
                            const isPaused = isActive && narratorStatus === 'paused';
                            const isEditing = editingId === rec.id;
                            return (
                                <div
                                    key={rec.id}
                                    className={`narrator-item ${isActive ? 'active' : ''} ${isPlaying ? 'playing' : ''}`}
                                >
                                    <div className="narrator-item-row">
                                        <button
                                            className="narrator-play-btn"
                                            title={isPlaying ? 'Pause narration' : isPaused ? 'Resume narration' : 'Play narration'}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                if (isPlaying) onNarratorPause();
                                                else if (isPaused) onNarratorResume();
                                                else onNarratorPlay(rec);
                                            }}
                                        >
                                            <Icon name={isPlaying ? 'pause' : 'play'} />
                                        </button>
                                        <div className="narrator-item-body">
                                            {isEditing ? (
                                                <input
                                                    autoFocus
                                                    className="narrator-title-input"
                                                    value={editingTitle}
                                                    onChange={(e) => setEditingTitle(e.target.value)}
                                                    onBlur={() => rec.id !== undefined && commitTitle(rec.id)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') {
                                                            e.preventDefault();
                                                            (e.target as HTMLInputElement).blur();
                                                        } else if (e.key === 'Escape') {
                                                            setEditingId(null);
                                                        }
                                                    }}
                                                />
                                            ) : (
                                                <div className="narrator-title" title={rec.question}>{rec.title}</div>
                                            )}
                                            <div className="narrator-meta">
                                                {rec.steps.length} step{rec.steps.length === 1 ? '' : 's'}
                                            </div>
                                        </div>
                                        <div className="narrator-actions">
                                            <button
                                                className="narrator-icon-btn"
                                                title="Rename"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (rec.id === undefined) return;
                                                    setEditingId(rec.id);
                                                    setEditingTitle(rec.title);
                                                }}
                                            >
                                                <Icon name="edit" />
                                            </button>
                                            <button
                                                className="narrator-icon-btn danger"
                                                title="Delete"
                                                onClick={(e) => { e.stopPropagation(); handleDelete(rec); }}
                                            >
                                                <Icon name="trash" />
                                            </button>
                                        </div>
                                    </div>
                                    {isActive && (
                                        <div className="narrator-timeline">
                                            <div className="narrator-transport">
                                                <button
                                                    className="narrator-icon-btn"
                                                    title="Previous step"
                                                    onClick={onNarratorPrev}
                                                    disabled={narratorStepIndex === 0}
                                                >
                                                    <Icon name="prevStep" />
                                                </button>
                                                <button
                                                    className="narrator-icon-btn"
                                                    title={isPlaying ? 'Pause' : 'Resume'}
                                                    onClick={isPlaying ? onNarratorPause : onNarratorResume}
                                                >
                                                    <Icon name={isPlaying ? 'pause' : 'play'} />
                                                </button>
                                                <button
                                                    className="narrator-icon-btn"
                                                    title="Next step"
                                                    onClick={onNarratorNext}
                                                    disabled={narratorStepIndex >= rec.steps.length - 1}
                                                >
                                                    <Icon name="nextStep" />
                                                </button>
                                                <button
                                                    className="narrator-icon-btn"
                                                    title="Stop narration"
                                                    onClick={onNarratorStop}
                                                >
                                                    <Icon name="close" />
                                                </button>
                                                <div className="narrator-progress">
                                                    <div
                                                        className="narrator-progress-fill"
                                                        style={{
                                                            width: `${Math.round(((narratorStepIndex + 1) / Math.max(1, rec.steps.length)) * 100)}%`,
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                            <div className="narrator-steps">
                                                {rec.steps.map((step, i) => (
                                                    <button
                                                        key={i}
                                                        className={`narrator-step ${i === narratorStepIndex ? 'active' : ''} ${i < narratorStepIndex ? 'past' : ''}`}
                                                        onClick={() => onNarratorGoto(i)}
                                                        title={step.narration}
                                                    >
                                                        <span className="narrator-step-index">{i + 1}</span>
                                                        <span className="narrator-step-text">{step.narration}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            {/* STATS */}
            {graph && (
                <div className="stats">
                    <div>{graph.metadata.fileCount} files analyzed</div>
                    <div>{graph.metadata.totalSymbols} symbols found</div>
                    <div>{graph.metadata.totalEdges} dependencies</div>
                    <div>{graph.metadata.languages.join(', ')}</div>
                </div>
            )}

            {/* AI PROCESSING */}
            <div className="ai-processing">
                <div className="ai-processing-label" title="Controls prompt size, token budget, and reasoning depth for the local AI.">
                    AI Processing
                </div>
                <div className="ai-processing-toggle" role="radiogroup" aria-label="AI Processing tier">
                    {PROCESSING_MODES.map((m) => (
                        <button
                            key={m.id}
                            type="button"
                            role="radio"
                            aria-checked={processingMode === m.id}
                            className={`ai-processing-btn ${processingMode === m.id ? 'active' : ''}`}
                            onClick={() => onProcessingModeChange(m.id)}
                            title={m.hint}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
