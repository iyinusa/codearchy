import { useEffect, useState } from 'react';

/** The currently active project id (workspace absolute path) as signalled by
 *  the extension host via graphData.metadata.projectId. Views subscribe via
 *  {@link useProjectId} so they re-hydrate positions / history whenever the
 *  user switches to a different workspace in the same webview session. */
let currentProjectId: string | null = null;
const listeners = new Set<(id: string | null) => void>();

export function setProjectId(id: string | null): void {
    if (currentProjectId === id) return;
    currentProjectId = id;
    for (const l of listeners) {
        try { l(id); } catch (e) { console.error('[CodeArchy] project listener error', e); }
    }
}

export function getProjectId(): string | null {
    return currentProjectId;
}

export function useProjectId(): string | null {
    const [id, setId] = useState<string | null>(currentProjectId);
    useEffect(() => {
        const cb = (next: string | null) => setId(next);
        listeners.add(cb);
        // Sync immediately in case the project was set before we subscribed.
        if (currentProjectId !== id) setId(currentProjectId);
        return () => { listeners.delete(cb); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return id;
}
