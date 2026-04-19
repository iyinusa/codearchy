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
}

export function Toolbar({
    viewMode,
    onViewModeChange,
    onRefresh,
    onExportSVG,
    onExportPNG,
    showMiniMap,
    onToggleMiniMap,
}: ToolbarProps) {
    return (
        <div className="toolbar">
            <div className="toolbar-group">
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
