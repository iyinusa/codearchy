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

// -------------------------------------------------------------------------
// Shape taxonomy — distinct visual symbols per architectural role.
// We infer the shape from the node's type + label/description keywords so
// users can quickly recognize databases, caches, queues, gateways, etc.
// The AI contract remains 4 high-level types (subsystem/layer/service/external);
// shape inference is a purely visual enhancement in the UI layer.
// -------------------------------------------------------------------------
type NodeShape =
    | 'subsystem'
    | 'layer'
    | 'service'
    | 'external'
    | 'database'
    | 'cache'
    | 'queue'
    | 'gateway'
    | 'ui'
    | 'auth'
    | 'cloud'
    | 'worker';

const SHAPE_ICONS: Record<NodeShape, AppIconName> = {
    subsystem: 'nodeSubsystem',
    layer: 'nodeLayer',
    service: 'nodeService',
    external: 'nodeExternal',
    database: 'nodeDatabase',
    cache: 'nodeCache',
    queue: 'nodeQueue',
    gateway: 'nodeGateway',
    ui: 'nodeUi',
    auth: 'nodeAuth',
    cloud: 'nodeCloud',
    worker: 'nodeWorker',
};

const SHAPE_LABELS: Record<NodeShape, string> = {
    subsystem: 'Subsystem',
    layer: 'Layer',
    service: 'Service',
    external: 'External',
    database: 'Database',
    cache: 'Cache',
    queue: 'Queue',
    gateway: 'Gateway',
    ui: 'UI',
    auth: 'Auth',
    cloud: 'Cloud',
    worker: 'Worker',
};

// Extra pixels added to bounding box for silhouettes that pinch inwards
// (hexagon tips, cylinder caps, shield curve, cloud bumps).
const SHAPE_PADDING: Record<NodeShape, number> = {
    subsystem: 0,
    layer: 0,
    service: 0,
    external: 12,
    database: 14,
    cache: 14,
    queue: 10,
    gateway: 16,
    ui: 10,
    auth: 12,
    cloud: 14,
    worker: 12,
};

const SHAPE_KEYWORDS: Array<{ shape: NodeShape; patterns: RegExp }> = [
    // Order matters: more specific matches first.
    { shape: 'database', patterns: /\b(database|db|postgres|postgresql|mysql|mariadb|sqlite|mongo|mongodb|dynamodb|cosmos|persistence|repository|storage|orm|prisma|sequelize|typeorm|mongoose|datastore)\b/i },
    { shape: 'cache', patterns: /\b(cache|caching|redis|memcached|memcache|in[- ]memory)\b/i },
    { shape: 'queue', patterns: /\b(queue|kafka|rabbitmq|rabbit|sqs|pubsub|pub[- ]sub|message[- ]bus|event[- ]bus|broker|stream|topic)\b/i },
    { shape: 'gateway', patterns: /\b(gateway|api[- ]gateway|router|routing|proxy|reverse[- ]proxy|ingress|load[- ]balancer|nginx|traefik|edge)\b/i },
    { shape: 'auth', patterns: /\b(auth|authentication|authorization|identity|iam|oauth|jwt|login|session|permission|security|rbac|sso)\b/i },
    { shape: 'ui', patterns: /\b(ui|gui|frontend|front[- ]end|client|browser|view|page|component|react|vue|angular|svelte|presentation|widget)\b/i },
    { shape: 'cloud', patterns: /\b(cloud|third[- ]party|external[- ]api|saas|webhook|integration|aws|azure|gcp|stripe|twilio|sendgrid)\b/i },
    { shape: 'worker', patterns: /\b(worker|job|cron|scheduler|background|task|batch|processor|consumer|producer)\b/i },
    { shape: 'gateway', patterns: /\b(controller|endpoint|route|api)\b/i }, // catch-all API-ish fallback
];

function inferNodeShape(
    type: string,
    label: string,
    description: string
): NodeShape {
    const haystack = `${label} ${description}`;
    for (const { shape, patterns } of SHAPE_KEYWORDS) {
        if (patterns.test(haystack)) return shape;
    }
    switch (type) {
        case 'external':
            return 'cloud';
        case 'layer':
            return 'layer';
        case 'service':
            return 'service';
        case 'subsystem':
        default:
            return 'subsystem';
    }
}

// -------------------------------------------------------------------------
// SVG silhouette rendered behind each node's content to give it a distinct
// architectural symbol. The bounding box stays rectangular so ELK layout
// and React Flow handles continue to work unchanged.
// -------------------------------------------------------------------------
function ShapeBackground({ shape, color }: { shape: NodeShape; color: string }) {
    return (
        <svg
            className="system-node-shape"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
        >
            <defs>
                <linearGradient id={`grad-${shape}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity="0.18" />
                    <stop offset="100%" stopColor={color} stopOpacity="0.04" />
                </linearGradient>
            </defs>
            {renderShapePath(shape, `url(#grad-${shape})`, color)}
        </svg>
    );
}

function renderShapePath(shape: NodeShape, fill: string, stroke: string) {
    const strokeProps = { stroke, strokeWidth: 1.5, fill, vectorEffect: 'non-scaling-stroke' as const };
    switch (shape) {
        case 'database':
            return (
                <g {...strokeProps}>
                    <path d="M 8 14 Q 8 4 50 4 Q 92 4 92 14 L 92 86 Q 92 96 50 96 Q 8 96 8 86 Z" />
                    <path d="M 8 14 Q 8 24 50 24 Q 92 24 92 14" fill="none" />
                    <path d="M 8 30 Q 8 40 50 40 Q 92 40 92 30" fill="none" opacity="0.5" />
                </g>
            );
        case 'cache':
            return <polygon points="20,6 80,6 96,50 80,94 20,94 4,50" {...strokeProps} />;
        case 'queue':
            return <polygon points="14,10 94,10 86,90 6,90" {...strokeProps} />;
        case 'gateway':
            return (
                <g {...strokeProps}>
                    <polygon points="4,20 86,20 96,50 86,80 4,80 14,50" />
                </g>
            );
        case 'ui':
            return (
                <g {...strokeProps}>
                    <rect x="6" y="8" width="88" height="68" rx="4" />
                    <rect x="38" y="78" width="24" height="6" fill={stroke} opacity="0.35" stroke="none" />
                    <rect x="28" y="84" width="44" height="4" rx="2" fill={stroke} opacity="0.35" stroke="none" />
                </g>
            );
        case 'auth':
            return (
                <path
                    d="M 50 4 L 92 18 L 92 52 Q 92 82 50 96 Q 8 82 8 52 L 8 18 Z"
                    {...strokeProps}
                />
            );
        case 'cloud':
        case 'external':
            return (
                <path
                    d="M 26 74 Q 6 74 6 56 Q 6 42 22 40 Q 24 22 44 22 Q 60 22 64 36 Q 82 34 86 50 Q 96 54 94 66 Q 92 78 78 78 L 28 78 Q 26 78 26 74 Z"
                    {...strokeProps}
                />
            );
        case 'worker':
            return (
                <g {...strokeProps}>
                    <rect x="18" y="18" width="64" height="64" rx="6" />
                    <rect x="32" y="32" width="36" height="36" rx="3" fill="none" opacity="0.6" />
                    {[28, 44, 60, 76].map(y => (
                        <React.Fragment key={`l${y}`}>
                            <line x1="4" y1={y} x2="18" y2={y} />
                            <line x1="82" y1={y} x2="96" y2={y} />
                        </React.Fragment>
                    ))}
                    {[28, 44, 60, 76].map(x => (
                        <React.Fragment key={`v${x}`}>
                            <line x1={x} y1="4" x2={x} y2="18" />
                            <line x1={x} y1="82" x2={x} y2="96" />
                        </React.Fragment>
                    ))}
                </g>
            );
        case 'layer':
            return (
                <g {...strokeProps}>
                    <rect x="6" y="14" width="88" height="22" rx="4" />
                    <rect x="6" y="40" width="88" height="22" rx="4" opacity="0.75" />
                    <rect x="6" y="66" width="88" height="22" rx="4" opacity="0.5" />
                </g>
            );
        case 'service':
            return (
                <g {...strokeProps}>
                    <rect x="6" y="10" width="88" height="80" rx="8" />
                    <circle cx="16" cy="22" r="2.5" fill={stroke} stroke="none" />
                    <circle cx="24" cy="22" r="2.5" fill={stroke} opacity="0.5" stroke="none" />
                    <line x1="6" y1="34" x2="94" y2="34" opacity="0.4" />
                    <line x1="6" y1="58" x2="94" y2="58" opacity="0.4" />
                </g>
            );
        case 'subsystem':
        default:
            return <rect x="4" y="4" width="92" height="92" rx="10" {...strokeProps} />;
    }
}

function SystemNode({ data, selected }: NodeProps) {
    const nodeData = data as {
        label: string;
        description: string;
        nodeType: string;
        color: string;
        childCount: number;
        dimmed: boolean;
        shape: NodeShape;
    };

    const iconName = SHAPE_ICONS[nodeData.shape] ?? 'nodeSubsystem';
    const shapeLabel = SHAPE_LABELS[nodeData.shape] ?? nodeData.nodeType;

    return (
        <div
            className={`system-node shape-${nodeData.shape} ${selected ? 'selected' : ''} ${nodeData.dimmed ? 'dimmed' : ''}`}
            style={{ ['--node-accent' as any]: nodeData.color }}
        >
            <ShapeBackground shape={nodeData.shape} color={nodeData.color} />
            <Handle type="target" position={Position.Top} className="handle" />
            <div className="system-node-inner">
                <div className="system-node-header">
                    <span
                        className="system-node-icon"
                        style={{
                            color: nodeData.color,
                            background: `${nodeData.color}22`,
                            boxShadow: `inset 0 0 0 1px ${nodeData.color}55`,
                        }}
                    >
                        <Icon name={iconName} fixedWidth />
                    </span>
                    <div className="system-node-titles">
                        <span className="system-node-label" title={nodeData.label}>
                            {nodeData.label}
                        </span>
                        <span className="system-node-type" style={{ color: nodeData.color }}>
                            {shapeLabel}
                        </span>
                    </div>
                </div>
                <div className="system-node-desc" title={nodeData.description}>
                    {nodeData.description}
                </div>
                {nodeData.childCount > 0 && (
                    <div className="system-node-footer">
                        <span className="system-node-count">
                            {nodeData.childCount} {nodeData.childCount === 1 ? 'module' : 'modules'}
                        </span>
                    </div>
                )}
            </div>
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
        const shape = inferNodeShape(node.type, node.label, node.description);
        // Non-rectangular shapes (hexagon, cloud, shield, cylinder) need a bit
        // more bounding box so the content doesn't clip the silhouette edges.
        const shapePadding = SHAPE_PADDING[shape] ?? 0;
        const size = estimateNodeSize(node.label, node.description, {
            minWidth: 240,
            maxWidth: 320,
            padding: 36 + shapePadding,
            lineHeight: 18,
        });
        const height = Math.max(140, size.height + 80 + shapePadding);
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
                shape,
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
