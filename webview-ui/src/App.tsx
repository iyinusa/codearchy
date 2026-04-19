import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ArchitectureGraph, ViewMode } from './types';
import { postMessage } from './vscode';
import { ReactFlowView } from './components/ReactFlowView';
import { CytoscapeView } from './components/CytoscapeView';
import { Sidebar } from './components/Sidebar';
import { DetailPanel } from './components/DetailPanel';
import { Toolbar } from './components/Toolbar';

export function App() {
    const [graph, setGraph] = useState<ArchitectureGraph | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>('reactflow');
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [highlightedSubsystem, setHighlightedSubsystem] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [showMiniMap, setShowMiniMap] = useState(true);
    const mainContentRef = useRef<HTMLDivElement>(null);

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
            }
        };
        window.addEventListener('message', handler);
        postMessage('ready');
        return () => window.removeEventListener('message', handler);
    }, []);

    const exportAsSVG = useCallback(() => {
        // Generate SVG from current view
        const container = mainContentRef.current;
        if (!container || !graph) return;

        const svgContent = generateArchitectureSVG(graph);
        postMessage('exportResult', { format: 'svg', data: svgContent, mimeType: 'image/svg+xml' });
    }, [graph]);

    const exportAsPNG = useCallback(() => {
        const container = mainContentRef.current;
        if (!container || !graph) return;

        const svgContent = generateArchitectureSVG(graph);
        // Convert SVG to PNG via canvas
        const img = new Image();
        const svgBlob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
        const url = URL.createObjectURL(svgBlob);
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const scale = 2; // High DPI
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
            const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
            postMessage('exportResult', { format: 'png', data: base64, mimeType: 'image/png' });
        };
        img.src = url;
    }, [graph]);

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

    const handleExportSVG = useCallback(() => {
        exportAsSVG();
    }, [exportAsSVG]);

    const handleExportPNG = useCallback(() => {
        exportAsPNG();
    }, [exportAsPNG]);

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
                />
                {!graph ? (
                    <div className="loading">
                        <div className="spinner" />
                        Waiting for analysis data...
                    </div>
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
