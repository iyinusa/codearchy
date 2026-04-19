/** Types shared between extension host and webview UI */

export interface SymbolInfo {
    name: string;
    kind: string;
    filePath: string;
    startLine: number;
    endLine: number;
    exported: boolean;
}

export interface GraphNode {
    id: string;
    label: string;
    filePath: string;
    type: string;
    symbols: SymbolInfo[];
    group?: string;
    metadata: Record<string, unknown>;
}

export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    type: string;
    weight: number;
    metadata: Record<string, unknown>;
}

export interface SubsystemInfo {
    id: string;
    name: string;
    description: string;
    nodeIds: string[];
    color: string;
}

export interface GraphMetadata {
    analyzedAt: number;
    fileCount: number;
    totalSymbols: number;
    totalEdges: number;
    languages: string[];
}

export interface ArchitectureGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    subsystems: SubsystemInfo[];
    metadata: GraphMetadata;
}

export type ViewMode = 'reactflow' | 'cytoscape';

export interface WebviewMessage {
    type: string;
    payload: unknown;
}
