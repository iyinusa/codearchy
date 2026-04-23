import React from 'react';
import type { ViewMode } from '../types';
import { Icon } from './Icons';

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
                // disabled={!hasSystemArch && !isGeneratingArch}
                >
                    <Icon name="systemView" fixedWidth /> System
                </button>
                <button
                    className={`toolbar-btn ${viewMode === 'reactflow' ? 'active' : ''}`}
                    onClick={() => onViewModeChange('reactflow')}
                    title="React Flow View"
                >
                    <Icon name="flowView" fixedWidth /> Flow
                </button>
                <button
                    className={`toolbar-btn ${viewMode === 'cytoscape' ? 'active' : ''}`}
                    onClick={() => onViewModeChange('cytoscape')}
                    title="Cytoscape Dense View"
                >
                    <Icon name="denseView" fixedWidth /> Dense
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
                        <><Icon name="spinner" spin fixedWidth /> Analyzing...</>
                    ) : (
                        <><Icon name="aiAnalyze" fixedWidth /> AI Analyze</>
                    )}
                </button>
                <button
                    className="toolbar-btn"
                    onClick={onOpenModelSelector}
                    title="AI Model Settings"
                >
                    <Icon name="modelSettings" fixedWidth /> Model
                </button>
            </div>
            <div className="toolbar-group">
                <button
                    className={`toolbar-btn ${showMiniMap ? 'active' : ''}`}
                    onClick={onToggleMiniMap}
                    title={showMiniMap ? 'Hide Mini Map' : 'Show Mini Map'}
                >
                    <Icon name="miniMap" fixedWidth /> Map
                </button>
                <button className="toolbar-btn" onClick={onRefresh} title="Refresh">
                    <Icon name="refresh" />
                </button>
                <button className="toolbar-btn" onClick={onExportSVG} title="Export SVG">
                    <Icon name="exportSvg" fixedWidth /> SVG
                </button>
                <button className="toolbar-btn" onClick={onExportPNG} title="Export PNG">
                    <Icon name="exportPng" fixedWidth /> PNG
                </button>
            </div>
        </div>
    );
}
