import React, { useMemo, useCallback } from 'react';
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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { SystemArchitecture, SystemArchNode } from '../types';
import { Icon } from './Icons';
import type { AppIconName } from './Icons';

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
    };

    const typeIcons: Record<string, AppIconName> = {
        subsystem: 'nodeSubsystem',
        layer: 'nodeLayer',
        service: 'nodeService',
        external: 'nodeExternal',
    };

    return (
        <div
            className={`system-node ${selected ? 'selected' : ''}`}
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

export function SystemView({ architecture, showMiniMap }: SystemViewProps) {
    const { flowNodes, flowEdges } = useMemo(() => {
        return buildSystemFlowElements(architecture);
    }, [architecture]);

    const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

    React.useEffect(() => {
        setNodes(flowNodes);
        setEdges(flowEdges);
    }, [flowNodes, flowEdges, setNodes, setEdges]);

    const onPaneClick = useCallback(() => {
        // Deselect
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
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    nodeTypes={nodeTypes}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
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
                                const d = node.data as { color?: string };
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

function buildSystemFlowElements(
    arch: SystemArchitecture
): { flowNodes: Node[]; flowEdges: Edge[] } {
    const flowNodes: Node[] = [];
    const flowEdges: Edge[] = [];

    // Layout: arrange nodes in a grid
    const cols = Math.ceil(Math.sqrt(arch.nodes.length));
    const spacingX = 350;
    const spacingY = 250;

    arch.nodes.forEach((node, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);

        flowNodes.push({
            id: node.id,
            type: 'systemNode',
            position: { x: col * spacingX + 50, y: row * spacingY + 50 },
            data: {
                label: node.label,
                description: node.description,
                nodeType: node.type,
                color: node.color,
                childCount: node.children?.length || 0,
            },
        });
    });

    const edgeTypeStyles: Record<string, { color: string; animated: boolean; dash?: string }> = {
        'dependency': { color: '#90A4AE', animated: false },
        'data-flow': { color: '#4FC3F7', animated: true },
        'api-call': { color: '#FFB74D', animated: false },
        'event': { color: '#BA68C8', animated: true },
    };

    arch.edges.forEach((edge) => {
        const style = edgeTypeStyles[edge.type] || edgeTypeStyles['dependency'];

        flowEdges.push({
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
    });

    return { flowNodes, flowEdges };
}
