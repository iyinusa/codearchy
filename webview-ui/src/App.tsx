import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ArchitectureGraph, ViewMode, SystemArchitecture, ProcessingMode, NarratorStep, NarratorPayload } from './types';
import { postMessage } from './vscode';
import { ReactFlowView } from './components/ReactFlowView';
import type { ReactFlowViewHandle } from './components/ReactFlowView';
import { CytoscapeView } from './components/CytoscapeView';
import type { CytoscapeViewHandle } from './components/CytoscapeView';
import { SystemView } from './components/SystemView';
import type { SystemViewHandle } from './components/SystemView';
import { Sidebar } from './components/Sidebar';
import { DetailPanel } from './components/DetailPanel';
import { Toolbar } from './components/Toolbar';
import { ModelSelector } from './components/ModelSelector';
import { VoiceSelector } from './components/VoiceSelector';
import { ChatPanel } from './components/ChatPanel';
import { Icon } from './components/Icons';
import { useStoryPlayer } from './components/useStoryPlayer';
import { subscribeSynthesizing, synthesizeKokoroAudio, isKokoroActive, getActiveKokoroVoiceId } from './voice/ttsManager';
import {
    setProjectId,
    getProjectId,
    upsertProject,
    loadSystemRecord,
    saveSystemArchitecture,
    createNarrator,
    updateNarratorStepVoice,
    subscribeNarrators,
    type NarratorRecord,
} from './db';

export function App() {
    const [graph, setGraph] = useState<ArchitectureGraph | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>('reactflow');
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [highlightedSubsystem, setHighlightedSubsystem] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [showMiniMap, setShowMiniMap] = useState(true);
    const [showModelSelector, setShowModelSelector] = useState(false);
    const [showVoiceSelector, setShowVoiceSelector] = useState(false);
    const [systemArch, setSystemArch] = useState<SystemArchitecture | null>(null);
    const [isGeneratingArch, setIsGeneratingArch] = useState(false);
    const [archProgress, setArchProgress] = useState<string>('');
    /** Raw model output streamed during architecture generation. Shown to the
     *  user as a live transcript so long waits feel responsive. */
    const [archStream, setArchStream] = useState<string>('');
    const [chatOpen, setChatOpen] = useState(false);
    const [processingMode, setProcessingMode] = useState<ProcessingMode>('moderate');
    const [narrators, setNarrators] = useState<NarratorRecord[]>([]);
    const [narrationViewMode, setNarrationViewMode] = useState<ViewMode | null>(null);
    const [narratedNodeId, setNarratedNodeId] = useState<string | null>(null);
    /** True while the TTS engine is synthesising audio but no sound has
     *  started playing yet. Drives the top-right "voice processing" overlay. */
    const [voiceSynthesizing, setVoiceSynthesizing] = useState(false);
    /** True between sending a generateNarrator request and receiving the
     *  generated payload. Drives the shimmer placeholder at the top of the
     *  narrations list so the user sees instant feedback. */
    const [narratorGenerating, setNarratorGenerating] = useState(false);
    /** Per-narrator voice-cache build progress (done/total chunks). Surfaces
     *  as a ring-progress around each narrator's play button. Entries are
     *  removed once the cache build completes. */
    const [narratorSynthProgress, setNarratorSynthProgress] = useState<
        Record<number, { done: number; total: number }>
    >({});
    const mainContentRef = useRef<HTMLDivElement>(null);
    const cytoscapeRef = useRef<CytoscapeViewHandle>(null);
    const reactFlowRef = useRef<ReactFlowViewHandle>(null);
    const systemViewRef = useRef<SystemViewHandle>(null);
    const archStreamBodyRef = useRef<HTMLPreElement>(null);
    const systemArchRef = useRef<SystemArchitecture | null>(null);
    systemArchRef.current = systemArch;
    const viewModeRef = useRef<ViewMode>(viewMode);
    viewModeRef.current = viewMode;

    // Scroll the arch-stream body to the bottom as new model tokens arrive.
    useEffect(() => {
        if (archStreamBodyRef.current) {
            archStreamBodyRef.current.scrollTop = archStreamBodyRef.current.scrollHeight;
        }
    }, [archStream]);

    // Kokoro is no longer eagerly started on app mount — the user explicitly
    // activates the neural voice engine from the Voice Configuration modal.
    // This avoids surprising background work on first webview launch.

    // Mirror the TTS "synthesizing" flag into local state so we can render
    // a top-right processing indicator while the engine prepares audio.
    useEffect(() => {
        return subscribeSynthesizing(setVoiceSynthesizing);
    }, []);

    /** Focus a narrated node, switching to the best-fit view automatically so
     *  the target is actually visible. System view is preferred when the id
     *  matches a subsystem; otherwise fall back to React Flow.
     *
     *  Robust against the race between view-mode change and ELK layout —
     *  `focusNode()` returns false until the node has rendered with a real
     *  position, so we retry on a short cadence (~50 ms × 60 = up to 3 s)
     *  until either the focus succeeds or we time out. Without this the
     *  first step of a story routinely missed its highlight + zoom because
     *  ReactFlow / SystemView wasn't done laying out yet.
     */
    const focusRetryRef = useRef<number | null>(null);
    const focusNarratedNode = useCallback((step: NarratorStep) => {
        setNarratedNodeId(step.targetNodeId);
        const sys = systemArchRef.current;
        const hasSystemHit = !!sys?.nodes.some(n => n.id === step.targetNodeId);
        const preferredMode: ViewMode = hasSystemHit ? 'system' : 'reactflow';
        if (viewModeRef.current !== preferredMode) {
            setViewMode(preferredMode);
            setNarrationViewMode(preferredMode);
        }

        // Cancel any prior in-flight retry loop so a fast step change can't
        // leave two loops competing for the same view.
        if (focusRetryRef.current !== null) {
            window.clearTimeout(focusRetryRef.current);
            focusRetryRef.current = null;
        }

        const startedAt = performance.now();
        const tryFocus = () => {
            focusRetryRef.current = null;
            // Bail out if the user moved on to a different step (or stopped)
            // in the meantime — the next step will start its own loop.
            const ref = preferredMode === 'system'
                ? systemViewRef.current
                : reactFlowRef.current;
            const ok = ref?.focusNode(step.targetNodeId, step.action) ?? false;
            if (ok) return;
            // Retry for up to ~3 s — enough for ELK layout to finish even on
            // larger graphs while still feeling instant when the view is
            // already warm.
            if (performance.now() - startedAt > 3000) return;
            focusRetryRef.current = window.setTimeout(tryFocus, 50);
        };
        // Defer the first attempt one frame so React commits the view-mode
        // change before we ask the new view for an imperative focus.
        requestAnimationFrame(() => requestAnimationFrame(tryFocus));
    }, []);

    // Cancel any pending focus retry on unmount so we don't poke a torn-down view.
    useEffect(
        () => () => {
            if (focusRetryRef.current !== null) {
                window.clearTimeout(focusRetryRef.current);
                focusRetryRef.current = null;
            }
        },
        [],
    );

    const storyPlayer = useStoryPlayer(focusNarratedNode);

    // Clear narrated highlight when the player stops.
    useEffect(() => {
        if (storyPlayer.state.status === 'idle') {
            setNarratedNodeId(null);
            setNarrationViewMode(null);
        }
    }, [storyPlayer.state.status]);

    // Live-subscribe to the narrators table so new entries — whether added
    // by the AI auto-generator, rename/delete, or any other tab — surface
    // in the sidebar instantly with no manual refetch required.
    const projectIdState = graph?.metadata?.projectId;
    useEffect(() => {
        if (!projectIdState) {
            setNarrators([]);
            return;
        }
        const unsubscribe = subscribeNarrators(
            projectIdState,
            (list) => setNarrators(list),
        );
        return unsubscribe;
    }, [projectIdState]);

    // Kept as a no-op stable reference so existing Sidebar prop wiring
    // remains unchanged. The live subscription above now handles refresh.
    const refreshNarrators = useCallback(() => {
        /* no-op — liveQuery keeps state in sync automatically */
    }, []);

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const message = event.data;
            switch (message.type) {
                case 'graphData': {
                    const nextGraph = message.payload as ArchitectureGraph;
                    setGraph(nextGraph);

                    // Sync project identity + codebase tree to IndexedDB and
                    // hydrate any cached system architecture for this project
                    // so the diagram shows up instantly even before the user
                    // re-runs AI Analyze.
                    const projectId = nextGraph.metadata?.projectId;
                    if (projectId) {
                        setProjectId(projectId);
                        const projectName = nextGraph.metadata?.projectName || projectId;
                        const projectPath = nextGraph.metadata?.projectPath || projectId;

                        // Fire-and-forget — never block render on IDB writes.
                        (async () => {
                            try {
                                const { structureChanged } = await upsertProject({
                                    id: projectId,
                                    name: projectName,
                                    path: projectPath,
                                    graph: nextGraph,
                                });
                                if (structureChanged) {
                                    // Codebase topology changed → the cached
                                    // AI architecture (if any) is now stale.
                                    // upsertProject already cleared IDB; drop
                                    // it from session state too so the user
                                    // sees a fresh "Generate" prompt instead
                                    // of outdated subsystems.
                                    setSystemArch(null);
                                    return;
                                }
                                const cached = await loadSystemRecord(projectId);
                                if (cached) {
                                    // Only hydrate if the current session has
                                    // no system arch yet — don't clobber a
                                    // freshly generated architecture.
                                    setSystemArch(prev => {
                                        if (prev) return prev;
                                        // Sync to extension host so the chat
                                        // system prompt has the subsystem data
                                        // even after a webview reload.
                                        postMessage('syncSystemArch', { architecture: cached.architecture });
                                        return cached.architecture;
                                    });
                                }
                            } catch (e) {
                                console.error('[CodeArchy] failed to hydrate project', e);
                            }
                        })();
                    }
                    break;
                }
                case 'exportSVG':
                    exportAsSVG();
                    break;
                case 'exportPNG':
                    exportAsPNG();
                    break;
                case 'systemArchData': {
                    const arch = message.payload as SystemArchitecture;
                    setSystemArch(arch);
                    setIsGeneratingArch(false);
                    setArchProgress('');
                    setArchStream('');
                    setViewMode('system');
                    // Persist the freshly generated architecture so it survives
                    // webview reloads and workspace reopenings. We read the id
                    // from the project-context singleton — reading from the
                    // `graph` closure would capture a stale null because this
                    // handler is registered once with empty deps.
                    const projectId = getProjectId();
                    if (projectId) {
                        saveSystemArchitecture(projectId, arch).catch(e =>
                            console.error('[CodeArchy] failed to save system arch', e),
                        );
                    }
                    break;
                }
                case 'systemArchProgress': {
                    const prog = message.payload as { message: string };
                    setArchProgress(prog.message);
                    break;
                }
                case 'systemArchStream': {
                    const payload = message.payload as { chunk: string };
                    if (payload?.chunk) {
                        setArchStream(prev => prev + payload.chunk);
                    }
                    break;
                }
                case 'setProcessingMode': {
                    const payload = message.payload as { mode: ProcessingMode };
                    if (payload?.mode) {
                        setProcessingMode(payload.mode);
                    }
                    break;
                }
                case 'error': {
                    const err = message.payload as { message: string };
                    setIsGeneratingArch(false);
                    setArchProgress('');
                    setArchStream('');
                    // Error shown via chat or inline
                    console.error('CodeArchy error:', err.message);
                    break;
                }
                case 'narratorGenerated': {
                    const payload = message.payload as NarratorPayload;
                    // Always clear the "generating" shimmer once a payload
                    // arrives, even if it turns out to be invalid below.
                    setNarratorGenerating(false);
                    if (!payload || !Array.isArray(payload.steps) || payload.steps.length === 0) {
                        break;
                    }
                    const pid = getProjectId();
                    if (!pid) break;
                    // Persist only — the live Dexie subscription above will
                    // push the new record into `narrators` state instantly.
                    (async () => {
                        try {
                            const narratorId = await createNarrator(pid, {
                                title: payload.title,
                                question: payload.question,
                                steps: payload.steps,
                                preferredView: payload.preferredView,
                                messageTimestamp: payload.messageTimestamp,
                            });
                            // Background voice cache: synthesise each step
                            // with the active Kokoro voice and persist the
                            // PCM so the narrator timeline plays back fluidly
                            // without 5-15 s synth gaps. Sequential to avoid
                            // saturating the worker; per-step failures are
                            // swallowed so one bad step doesn't kill the rest.
                            //
                            // Progress is tracked at step granularity so the
                            // sidebar can render a ring around the play btn
                            // and switch to "ready" the moment all steps are
                            // synthesised. We seed `done:0,total:n` upfront
                            // so the ring appears immediately at 0 %.
                            if (isKokoroActive() && payload.steps.length) {
                                const voiceId = getActiveKokoroVoiceId();
                                const total = payload.steps.length;
                                setNarratorSynthProgress(prev => ({
                                    ...prev,
                                    [narratorId]: { done: 0, total },
                                }));
                                void (async () => {
                                    for (let i = 0; i < payload.steps.length; i++) {
                                        const step = payload.steps[i];
                                        try {
                                            const audio = await synthesizeKokoroAudio(
                                                step.narration,
                                                voiceId,
                                                undefined,
                                                'narrator',
                                            );
                                            if (audio) {
                                                await updateNarratorStepVoice(narratorId, i, audio);
                                            }
                                        } catch (e) {
                                            console.warn('[CodeArchy] narrator pre-synth failed at step', i, e);
                                        }
                                        // Bump per-step progress regardless
                                        // of success so the ring always
                                        // completes even when individual
                                        // chunks fail.
                                        setNarratorSynthProgress(prev => {
                                            const cur = prev[narratorId];
                                            if (!cur) return prev;
                                            return {
                                                ...prev,
                                                [narratorId]: { done: i + 1, total: cur.total },
                                            };
                                        });
                                    }
                                    // Drop the entry — the absence of an
                                    // entry is the "ready" signal for the
                                    // sidebar.
                                    setNarratorSynthProgress(prev => {
                                        if (!(narratorId in prev)) return prev;
                                        const next = { ...prev };
                                        delete next[narratorId];
                                        return next;
                                    });
                                })();
                            }
                        } catch (e) {
                            console.error('[CodeArchy] save narrator failed', e);
                        }
                    })();
                    break;
                }
            }
        };
        window.addEventListener('message', handler);
        postMessage('ready');
        return () => window.removeEventListener('message', handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const exportAsSVG = useCallback(() => {
        // Delegate to each view's imperative handle so the exported file
        // preserves the ELK-computed layout and routed edges that the user
        // actually sees — instead of re-running a naive grid layout that turns
        // large graphs into spaghetti.
        if (viewMode === 'cytoscape') {
            const svgContent = cytoscapeRef.current?.exportSVG();
            if (svgContent) {
                postMessage('exportResult', { format: 'svg', data: svgContent, mimeType: 'image/svg+xml' });
            }
            return;
        }
        if (viewMode === 'system') {
            const svgContent = systemViewRef.current?.exportSVG();
            if (svgContent) {
                postMessage('exportResult', { format: 'svg', data: svgContent, mimeType: 'image/svg+xml' });
            }
            return;
        }
        if (viewMode === 'reactflow') {
            const svgContent = reactFlowRef.current?.exportSVG();
            if (svgContent) {
                postMessage('exportResult', { format: 'svg', data: svgContent, mimeType: 'image/svg+xml' });
            }
            return;
        }
    }, [viewMode]);

    const exportAsPNG = useCallback(() => {
        if (viewMode === 'cytoscape') {
            const base64 = cytoscapeRef.current?.exportPNG();
            if (base64) {
                postMessage('exportResult', { format: 'png', data: base64, mimeType: 'image/png' });
            }
            return;
        }
        const pngPromise =
            viewMode === 'system'
                ? systemViewRef.current?.exportPNG()
                : viewMode === 'reactflow'
                    ? reactFlowRef.current?.exportPNG()
                    : null;
        if (!pngPromise) return;
        pngPromise.then(base64 => {
            if (base64) {
                postMessage('exportResult', { format: 'png', data: base64, mimeType: 'image/png' });
            }
        });
    }, [viewMode]);

    const handleNodeSelect = useCallback((nodeId: string | null) => {
        // Interactive narration: clicking a node while a narrator is playing
        // pauses the timeline so the user can explore freely.
        if (nodeId && storyPlayer.state.status === 'playing') {
            storyPlayer.pause();
        }
        setSelectedNodeId(nodeId);
    }, [storyPlayer]);

    const handleSubsystemHighlight = useCallback((subsystemId: string | null) => {
        setHighlightedSubsystem(subsystemId);
    }, []);

    const handleNavigateToFile = useCallback((filePath: string, line?: number) => {
        postMessage('navigateToFile', { filePath, line });
    }, []);

    const handleRefresh = useCallback(() => {
        postMessage('refreshRequest');
    }, []);

    const handleExportSVG = useCallback(() => { exportAsSVG(); }, [exportAsSVG]);
    const handleExportPNG = useCallback(() => { exportAsPNG(); }, [exportAsPNG]);

    const handleGenerateSystemArch = useCallback(() => {
        if (isGeneratingArch) return;
        setIsGeneratingArch(true);
        setArchProgress('Preparing architecture analysis...');
        setArchStream('');
        postMessage('generateSystemArch');
    }, [isGeneratingArch]);

    const handleProcessingModeChange = useCallback((mode: ProcessingMode) => {
        setProcessingMode(mode);
        postMessage('setProcessingMode', { mode });
    }, []);

    const selectedNode = graph?.nodes.find(n => n.id === selectedNodeId) ?? null;

    const handleNarratorPlay = useCallback((narrator: NarratorRecord) => {
        if (!narrator.id || !narrator.steps?.length) return;
        storyPlayer.play(narrator.id, narrator.steps);
    }, [storyPlayer]);

    const handleNarratorStop = useCallback(() => {
        storyPlayer.stop();
    }, [storyPlayer]);

    const handleNarratorsChanged = useCallback(() => {
        void refreshNarrators();
    }, [refreshNarrators]);

    return (
        <div className="app">
            <Sidebar
                graph={graph}
                searchTerm={searchTerm}
                onSearchChange={setSearchTerm}
                highlightedSubsystem={highlightedSubsystem}
                onSubsystemHighlight={handleSubsystemHighlight}
                processingMode={processingMode}
                onProcessingModeChange={handleProcessingModeChange}
                narrators={narrators}
                activeNarratorId={storyPlayer.state.narratorId}
                narratorStatus={storyPlayer.state.status}
                narratorStepIndex={storyPlayer.state.stepIndex}
                onNarratorPlay={handleNarratorPlay}
                onNarratorPause={storyPlayer.pause}
                onNarratorResume={storyPlayer.resume}
                onNarratorStop={handleNarratorStop}
                onNarratorNext={storyPlayer.next}
                onNarratorPrev={storyPlayer.prev}
                onNarratorGoto={storyPlayer.gotoStep}
                onNarratorsChanged={handleNarratorsChanged}
                narratorGenerating={narratorGenerating}
                narratorSynthProgress={narratorSynthProgress}
            />
            <div className="main-content" ref={mainContentRef}>
                <Toolbar
                    viewMode={viewMode}
                    onViewModeChange={setViewMode}
                    onRefresh={handleRefresh}
                    onExportSVG={handleExportSVG}
                    onExportPNG={handleExportPNG}
                    showMiniMap={showMiniMap}
                    onToggleMiniMap={() => setShowMiniMap(v => !v)}
                    onOpenModelSelector={() => setShowModelSelector(true)}
                    onOpenVoiceSelector={() => setShowVoiceSelector(true)}
                    hasSystemArch={!!systemArch}
                    isGeneratingArch={isGeneratingArch}
                    onGenerateSystemArch={handleGenerateSystemArch}
                />
                {!graph ? (
                    <div className="loading">
                        <div className="spinner" />
                        Waiting for analysis data...
                    </div>
                ) : viewMode === 'system' ? (
                    systemArch ? (
                        <SystemView ref={systemViewRef} architecture={systemArch} showMiniMap={showMiniMap} narratedNodeId={narratedNodeId} />
                    ) : isGeneratingArch ? (
                        <div className="loading">
                            <div className="loading-arch-top">
                                <div className="spinner" />
                                <div className="loading-text">
                                    <strong>Generating System Architecture</strong>
                                    <span className="loading-sub">{archProgress}</span>
                                </div>
                            </div>
                            {archStream && (
                                <div className="arch-stream" aria-live="polite">
                                    <div className="arch-stream-header">Live model output</div>
                                    <pre ref={archStreamBodyRef} className="arch-stream-body">{archStream}</pre>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="loading">
                            <div className="system-empty">
                                <div className="system-empty-icon">
                                    <Icon name="systemView" size="3x" />
                                </div>
                                <h3>System Architecture</h3>
                                <p>Click <strong>"AI Analyze"</strong> to generate a high-level system architecture.</p>
                                <button className="btn-generate" onClick={handleGenerateSystemArch}>
                                    <Icon name="aiAnalyze" /> Generate System Architecture
                                </button>
                            </div>
                        </div>
                    )
                ) : viewMode === 'reactflow' ? (
                    <ReactFlowView
                        ref={reactFlowRef}
                        graph={graph}
                        selectedNodeId={selectedNodeId}
                        highlightedSubsystem={highlightedSubsystem}
                        searchTerm={searchTerm}
                        onNodeSelect={handleNodeSelect}
                        onNavigateToFile={handleNavigateToFile}
                        showMiniMap={showMiniMap}
                        narratedNodeId={narratedNodeId}
                    />
                ) : (
                    <CytoscapeView
                        ref={cytoscapeRef}
                        graph={graph}
                        selectedNodeId={selectedNodeId}
                        highlightedSubsystem={highlightedSubsystem}
                        searchTerm={searchTerm}
                        onNodeSelect={handleNodeSelect}
                    />
                )}
                {selectedNode && graph && (
                    <DetailPanel
                        node={selectedNode}
                        graph={graph}
                        onClose={() => setSelectedNodeId(null)}
                        onNavigateToFile={handleNavigateToFile}
                    />
                )}
            </div>

            {/* Chat Panel */}
            <ChatPanel
                isOpen={chatOpen}
                onToggle={() => setChatOpen(v => !v)}
                onNarratorGenerationStart={() => setNarratorGenerating(true)}
            />

            {/* Model Selector Modal */}
            {showModelSelector && (
                <ModelSelector onClose={() => setShowModelSelector(false)} />
            )}

            {/* Voice Selector Modal */}
            {showVoiceSelector && (
                <VoiceSelector onClose={() => setShowVoiceSelector(false)} />
            )}

            {/* Voice synthesis overlay — visible only while the TTS engine is
                preparing audio but hasn't started playing yet. */}
            {voiceSynthesizing && (
                <div
                    className="tts-synth-overlay"
                    role="status"
                    aria-live="polite"
                    aria-label="Processing voice"
                    title="Processing voice…"
                >
                    <div className="tts-synth-spinner" />
                    <span className="tts-synth-label">Processing voice…</span>
                </div>
            )}
        </div>
    );
}
