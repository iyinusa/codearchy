import React, {
    useMemo,
    useCallback,
    useEffect,
    useState,
    forwardRef,
    useImperativeHandle,
    useRef,
} from 'react';
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
    useReactFlow,
    ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ArchitectureGraph, GraphNode } from '../types';
import { layoutWithElk, estimateNodeSize } from './elkLayout';
import { buildFlowSvg, svgToPngBase64 } from './exportSvg';
import {
    loadFlowPositions,
    saveFlowPositions,
    useProjectId,
    type PositionMap,
} from '../db';

/** Imperative handle exposed to parents so they can export exactly what is on
 *  screen (ELK-laid-out nodes + routed edges) rather than re-running a naive
 *  grid layout that produces a spaghetti diagram. */
export interface ReactFlowViewHandle {
    exportSVG(): string | null;
    exportPNG(): Promise<string | null>;
    /** Smoothly pan + zoom to a node and (optionally) pulse-highlight it so
     *  the Narrator feature can drive an animated walkthrough. */
    focusNode(nodeId: string, action?: 'focus' | 'highlight' | 'zoom'): boolean;
}

interface ReactFlowViewProps {
    graph: ArchitectureGraph;
    selectedNodeId: string | null;
    highlightedSubsystem: string | null;
    searchTerm: string;
    onNodeSelect: (nodeId: string | null) => void;
    onNavigateToFile: (filePath: string, line?: number) => void;
    showMiniMap: boolean;
    /** When set, apply the narrator-active pulse to this node id. */
    narratedNodeId?: string | null;
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
        narrated?: boolean;
    };

    return (
        <div
            className={`module-node ${selected ? 'selected' : ''} ${nodeData.dimmed ? 'dimmed' : ''} ${nodeData.narrated ? 'narrator-active' : ''}`}
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

// Small subsystem header label placed above its first module. Just a marker,
// not a container — every module node stands alone in the layout.
function SubsystemHeaderNode({ data }: NodeProps) {
    const nodeData = data as { label: string; color: string; count: number };
    return (
        <div
            className="subsystem-header-node"
            style={{ borderColor: nodeData.color, color: nodeData.color }}
        >
            <span className="subsystem-header-dot" style={{ background: nodeData.color }} />
            <span>{nodeData.label}</span>
            <span className="subsystem-header-count">{nodeData.count}</span>
        </div>
    );
}

const nodeTypes: NodeTypes = {
    moduleNode: ModuleNode,
    subsystemHeaderNode: SubsystemHeaderNode,
};

function ReactFlowViewInner({
    graph,
    selectedNodeId,
    highlightedSubsystem,
    searchTerm,
    onNodeSelect,
    onNavigateToFile,
    showMiniMap,
    narratedNodeId,
    forwardedRef,
}: ReactFlowViewProps & { forwardedRef?: React.Ref<ReactFlowViewHandle> }) {
    // Build raw (unpositioned) elements from the graph structure only.
    // Cosmetic state (dim / highlight / selection) is applied separately to
    // avoid re-running the expensive auto-layout on every UI interaction.
    const { rawNodes, rawEdges } = useMemo(
        () => buildRawFlowElements(graph),
        [graph]
    );

    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const [isLayouting, setIsLayouting] = useState(false);
    const { fitView, setCenter } = useReactFlow();
    const projectId = useProjectId();

    // Auto-layout trigger: runs whenever the graph structure changes.
    // Prefers DexieJS-cached positions (so user drags persist across reloads)
    // and only falls back to ELK when the cache is missing or partial.
    useEffect(() => {
        let cancelled = false;
        setIsLayouting(true);

        const applyLayout = async () => {
            let cached: PositionMap | null = null;
            if (projectId) {
                try {
                    cached = await loadFlowPositions(projectId);
                } catch (e) {
                    console.error('[CodeArchy] loadFlowPositions failed', e);
                }
            }

            const hasFullCache =
                !!cached && rawNodes.every(n => cached && cached[n.id]);

            if (hasFullCache && cached) {
                if (cancelled) return;
                const positioned: Node[] = rawNodes.map(n => ({
                    ...n,
                    position: cached![n.id],
                }));
                setNodes(positioned);
                setEdges(rawEdges);
                requestAnimationFrame(() => {
                    if (!cancelled) fitView({ padding: 0.2, duration: 300 });
                });
                setIsLayouting(false);
                return;
            }

            try {
                const { nodes: laidOut, edges: laidEdges } = await layoutWithElk(
                    rawNodes,
                    rawEdges,
                    {
                        algorithm: 'layered',
                        direction: 'DOWN',
                        edgeRouting: 'ORTHOGONAL',
                        nodeSpacing: 70,
                        layerSpacing: 110,
                        padding: 36,
                    },
                );
                if (cancelled) return;
                // Overlay cached positions on top of ELK for any nodes the
                // user has previously moved — so existing placements are
                // preserved even when the structure changed slightly.
                const positioned = cached
                    ? laidOut.map(n => (cached![n.id] ? { ...n, position: cached![n.id] } : n))
                    : laidOut;
                setNodes(positioned);
                setEdges(laidEdges);
                requestAnimationFrame(() => {
                    if (!cancelled) fitView({ padding: 0.2, duration: 300 });
                });
                // Persist the fresh layout so subsequent loads skip ELK.
                if (projectId) {
                    const map: PositionMap = {};
                    for (const n of positioned) {
                        map[n.id] = { x: n.position.x, y: n.position.y };
                    }
                    saveFlowPositions(projectId, map);
                }
            } catch (err) {
                console.error('[CodeArchy] ELK layout failed:', err);
                if (!cancelled) {
                    setNodes(rawNodes);
                    setEdges(rawEdges);
                }
            } finally {
                if (!cancelled) setIsLayouting(false);
            }
        };

        applyLayout();

        return () => {
            cancelled = true;
        };
    }, [rawNodes, rawEdges, setNodes, setEdges, fitView, projectId]);

    // Apply cosmetic overlays (dim / highlight / selection) without re-layout.
    useEffect(() => {
        setNodes(curr =>
            curr.map(n => {
                if (n.type !== 'moduleNode') return n;
                const graphNode = graph.nodes.find(g => g.id === n.id);
                if (!graphNode) return n;
                const dimmed = getDimmedState(
                    graphNode,
                    highlightedSubsystem,
                    searchTerm,
                    graph,
                    selectedNodeId
                );
                const isSelected = n.id === selectedNodeId;
                const narrated = !!narratedNodeId && n.id === narratedNodeId;
                if (
                    (n.data as any).dimmed === dimmed &&
                    n.selected === isSelected &&
                    (n.data as any).narrated === narrated
                ) {
                    return n;
                }
                return {
                    ...n,
                    selected: isSelected,
                    data: { ...n.data, dimmed, narrated },
                };
            })
        );

        setEdges(curr =>
            curr.map(e => {
                const isConnectedToSelected = selectedNodeId
                    ? e.source === selectedNodeId || e.target === selectedNodeId
                    : null;
                const isHighlighted = selectedNodeId
                    ? !!isConnectedToSelected
                    : highlightedSubsystem === null ||
                    !!graph.subsystems
                        .find(s => s.id === highlightedSubsystem)
                        ?.nodeIds.includes(e.source) ||
                    !!graph.subsystems
                        .find(s => s.id === highlightedSubsystem)
                        ?.nodeIds.includes(e.target);
                const opacity = selectedNodeId
                    ? isConnectedToSelected
                        ? 0.9
                        : 0.08
                    : isHighlighted
                        ? 0.8
                        : 0.25;
                return {
                    ...e,
                    animated: selectedNodeId ? !!isConnectedToSelected : false,
                    style: {
                        ...(e.style || {}),
                        stroke: isHighlighted ? 'var(--accent)' : 'var(--border)',
                        strokeWidth: isHighlighted ? 2 : 1,
                        opacity,
                    },
                    markerEnd: {
                        type: MarkerType.ArrowClosed,
                        width: 12,
                        height: 12,
                        color: isHighlighted ? 'var(--accent)' : 'var(--border)',
                    },
                };
            })
        );
    }, [graph, selectedNodeId, highlightedSubsystem, searchTerm, setNodes, setEdges, narratedNodeId]);

    const onNodeClick = useCallback(
        (_event: React.MouseEvent, node: Node) => {
            if (node.type === 'moduleNode') {
                onNodeSelect(node.id);
            }
        },
        [onNodeSelect]
    );

    // Intercept node changes to persist positions whenever the user drags.
    // Writes are debounced inside saveFlowPositions so we never stall the
    // drag animation on IndexedDB I/O.
    const handleNodesChange = useCallback(
        (changes: Parameters<typeof onNodesChange>[0]) => {
            onNodesChange(changes);
            if (!projectId) return;
            const hasPositionChange = changes.some(
                c => c.type === 'position' && (c as { position?: unknown }).position,
            );
            if (!hasPositionChange) return;
            // Read the latest positions from the ref populated below so we
            // capture the state AFTER React Flow applied the change.
            queueMicrotask(() => {
                const latest = nodesRef.current;
                if (!latest || !latest.length) return;
                const map: PositionMap = {};
                for (const n of latest) {
                    map[n.id] = { x: n.position.x, y: n.position.y };
                }
                saveFlowPositions(projectId, map);
            });
        },
        [onNodesChange, projectId],
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

    // Keep refs to the latest laid-out nodes/edges so the imperative export
    // handle always sees the current diagram (not a stale closure).
    const nodesRef = useRef<Node[]>([]);
    const edgesRef = useRef<Edge[]>([]);
    const graphRef = useRef<ArchitectureGraph>(graph);
    nodesRef.current = nodes;
    edgesRef.current = edges;
    graphRef.current = graph;

    useImperativeHandle(
        forwardedRef,
        () => ({
            exportSVG(): string | null {
                const g = graphRef.current;
                const laidOut = nodesRef.current;
                if (!laidOut.length) return null;
                return buildFlowSvg(laidOut, edgesRef.current, {
                    groups: g.subsystems.map(s => ({
                        id: s.id,
                        name: s.name,
                        color: s.color,
                        nodeIds: s.nodeIds,
                    })),
                    getNodeVisual: node => {
                        const data = node.data as {
                            label: string;
                            language?: string;
                            symbolCount?: number;
                            subsystemColor?: string;
                        };
                        const subtitle = data.language
                            ? `${data.language} · ${data.symbolCount ?? 0} symbols`
                            : `${data.symbolCount ?? 0} symbols`;
                        return {
                            title: data.label,
                            subtitle,
                            color: data.subsystemColor || '#454545',
                            variant: 'module',
                        };
                    },
                    getEdgeVisual: () => ({ color: '#6b7280', strokeWidth: 1.2 }),
                });
            },
            exportPNG(): Promise<string | null> {
                const svg = this.exportSVG();
                if (!svg) return Promise.resolve(null);
                return new Promise(resolve => {
                    svgToPngBase64(svg, base64 => resolve(base64));
                });
            },
            focusNode(nodeId: string, action: 'focus' | 'highlight' | 'zoom' = 'focus'): boolean {
                const node = nodesRef.current.find(n => n.id === nodeId);
                if (!node) return false;
                const width = (node as { width?: number }).width ?? 200;
                const height = (node as { height?: number }).height ?? 80;
                const cx = node.position.x + width / 2;
                const cy = node.position.y + height / 2;
                const zoom = action === 'zoom' ? 1.5 : action === 'highlight' ? 1.1 : 1.25;
                setCenter(cx, cy, { zoom, duration: 700 });
                return true;
            },
        }),
        [setCenter]
    );

    return (
        <div className="reactflow-container">
            {isLayouting && (
                <div className="elk-layout-overlay" aria-hidden>
                    <div className="elk-layout-pill">Auto-layout…</div>
                </div>
            )}
            <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodesChange={handleNodesChange}
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
                {showMiniMap && (
                    <MiniMap
                        nodeColor={(node) => {
                            const data = node.data as { subsystemColor?: string; dimmed?: boolean };
                            return data.dimmed ? '#333' : data.subsystemColor || '#666';
                        }}
                        maskColor="rgba(0, 0, 0, 0.6)"
                        style={{ background: 'var(--sidebar-bg)' }}
                    />
                )}
            </ReactFlow>
        </div>
    );
}

export const ReactFlowView = forwardRef<ReactFlowViewHandle, ReactFlowViewProps>(
    function ReactFlowView(props, ref) {
        return (
            <ReactFlowProvider>
                <ReactFlowViewInner {...props} forwardedRef={ref} />
            </ReactFlowProvider>
        );
    }
);

function buildRawFlowElements(
    graph: ArchitectureGraph
): { rawNodes: (Node & { width?: number; height?: number })[]; rawEdges: Edge[] } {
    const rawNodes: (Node & { width?: number; height?: number })[] = [];
    const rawEdges: Edge[] = [];

    // Map each module id to its subsystem color so we can tint border bars
    // without needing parent containers.
    const subsystemByNodeId = new Map<string, { name: string; color: string }>();
    for (const sub of graph.subsystems) {
        for (const nid of sub.nodeIds) {
            subsystemByNodeId.set(nid, { name: sub.name, color: sub.color });
        }
    }

    // Flat nodes: every module stands alone, ELK places them, the subsystem
    // colour on the left border communicates grouping visually. Sorting by
    // subsystem before handing to ELK lets its `considerModelOrder` heuristic
    // cluster same-subsystem modules near each other.
    const subsystemIndex = new Map<string, number>();
    graph.subsystems.forEach((s, i) => subsystemIndex.set(s.id, i));
    const sortedGraphNodes = [...graph.nodes].sort((a, b) => {
        const aSub = graph.subsystems.find(s => s.name === (a.group || ''));
        const bSub = graph.subsystems.find(s => s.name === (b.group || ''));
        const ai = aSub ? subsystemIndex.get(aSub.id)! : 999;
        const bi = bSub ? subsystemIndex.get(bSub.id)! : 999;
        if (ai !== bi) return ai - bi;
        return a.label.localeCompare(b.label);
    });

    for (const node of sortedGraphNodes) {
        const sub = subsystemByNodeId.get(node.id);
        const size = estimateNodeSize(
            node.label,
            `${(node.metadata.language as string) || ''} · ${node.symbols.length} symbols`,
            { minWidth: 180, maxWidth: 240, padding: 28 }
        );
        rawNodes.push({
            id: node.id,
            type: 'moduleNode',
            position: { x: 0, y: 0 },
            width: size.width,
            height: Math.max(size.height, 80),
            data: {
                label: node.label,
                fullPath: node.id,
                language: (node.metadata.language as string) || '',
                symbolCount: node.symbols.length,
                subsystemColor: sub?.color || '',
                dimmed: false,
            },
        });
    }

    for (const edge of graph.edges) {
        rawEdges.push({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: 'smoothstep',
            animated: false,
            style: {
                stroke: 'var(--border)',
                strokeWidth: 1,
                opacity: 0.5,
            },
            markerEnd: {
                type: MarkerType.ArrowClosed,
                width: 12,
                height: 12,
                color: 'var(--border)',
            },
        });
    }

    return { rawNodes, rawEdges };
}

function getDimmedState(
    node: GraphNode,
    highlightedSubsystem: string | null,
    searchTerm: string,
    graph: ArchitectureGraph,
    selectedNodeId: string | null
): boolean {
    if (selectedNodeId) {
        if (node.id === selectedNodeId) return false;
        const connected = graph.edges.some(
            e =>
                (e.source === selectedNodeId && e.target === node.id) ||
                (e.target === selectedNodeId && e.source === node.id)
        );
        return !connected;
    }
    if (searchTerm) {
        return !node.id.toLowerCase().includes(searchTerm.toLowerCase());
    }
    if (highlightedSubsystem) {
        const sub = graph.subsystems.find(s => s.id === highlightedSubsystem);
        return sub ? !sub.nodeIds.includes(node.id) : false;
    }
    return false;
}
