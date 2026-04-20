import React from 'react';
import type { ViewMode } from '../types';

interface ToolbarProps {
    viewMode: ViewMode;
    onViewModeChange: (mode: ViewMode) => void;
    onRefresh: () => void;
    onExportSVG: () => void;
    onExportPNG: () => void;
    showMiniMap: boolean;
    onToggleMiniMap: () => void;
    onOpenModelSelector: () => void;
    hasSystemArch: boolean;
    isGeneratingArch: boolean;
    onGenerateSystemArch: () => void;
}

export function Toolbar({
    viewMode,
    onViewModeChange,
    onRefresh,
    onExportSVG,
    onExportPNG,
    showMiniMap,
    onToggleMiniMap,
    onOpenModelSelector,
    hasSystemArch,
    isGeneratingArch,
    onGenerateSystemArch,
}: ToolbarProps) {
    return (
        <div className="toolbar">
            <div className="toolbar-group">
                <button
                    className={`toolbar-btn ${viewMode === 'system' ? 'active' : ''}`}
                    onClick={() => onViewModeChange('system')}
                    title="AI System Architecture View"
                    disabled={!hasSystemArch && !isGeneratingArch}
                >
                    🏗 System
                </button>
                <button
                    className={`toolbar-btn ${viewMode === 'reactflow' ? 'active' : ''}`}
                    onClick={() => onViewModeChange('reactflow')}
                    title="React Flow View"
                >
                    ⊞ Flow
                </button>
                <button
                    className={`toolbar-btn ${viewMode === 'cytoscape' ? 'active' : ''}`}
                    onClick={() => onViewModeChange('cytoscape')}
                    title="Cytoscape Dense View"
                >
                    ◉ Dense
                </button>
            </div>
            <div className="toolbar-group">
                <button
                    className={`toolbar-btn toolbar-ai-btn ${isGeneratingArch ? 'generating' : ''}`}
                    onClick={onGenerateSystemArch}
                    disabled={isGeneratingArch}
                    title={isGeneratingArch ? 'Generating architecture...' : 'Generate AI System Architecture'}
                >
                    {isGeneratingArch ? (
                        <><span className="btn-spinner" /> Analyzing...</>
                    ) : (
                        '✦ AI Analyze'
                    )}
                </button>
                <button
                    className="toolbar-btn"
                    onClick={onOpenModelSelector}
                    title="AI Model Settings"
                >
                    ⚙ Model
                </button>
            </div>
            <div className="toolbar-group">
                <button
                    className={`toolbar-btn ${showMiniMap ? 'active' : ''}`}
                    onClick={onToggleMiniMap}
                    title={showMiniMap ? 'Hide Mini Map' : 'Show Mini Map'}
                >
                    ⧉ Map
                </button>
            </div>
            <div className="toolbar-group">
                <button className="toolbar-btn" onClick={onRefresh} title="Refresh">
                    ↻
                </button>
                <button className="toolbar-btn" onClick={onExportSVG} title="Export SVG">
                    SVG
                </button>
                <button className="toolbar-btn" onClick={onExportPNG} title="Export PNG">
                    PNG
                </button>
            </div>
        </div>
    );
}
