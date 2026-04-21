import React from 'react';
import type { ArchitectureGraph, GraphNode } from '../types';
import { Icon } from './Icons';

interface DetailPanelProps {
    node: GraphNode;
    graph: ArchitectureGraph;
    onClose: () => void;
    onNavigateToFile: (filePath: string, line?: number) => void;
}

export function DetailPanel({ node, graph, onClose, onNavigateToFile }: DetailPanelProps) {
    const subsystem = graph.subsystems.find(s => s.nodeIds.includes(node.id));
    const inEdges = graph.edges.filter(e => e.target === node.id);
    const outEdges = graph.edges.filter(e => e.source === node.id);

    return (
        <div className="detail-panel">
            <button className="detail-close" onClick={onClose} title="Close">
                <Icon name="close" />
            </button>
            <h3>{node.id}</h3>
            <div className="detail-row">
                <span className="detail-label">Group:</span>
                <span>{subsystem ? subsystem.name : 'None'}</span>
            </div>
            <div className="detail-row">
                <span className="detail-label">Language:</span>
                <span>{(node.metadata.language as string) || 'unknown'}</span>
            </div>
            <div className="detail-row">
                <span className="detail-label">Imports:</span>
                <span>{inEdges.length} incoming, {outEdges.length} outgoing</span>
            </div>
            <div className="detail-row">
                <span className="detail-label">File:</span>
                <span
                    className="detail-link"
                    onClick={() => onNavigateToFile(node.filePath)}
                >
                    {node.label}
                </span>
            </div>
            {node.symbols.length > 0 && (
                <>
                    <div className="detail-section-label">Symbols:</div>
                    <div className="detail-symbols">
                        {node.symbols.slice(0, 20).map((sym, i) => (
                            <span
                                key={i}
                                className="symbol-tag"
                                title={sym.kind}
                                onClick={() => onNavigateToFile(node.filePath, sym.startLine)}
                            >
                                {sym.name}
                            </span>
                        ))}
                        {node.symbols.length > 20 && (
                            <span className="symbol-tag">+{node.symbols.length - 20} more</span>
                        )}
                    </div>
                </>
            )}
            {(inEdges.length > 0 || outEdges.length > 0) && (
                <>
                    <div className="detail-section-label">Dependencies:</div>
                    <div className="detail-deps">
                        {outEdges.slice(0, 10).map((e) => (
                            <div key={e.id} className="dep-item">
                                <span className="dep-arrow">→</span>
                                <span className="dep-target">{e.target}</span>
                            </div>
                        ))}
                        {inEdges.slice(0, 10).map((e) => (
                            <div key={e.id} className="dep-item">
                                <span className="dep-arrow">←</span>
                                <span className="dep-target">{e.source}</span>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
