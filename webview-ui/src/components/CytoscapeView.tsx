import React, { useEffect, useRef, useCallback } from 'react';
import cytoscape from 'cytoscape';
import type { ArchitectureGraph } from '../types';

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

interface CytoscapeViewProps {
    graph: ArchitectureGraph;
    selectedNodeId: string | null;
    highlightedSubsystem: string | null;
    searchTerm: string;
    onNodeSelect: (nodeId: string | null) => void;
}

export function CytoscapeView({
    graph,
    selectedNodeId,
    highlightedSubsystem,
    searchTerm,
    onNodeSelect,
}: CytoscapeViewProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const cyRef = useRef<cytoscape.Core | null>(null);

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

    return (
        <div className="cytoscape-container">
            <div ref={containerRef} className="cytoscape-canvas" />
            <button className="cy-fit-btn" onClick={handleFit} title="Fit to view">
                ⊞
            </button>
        </div>
    );
}

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
