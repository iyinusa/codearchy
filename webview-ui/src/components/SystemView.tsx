import React, { useMemo, useCallback, useEffect, useState } from 'react';
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    Node,
    Edge,
    NodeTypes,
    useNodesState,
    useEdgesState,
    MarkerType,
    Handle,
    Position,
    NodeProps,
    BackgroundVariant,
    ReactFlowProvider,
    useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { SystemArchitecture } from '../types';
import { Icon } from './Icons';
import type { AppIconName } from './Icons';
import { layoutWithElk, estimateNodeSize } from './elkLayout';

interface SystemViewProps {
    architecture: SystemArchitecture;
    showMiniMap: boolean;
}

function SystemNode({ data, selected }: NodeProps) {
    const nodeData = data as {
        label: string;
        description: string;
        nodeType: string;
        color: string;
        childCount: number;
        dimmed: boolean;
    };

    const typeIcons: Record<string, AppIconName> = {
        subsystem: 'nodeSubsystem',
        layer: 'nodeLayer',
        service: 'nodeService',
        external: 'nodeExternal',
    };

    return (
        <div
            className={`system-node ${selected ? 'selected' : ''} ${nodeData.dimmed ? 'dimmed' : ''}`}
            style={{ borderColor: nodeData.color, borderLeftWidth: 4 }}
        >
            <Handle type="target" position={Position.Top} className="handle" />
            <div className="system-node-header">
                <span className="system-node-icon" style={{ color: nodeData.color }}>
                    <Icon name={typeIcons[nodeData.nodeType] ?? 'nodeSubsystem'} fixedWidth />
                </span>
                <span className="system-node-label">{nodeData.label}</span>
            </div>
            <div className="system-node-desc">{nodeData.description}</div>
            <div className="system-node-footer">
                <span className="system-node-type">{nodeData.nodeType}</span>
                {nodeData.childCount > 0 && (
                    <span className="system-node-count">{nodeData.childCount} modules</span>
                )}
            </div>
            <div className="system-node-bar" style={{ background: nodeData.color }} />
            <Handle type="source" position={Position.Bottom} className="handle" />
        </div>
    );
}

const nodeTypes: NodeTypes = {
    systemNode: SystemNode,
};

function SystemViewInner({ architecture, showMiniMap }: SystemViewProps) {
    const { rawNodes, rawEdges } = useMemo(
        () => buildRawSystemElements(architecture),
        [architecture]
    );

    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const [isLayouting, setIsLayouting] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const { fitView } = useReactFlow();

    useEffect(() => {
        let cancelled = false;
        setIsLayouting(true);
        const direction = pickDirection(rawNodes.length, rawEdges.length);
        layoutWithElk(rawNodes, rawEdges, {
            algorithm: 'layered',
            direction,
            edgeRouting: 'ORTHOGONAL',
            nodeSpacing: 80,
            layerSpacing: 140,
            padding: 40,
        })
            .then(({ nodes: laidOut, edges: laidEdges }) => {
                if (cancelled) return;
                setNodes(laidOut);
                setEdges(laidEdges);
                requestAnimationFrame(() => {
                    if (!cancelled) fitView({ padding: 0.3, duration: 300 });
                });
            })
            .catch(err => {
                console.error('[CodeArchy] ELK layout failed (system view):', err);
                if (!cancelled) {
                    setNodes(rawNodes);
                    setEdges(rawEdges);
                }
            })
            .finally(() => {
                if (!cancelled) setIsLayouting(false);
            });
        return () => {
            cancelled = true;
        };
    }, [rawNodes, rawEdges, setNodes, setEdges, fitView]);

    const connectedIds = useMemo(() => {
        if (!selectedId) return null;
        const set = new Set<string>([selectedId]);
        for (const e of architecture.edges) {
            if (e.source === selectedId) set.add(e.target);
            if (e.target === selectedId) set.add(e.source);
        }
        return set;
    }, [selectedId, architecture.edges]);

    useEffect(() => {
        setNodes(curr =>
            curr.map(n => {
                const isSelected = n.id === selectedId;
                const dimmed = !!(connectedIds && !connectedIds.has(n.id));
                if ((n.data as any).dimmed === dimmed && n.selected === isSelected) {
                    return n;
                }
                return {
                    ...n,
                    selected: isSelected,
                    data: { ...n.data, dimmed },
                };
            })
        );

        setEdges(curr =>
            curr.map(e => {
                const isConnected =
                    !!selectedId && (e.source === selectedId || e.target === selectedId);
                const opacity = selectedId ? (isConnected ? 1 : 0.08) : 1;
                const strokeWidth = isConnected ? 3 : 2;
                return {
                    ...e,
                    animated: isConnected || (!selectedId && !!e.animated),
                    style: {
                        ...(e.style || {}),
                        strokeWidth,
                        opacity,
                    },
                    labelStyle: {
                        ...((e.labelStyle as object) || {}),
                        opacity,
                    },
                    labelBgStyle: {
                        ...((e.labelBgStyle as object) || {}),
                        fillOpacity: selectedId ? (isConnected ? 0.95 : 0.08) : 0.9,
                    },
                };
            })
        );
    }, [selectedId, connectedIds, setNodes, setEdges]);

    const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
        setSelectedId(prev => (prev === node.id ? null : node.id));
    }, []);

    const onPaneClick = useCallback(() => {
        setSelectedId(null);
    }, []);

    return (
        <div className="system-view-container">
            <div className="system-view-banner">
                <div className="system-banner-content">
                    <span className="system-pattern-badge">{architecture.pattern}</span>
                    <span className="system-summary">{architecture.summary}</span>
                </div>
            </div>
            <div className="system-flow-wrapper">
                {isLayouting && (
                    <div className="elk-layout-overlay" aria-hidden>
                        <div className="elk-layout-pill">Auto-layout…</div>
                    </div>
                )}
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onNodeClick={onNodeClick}
                    onPaneClick={onPaneClick}
                    fitView
                    fitViewOptions={{ padding: 0.3 }}
                    minZoom={0.2}
                    maxZoom={2}
                    defaultEdgeOptions={{ type: 'smoothstep' }}
                    proOptions={{ hideAttribution: true }}
                >
                    <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
                    <Controls showInteractive={false} />
                    {showMiniMap && (
                        <MiniMap
                            nodeColor={(node) => {
                                const d = node.data as { color?: string; dimmed?: boolean };
                                if (d.dimmed) return '#333';
                                return d.color || '#666';
                            }}
                            maskColor="rgba(0, 0, 0, 0.6)"
                            style={{ background: 'var(--sidebar-bg)' }}
                        />
                    )}
                </ReactFlow>
            </div>
        </div>
    );
}

export function SystemView(props: SystemViewProps) {
    return (
        <ReactFlowProvider>
            <SystemViewInner {...props} />
        </ReactFlowProvider>
    );
}

function pickDirection(nodeCount: number, edgeCount: number): 'DOWN' | 'RIGHT' {
    const density = nodeCount > 0 ? edgeCount / nodeCount : 0;
    return density > 1.2 ? 'RIGHT' : 'DOWN';
}

function buildRawSystemElements(
    arch: SystemArchitecture
): { rawNodes: (Node & { width?: number; height?: number })[]; rawEdges: Edge[] } {
    const rawNodes: (Node & { width?: number; height?: number })[] = [];
    const rawEdges: Edge[] = [];

    for (const node of arch.nodes) {
        const size = estimateNodeSize(node.label, node.description, {
            minWidth: 240,
            maxWidth: 320,
            padding: 36,
            lineHeight: 18,
        });
        const height = Math.max(140, size.height + 80);
        rawNodes.push({
            id: node.id,
            type: 'systemNode',
            position: { x: 0, y: 0 },
            width: size.width,
            height,
            data: {
                label: node.label,
                description: node.description,
                nodeType: node.type,
                color: node.color,
                childCount: node.children?.length || 0,
                dimmed: false,
            },
        });
    }

    const edgeTypeStyles: Record<string, { color: string; animated: boolean }> = {
        'dependency': { color: '#90A4AE', animated: false },
        'data-flow': { color: '#4FC3F7', animated: true },
        'api-call': { color: '#FFB74D', animated: false },
        'event': { color: '#BA68C8', animated: true },
    };

    for (const edge of arch.edges) {
        const style = edgeTypeStyles[edge.type] || edgeTypeStyles['dependency'];
        rawEdges.push({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: 'smoothstep',
            animated: style.animated,
            label: edge.label,
            labelStyle: { fill: 'var(--fg)', fontSize: 10, fontWeight: 500 },
            labelBgStyle: { fill: 'var(--node-bg)', fillOpacity: 0.9 },
            labelBgPadding: [4, 2] as [number, number],
            style: {
                stroke: style.color,
                strokeWidth: 2,
            },
            markerEnd: {
                type: MarkerType.ArrowClosed,
                width: 14,
                height: 14,
                color: style.color,
            },
        });
    }

    return { rawNodes, rawEdges };
}
