import * as vscode from 'vscode';

export interface SymbolInfo {
    name: string;
    kind: SymbolKind;
    filePath: string;
    startLine: number;
    endLine: number;
    exported: boolean;
}

export enum SymbolKind {
    Function = 'function',
    Class = 'class',
    Interface = 'interface',
    Variable = 'variable',
    Type = 'type',
    Enum = 'enum',
    Module = 'module',
    Method = 'method',
}

export interface ImportInfo {
    source: string;
    specifiers: string[];
    isDefault: boolean;
    isNamespace: boolean;
    filePath: string;
}

export interface FileAnalysis {
    filePath: string;
    language: string;
    symbols: SymbolInfo[];
    imports: ImportInfo[];
    exports: string[];
}

export interface GraphNode {
    id: string;
    label: string;
    filePath: string;
    type: NodeType;
    symbols: SymbolInfo[];
    group?: string;
    metadata: Record<string, unknown>;
}

export enum NodeType {
    File = 'file',
    Module = 'module',
    Subsystem = 'subsystem',
}

export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    type: EdgeType;
    weight: number;
    metadata: Record<string, unknown>;
}

export enum EdgeType {
    Import = 'import',
    Export = 'export',
    Dependency = 'dependency',
    Composition = 'composition',
}

export interface ArchitectureGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    subsystems: SubsystemInfo[];
    metadata: GraphMetadata;
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
    /** Display name for the project (usually folder basename). */
    projectName?: string;
    /** Absolute filesystem path of the workspace root. */
    projectPath?: string;
}

export interface WebviewMessage {
    type: WebviewMessageType;
    payload: unknown;
}

export enum WebviewMessageType {
    Ready = 'ready',
    GraphData = 'graphData',
    NodeSelected = 'nodeSelected',
    RefreshRequest = 'refreshRequest',
    AnalysisProgress = 'analysisProgress',
    AnalysisComplete = 'analysisComplete',
    Error = 'error',
    NavigateToFile = 'navigateToFile',
    FilterChanged = 'filterChanged',
    ExportSVG = 'exportSVG',
    ExportPNG = 'exportPNG',
    ExportResult = 'exportResult',
    SwitchView = 'switchView',
    // AI Model & System Architecture
    RequestModelStatus = 'requestModelStatus',
    ModelStatus = 'modelStatus',
    SelectModel = 'selectModel',
    GenerateSystemArch = 'generateSystemArch',
    SystemArchData = 'systemArchData',
    SystemArchProgress = 'systemArchProgress',
    // Chat / Conversation
    ChatMessage = 'chatMessage',
    ChatResponse = 'chatResponse',
    ChatChunk = 'chatChunk',
    ChatThinking = 'chatThinking',
    ClearChat = 'clearChat',
    /** Webview → host: replace the host-side conversation history so the LLM
     *  context window matches the persisted DexieJS store after a delete. */
    SyncChatHistory = 'syncChatHistory',
    // Voice input (extension-host capture)
    StartVoiceRecording = 'startVoiceRecording',
    StopVoiceRecording = 'stopVoiceRecording',
    VoiceRecordingState = 'voiceRecordingState',
    VoiceTranscript = 'voiceTranscript',
}

export interface AnalysisProgress {
    phase: string;
    current: number;
    total: number;
    message: string;
}

export interface ExtensionConfig {
    includedLanguages: string[];
    excludePatterns: string[];
    maxFileSize: number;
    aiModel: 'gemma-e2b' | 'gemma-e4b' | 'none';
}

export function getConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('codearchy');
    return {
        includedLanguages: config.get<string[]>('includedLanguages', ['typescript', 'javascript', 'python', 'java', 'go', 'rust']),
        excludePatterns: config.get<string[]>('excludePatterns', ['**/node_modules/**', '**/dist/**', '**/out/**']),
        maxFileSize: config.get<number>('maxFileSize', 500000),
        aiModel: config.get<'gemma-e2b' | 'gemma-e4b' | 'none'>('aiModel', 'none'),
    };
}

export const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
    typescript: ['.ts', '.tsx'],
    javascript: ['.js', '.jsx', '.mjs', '.cjs'],
    python: ['.py'],
    java: ['.java'],
    go: ['.go'],
    rust: ['.rs'],
};

export function getLanguageFromExtension(ext: string): string | undefined {
    for (const [lang, exts] of Object.entries(LANGUAGE_EXTENSIONS)) {
        if (exts.includes(ext)) {
            return lang;
        }
    }
    return undefined;
}
