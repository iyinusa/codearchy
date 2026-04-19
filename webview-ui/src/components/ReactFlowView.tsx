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
import type { ArchitectureGraph, GraphNode, SubsystemInfo } from '../types';

interface ReactFlowViewProps {
    graph: ArchitectureGraph;
    selectedNodeId: string | null;
    highlightedSubsystem: string | null;
    searchTerm: string;
    onNodeSelect: (nodeId: string | null) => void;
    onNavigateToFile: (filePath: string, line?: number) => void;
}

// Custom node component for architecture modules
function ModuleNode({ data, selected }: NodeProps) {
    const nodeData = data as {
        label: string;
        fullPath: string;
        language: string;
        symbolCount: number;
        subsystemColor: string;
        dimmed: boolean;
    };

    return (
        <div
            className={`module-node ${selected ? 'selected' : ''} ${nodeData.dimmed ? 'dimmed' : ''}`}
            style={{ borderLeftColor: nodeData.subsystemColor || 'var(--node-border)' }}
        >
            <Handle type="target" position={Position.Top} className="handle" />
            <div className="module-node-label" title={nodeData.fullPath}>
                {nodeData.label}
            </div>
            <div className="module-node-meta">
                {nodeData.language} · {nodeData.symbolCount} symbols
            </div>
            {nodeData.symbolCount > 0 && (
                <div className="module-node-badge">{nodeData.symbolCount}</div>
            )}
            <div
                className="module-node-group-bar"
                style={{ background: nodeData.subsystemColor || 'transparent' }}
            />
            <Handle type="source" position={Position.Bottom} className="handle" />
        </div>
    );
}

// Custom node for subsystem group headers
function SubsystemNode({ data }: NodeProps) {
    const nodeData = data as { label: string; color: string; count: number };
    return (
        <div className="subsystem-header-node" style={{ borderColor: nodeData.color }}>
            <div className="subsystem-header-dot" style={{ background: nodeData.color }} />
            <span>{nodeData.label}</span>
            <span className="subsystem-header-count">{nodeData.count}</span>
        </div>
    );
}

const nodeTypes: NodeTypes = {
    moduleNode: ModuleNode,
    subsystemNode: SubsystemNode,
};

export function ReactFlowView({
    graph,
    selectedNodeId,
    highlightedSubsystem,
    searchTerm,
    onNodeSelect,
    onNavigateToFile,
}: ReactFlowViewProps) {
    const { flowNodes, flowEdges } = useMemo(() => {
        return buildFlowElements(graph, highlightedSubsystem, searchTerm);
    }, [graph, highlightedSubsystem, searchTerm]);

    const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

    // Update nodes/edges when graph changes
    React.useEffect(() => {
        setNodes(flowNodes);
        setEdges(flowEdges);
    }, [flowNodes, flowEdges, setNodes, setEdges]);

    const onNodeClick = useCallback(
        (_event: React.MouseEvent, node: Node) => {
            if (node.type === 'moduleNode') {
                onNodeSelect(node.id);
            }
        },
        [onNodeSelect]
    );

    const onNodeDoubleClick = useCallback(
        (_event: React.MouseEvent, node: Node) => {
            if (node.type === 'moduleNode') {
                const graphNode = graph.nodes.find(n => n.id === node.id);
                if (graphNode) {
                    onNavigateToFile(graphNode.filePath);
                }
            }
        },
        [graph, onNavigateToFile]
    );

    const onPaneClick = useCallback(() => {
        onNodeSelect(null);
    }, [onNodeSelect]);

    return (
        <div className="reactflow-container">
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                onNodeDoubleClick={onNodeDoubleClick}
                onPaneClick={onPaneClick}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                minZoom={0.1}
                maxZoom={3}
                defaultEdgeOptions={{
                    type: 'smoothstep',
                    animated: false,
                }}
                proOptions={{ hideAttribution: true }}
            >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--border)" />
                <Controls showInteractive={false} />
                <MiniMap
                    nodeColor={(node) => {
                        const data = node.data as { subsystemColor?: string };
                        return data.subsystemColor || '#666';
                    }}
                    maskColor="rgba(0, 0, 0, 0.6)"
                    style={{ background: 'var(--sidebar-bg)' }}
                />
            </ReactFlow>
        </div>
    );
}

function buildFlowElements(
    graph: ArchitectureGraph,
    highlightedSubsystem: string | null,
    searchTerm: string
): { flowNodes: Node[]; flowEdges: Edge[] } {
    const flowNodes: Node[] = [];
    const flowEdges: Edge[] = [];

    // Group nodes by subsystem for layout
    const groups: Record<string, GraphNode[]> = {};
    for (const node of graph.nodes) {
        const group = node.group || 'ungrouped';
        if (!groups[group]) groups[group] = [];
        groups[group].push(node);
    }

    const groupNames = Object.keys(groups);
    const cols = Math.ceil(Math.sqrt(groupNames.length));
    const groupSpacingX = 500;
    const groupSpacingY = 400;
    const nodeSpacingX = 220;
    const nodeSpacingY = 100;

    let groupIndex = 0;
    for (const groupName of groupNames) {
        const groupNodes = groups[groupName];
        const groupCol = groupIndex % cols;
        const groupRow = Math.floor(groupIndex / cols);
        const baseX = groupCol * groupSpacingX + 50;
        const baseY = groupRow * groupSpacingY + 80;

        // Find subsystem for this group
        const subsystem = graph.subsystems.find(s => s.name === groupName);

        // Add subsystem header node
        if (subsystem) {
            flowNodes.push({
                id: `group-${subsystem.id}`,
                type: 'subsystemNode',
                position: { x: baseX - 10, y: baseY - 50 },
                data: {
                    label: subsystem.name,
                    color: subsystem.color,
                    count: subsystem.nodeIds.length,
                },
                draggable: true,
                selectable: false,
            });
        }

        const innerCols = Math.ceil(Math.sqrt(groupNodes.length));
        for (let i = 0; i < groupNodes.length; i++) {
            const node = groupNodes[i];
            const col = i % innerCols;
            const row = Math.floor(i / innerCols);

            const isDimmed = getDimmedState(node, highlightedSubsystem, searchTerm, graph);

            flowNodes.push({
                id: node.id,
                type: 'moduleNode',
                position: {
                    x: baseX + col * nodeSpacingX,
                    y: baseY + row * nodeSpacingY,
                },
                data: {
                    label: node.label,
                    fullPath: node.id,
                    language: (node.metadata.language as string) || '',
                    symbolCount: node.symbols.length,
                    subsystemColor: subsystem?.color || '',
                    dimmed: isDimmed,
                },
                selected: false,
            });
        }
        groupIndex++;
    }

    // Build edges
    for (const edge of graph.edges) {
        const isHighlighted = !!(
            highlightedSubsystem === null ||
            graph.subsystems.find(s => s.id === highlightedSubsystem)?.nodeIds.includes(edge.source) ||
            graph.subsystems.find(s => s.id === highlightedSubsystem)?.nodeIds.includes(edge.target)
        );

        flowEdges.push({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: 'smoothstep',
            animated: false,
            style: {
                stroke: isHighlighted ? 'var(--accent)' : 'var(--border)',
                strokeWidth: isHighlighted ? 2 : 1,
                opacity: isHighlighted ? 0.8 : 0.3,
            },
            markerEnd: {
                type: MarkerType.ArrowClosed,
                width: 12,
                height: 12,
                color: isHighlighted ? 'var(--accent)' : 'var(--border)',
            },
        });
    }

    return { flowNodes, flowEdges };
}

function getDimmedState(
    node: GraphNode,
    highlightedSubsystem: string | null,
    searchTerm: string,
    graph: ArchitectureGraph
): boolean {
    if (searchTerm) {
        return !node.id.toLowerCase().includes(searchTerm.toLowerCase());
    }
    if (highlightedSubsystem) {
        const sub = graph.subsystems.find(s => s.id === highlightedSubsystem);
        return sub ? !sub.nodeIds.includes(node.id) : false;
    }
    return false;
}
