import {
    db,
    ProjectRecord,
    PositionMap,
    FlowRecord,
    CytoscapeRecord,
    SystemRecord,
    ConversationMessageRecord,
    NarratorRecord,
    NarratorStepRecord,
} from './database';
import { liveQuery, type Subscription } from 'dexie';
import type { ArchitectureGraph, SystemArchitecture } from '../types';

/** Cheap structural fingerprint — covers node/edge identity changes but
 *  ignores metadata noise that should NOT invalidate cached positions. */
export function hashGraph(graph: ArchitectureGraph): string {
    const nodeIds = graph.nodes.map(n => n.id).sort().join('|');
    const edgeKeys = graph.edges.map(e => `${e.source}>${e.target}`).sort().join('|');
    return djb2(nodeIds + '::' + edgeKeys);
}

function djb2(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

/** Fire-and-forget debounced writer. Swallows errors into the console so a
 *  transient IndexedDB failure never bubbles up into the React render path. */
function debouncedWrite<A extends unknown[]>(
    fn: (...args: A) => Promise<unknown>,
    delay: number,
): (...args: A) => void {
    let handle: number | undefined;
    let latest: A | null = null;
    return (...args: A) => {
        latest = args;
        if (handle !== undefined) window.clearTimeout(handle);
        handle = window.setTimeout(async () => {
            handle = undefined;
            const args2 = latest;
            if (!args2) return;
            try {
                await fn(...args2);
            } catch (e) {
                console.error('[CodeArchy DB] write failed', e);
            }
        }, delay);
    };
}

// ------------------------------------------------------------------
// Project
// ------------------------------------------------------------------

export async function upsertProject(input: {
    id: string;
    name: string;
    path: string;
    graph: ArchitectureGraph;
}): Promise<{ record: ProjectRecord; structureChanged: boolean }> {
    const graphHash = hashGraph(input.graph);
    const now = Date.now();
    const existing = await db.projects.get(input.id);
    const structureChanged = !existing || existing.graphHash !== graphHash;

    const record: ProjectRecord = {
        id: input.id,
        name: input.name,
        path: input.path,
        graphJson: JSON.stringify(input.graph),
        graphHash,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
    await db.projects.put(record);

    // If the structure changed, drop stale position caches for any nodes that
    // no longer exist so the views don't apply ghost coordinates. Also
    // invalidate the cached AI-generated system architecture — it was
    // inferred from the previous codebase topology and is no longer valid.
    if (structureChanged) {
        await pruneStalePositions(input.id, input.graph);
        await db.systems.delete(input.id);
    }

    return { record, structureChanged };
}

async function pruneStalePositions(projectId: string, graph: ArchitectureGraph): Promise<void> {
    const validIds = new Set(graph.nodes.map(n => n.id));
    await db.transaction('rw', db.flows, db.cytoscape, async () => {
        const flow = await db.flows.get(projectId);
        if (flow) {
            const filtered = filterPositions(flow.positions, validIds);
            if (filtered) {
                await db.flows.put({ ...flow, positions: filtered, updatedAt: Date.now() });
            }
        }
        const cyto = await db.cytoscape.get(projectId);
        if (cyto) {
            const filtered = filterPositions(cyto.positions, validIds);
            if (filtered) {
                await db.cytoscape.put({ ...cyto, positions: filtered, updatedAt: Date.now() });
            }
        }
    });
}

function filterPositions(positions: PositionMap, validIds: Set<string>): PositionMap | null {
    let changed = false;
    const next: PositionMap = {};
    for (const [id, pos] of Object.entries(positions)) {
        if (validIds.has(id)) next[id] = pos;
        else changed = true;
    }
    return changed ? next : null;
}

// ------------------------------------------------------------------
// Flow (React Flow view) positions
// ------------------------------------------------------------------

export async function loadFlowPositions(projectId: string): Promise<PositionMap | null> {
    const rec = await db.flows.get(projectId);
    return rec?.positions ?? null;
}

export const saveFlowPositions = debouncedWrite(
    async (projectId: string, positions: PositionMap): Promise<void> => {
        const record: FlowRecord = { projectId, positions, updatedAt: Date.now() };
        await db.flows.put(record);
    },
    350,
);

// ------------------------------------------------------------------
// Cytoscape view positions
// ------------------------------------------------------------------

export async function loadCytoscapePositions(projectId: string): Promise<PositionMap | null> {
    const rec = await db.cytoscape.get(projectId);
    return rec?.positions ?? null;
}

export const saveCytoscapePositions = debouncedWrite(
    async (projectId: string, positions: PositionMap): Promise<void> => {
        const record: CytoscapeRecord = { projectId, positions, updatedAt: Date.now() };
        await db.cytoscape.put(record);
    },
    350,
);

// ------------------------------------------------------------------
// System architecture (AI-generated) + positions
// ------------------------------------------------------------------

export async function loadSystemRecord(
    projectId: string,
): Promise<{ architecture: SystemArchitecture; positions: PositionMap } | null> {
    const rec = await db.systems.get(projectId);
    if (!rec) return null;
    try {
        const architecture = JSON.parse(rec.architectureJson) as SystemArchitecture;
        return { architecture, positions: rec.positions || {} };
    } catch {
        return null;
    }
}

export async function saveSystemArchitecture(
    projectId: string,
    architecture: SystemArchitecture,
): Promise<void> {
    const existing = await db.systems.get(projectId);
    const record: SystemRecord = {
        projectId,
        architectureJson: JSON.stringify(architecture),
        // New architecture payload invalidates any prior saved positions —
        // the set of subsystem ids almost always changes across inferences.
        positions: {},
        updatedAt: Date.now(),
    };
    if (existing) {
        // Preserve positions only if the node id set is identical.
        const oldIds = Object.keys(existing.positions || {});
        const newIds = new Set(architecture.nodes.map(n => n.id));
        const overlap = oldIds.filter(id => newIds.has(id));
        if (overlap.length === oldIds.length && oldIds.length === architecture.nodes.length) {
            record.positions = existing.positions;
        }
    }
    await db.systems.put(record);
}

export const saveSystemPositions = debouncedWrite(
    async (projectId: string, positions: PositionMap): Promise<void> => {
        const existing = await db.systems.get(projectId);
        if (!existing) return; // No architecture cached → nothing to attach to.
        await db.systems.put({ ...existing, positions, updatedAt: Date.now() });
    },
    350,
);

export async function clearSystemArchitecture(projectId: string): Promise<void> {
    await db.systems.delete(projectId);
}

// ------------------------------------------------------------------
// Conversations
// ------------------------------------------------------------------

export async function loadConversation(projectId: string): Promise<ConversationMessageRecord[]> {
    return db.conversations
        .where('projectId')
        .equals(projectId)
        .sortBy('timestamp');
}

export async function appendConversationMessage(
    projectId: string,
    msg: Omit<ConversationMessageRecord, 'id' | 'projectId'>,
): Promise<number> {
    const id = await db.conversations.add({
        projectId,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
    });
    return id as number;
}

export async function updateConversationMessage(
    id: number,
    patch: Partial<Pick<ConversationMessageRecord, 'content' | 'role' | 'timestamp'>>,
): Promise<void> {
    await db.conversations.update(id, patch);
}

export async function deleteConversationMessage(id: number): Promise<void> {
    await db.conversations.delete(id);
}

export async function clearConversation(projectId: string): Promise<void> {
    await db.conversations.where('projectId').equals(projectId).delete();
}

// ------------------------------------------------------------------
// Narrators (AI-generated story-player timelines)
// ------------------------------------------------------------------

export async function listNarrators(projectId: string): Promise<NarratorRecord[]> {
    const all = await db.narrators.where('projectId').equals(projectId).toArray();
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Subscribe to a live, auto-refreshing view of the narrators belonging to
 *  the given project. The callback fires immediately with the current list
 *  and then again on every add / update / delete touching that project —
 *  even when the mutation happens in another tab or the extension host.
 *  Returns an unsubscribe function. */
export function subscribeNarrators(
    projectId: string,
    onChange: (list: NarratorRecord[]) => void,
    onError?: (err: unknown) => void,
): () => void {
    const observable = liveQuery(async () => {
        const all = await db.narrators.where('projectId').equals(projectId).toArray();
        return all.sort((a, b) => b.updatedAt - a.updatedAt);
    });
    const sub: Subscription = observable.subscribe({
        next: onChange,
        error: (err) => {
            console.error('[CodeArchy] narrator liveQuery failed', err);
            onError?.(err);
        },
    });
    return () => sub.unsubscribe();
}

export async function getNarrator(id: number): Promise<NarratorRecord | undefined> {
    return db.narrators.get(id);
}

export async function createNarrator(
    projectId: string,
    data: Omit<NarratorRecord, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>,
): Promise<number> {
    const now = Date.now();
    const id = await db.narrators.add({
        projectId,
        title: data.title,
        question: data.question,
        steps: data.steps,
        preferredView: data.preferredView,
        messageTimestamp: data.messageTimestamp,
        createdAt: now,
        updatedAt: now,
    });
    return id as number;
}

export async function updateNarratorTitle(id: number, title: string): Promise<void> {
    await db.narrators.update(id, { title, updatedAt: Date.now() });
}

export async function updateNarratorSteps(id: number, steps: NarratorStepRecord[]): Promise<void> {
    await db.narrators.update(id, { steps, updatedAt: Date.now() });
}

export async function deleteNarrator(id: number): Promise<void> {
    await db.narrators.delete(id);
}
