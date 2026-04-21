import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ArchitectureGraph, WebviewMessage, WebviewMessageType } from '../types';
import { OllamaService, MODEL_OPTIONS, SystemArchitecture } from '../inference/OllamaService';

export class ArchitecturePanel {
  private static instance: ArchitecturePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private currentGraph: ArchitectureGraph | undefined;
  private ollamaService: OllamaService;
  private selectedModel: string | null = null;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.ollamaService = new OllamaService();

    // Load saved model selection
    const config = vscode.workspace.getConfiguration('codearchy');
    const aiModel = config.get<string>('aiModel', 'none');
    if (aiModel !== 'none') {
      this.selectedModel = aiModel;
    }

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      null,
      this.disposables
    );
  }

  static createOrShow(extensionUri: vscode.Uri, graph: ArchitectureGraph) {
    const column = vscode.ViewColumn.Beside;

    if (ArchitecturePanel.instance) {
      ArchitecturePanel.instance.panel.reveal(column);
      ArchitecturePanel.instance.sendGraphData(graph);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'codearchArchitecture',
      'CodeArchy: Architecture',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'webview-ui', 'dist'),
          vscode.Uri.joinPath(extensionUri, 'media'),
        ],
      }
    );

    ArchitecturePanel.instance = new ArchitecturePanel(panel, extensionUri);
    ArchitecturePanel.instance.panel.webview.html = ArchitecturePanel.instance.getWebviewContent();
    ArchitecturePanel.instance.currentGraph = graph;
  }

  static update(graph: ArchitectureGraph) {
    if (ArchitecturePanel.instance) {
      ArchitecturePanel.instance.sendGraphData(graph);
    }
  }

  static dispose() {
    if (ArchitecturePanel.instance) {
      ArchitecturePanel.instance.panel.dispose();
    }
  }

  static triggerExport(format: 'svg' | 'png') {
    if (ArchitecturePanel.instance) {
      ArchitecturePanel.instance.panel.webview.postMessage({
        type: format === 'svg' ? WebviewMessageType.ExportSVG : WebviewMessageType.ExportPNG,
        payload: null,
      });
    }
  }

  private sendGraphData(graph: ArchitectureGraph) {
    this.currentGraph = graph;
    this.panel.webview.postMessage({
      type: WebviewMessageType.GraphData,
      payload: graph,
    });
  }

  private handleMessage(message: WebviewMessage) {
    switch (message.type) {
      case WebviewMessageType.Ready:
        if (this.currentGraph) {
          this.sendGraphData(this.currentGraph);
        }
        break;

      case WebviewMessageType.NavigateToFile: {
        const payload = message.payload as { filePath: string; line?: number };
        if (payload.filePath) {
          const uri = vscode.Uri.file(payload.filePath);
          const options: vscode.TextDocumentShowOptions = {};
          if (payload.line !== undefined) {
            options.selection = new vscode.Range(payload.line, 0, payload.line, 0);
          }
          vscode.window.showTextDocument(uri, options);
        }
        break;
      }

      case WebviewMessageType.RefreshRequest:
        vscode.commands.executeCommand('codearchy.refreshView');
        break;

      case WebviewMessageType.ExportSVG:
      case WebviewMessageType.ExportPNG: {
        this.panel.webview.postMessage({
          type: message.type,
          payload: null,
        });
        break;
      }

      case WebviewMessageType.ExportResult: {
        const result = message.payload as { format: string; data: string; mimeType: string };
        if (result) {
          this.handleExportResult(result);
        }
        break;
      }

      // --- AI Model Messages ---
      case WebviewMessageType.RequestModelStatus:
        this.handleModelStatusRequest();
        break;

      case WebviewMessageType.SelectModel: {
        const modelPayload = message.payload as { modelId: string };
        this.handleModelSelection(modelPayload.modelId);
        break;
      }

      case WebviewMessageType.GenerateSystemArch:
        this.handleGenerateSystemArch();
        break;

      // --- Chat Messages ---
      case WebviewMessageType.ChatMessage: {
        const chatPayload = message.payload as { content: string };
        this.handleChatMessage(chatPayload.content);
        break;
      }

      case WebviewMessageType.ClearChat:
        this.ollamaService.clearConversation();
        break;
    }
  }

  // --- AI Model Handlers ---

  private async handleModelStatusRequest() {
    try {
      const status = await this.ollamaService.getModelStatus();
      this.panel.webview.postMessage({
        type: WebviewMessageType.ModelStatus,
        payload: {
          ...status,
          selectedModel: this.selectedModel,
        },
      });
    } catch {
      this.panel.webview.postMessage({
        type: WebviewMessageType.ModelStatus,
        payload: {
          ollamaRunning: false,
          models: MODEL_OPTIONS.map((m) => ({ ...m, installed: false })),
          selectedModel: null,
        },
      });
    }
  }

  private async handleModelSelection(modelId: string) {
    this.selectedModel = modelId;
    // Persist to settings
    const config = vscode.workspace.getConfiguration('codearchy');
    await config.update('aiModel', modelId, vscode.ConfigurationTarget.Workspace);

    // Send updated status
    this.handleModelStatusRequest();
    vscode.window.showInformationMessage(`CodeArchy: AI model set to ${modelId}`);
  }

  private async handleGenerateSystemArch() {
    if (!this.currentGraph) {
      this.sendError('No codebase analysis available. Run "Analyze Workspace" first.');
      return;
    }

    const modelOpt = MODEL_OPTIONS.find((m) => m.id === this.selectedModel);
    if (!modelOpt) {
      // Try to use ollama anyway or prompt to select
      const available = await this.ollamaService.isAvailable();
      if (!available) {
        this.sendError('Ollama is not running. Please start Ollama and select a model.');
        this.panel.webview.postMessage({
          type: WebviewMessageType.SystemArchProgress,
          payload: { message: '' },
        });
        return;
      }

      // No model selected — try fallback with heuristics
      this.panel.webview.postMessage({
        type: WebviewMessageType.SystemArchProgress,
        payload: { message: 'No AI model selected. Using heuristic analysis...' },
      });

      const fallbackArch = this.buildFallbackArchitecture(this.currentGraph);
      this.panel.webview.postMessage({
        type: WebviewMessageType.SystemArchData,
        payload: fallbackArch,
      });
      return;
    }

    try {
      this.panel.webview.postMessage({
        type: WebviewMessageType.SystemArchProgress,
        payload: { message: `Connecting to Ollama (${modelOpt.label})...` },
      });

      const available = await this.ollamaService.isAvailable();
      if (!available) {
        this.sendError('Cannot connect to Ollama. Make sure it\'s running at localhost:11434.');
        return;
      }

      this.panel.webview.postMessage({
        type: WebviewMessageType.SystemArchProgress,
        payload: { message: `Analyzing codebase with ${modelOpt.label}... This may take a moment.` },
      });

      const architecture = await this.ollamaService.generateSystemArchitecture(
        this.currentGraph,
        modelOpt.ollamaTag,
        (chunk) => {
          this.panel.webview.postMessage({
            type: WebviewMessageType.SystemArchProgress,
            payload: { message: `Generating architecture... (streaming)` },
          });
        }
      );

      this.panel.webview.postMessage({
        type: WebviewMessageType.SystemArchData,
        payload: architecture,
      });

      vscode.window.showInformationMessage(
        `CodeArchy: System architecture generated — ${architecture.nodes.length} subsystems, pattern: ${architecture.pattern}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.sendError(`Architecture generation failed: ${msg}`);
    }
  }

  private buildFallbackArchitecture(graph: ArchitectureGraph): SystemArchitecture {
    const COLORS = [
      '#4FC3F7', '#81C784', '#FFB74D', '#E57373',
      '#BA68C8', '#4DB6AC', '#FF8A65', '#90A4AE',
    ];

    const nodes = graph.subsystems.map((sub, i) => ({
      id: sub.id,
      label: sub.name,
      description: sub.description,
      type: 'subsystem' as const,
      color: COLORS[i % COLORS.length],
      children: sub.nodeIds,
    }));

    const subsystemMap = new Map<string, string>();
    for (const sub of graph.subsystems) {
      for (const nodeId of sub.nodeIds) {
        subsystemMap.set(nodeId, sub.id);
      }
    }

    const edgeSet = new Set<string>();
    const edges: Array<{ id: string; source: string; target: string; label: string; type: 'dependency' }> = [];
    for (const edge of graph.edges) {
      const sourceSub = subsystemMap.get(edge.source);
      const targetSub = subsystemMap.get(edge.target);
      if (sourceSub && targetSub && sourceSub !== targetSub) {
        const key = `${sourceSub}->${targetSub}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({
            id: `sysedge-${edges.length}`,
            source: sourceSub,
            target: targetSub,
            label: 'depends on',
            type: 'dependency',
          });
        }
      }
    }

    return {
      nodes,
      edges,
      pattern: 'Modular',
      summary: `Heuristic analysis: ${graph.subsystems.length} subsystems across ${graph.metadata.fileCount} files (${graph.metadata.languages.join(', ')}).`,
    };
  }

  // --- Chat Handler ---

  private async handleChatMessage(content: string) {
    if (!this.currentGraph) {
      this.panel.webview.postMessage({
        type: WebviewMessageType.ChatResponse,
        payload: { content: '', error: 'No codebase analysis available. Run "Analyze Workspace" first.' },
      });
      return;
    }

    const modelOpt = MODEL_OPTIONS.find((m) => m.id === this.selectedModel);
    if (!modelOpt) {
      this.panel.webview.postMessage({
        type: WebviewMessageType.ChatResponse,
        payload: { content: '', error: 'No AI model selected. Open Model Settings to configure.' },
      });
      return;
    }

    try {
      const available = await this.ollamaService.isAvailable();
      if (!available) {
        this.panel.webview.postMessage({
          type: WebviewMessageType.ChatResponse,
          payload: { content: '', error: 'Cannot connect to Ollama. Make sure it\'s running.' },
        });
        return;
      }

      // Set architecture context for chat
      this.ollamaService.setArchitectureContext(this.currentGraph);

      const response = await this.ollamaService.chat(
        content,
        modelOpt.ollamaTag,
        (chunk) => {
          this.panel.webview.postMessage({
            type: WebviewMessageType.ChatChunk,
            payload: { content: chunk },
          });
        },
        (thinkChunk) => {
          this.panel.webview.postMessage({
            type: WebviewMessageType.ChatThinking,
            payload: { content: thinkChunk },
          });
        }
      );

      this.panel.webview.postMessage({
        type: WebviewMessageType.ChatResponse,
        payload: { content: response },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.panel.webview.postMessage({
        type: WebviewMessageType.ChatResponse,
        payload: { content: '', error: `Chat failed: ${msg}` },
      });
    }
  }

  private sendError(message: string) {
    this.panel.webview.postMessage({
      type: WebviewMessageType.Error,
      payload: { message },
    });
    vscode.window.showErrorMessage(`CodeArchy: ${message}`);
  }

  private async handleExportResult(result: { format: string; data: string; mimeType: string }) {
    const defaultName = `codearchy-architecture.${result.format}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultName),
      filters: result.format === 'svg'
        ? { 'SVG Image': ['svg'] }
        : { 'PNG Image': ['png'] },
    });

    if (!uri) return;

    try {
      if (result.format === 'png') {
        // data is base64-encoded PNG
        const buffer = Buffer.from(result.data, 'base64');
        await vscode.workspace.fs.writeFile(uri, buffer);
      } else {
        // SVG is plain text
        await vscode.workspace.fs.writeFile(uri, Buffer.from(result.data, 'utf-8'));
      }
      vscode.window.showInformationMessage(`CodeArchy: Exported ${result.format.toUpperCase()} to ${uri.fsPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`CodeArchy: Export failed — ${msg}`);
    }
  }

  private dispose() {
    ArchitecturePanel.instance = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  private getWebviewContent(): string {
    const webview = this.panel.webview;
    const nonce = getNonce();

    // Try to load the bundled webview-ui
    const bundlePath = path.join(this.extensionUri.fsPath, 'webview-ui', 'dist', 'webview.js');
    const hasBundledUI = fs.existsSync(bundlePath);

    if (hasBundledUI) {
      const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'webview.js')
      );
      const cssUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'webview.css')
      );
      const baseStylesUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'architecture.css')
      );
      const iconUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png')
      );

      return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:; font-src data:;">
  <title>CodeArchy Architecture</title>
  <link rel="stylesheet" href="${cssUri}">
  <link rel="stylesheet" href="${baseStylesUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.CODEARCY_ICON_URI = "${iconUri}";</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    // Fallback: inline canvas-based rendering (original implementation)
    return this.getFallbackWebviewContent(nonce);
  }

  private getFallbackWebviewContent(nonce: string): string {
    const webview = this.panel.webview;
    const fallbackStylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'architecture-fallback.css')
    );

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src data:;">
  <title>CodeArchy Architecture</title>
  <link rel="stylesheet" href="${fallbackStylesUri}">
</head>
<body>
  <div id="app">
    <div id="sidebar">
      <div id="sidebar-header">
        <h2>Architecture</h2>
        <input type="text" id="search-input" placeholder="Filter modules..." />
      </div>
      <div id="subsystem-list"></div>
      <div id="stats"></div>
    </div>
    <div id="canvas-container">
      <div id="toolbar">
        <button class="toolbar-btn" id="btn-zoom-in" title="Zoom In">+</button>
        <button class="toolbar-btn" id="btn-zoom-out" title="Zoom Out">−</button>
        <button class="toolbar-btn" id="btn-fit" title="Fit to View">⊞</button>
        <button class="toolbar-btn" id="btn-refresh" title="Refresh">↻</button>
      </div>
      <div id="canvas">
        <div id="loading"><div class="spinner"></div>Waiting for analysis data...</div>
        <svg id="edges-svg"></svg>
        <div id="nodes-container"></div>
      </div>
      <div id="detail-panel">
        <button class="detail-close" id="detail-close">✕</button>
        <div id="detail-content"></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    (function() {
      const vscodeApi = acquireVsCodeApi();

      // State
      let graphData = null;
      let nodePositions = {};
      let selectedNodeId = null;
      let highlightedSubsystem = null;
      let searchTerm = '';

      // Pan/zoom state
      let panX = 0, panY = 0, zoom = 1;
      let isPanning = false;
      let panStartX = 0, panStartY = 0;

      // Node drag state
      let isDraggingNode = false;
      let dragNodeId = null;
      let dragOffsetX = 0, dragOffsetY = 0;

      // DOM references
      const canvas = document.getElementById('canvas');
      const nodesContainer = document.getElementById('nodes-container');
      const edgesSvg = document.getElementById('edges-svg');
      const loading = document.getElementById('loading');
      const subsystemList = document.getElementById('subsystem-list');
      const statsEl = document.getElementById('stats');
      const detailPanel = document.getElementById('detail-panel');
      const detailContent = document.getElementById('detail-content');
      const searchInput = document.getElementById('search-input');

      // Signal ready
      vscodeApi.postMessage({ type: 'ready', payload: null });

      // Handle incoming messages
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'graphData') {
          graphData = message.payload;
          renderGraph();
        }
      });

      // Toolbar
      document.getElementById('btn-zoom-in').addEventListener('click', () => {
        zoom = Math.min(zoom * 1.2, 3);
        applyTransform();
        drawEdges();
      });
      document.getElementById('btn-zoom-out').addEventListener('click', () => {
        zoom = Math.max(zoom / 1.2, 0.2);
        applyTransform();
        drawEdges();
      });
      document.getElementById('btn-fit').addEventListener('click', fitToView);
      document.getElementById('btn-refresh').addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'refreshRequest', payload: null });
      });
      document.getElementById('detail-close').addEventListener('click', () => {
        detailPanel.classList.remove('visible');
        selectedNodeId = null;
        updateNodeSelection();
        drawEdges();
      });

      // Search
      searchInput.addEventListener('input', (e) => {
        searchTerm = e.target.value.toLowerCase();
        updateNodeVisibility();
      });

      // Pan handling
      canvas.addEventListener('mousedown', (e) => {
        if (e.target === canvas || e.target === nodesContainer || e.target === edgesSvg) {
          isPanning = true;
          panStartX = e.clientX - panX;
          panStartY = e.clientY - panY;
          canvas.classList.add('dragging');
        }
      });
      window.addEventListener('mousemove', (e) => {
        if (isPanning) {
          panX = e.clientX - panStartX;
          panY = e.clientY - panStartY;
          applyTransform();
          drawEdges();
        }
        if (isDraggingNode && dragNodeId) {
          const rect = canvas.getBoundingClientRect();
          const x = (e.clientX - rect.left - panX) / zoom - dragOffsetX;
          const y = (e.clientY - rect.top - panY) / zoom - dragOffsetY;
          nodePositions[dragNodeId] = { x, y };
          const nodeEl = document.querySelector('[data-node-id="' + dragNodeId + '"]');
          if (nodeEl) {
            nodeEl.style.left = x + 'px';
            nodeEl.style.top = y + 'px';
          }
          drawEdges();
        }
      });
      window.addEventListener('mouseup', () => {
        isPanning = false;
        isDraggingNode = false;
        dragNodeId = null;
        canvas.classList.remove('dragging');
        canvas.classList.remove('node-drag');
      });

      // Zoom with wheel
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(0.1, Math.min(3, zoom * delta));
        
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        panX = mouseX - (mouseX - panX) * (newZoom / zoom);
        panY = mouseY - (mouseY - panY) * (newZoom / zoom);
        zoom = newZoom;
        
        applyTransform();
        drawEdges();
      }, { passive: false });

      function applyTransform() {
        nodesContainer.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
        nodesContainer.style.transformOrigin = '0 0';
      }

      function renderGraph() {
        if (!graphData) return;
        loading.style.display = 'none';
        computeLayout();
        renderNodes();
        renderSubsystems();
        renderStats();
        drawEdges();
        fitToView();
      }

      function computeLayout() {
        const nodes = graphData.nodes;
        if (nodes.length === 0) return;

        // Group nodes by subsystem
        const groups = {};
        for (const node of nodes) {
          const group = node.group || 'ungrouped';
          if (!groups[group]) groups[group] = [];
          groups[group].push(node);
        }

        const groupNames = Object.keys(groups);
        const groupCount = groupNames.length;
        
        // Layout groups in a grid pattern
        const cols = Math.ceil(Math.sqrt(groupCount));
        const groupSpacingX = 400;
        const groupSpacingY = 350;
        const nodeSpacingX = 180;
        const nodeSpacingY = 70;

        let groupIndex = 0;
        for (const groupName of groupNames) {
          const groupNodes = groups[groupName];
          const groupCol = groupIndex % cols;
          const groupRow = Math.floor(groupIndex / cols);
          const baseX = groupCol * groupSpacingX + 50;
          const baseY = groupRow * groupSpacingY + 50;

          const innerCols = Math.ceil(Math.sqrt(groupNodes.length));
          for (let i = 0; i < groupNodes.length; i++) {
            const col = i % innerCols;
            const row = Math.floor(i / innerCols);
            nodePositions[groupNodes[i].id] = {
              x: baseX + col * nodeSpacingX,
              y: baseY + row * nodeSpacingY,
            };
          }
          groupIndex++;
        }
      }

      function renderNodes() {
        nodesContainer.innerHTML = '';
        for (const node of graphData.nodes) {
          const pos = nodePositions[node.id];
          if (!pos) continue;

          const el = document.createElement('div');
          el.className = 'graph-node';
          el.dataset.nodeId = node.id;
          el.style.left = pos.x + 'px';
          el.style.top = pos.y + 'px';

          const subsystem = graphData.subsystems.find(s => s.nodeIds.includes(node.id));
          const borderColor = subsystem ? subsystem.color : 'var(--node-border)';
          el.style.borderLeftColor = borderColor;
          el.style.borderLeftWidth = '3px';

          el.innerHTML =
            '<div class="node-label" title="' + escapeHtml(node.id) + '">' + escapeHtml(node.label) + '</div>' +
            '<div class="node-meta">' + escapeHtml(node.metadata.language || '') + ' · ' + (node.symbols.length) + ' symbols</div>' +
            (node.symbols.length > 0 ? '<div class="node-badge">' + node.symbols.length + '</div>' : '') +
            (subsystem ? '<div class="node-group-indicator" style="background:' + subsystem.color + '"></div>' : '');

          // Node click
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            selectNode(node);
          });

          // Node drag
          el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            isDraggingNode = true;
            dragNodeId = node.id;
            const rect = canvas.getBoundingClientRect();
            dragOffsetX = ((e.clientX - rect.left - panX) / zoom) - pos.x;
            dragOffsetY = ((e.clientY - rect.top - panY) / zoom) - pos.y;
            canvas.classList.add('node-drag');
          });

          // Double-click to open file
          el.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            vscodeApi.postMessage({
              type: 'navigateToFile',
              payload: { filePath: node.filePath }
            });
          });

          nodesContainer.appendChild(el);
        }
      }

      function drawEdges() {
        if (!graphData) return;
        
        const svgRect = canvas.getBoundingClientRect();
        edgesSvg.setAttribute('viewBox', '0 0 ' + svgRect.width + ' ' + svgRect.height);
        
        let html = '<defs><marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon class="edge-arrow" points="0 0, 8 3, 0 6"/></marker>';
        html += '<marker id="arrowhead-hl" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon class="edge-arrow highlighted" points="0 0, 8 3, 0 6"/></marker></defs>';

        for (const edge of graphData.edges) {
          const sourcePos = nodePositions[edge.source];
          const targetPos = nodePositions[edge.target];
          if (!sourcePos || !targetPos) continue;

          const isHighlighted = selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId);

          // Transform coordinates to SVG space
          const sx = sourcePos.x * zoom + panX + 60;
          const sy = sourcePos.y * zoom + panY + 20;
          const tx = targetPos.x * zoom + panX + 60;
          const ty = targetPos.y * zoom + panY + 20;

          // Bezier curve
          const mx = (sx + tx) / 2;
          const my = (sy + ty) / 2;
          const dx = tx - sx;
          const dy = ty - sy;
          const cx = mx - dy * 0.15;
          const cy = my + dx * 0.15;

          const cls = 'edge-line' + (isHighlighted ? ' highlighted' : '');
          const marker = isHighlighted ? 'url(#arrowhead-hl)' : 'url(#arrowhead)';
          html += '<path class="' + cls + '" d="M ' + sx + ' ' + sy + ' Q ' + cx + ' ' + cy + ' ' + tx + ' ' + ty + '" marker-end="' + marker + '"/>';
        }

        edgesSvg.innerHTML = html;
      }

      function selectNode(node) {
        selectedNodeId = node.id;
        updateNodeSelection();
        drawEdges();
        showDetail(node);
      }

      function updateNodeSelection() {
        document.querySelectorAll('.graph-node').forEach(el => {
          el.classList.toggle('selected', el.dataset.nodeId === selectedNodeId);
        });
      }

      function showDetail(node) {
        const subsystem = graphData.subsystems.find(s => s.nodeIds.includes(node.id));
        const inEdges = graphData.edges.filter(e => e.target === node.id);
        const outEdges = graphData.edges.filter(e => e.source === node.id);

        let html = '<h3>' + escapeHtml(node.id) + '</h3>';
        html += '<div class="detail-row"><span class="detail-label">Group:</span><span>' + escapeHtml(subsystem ? subsystem.name : 'None') + '</span></div>';
        html += '<div class="detail-row"><span class="detail-label">Language:</span><span>' + escapeHtml(node.metadata.language || 'unknown') + '</span></div>';
        html += '<div class="detail-row"><span class="detail-label">Imports:</span><span>' + inEdges.length + ' incoming, ' + outEdges.length + ' outgoing</span></div>';
        html += '<div class="detail-row"><span class="detail-label">File:</span><span class="detail-link" onclick="openFile(\'' + escapeJs(node.filePath) + '\')">' + escapeHtml(node.label) + '</span></div>';

        if (node.symbols.length > 0) {
          html += '<div style="margin-top:6px"><span class="detail-label">Symbols:</span></div>';
          html += '<div class="detail-symbols">';
          for (const sym of node.symbols.slice(0, 20)) {
            html += '<span class="symbol-tag" title="' + escapeHtml(sym.kind) + '">' + escapeHtml(sym.name) + '</span>';
          }
          if (node.symbols.length > 20) {
            html += '<span class="symbol-tag">+' + (node.symbols.length - 20) + ' more</span>';
          }
          html += '</div>';
        }

        detailContent.innerHTML = html;
        detailPanel.classList.add('visible');
      }

      function renderSubsystems() {
        if (!graphData.subsystems || graphData.subsystems.length === 0) {
          subsystemList.innerHTML = '<div style="padding:12px;opacity:0.5;font-size:12px">No subsystems detected</div>';
          return;
        }

        let html = '';
        for (const sub of graphData.subsystems) {
          html += '<div class="subsystem-item" data-subsystem-id="' + escapeHtml(sub.id) + '">' +
            '<div class="subsystem-dot" style="background:' + sub.color + '"></div>' +
            '<span>' + escapeHtml(sub.name) + '</span>' +
            '<span class="subsystem-count">' + sub.nodeIds.length + '</span>' +
            '</div>';
        }
        subsystemList.innerHTML = html;

        subsystemList.querySelectorAll('.subsystem-item').forEach(el => {
          el.addEventListener('click', () => {
            const subId = el.dataset.subsystemId;
            const sub = graphData.subsystems.find(s => s.id === subId);
            if (!sub) return;

            const wasActive = el.classList.contains('active');
            subsystemList.querySelectorAll('.subsystem-item').forEach(e => e.classList.remove('active'));

            if (wasActive) {
              highlightedSubsystem = null;
              document.querySelectorAll('.graph-node').forEach(n => { n.style.opacity = '1'; });
            } else {
              el.classList.add('active');
              highlightedSubsystem = sub.id;
              document.querySelectorAll('.graph-node').forEach(n => {
                const nodeId = n.dataset.nodeId;
                n.style.opacity = sub.nodeIds.includes(nodeId) ? '1' : '0.2';
              });
            }
          });
        });
      }

      function renderStats() {
        if (!graphData) return;
        const m = graphData.metadata;
        statsEl.innerHTML =
          '<div>' + m.fileCount + ' files analyzed</div>' +
          '<div>' + m.totalSymbols + ' symbols found</div>' +
          '<div>' + m.totalEdges + ' dependencies</div>' +
          '<div>' + m.languages.join(', ') + '</div>';
      }

      function updateNodeVisibility() {
        document.querySelectorAll('.graph-node').forEach(el => {
          const nodeId = el.dataset.nodeId;
          if (!searchTerm) {
            el.style.opacity = '1';
            return;
          }
          const matches = nodeId.toLowerCase().includes(searchTerm);
          el.style.opacity = matches ? '1' : '0.15';
        });
      }

      function fitToView() {
        if (!graphData || graphData.nodes.length === 0) return;

        const positions = Object.values(nodePositions);
        if (positions.length === 0) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const pos of positions) {
          minX = Math.min(minX, pos.x);
          minY = Math.min(minY, pos.y);
          maxX = Math.max(maxX, pos.x + 160);
          maxY = Math.max(maxY, pos.y + 50);
        }

        const canvasRect = canvas.getBoundingClientRect();
        const graphW = maxX - minX + 100;
        const graphH = maxY - minY + 100;
        const scaleX = canvasRect.width / graphW;
        const scaleY = canvasRect.height / graphH;
        zoom = Math.min(scaleX, scaleY, 1.5) * 0.85;

        panX = (canvasRect.width - graphW * zoom) / 2 - minX * zoom;
        panY = (canvasRect.height - graphH * zoom) / 2 - minY * zoom;

        applyTransform();
        drawEdges();
      }

      // Global function for inline onclick
      window.openFile = function(filePath) {
        vscodeApi.postMessage({
          type: 'navigateToFile',
          payload: { filePath: filePath }
        });
      };

      function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }

      function escapeJs(str) {
        if (!str) return '';
        return str.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
      }
    })();
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
