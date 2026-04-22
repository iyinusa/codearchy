import React from 'react';
import type { ArchitectureGraph } from '../types';

interface SidebarProps {
    graph: ArchitectureGraph | null;
    searchTerm: string;
    onSearchChange: (term: string) => void;
    highlightedSubsystem: string | null;
    onSubsystemHighlight: (id: string | null) => void;
}

export function Sidebar({
    graph,
    searchTerm,
    onSearchChange,
    highlightedSubsystem,
    onSubsystemHighlight,
}: SidebarProps) {
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

            {/* STATS */}
            {graph && (
                <div className="stats">
                    <div>{graph.metadata.fileCount} files analyzed</div>
                    <div>{graph.metadata.totalSymbols} symbols found</div>
                    <div>{graph.metadata.totalEdges} dependencies</div>
                    <div>{graph.metadata.languages.join(', ')}</div>
                </div>
            )}
        </div>
    );
}
