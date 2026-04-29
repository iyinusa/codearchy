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
    /** Stable identity for persistence (workspace absolute path). */
    projectId?: string;
    projectName?: string;
    projectPath?: string;
}

export interface ArchitectureGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    subsystems: SubsystemInfo[];
    metadata: GraphMetadata;
}

export type ViewMode = 'system' | 'reactflow' | 'cytoscape';

export type ProcessingMode = 'fast' | 'moderate' | 'indepth';

export interface WebviewMessage {
    type: string;
    payload: unknown;
}

// AI Model types
export interface ModelOption {
    id: 'gemma-e2b' | 'gemma-e4b';
    label: string;
    ollamaTag: string;
    description: string;
    paramSize: string;
    diskSize: string;
    ramRequired: string;
    installed: boolean;
}

export interface ModelStatusPayload {
    ollamaRunning: boolean;
    models: ModelOption[];
    selectedModel: string | null;
}

// System Architecture types
export interface SystemArchNode {
    id: string;
    label: string;
    description: string;
    type: 'subsystem' | 'layer' | 'service' | 'external';
    color: string;
    children?: string[];
}

export interface SystemArchEdge {
    id: string;
    source: string;
    target: string;
    label: string;
    type: 'dependency' | 'data-flow' | 'api-call' | 'event';
}

export interface SystemArchitecture {
    nodes: SystemArchNode[];
    edges: SystemArchEdge[];
    pattern: string;
    summary: string;
}

// Chat types
export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    isStreaming?: boolean;
    /** Dexie auto-increment id once the message is persisted. */
    id?: number;
    /** Cached Kokoro PCM buffer for this message (assistant only). */
    voice?: ArrayBuffer;
    /** Kokoro voice id the cached PCM was synthesised with. */
    voiceId?: string;
    /** Sample rate of the cached PCM (Hz). */
    voiceSampleRate?: number;
}

// Narrator types (AI-generated story-player timeline)
export type NarratorAction = 'focus' | 'highlight' | 'zoom';

export interface NarratorStep {
    targetNodeId: string;
    narration: string;
    action: NarratorAction;
    durationMs?: number;
    /** Cached Kokoro PCM for this step's narration. */
    voice?: ArrayBuffer;
    /** Kokoro voice id the cached PCM was synthesised with. */
    voiceId?: string;
    /** Sample rate of the cached PCM (Hz). */
    voiceSampleRate?: number;
}

export interface NarratorPayload {
    title: string;
    question: string;
    steps: NarratorStep[];
    preferredView: 'system' | 'reactflow';
    messageTimestamp?: number;
}
