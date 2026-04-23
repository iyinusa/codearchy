import React, { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import cytoscape from 'cytoscape';
import type { ArchitectureGraph } from '../types';
import { Icon } from './Icons';
import {
    loadCytoscapePositions,
    saveCytoscapePositions,
    useProjectId,
    type PositionMap,
} from '../db';

// Dynamically import dagre layout if available
let dagreRegistered = false;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dagre = require('cytoscape-dagre');
    if (!dagreRegistered) {
        cytoscape.use(dagre);
        dagreRegistered = true;
    }
} catch {
    // dagre not available, use default layouts
}

/** Handle exposed to parent via forwardRef — used for view-aware export */
export interface CytoscapeViewHandle {
    exportPNG(): string | null;
    exportSVG(): string | null;
}

interface CytoscapeViewProps {
    graph: ArchitectureGraph;
    selectedNodeId: string | null;
    highlightedSubsystem: string | null;
    searchTerm: string;
    onNodeSelect: (nodeId: string | null) => void;
}

export const CytoscapeView = forwardRef<CytoscapeViewHandle, CytoscapeViewProps>(function CytoscapeView({
    graph,
    selectedNodeId,
    highlightedSubsystem,
    searchTerm,
    onNodeSelect,
}, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cyRef = useRef<cytoscape.Core | null>(null);
    const projectId = useProjectId();
    const projectIdRef = useRef<string | null>(projectId);
    projectIdRef.current = projectId;

    // Initialize Cytoscape
    useEffect(() => {
        if (!containerRef.current) return;

        const elements: cytoscape.ElementDefinition[] = [];

        // Add compound (parent) nodes for subsystems
        for (const subsystem of graph.subsystems) {
            elements.push({
                data: {
                    id: `group-${subsystem.id}`,
                    label: subsystem.name,
                    color: subsystem.color,
                    type: 'subsystem',
                },
            });
        }

        // Add nodes
        for (const node of graph.nodes) {
            const subsystem = graph.subsystems.find(s => s.nodeIds.includes(node.id));
            elements.push({
                data: {
                    id: node.id,
                    label: node.label,
                    parent: subsystem ? `group-${subsystem.id}` : undefined,
                    language: node.metadata.language as string || '',
                    symbolCount: node.symbols.length,
                    subsystemColor: subsystem?.color || '#666',
                    filePath: node.filePath,
                    type: 'module',
                },
            });
        }

        // Add edges
        for (const edge of graph.edges) {
            elements.push({
                data: {
                    id: edge.id,
                    source: edge.source,
                    target: edge.target,
                    weight: edge.weight,
                },
            });
        }

        const cy = cytoscape({
            container: containerRef.current,
            elements,
            style: getCytoscapeStyle(),
            layout: getLayout(graph.nodes.length),
            wheelSensitivity: 0.3,
            minZoom: 0.1,
            maxZoom: 3,
        });

        // Hydrate cached positions (if any) after the initial layout settles.
        // Cytoscape runs its layout async, so we wait for `layoutstop` before
        // applying persisted coordinates — otherwise the engine would
        // overwrite them. Positions are saved whenever the user drags a node
        // (`dragfree`), debounced to keep IDB writes off the render path.
        const applyCachedPositions = async () => {
            const pid = projectIdRef.current;
            if (!pid) return;
            try {
                const cached = await loadCytoscapePositions(pid);
                if (!cached) return;
                let applied = false;
                cy.nodes('[type="module"]').forEach(node => {
                    const pos = cached[node.id()];
                    if (pos) {
                        node.position(pos);
                        applied = true;
                    }
                });
                if (applied) {
                    cy.fit(undefined, 40);
                }
            } catch (e) {
                console.error('[CodeArchy] loadCytoscapePositions failed', e);
            }
        };

        cy.one('layoutstop', () => {
            applyCachedPositions();
        });

        const persistPositions = () => {
            const pid = projectIdRef.current;
            if (!pid) return;
            const map: PositionMap = {};
            cy.nodes('[type="module"]').forEach(node => {
                const p = node.position();
                map[node.id()] = { x: p.x, y: p.y };
            });
            saveCytoscapePositions(pid, map);
        };

        // Event handlers
        cy.on('tap', 'node[type="module"]', (event) => {
            const nodeId = event.target.id();
            onNodeSelect(nodeId);
        });

        cy.on('tap', (event) => {
            if (event.target === cy) {
                onNodeSelect(null);
            }
        });

        cy.on('dragfree', 'node[type="module"]', () => {
            persistPositions();
        });

        cyRef.current = cy;

        return () => {
            cy.destroy();
            cyRef.current = null;
        };
    }, [graph]); // Re-create when graph changes

    // Handle selection changes
    useEffect(() => {
        const cy = cyRef.current;
        if (!cy) return;

        cy.nodes().removeClass('selected');
        if (selectedNodeId) {
            cy.getElementById(selectedNodeId).addClass('selected');
        }
    }, [selectedNodeId]);

    // Handle node selection focus (fade non-connected nodes/edges)
    useEffect(() => {
        const cy = cyRef.current;
        if (!cy) return;

        cy.nodes('[type="module"]').removeClass('focus-dimmed');
        cy.edges().removeClass('focus-dimmed focus-active');

        if (selectedNodeId) {
            const connectedNodeIds = new Set([selectedNodeId]);
            graph.edges.forEach(edge => {
                if (edge.source === selectedNodeId) connectedNodeIds.add(edge.target);
                if (edge.target === selectedNodeId) connectedNodeIds.add(edge.source);
            });

            cy.nodes('[type="module"]').forEach(node => {
                if (!connectedNodeIds.has(node.id())) {
                    node.addClass('focus-dimmed');
                }
            });

            cy.edges().forEach(edge => {
                const isConnected =
                    edge.source().id() === selectedNodeId ||
                    edge.target().id() === selectedNodeId;
                edge.addClass(isConnected ? 'focus-active' : 'focus-dimmed');
            });
        }
    }, [selectedNodeId, graph]);

    // Handle subsystem highlighting
    useEffect(() => {
        const cy = cyRef.current;
        if (!cy) return;

        cy.nodes('[type="module"]').removeClass('dimmed');
        cy.edges().removeClass('dimmed');

        if (highlightedSubsystem) {
            const sub = graph.subsystems.find(s => s.id === highlightedSubsystem);
            if (sub) {
                cy.nodes('[type="module"]').forEach(node => {
                    if (!sub.nodeIds.includes(node.id())) {
                        node.addClass('dimmed');
                    }
                });
                cy.edges().forEach(edge => {
                    const src = edge.source().id();
                    const tgt = edge.target().id();
                    if (!sub.nodeIds.includes(src) && !sub.nodeIds.includes(tgt)) {
                        edge.addClass('dimmed');
                    }
                });
            }
        }
    }, [highlightedSubsystem, graph]);

    // Handle search filtering
    useEffect(() => {
        const cy = cyRef.current;
        if (!cy) return;

        cy.nodes('[type="module"]').removeClass('search-dimmed');
        if (searchTerm) {
            cy.nodes('[type="module"]').forEach(node => {
                if (!node.id().toLowerCase().includes(searchTerm.toLowerCase())) {
                    node.addClass('search-dimmed');
                }
            });
        }
    }, [searchTerm]);

    // Refit on resize
    const handleFit = useCallback(() => {
        cyRef.current?.fit(undefined, 50);
    }, []);

    useEffect(() => {
        const observer = new ResizeObserver(() => {
            cyRef.current?.resize();
        });
        if (containerRef.current) {
            observer.observe(containerRef.current);
        }
        return () => observer.disconnect();
    }, []);

    // Expose export methods to parent via forwardRef
    useImperativeHandle(ref, () => ({
        exportPNG(): string | null {
            if (!cyRef.current) return null;
            // cy.png() returns a base64 data URI; strip the prefix for consistency with other exporters
            const dataUri = (cyRef.current as cytoscape.Core).png({ full: true, bg: '#1e1e1e', scale: 2 });
            return typeof dataUri === 'string' ? dataUri.replace(/^data:image\/png;base64,/, '') : null;
        },
        exportSVG(): string | null {
            if (!cyRef.current) return null;
            return generateCytoscapeSVG(graph, cyRef.current);
        },
    }), [graph]);

    return (
        <div className="cytoscape-container">
            <div ref={containerRef} className="cytoscape-canvas" />
            <button className="cy-fit-btn" onClick={handleFit} title="Fit to view">
                <Icon name="fitView" />
            </button>
        </div>
    );
});

function getLayout(nodeCount: number): cytoscape.LayoutOptions {
    if (dagreRegistered && nodeCount < 200) {
        return {
            name: 'dagre',
            rankDir: 'TB',
            nodeSep: 60,
            rankSep: 80,
            padding: 30,
        } as cytoscape.LayoutOptions;
    }
    // Fallback: cose layout (force-directed, built-in)
    return {
        name: 'cose',
        animate: false,
        randomize: false,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 120,
        edgeElasticity: () => 100,
        nestingFactor: 1.2,
        gravity: 0.25,
        numIter: 1000,
        padding: 30,
    } as cytoscape.LayoutOptions;
}

function getCytoscapeStyle(): cytoscape.StylesheetStyle[] {
    return [
        {
            selector: 'node[type="module"]',
            style: {
                label: 'data(label)',
                'background-color': 'data(subsystemColor)',
                'text-valign': 'bottom' as const,
                'text-halign': 'center' as const,
                'font-size': '10px',
                color: '#ccc',
                'text-margin-y': 6,
                width: 30,
                height: 30,
                'border-width': 2,
                'border-color': '#555',
                'text-max-width': '120px',
                'text-wrap': 'ellipsis' as const,
                'transition-property': 'opacity',
                'transition-duration': 200,
            },
        },
        {
            selector: 'node[type="subsystem"]',
            style: {
                label: 'data(label)',
                'background-color': 'data(color)',
                'background-opacity': 0.1,
                'border-color': 'data(color)',
                'border-width': 2,
                'border-opacity': 0.5,
                'text-valign': 'top' as const,
                'text-halign': 'center' as const,
                'font-size': '12px',
                'font-weight': 'bold',
                color: 'data(color)',
                'text-margin-y': -8,
                padding: '20px',
            },
        },
        {
            selector: 'node.selected',
            style: {
                'border-color': '#007acc',
                'border-width': 3,
                'background-color': '#094771',
            },
        },
        {
            selector: 'node.dimmed, node.search-dimmed, node.focus-dimmed',
            style: {
                opacity: 0.12,
            },
        },
        {
            selector: 'edge',
            style: {
                width: 1,
                'line-color': '#555',
                'target-arrow-color': '#555',
                'target-arrow-shape': 'triangle' as const,
                'curve-style': 'bezier' as const,
                opacity: 0.5,
                'arrow-scale': 0.8,
            },
        },
        {
            selector: 'edge.dimmed, edge.focus-dimmed',
            style: {
                opacity: 0.06,
            },
        },
        {
            selector: 'edge.focus-active',
            style: {
                'line-color': '#007acc',
                'target-arrow-color': '#007acc',
                opacity: 0.9,
                width: 2,
            },
        },
    ];
}

/**
 * Generate an SVG snapshot of the current Cytoscape layout.
 * Uses actual node positions from the live cytoscape instance so the export
 * matches exactly what the user sees on screen.
 */
function generateCytoscapeSVG(graph: ArchitectureGraph, cy: cytoscape.Core): string {
    const nodeWidth = 100;
    const nodeHeight = 36;
    const padding = 40;

    // Collect positions from the live layout
    const positions: Record<string, { x: number; y: number }> = {};
    cy.nodes('[type="module"]').forEach((node) => {
        const pos = node.position();
        positions[node.id()] = { x: pos.x, y: pos.y };
    });

    const allPos = Object.values(positions);
    if (allPos.length === 0) return '<svg xmlns="http://www.w3.org/2000/svg"/>';

    const minX = Math.min(...allPos.map(p => p.x)) - padding;
    const minY = Math.min(...allPos.map(p => p.y)) - padding;
    const maxX = Math.max(...allPos.map(p => p.x)) + nodeWidth + padding;
    const maxY = Math.max(...allPos.map(p => p.y)) + nodeHeight + padding;
    const w = maxX - minX;
    const h = maxY - minY;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${minX} ${minY} ${w} ${h}">`;
    svg += `<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#1e1e1e"/>`;
    svg += '<defs><marker id="arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#555"/></marker></defs>';

    // Draw subsystem bounding boxes
    for (const subsystem of graph.subsystems) {
        const subPositions = subsystem.nodeIds
            .map(id => positions[id])
            .filter(Boolean);
        if (subPositions.length === 0) continue;
        const sx = Math.min(...subPositions.map(p => p.x)) - 18;
        const sy = Math.min(...subPositions.map(p => p.y)) - 24;
        const ex = Math.max(...subPositions.map(p => p.x)) + nodeWidth + 18;
        const ey = Math.max(...subPositions.map(p => p.y)) + nodeHeight + 12;
        svg += `<rect x="${sx}" y="${sy}" width="${ex - sx}" height="${ey - sy}" rx="8" fill="${subsystem.color}12" stroke="${subsystem.color}" stroke-width="1" stroke-dasharray="4 2" opacity="0.6"/>`;
        svg += `<text x="${sx + 8}" y="${sy + 14}" fill="${subsystem.color}" font-size="10" font-weight="bold" font-family="sans-serif">${escCy(subsystem.name)}</text>`;
    }

    // Draw edges
    for (const edge of graph.edges) {
        const src = positions[edge.source];
        const tgt = positions[edge.target];
        if (!src || !tgt) continue;
        const sx = src.x + nodeWidth / 2;
        const sy = src.y + nodeHeight;
        const tx = tgt.x + nodeWidth / 2;
        const ty = tgt.y;
        svg += `<line x1="${sx}" y1="${sy}" x2="${tx}" y2="${ty}" stroke="#555" stroke-width="1" opacity="0.4" marker-end="url(#arr)"/>`;
    }

    // Draw nodes
    for (const node of graph.nodes) {
        const pos = positions[node.id];
        if (!pos) continue;
        const subsystem = graph.subsystems.find(s => s.nodeIds.includes(node.id));
        const color = subsystem?.color ?? '#454545';
        svg += `<rect x="${pos.x}" y="${pos.y}" width="${nodeWidth}" height="${nodeHeight}" rx="5" fill="#252526" stroke="${color}" stroke-width="1.5"/>`;
        svg += `<text x="${pos.x + 8}" y="${pos.y + 16}" fill="#d4d4d4" font-size="10" font-weight="600" font-family="sans-serif">${escCy(trunc(node.label, 16))}</text>`;
        svg += `<text x="${pos.x + 8}" y="${pos.y + 28}" fill="#888" font-size="9" font-family="sans-serif">${escCy(String(node.metadata.language ?? ''))} · ${node.symbols.length}</text>`;
    }

    svg += '</svg>';
    return svg;
}

function escCy(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function trunc(str: string, max: number): string {
    return str.length > max ? str.slice(0, max) + '…' : str;
}
