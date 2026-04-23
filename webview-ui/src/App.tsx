import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ArchitectureGraph, ViewMode, SystemArchitecture } from './types';
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
import { ChatPanel } from './components/ChatPanel';
import { Icon } from './components/Icons';
import {
    setProjectId,
    getProjectId,
    upsertProject,
    loadSystemRecord,
    saveSystemArchitecture,
} from './db';

export function App() {
    const [graph, setGraph] = useState<ArchitectureGraph | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>('reactflow');
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const [highlightedSubsystem, setHighlightedSubsystem] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [showMiniMap, setShowMiniMap] = useState(true);
    const [showModelSelector, setShowModelSelector] = useState(false);
    const [systemArch, setSystemArch] = useState<SystemArchitecture | null>(null);
    const [isGeneratingArch, setIsGeneratingArch] = useState(false);
    const [archProgress, setArchProgress] = useState<string>('');
    const [chatOpen, setChatOpen] = useState(false);
    const mainContentRef = useRef<HTMLDivElement>(null);
    const cytoscapeRef = useRef<CytoscapeViewHandle>(null);
    const reactFlowRef = useRef<ReactFlowViewHandle>(null);
    const systemViewRef = useRef<SystemViewHandle>(null);

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
                                    setSystemArch(prev => prev ?? cached.architecture);
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
                case 'error': {
                    const err = message.payload as { message: string };
                    setIsGeneratingArch(false);
                    setArchProgress('');
                    // Error shown via chat or inline
                    console.error('CodeArchy error:', err.message);
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
        setSelectedNodeId(nodeId);
    }, []);

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
        postMessage('generateSystemArch');
    }, [isGeneratingArch]);

    const selectedNode = graph?.nodes.find(n => n.id === selectedNodeId) ?? null;

    return (
        <div className="app">
            <Sidebar
                graph={graph}
                searchTerm={searchTerm}
                onSearchChange={setSearchTerm}
                highlightedSubsystem={highlightedSubsystem}
                onSubsystemHighlight={handleSubsystemHighlight}
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
                        <SystemView ref={systemViewRef} architecture={systemArch} showMiniMap={showMiniMap} />
                    ) : isGeneratingArch ? (
                        <div className="loading">
                            <div className="spinner" />
                            <div className="loading-text">
                                <strong>Generating System Architecture</strong>
                                <span className="loading-sub">{archProgress}</span>
                            </div>
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
            <ChatPanel isOpen={chatOpen} onToggle={() => setChatOpen(v => !v)} />

            {/* Model Selector Modal */}
            {showModelSelector && (
                <ModelSelector onClose={() => setShowModelSelector(false)} />
            )}
        </div>
    );
}
