import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ArchitectureGraph, ViewMode, SystemArchitecture } from './types';
import { postMessage } from './vscode';
import { ReactFlowView } from './components/ReactFlowView';
import { CytoscapeView } from './components/CytoscapeView';
import type { CytoscapeViewHandle } from './components/CytoscapeView';
import { SystemView } from './components/SystemView';
import { Sidebar } from './components/Sidebar';
import { DetailPanel } from './components/DetailPanel';
import { Toolbar } from './components/Toolbar';
import { ModelSelector } from './components/ModelSelector';
import { ChatPanel } from './components/ChatPanel';
import { Icon } from './components/Icons';

export function App() {
    const [graph, setGraph] = useState<ArchitectureGraph | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>('reactflow');
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [highlightedSubsystem, setHighlightedSubsystem] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [showMiniMap, setShowMiniMap] = useState(true);
    const [showModelSelector, setShowModelSelector] = useState(false);
    const [systemArch, setSystemArch] = useState<SystemArchitecture | null>(null);
    const [isGeneratingArch, setIsGeneratingArch] = useState(false);
    const [archProgress, setArchProgress] = useState<string>('');
    const [chatOpen, setChatOpen] = useState(false);
    const mainContentRef = useRef<HTMLDivElement>(null);
    const cytoscapeRef = useRef<CytoscapeViewHandle>(null);

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const message = event.data;
            switch (message.type) {
                case 'graphData':
                    setGraph(message.payload as ArchitectureGraph);
                    break;
                case 'exportSVG':
                    exportAsSVG();
                    break;
                case 'exportPNG':
                    exportAsPNG();
                    break;
                case 'systemArchData': {
                    const arch = message.payload as SystemArchitecture;
                    setSystemArch(arch);
                    setIsGeneratingArch(false);
                    setArchProgress('');
                    setViewMode('system');
                    break;
                }
                case 'systemArchProgress': {
                    const prog = message.payload as { message: string };
                    setArchProgress(prog.message);
                    break;
                }
                case 'error': {
                    const err = message.payload as { message: string };
                    setIsGeneratingArch(false);
                    setArchProgress('');
                    // Error shown via chat or inline
                    console.error('CodeArchy error:', err.message);
                    break;
                }
            }
        };
        window.addEventListener('message', handler);
        postMessage('ready');
        return () => window.removeEventListener('message', handler);
    }, []);

    const exportAsSVG = useCallback(() => {
        if (viewMode === 'cytoscape') {
            const svgContent = cytoscapeRef.current?.exportSVG();
            if (svgContent) {
                postMessage('exportResult', { format: 'svg', data: svgContent, mimeType: 'image/svg+xml' });
            }
            return;
        }
        if (viewMode === 'system' && systemArch) {
            const svgContent = generateSystemArchSVG(systemArch);
            postMessage('exportResult', { format: 'svg', data: svgContent, mimeType: 'image/svg+xml' });
            return;
        }
        if (!graph) return;
        const svgContent = generateArchitectureSVG(graph);
        postMessage('exportResult', { format: 'svg', data: svgContent, mimeType: 'image/svg+xml' });
    }, [graph, viewMode, systemArch]);

    const exportAsPNG = useCallback(() => {
        if (viewMode === 'cytoscape') {
            const base64 = cytoscapeRef.current?.exportPNG();
            if (base64) {
                postMessage('exportResult', { format: 'png', data: base64, mimeType: 'image/png' });
            }
            return;
        }
        const svgContent =
            viewMode === 'system' && systemArch
                ? generateSystemArchSVG(systemArch)
                : graph
                    ? generateArchitectureSVG(graph)
                    : null;
        if (!svgContent) return;
        svgToPng(svgContent, (base64) => {
            postMessage('exportResult', { format: 'png', data: base64, mimeType: 'image/png' });
        });
    }, [graph, viewMode, systemArch]);

    const handleNodeSelect = useCallback((nodeId: string | null) => {
        setSelectedNodeId(nodeId);
    }, []);

    const handleSubsystemHighlight = useCallback((subsystemId: string | null) => {
        setHighlightedSubsystem(subsystemId);
    }, []);

    const handleNavigateToFile = useCallback((filePath: string, line?: number) => {
        postMessage('navigateToFile', { filePath, line });
    }, []);

    const handleRefresh = useCallback(() => {
        postMessage('refreshRequest');
    }, []);

    const handleExportSVG = useCallback(() => { exportAsSVG(); }, [exportAsSVG]);
    const handleExportPNG = useCallback(() => { exportAsPNG(); }, [exportAsPNG]);

    const handleGenerateSystemArch = useCallback(() => {
        if (isGeneratingArch) return;
        setIsGeneratingArch(true);
        setArchProgress('Preparing architecture analysis...');
        postMessage('generateSystemArch');
    }, [isGeneratingArch]);

    const selectedNode = graph?.nodes.find(n => n.id === selectedNodeId) ?? null;

    return (
        <div className="app">
            <Sidebar
                graph={graph}
                searchTerm={searchTerm}
                onSearchChange={setSearchTerm}
                highlightedSubsystem={highlightedSubsystem}
                onSubsystemHighlight={handleSubsystemHighlight}
            />
            <div className="main-content" ref={mainContentRef}>
                <Toolbar
                    viewMode={viewMode}
                    onViewModeChange={setViewMode}
                    onRefresh={handleRefresh}
                    onExportSVG={handleExportSVG}
                    onExportPNG={handleExportPNG}
                    showMiniMap={showMiniMap}
                    onToggleMiniMap={() => setShowMiniMap(v => !v)}
                    onOpenModelSelector={() => setShowModelSelector(true)}
                    hasSystemArch={!!systemArch}
                    isGeneratingArch={isGeneratingArch}
                    onGenerateSystemArch={handleGenerateSystemArch}
                />
                {!graph ? (
                    <div className="loading">
                        <div className="spinner" />
                        Waiting for analysis data...
                    </div>
                ) : viewMode === 'system' ? (
                    systemArch ? (
                        <SystemView architecture={systemArch} showMiniMap={showMiniMap} />
                    ) : isGeneratingArch ? (
                        <div className="loading">
                            <div className="spinner" />
                            <div className="loading-text">
                                <strong>Generating System Architecture</strong>
                                <span className="loading-sub">{archProgress}</span>
                            </div>
                        </div>
                    ) : (
                        <div className="loading">
                            <div className="system-empty">
                                <div className="system-empty-icon">
                                    <Icon name="systemView" size="3x" />
                                </div>
                                <h3>System Architecture</h3>
                                <p>Click <strong>"AI Analyze"</strong> to generate a high-level system architecture.</p>
                                <button className="btn-generate" onClick={handleGenerateSystemArch}>
                                    <Icon name="aiAnalyze" /> Generate System Architecture
                                </button>
                            </div>
                        </div>
                    )
                ) : viewMode === 'reactflow' ? (
                    <ReactFlowView
                        graph={graph}
                        selectedNodeId={selectedNodeId}
                        highlightedSubsystem={highlightedSubsystem}
                        searchTerm={searchTerm}
                        onNodeSelect={handleNodeSelect}
                        onNavigateToFile={handleNavigateToFile}
                        showMiniMap={showMiniMap}
                    />
                ) : (
                    <CytoscapeView
                        ref={cytoscapeRef}
                        graph={graph}
                        selectedNodeId={selectedNodeId}
                        highlightedSubsystem={highlightedSubsystem}
                        searchTerm={searchTerm}
                        onNodeSelect={handleNodeSelect}
                    />
                )}
                {selectedNode && graph && (
                    <DetailPanel
                        node={selectedNode}
                        graph={graph}
                        onClose={() => setSelectedNodeId(null)}
                        onNavigateToFile={handleNavigateToFile}
                    />
                )}
            </div>

            {/* Chat Panel */}
            <ChatPanel isOpen={chatOpen} onToggle={() => setChatOpen(v => !v)} />

            {/* Model Selector Modal */}
            {showModelSelector && (
                <ModelSelector onClose={() => setShowModelSelector(false)} />
            )}
        </div>
    );
}

/** Generate a standalone SVG representation of the architecture graph */
function generateArchitectureSVG(graph: ArchitectureGraph): string {
    const padding = 40;
    const nodeWidth = 160;
    const nodeHeight = 50;
    const nodeSpacingX = 220;
    const nodeSpacingY = 100;
    const groupSpacingX = 500;
    const groupSpacingY = 400;

    // Group nodes by subsystem
    const groups: Record<string, typeof graph.nodes> = {};
    for (const node of graph.nodes) {
        const group = node.group || 'ungrouped';
        if (!groups[group]) groups[group] = [];
        groups[group].push(node);
    }

    const groupNames = Object.keys(groups);
    const cols = Math.ceil(Math.sqrt(groupNames.length));
    const positions: Record<string, { x: number; y: number }> = {};

    let groupIndex = 0;
    for (const groupName of groupNames) {
        const groupNodes = groups[groupName];
        const groupCol = groupIndex % cols;
        const groupRow = Math.floor(groupIndex / cols);
        const baseX = groupCol * groupSpacingX + padding;
        const baseY = groupRow * groupSpacingY + padding;

        const innerCols = Math.ceil(Math.sqrt(groupNodes.length));
        for (let i = 0; i < groupNodes.length; i++) {
            const col = i % innerCols;
            const row = Math.floor(i / innerCols);
            positions[groupNodes[i].id] = {
                x: baseX + col * nodeSpacingX,
                y: baseY + row * nodeSpacingY,
            };
        }
        groupIndex++;
    }

    // Calculate total SVG size
    const allPos = Object.values(positions);
    const maxX = Math.max(...allPos.map(p => p.x)) + nodeWidth + padding;
    const maxY = Math.max(...allPos.map(p => p.y)) + nodeHeight + padding;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX}" height="${maxY}" viewBox="0 0 ${maxX} ${maxY}">`;
    svg += `<rect width="${maxX}" height="${maxY}" fill="#1e1e1e"/>`;
    svg += '<defs><marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#666"/></marker></defs>';

    // Draw edges
    for (const edge of graph.edges) {
        const src = positions[edge.source];
        const tgt = positions[edge.target];
        if (!src || !tgt) continue;
        const sx = src.x + nodeWidth / 2;
        const sy = src.y + nodeHeight;
        const tx = tgt.x + nodeWidth / 2;
        const ty = tgt.y;
        const mx = (sx + tx) / 2;
        const my = (sy + ty) / 2;
        const dx = tx - sx;
        const dy = ty - sy;
        const cx = mx - dy * 0.15;
        const cy = my + dx * 0.15;
        svg += `<path d="M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}" fill="none" stroke="#555" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)"/>`;
    }

    // Draw subsystem backgrounds
    for (const groupName of groupNames) {
        const groupNodes = groups[groupName];
        const subsystem = graph.subsystems.find(s => s.name === groupName);
        if (!subsystem || groupNodes.length === 0) continue;
        const groupPositions = groupNodes.map(n => positions[n.id]).filter(Boolean);
        const minX = Math.min(...groupPositions.map(p => p.x)) - 15;
        const minY = Math.min(...groupPositions.map(p => p.y)) - 30;
        const gMaxX = Math.max(...groupPositions.map(p => p.x)) + nodeWidth + 15;
        const gMaxY = Math.max(...groupPositions.map(p => p.y)) + nodeHeight + 15;
        svg += `<rect x="${minX}" y="${minY}" width="${gMaxX - minX}" height="${gMaxY - minY}" rx="8" fill="${subsystem.color}10" stroke="${subsystem.color}" stroke-width="1" stroke-dasharray="4 2" opacity="0.5"/>`;
        svg += `<text x="${minX + 8}" y="${minY + 16}" fill="${subsystem.color}" font-size="11" font-weight="bold" font-family="sans-serif">${escapeXml(subsystem.name)}</text>`;
    }

    // Draw nodes
    for (const node of graph.nodes) {
        const pos = positions[node.id];
        if (!pos) continue;
        const subsystem = graph.subsystems.find(s => s.nodeIds.includes(node.id));
        const borderColor = subsystem ? subsystem.color : '#454545';
        svg += `<rect x="${pos.x}" y="${pos.y}" width="${nodeWidth}" height="${nodeHeight}" rx="6" fill="#252526" stroke="${borderColor}" stroke-width="1.5"/>`;
        svg += `<text x="${pos.x + 10}" y="${pos.y + 22}" fill="#d4d4d4" font-size="12" font-weight="600" font-family="sans-serif">${escapeXml(truncate(node.label, 20))}</text>`;
        svg += `<text x="${pos.x + 10}" y="${pos.y + 38}" fill="#888" font-size="10" font-family="sans-serif">${escapeXml((node.metadata.language as string) || '')} · ${node.symbols.length} symbols</text>`;
    }

    svg += '</svg>';
    return svg;
}

function escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str: string, max: number): string {
    return str.length > max ? str.slice(0, max) + '…' : str;
}

/** Shared SVG-to-PNG helper: renders an SVG string to a PNG base64 string via canvas. */
function svgToPng(svgContent: string, onDone: (base64: string) => void): void {
    const img = new Image();
    const svgBlob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = 2;
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.scale(scale, scale);
        ctx.fillStyle = '#1e1e1e';
        ctx.fillRect(0, 0, img.width, img.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const dataUrl = canvas.toDataURL('image/png');
        onDone(dataUrl.replace(/^data:image\/png;base64,/, ''));
    };
    img.src = url;
}

/** Generate a standalone SVG for the AI System Architecture view. */
function generateSystemArchSVG(arch: SystemArchitecture): string {
    const nodeW = 220;
    const nodeH = 80;
    const cols = Math.ceil(Math.sqrt(arch.nodes.length));
    const spacingX = 300;
    const spacingY = 160;
    const padding = 50;

    const positions: Record<string, { x: number; y: number }> = {};
    arch.nodes.forEach((node, i) => {
        positions[node.id] = {
            x: (i % cols) * spacingX + padding,
            y: Math.floor(i / cols) * spacingY + padding,
        };
    });

    const allPos = Object.values(positions);
    const maxX = Math.max(...allPos.map(p => p.x)) + nodeW + padding;
    const maxY = Math.max(...allPos.map(p => p.y)) + nodeH + padding;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX}" height="${maxY}" viewBox="0 0 ${maxX} ${maxY}">`;
    svg += `<rect width="${maxX}" height="${maxY}" fill="#1e1e1e"/>`;
    svg += '<defs><marker id="arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#666"/></marker></defs>';

    // Edges
    for (const edge of arch.edges) {
        const src = positions[edge.source];
        const tgt = positions[edge.target];
        if (!src || !tgt) continue;
        const sx = src.x + nodeW / 2;
        const sy = src.y + nodeH;
        const tx = tgt.x + nodeW / 2;
        const ty = tgt.y;
        const edgeColors: Record<string, string> = {
            'dependency': '#90A4AE',
            'data-flow': '#4FC3F7',
            'api-call': '#FFB74D',
            'event': '#BA68C8',
        };
        const color = edgeColors[edge.type] ?? '#666';
        svg += `<path d="M ${sx} ${sy} C ${sx} ${(sy + ty) / 2}, ${tx} ${(sy + ty) / 2}, ${tx} ${ty}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.7" marker-end="url(#arrow)"/>`;
        if (edge.label) {
            const mx = (sx + tx) / 2;
            const my = (sy + ty) / 2;
            svg += `<rect x="${mx - 30}" y="${my - 8}" width="60" height="14" rx="3" fill="#252526" opacity="0.9"/>`;
            svg += `<text x="${mx}" y="${my + 3}" fill="#aaa" font-size="9" font-family="sans-serif" text-anchor="middle">${escapeXml(edge.label)}</text>`;
        }
    }

    // Nodes
    for (const node of arch.nodes) {
        const pos = positions[node.id];
        if (!pos) continue;
        svg += `<rect x="${pos.x}" y="${pos.y}" width="${nodeW}" height="${nodeH}" rx="8" fill="#252526" stroke="${node.color}" stroke-width="2"/>`;
        svg += `<rect x="${pos.x}" y="${pos.y}" width="4" height="${nodeH}" rx="2" fill="${node.color}"/>`;
        svg += `<text x="${pos.x + 16}" y="${pos.y + 24}" fill="${node.color}" font-size="13" font-weight="700" font-family="sans-serif">${escapeXml(node.label)}</text>`;
        svg += `<text x="${pos.x + 16}" y="${pos.y + 42}" fill="#aaa" font-size="10" font-family="sans-serif">${escapeXml(truncate(node.description, 36))}</text>`;
        svg += `<text x="${pos.x + 16}" y="${pos.y + 60}" fill="#666" font-size="9" font-family="sans-serif">${escapeXml(node.type)}</text>`;
    }

    // Banner with pattern
    svg += `<text x="${padding}" y="20" fill="#555" font-size="11" font-family="sans-serif">${escapeXml(arch.pattern)}</text>`;

    svg += '</svg>';
    return svg;
}
