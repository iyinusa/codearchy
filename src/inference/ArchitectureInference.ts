import {
    ArchitectureGraph,
    SubsystemInfo,
    GraphNode,
    GraphEdge,
} from '../types';

const SUBSYSTEM_COLORS = [
    '#4FC3F7', '#81C784', '#FFB74D', '#E57373',
    '#BA68C8', '#4DB6AC', '#FF8A65', '#90A4AE',
    '#AED581', '#FFD54F', '#F06292', '#7986CB',
];

const HEURISTIC_GROUPS: Record<string, string[]> = {
    'API / Routes': ['route', 'router', 'controller', 'handler', 'endpoint', 'api', 'middleware'],
    'Models / Data': ['model', 'schema', 'entity', 'dto', 'migration', 'database', 'db', 'repository', 'repo'],
    'Services / Logic': ['service', 'provider', 'manager', 'engine', 'processor', 'worker', 'job', 'task'],
    'Utilities': ['util', 'helper', 'common', 'shared', 'lib', 'tool', 'constant', 'config', 'env'],
    'Views / UI': ['view', 'component', 'page', 'layout', 'template', 'screen', 'widget', 'ui'],
    'Tests': ['test', 'spec', 'mock', 'fixture', '__test__', '__spec__'],
    'Types / Interfaces': ['type', 'interface', 'contract', 'definition', 'typing'],
    'Auth / Security': ['auth', 'login', 'session', 'token', 'permission', 'role', 'guard', 'security', 'password'],
    'Messaging / Events': ['event', 'listener', 'emitter', 'queue', 'pubsub', 'message', 'notification', 'webhook'],
    'Storage / Files': ['storage', 'upload', 'file', 'asset', 'media', 'image', 'blob', 's3'],
};

export class ArchitectureInference {
    inferSubsystems(graph: ArchitectureGraph): ArchitectureGraph {
        const subsystems: SubsystemInfo[] = [];
        const assignments = new Map<string, string>();

        // Phase 1: Directory-based grouping
        const dirGroups = this.groupByDirectory(graph.nodes);

        // Phase 2: Heuristic semantic grouping
        for (const node of graph.nodes) {
            const heuristicGroup = this.matchHeuristicGroup(node);
            if (heuristicGroup) {
                assignments.set(node.id, heuristicGroup);
            }
        }

        // Phase 3: Merge directory grouping with heuristic grouping
        for (const [dir, nodeIds] of dirGroups) {
            const heuristicCounts = new Map<string, number>();
            for (const nodeId of nodeIds) {
                const group = assignments.get(nodeId);
                if (group) {
                    heuristicCounts.set(group, (heuristicCounts.get(group) || 0) + 1);
                }
            }

            let groupName: string;
            if (heuristicCounts.size > 0) {
                // Use the most common heuristic group in this directory
                groupName = [...heuristicCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
            } else {
                groupName = this.humanizeDirectoryName(dir);
            }

            for (const nodeId of nodeIds) {
                if (!assignments.has(nodeId)) {
                    assignments.set(nodeId, groupName);
                }
            }
        }

        // Phase 4: Connectivity-based refinement
        this.refineByConnectivity(graph, assignments);

        // Build subsystem objects
        const groupedNodes = new Map<string, string[]>();
        for (const [nodeId, group] of assignments) {
            const existing = groupedNodes.get(group) || [];
            existing.push(nodeId);
            groupedNodes.set(group, existing);
        }

        let colorIndex = 0;
        for (const [name, nodeIds] of groupedNodes) {
            if (nodeIds.length === 0) continue;

            subsystems.push({
                id: `subsystem-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                name,
                description: `Contains ${nodeIds.length} module(s): ${this.describeSubsystem(nodeIds, graph)}`,
                nodeIds,
                color: SUBSYSTEM_COLORS[colorIndex % SUBSYSTEM_COLORS.length],
            });
            colorIndex++;
        }

        // Assign group info to nodes
        const updatedNodes = graph.nodes.map((node) => ({
            ...node,
            group: assignments.get(node.id),
        }));

        return {
            ...graph,
            nodes: updatedNodes,
            subsystems,
        };
    }

    private groupByDirectory(nodes: GraphNode[]): Map<string, string[]> {
        const groups = new Map<string, string[]>();
        for (const node of nodes) {
            const parts = node.id.split('/');
            const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
            const existing = groups.get(dir) || [];
            existing.push(node.id);
            groups.set(dir, existing);
        }
        return groups;
    }

    private matchHeuristicGroup(node: GraphNode): string | undefined {
        const lowerPath = node.id.toLowerCase();
        const lowerLabel = node.label.toLowerCase();
        const combined = `${lowerPath} ${lowerLabel}`;

        for (const [groupName, keywords] of Object.entries(HEURISTIC_GROUPS)) {
            for (const keyword of keywords) {
                if (combined.includes(keyword)) {
                    return groupName;
                }
            }
        }
        return undefined;
    }

    private refineByConnectivity(graph: ArchitectureGraph, assignments: Map<string, string>) {
        const unassigned = graph.nodes.filter((n) => !assignments.has(n.id));
        if (unassigned.length === 0) return;

        const adjacency = this.buildAdjacency(graph.edges);

        for (const node of unassigned) {
            const neighbors = adjacency.get(node.id) || [];
            const neighborGroups = new Map<string, number>();

            for (const neighborId of neighbors) {
                const group = assignments.get(neighborId);
                if (group) {
                    neighborGroups.set(group, (neighborGroups.get(group) || 0) + 1);
                }
            }

            if (neighborGroups.size > 0) {
                const bestGroup = [...neighborGroups.entries()].sort((a, b) => b[1] - a[1])[0][0];
                assignments.set(node.id, bestGroup);
            } else {
                assignments.set(node.id, 'Other');
            }
        }
    }

    private buildAdjacency(edges: GraphEdge[]): Map<string, string[]> {
        const adj = new Map<string, string[]>();
        for (const edge of edges) {
            const sourceNeighbors = adj.get(edge.source) || [];
            sourceNeighbors.push(edge.target);
            adj.set(edge.source, sourceNeighbors);

            const targetNeighbors = adj.get(edge.target) || [];
            targetNeighbors.push(edge.source);
            adj.set(edge.target, targetNeighbors);
        }
        return adj;
    }

    private humanizeDirectoryName(dir: string): string {
        const parts = dir.split('/');
        const last = parts[parts.length - 1] || dir;
        return last.charAt(0).toUpperCase() + last.slice(1).replace(/[-_]/g, ' ');
    }

    private describeSubsystem(nodeIds: string[], graph: ArchitectureGraph): string {
        const maxShow = 3;
        const nodes = nodeIds.slice(0, maxShow).map((id) => {
            const node = graph.nodes.find((n) => n.id === id);
            return node?.label || id;
        });
        const suffix = nodeIds.length > maxShow ? ` and ${nodeIds.length - maxShow} more` : '';
        return nodes.join(', ') + suffix;
    }
}
