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
}

export class CodeArchyDatabase extends Dexie {
    projects!: Table<ProjectRecord, string>;
    flows!: Table<FlowRecord, string>;
    cytoscape!: Table<CytoscapeRecord, string>;
    systems!: Table<SystemRecord, string>;
    conversations!: Table<ConversationMessageRecord, number>;

    constructor() {
        super('CodeArchy');
        this.version(1).stores({
            projects: 'id, path, updatedAt',
            flows: 'projectId',
            cytoscape: 'projectId',
            systems: 'projectId',
            conversations: '++id, projectId, timestamp',
        });
    }
}

export const db = new CodeArchyDatabase();
