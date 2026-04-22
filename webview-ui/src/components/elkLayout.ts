// ELK-powered auto-layout for React Flow diagrams.
// Produces clean, non-overlapping, hierarchical layouts with orthogonal routing.
import ELK from 'elkjs/lib/elk.bundled.js';
import type { Node, Edge } from '@xyflow/react';

// Use a shared instance; elkjs spawns a web worker internally.
const elk = new ELK();

export type ElkDirection = 'DOWN' | 'RIGHT' | 'UP' | 'LEFT';

export interface ElkLayoutOptions {
    direction?: ElkDirection;
    algorithm?: 'layered' | 'mrtree' | 'force' | 'stress' | 'box';
    /** Spacing between nodes in the same layer */
    nodeSpacing?: number;
    /** Spacing between layers */
    layerSpacing?: number;
    /** Edge routing style */
    edgeRouting?: 'ORTHOGONAL' | 'POLYLINE' | 'SPLINES';
    /** Padding inside group/parent nodes */
    padding?: number;
}

interface SizedNode extends Node {
    width?: number;
    height?: number;
}

const DEFAULT_NODE_WIDTH = 180;
const DEFAULT_NODE_HEIGHT = 70;

/**
 * Run ELK on a flat or hierarchical (parent/child via `parentId`) graph and
 * return nodes with computed positions. Keeps node data/types intact.
 */
export async function layoutWithElk(
    nodes: SizedNode[],
    edges: Edge[],
    options: ElkLayoutOptions = {}
): Promise<{ nodes: Node[]; edges: Edge[] }> {
    if (nodes.length === 0) return { nodes, edges };

    const {
        direction = 'DOWN',
        algorithm = 'layered',
        nodeSpacing = 60,
        layerSpacing = 90,
        edgeRouting = 'ORTHOGONAL',
        padding = 32,
    } = options;

    const layoutOptions: Record<string, string> = {
        'elk.algorithm': algorithm,
        'elk.direction': direction,
        'elk.spacing.nodeNode': String(nodeSpacing),
        'elk.layered.spacing.nodeNodeBetweenLayers': String(layerSpacing),
        'elk.layered.spacing.edgeNodeBetweenLayers': '40',
        'elk.layered.spacing.edgeEdgeBetweenLayers': '20',
        'elk.edgeRouting': edgeRouting,
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
        'elk.layered.mergeEdges': 'true',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.padding': `[top=${padding + 24},left=${padding},bottom=${padding},right=${padding}]`,
    };

    // Build a hierarchical ELK node tree from React Flow parent/child relations.
    const byId = new Map<string, SizedNode>();
    for (const n of nodes) byId.set(n.id, n);

    interface ElkNode {
        id: string;
        width?: number;
        height?: number;
        children?: ElkNode[];
        layoutOptions?: Record<string, string>;
    }

    const elkNodesById = new Map<string, ElkNode>();
    const rootChildren: ElkNode[] = [];

    for (const n of nodes) {
        const elkNode: ElkNode = {
            id: n.id,
            width: n.width ?? (n.style?.width as number | undefined) ?? DEFAULT_NODE_WIDTH,
            height: n.height ?? (n.style?.height as number | undefined) ?? DEFAULT_NODE_HEIGHT,
        };
        // Parent/group nodes get their own nested layout
        const isGroup = nodes.some(other => other.parentId === n.id);
        if (isGroup) {
            elkNode.layoutOptions = {
                'elk.algorithm': algorithm,
                'elk.direction': direction,
                'elk.padding': `[top=${padding + 24},left=${padding},bottom=${padding},right=${padding}]`,
                'elk.spacing.nodeNode': String(Math.max(24, nodeSpacing - 20)),
                'elk.layered.spacing.nodeNodeBetweenLayers': String(Math.max(40, layerSpacing - 30)),
            };
            // Let ELK size the group to fit its children
            elkNode.width = undefined;
            elkNode.height = undefined;
        }
        elkNodesById.set(n.id, elkNode);
    }

    for (const n of nodes) {
        const elkNode = elkNodesById.get(n.id)!;
        if (n.parentId && elkNodesById.has(n.parentId)) {
            const parent = elkNodesById.get(n.parentId)!;
            parent.children = parent.children || [];
            parent.children.push(elkNode);
        } else {
            rootChildren.push(elkNode);
        }
    }

    // Only pass edges whose endpoints are in the graph.
    const nodeIds = new Set(nodes.map(n => n.id));
    const elkEdges = edges
        .filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
        .map(e => ({ id: e.id, sources: [e.source], targets: [e.target] }));

    const elkGraph = {
        id: 'root',
        layoutOptions,
        children: rootChildren,
        edges: elkEdges,
    };

    const result = await elk.layout(elkGraph as any);

    // Walk ELK result and assign positions. ELK gives positions relative to parent;
    // React Flow expects positions relative to the parent node as well when
    // `parentId` is set, which matches ELK's convention. So we can use positions directly.
    const positioned = new Map<string, { x: number; y: number; width: number; height: number }>();
    const walk = (n: any) => {
        if (typeof n.x === 'number' && typeof n.y === 'number') {
            positioned.set(n.id, {
                x: n.x,
                y: n.y,
                width: n.width ?? DEFAULT_NODE_WIDTH,
                height: n.height ?? DEFAULT_NODE_HEIGHT,
            });
        }
        if (n.children) for (const c of n.children) walk(c);
    };
    walk(result);

    // Apply ELK's computed sizes to every node's inline style so the rendered
    // DOM box matches the layout slot exactly. Without this, CSS `min-width` /
    // content-based sizing causes DOM elements to overflow their assigned
    // position and visually overlap.
    const laidOutNodes: Node[] = nodes.map(n => {
        const p = positioned.get(n.id);
        if (!p) return n;
        return {
            ...n,
            position: { x: p.x, y: p.y },
            width: p.width,
            height: p.height,
            style: {
                ...(n.style || {}),
                width: p.width,
                height: p.height,
            },
        };
    });

    return { nodes: laidOutNodes, edges };
}

/** Rough estimate of rendered node size based on its content. Intentionally
 *  generous to guarantee ELK reserves enough room and nodes don't overlap. */
export function estimateNodeSize(
    label: string,
    subtitle?: string,
    opts: { minWidth?: number; maxWidth?: number; padding?: number; lineHeight?: number } = {}
): { width: number; height: number } {
    const { minWidth = 180, maxWidth = 280, padding = 28, lineHeight = 18 } = opts;
    const charWidth = 7.5;
    const labelPx = label.length * charWidth + padding;
    const subtitlePx = subtitle ? subtitle.length * charWidth + padding : 0;
    const desired = Math.max(labelPx, subtitlePx);
    const width = Math.min(maxWidth, Math.max(minWidth, desired));
    const innerWidth = Math.max(40, width - padding);
    const subtitleLines = subtitle
        ? Math.max(1, Math.ceil((subtitle.length * charWidth) / innerWidth))
        : 0;
    // label line + meta lines + top/bottom padding + bottom bar
    const height = Math.max(
        72,
        padding + lineHeight + subtitleLines * lineHeight + (subtitle ? 12 : 0)
    );
    return { width, height };
}
