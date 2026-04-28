import Dexie, { Table } from 'dexie';

export interface ProjectRecord {
    /** Stable project identifier — workspace absolute path. */
    id: string;
    name: string;
    path: string;
    /** Serialized ArchitectureGraph (last known structure from the pipeline). */
    graphJson: string;
    /** Fast structural fingerprint (node/edge ids) used to decide if cached
     *  positions can still be reused. */
    graphHash: string;
    createdAt: number;
    updatedAt: number;
}

export interface PositionMap {
    [nodeId: string]: { x: number; y: number };
}

export interface FlowRecord {
    /** projectId is the primary key so we only ever keep one record per project. */
    projectId: string;
    positions: PositionMap;
    updatedAt: number;
}

export interface CytoscapeRecord {
    projectId: string;
    positions: PositionMap;
    updatedAt: number;
}

export interface SystemRecord {
    projectId: string;
    /** Serialized SystemArchitecture from the AI inference pipeline. */
    architectureJson: string;
    positions: PositionMap;
    updatedAt: number;
}

export interface ConversationMessageRecord {
    id?: number;
    projectId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    /** Cached Kokoro-synthesised PCM (Float32, mono) for this message.
     *  Stored as a raw ArrayBuffer in IndexedDB. Null until the background
     *  synthesiser produces audio (assistant messages only). */
    voice?: ArrayBuffer;
    /** Kokoro voice id the cached PCM was generated with. */
    voiceId?: string;
    /** Sample rate of the cached PCM (Hz). */
    voiceSampleRate?: number;
}

/** Persisted AI-generated narration timeline, driven by the Narrator feature.
 *  A narrator is silently produced each time the assistant replies so the
 *  user can replay the explanation as an animated walkthrough of the graph. */
export interface NarratorStepRecord {
    /** Id of the node to focus on during this step. Must match an id present
     *  in either the ArchitectureGraph or SystemArchitecture node set. */
    targetNodeId: string;
    /** Human-readable narration line — spoken via Web Speech + shown inline. */
    narration: string;
    /** Visual action to apply to the target node. */
    action: 'focus' | 'highlight' | 'zoom';
    /** Optional hint for how long to dwell on this step if TTS is unavailable. */
    durationMs?: number;
    /** Cached Kokoro-synthesised PCM for this step's narration. Populated by
     *  the background pre-synth pass kicked off after narrator creation. */
    voice?: ArrayBuffer;
    /** Kokoro voice id the cached PCM was generated with. */
    voiceId?: string;
    /** Sample rate of the cached PCM (Hz). */
    voiceSampleRate?: number;
}

export interface NarratorRecord {
    id?: number;
    projectId: string;
    /** Short title (user-editable). */
    title: string;
    /** The user question that seeded the narration (kept for search). */
    question: string;
    /** Timeline of steps. */
    steps: NarratorStepRecord[];
    /** Which view fits the narration best. */
    preferredView: 'system' | 'reactflow';
    /** Links the narrator to the chat message that produced it. */
    messageTimestamp?: number;
    createdAt: number;
    updatedAt: number;
}

export class CodeArchyDatabase extends Dexie {
    projects!: Table<ProjectRecord, string>;
    flows!: Table<FlowRecord, string>;
    cytoscape!: Table<CytoscapeRecord, string>;
    systems!: Table<SystemRecord, string>;
    conversations!: Table<ConversationMessageRecord, number>;
    narrators!: Table<NarratorRecord, number>;

    constructor() {
        super('CodeArchy');
        this.version(1).stores({
            projects: 'id, path, updatedAt',
            flows: 'projectId',
            cytoscape: 'projectId',
            systems: 'projectId',
            conversations: '++id, projectId, timestamp',
        });
        // v2 — narrators table for AI narration timelines
        this.version(2).stores({
            projects: 'id, path, updatedAt',
            flows: 'projectId',
            cytoscape: 'projectId',
            systems: 'projectId',
            conversations: '++id, projectId, timestamp',
            narrators: '++id, projectId, updatedAt, messageTimestamp',
        });
        // v3 — adds voice / voiceId / voiceSampleRate to conversations &
        // narrator steps. No index changes needed; the new fields are simply
        // additional columns on existing rows.
        this.version(3).stores({
            projects: 'id, path, updatedAt',
            flows: 'projectId',
            cytoscape: 'projectId',
            systems: 'projectId',
            conversations: '++id, projectId, timestamp',
            narrators: '++id, projectId, updatedAt, messageTimestamp',
        });
    }
}

export const db = new CodeArchyDatabase();
