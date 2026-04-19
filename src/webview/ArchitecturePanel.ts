import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ArchitectureGraph, WebviewMessage, WebviewMessageType } from '../types';

export class ArchitecturePanel {
  private static instance: ArchitecturePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private currentGraph: ArchitectureGraph | undefined;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

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
        // The webview sends export requests; we handle them by triggering
        // the export flow in the webview which sends back the result
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
    }
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

      return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:; font-src data:;">
  <title>CodeArchy Architecture</title>
  <link rel="stylesheet" href="${cssUri}">
  <style>
    ${getBaseStyles()}
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    // Fallback: inline canvas-based rendering (original implementation)
    return this.getFallbackWebviewContent(nonce);
  }

  private getFallbackWebviewContent(nonce: string): string {

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src data:;">
  <title>CodeArchy Architecture</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --border: var(--vscode-panel-border, #444);
      --accent: var(--vscode-focusBorder, #007acc);
      --node-bg: var(--vscode-editorWidget-background, #252526);
      --node-border: var(--vscode-editorWidget-border, #454545);
      --node-selected: var(--vscode-list-activeSelectionBackground, #094771);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #fff);
      --sidebar-bg: var(--vscode-sideBar-background, #1e1e1e);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-border: var(--vscode-input-border, #555);
      --input-fg: var(--vscode-input-foreground, #ccc);
      --scrollbar: var(--vscode-scrollbarSlider-background, rgba(121,121,121,.4));
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      overflow: hidden;
      width: 100vw;
      height: 100vh;
    }
    #app {
      display: flex;
      width: 100%;
      height: 100%;
    }

    /* Sidebar */
    #sidebar {
      width: 240px;
      min-width: 200px;
      max-width: 360px;
      background: var(--sidebar-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #sidebar-header {
      padding: 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #sidebar-header h2 {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }
    #search-input {
      width: 100%;
      padding: 4px 8px;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--input-fg);
      border-radius: 2px;
      font-size: 12px;
      outline: none;
    }
    #search-input:focus { border-color: var(--accent); }
    #subsystem-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }
    #subsystem-list::-webkit-scrollbar { width: 6px; }
    #subsystem-list::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 3px; }
    .subsystem-item {
      padding: 6px 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      user-select: none;
    }
    .subsystem-item:hover { background: rgba(255,255,255,0.05); }
    .subsystem-item.active { background: var(--node-selected); }
    .subsystem-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .subsystem-count {
      margin-left: auto;
      background: var(--badge-bg);
      color: var(--badge-fg);
      border-radius: 8px;
      padding: 1px 6px;
      font-size: 11px;
    }
    #stats {
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      font-size: 11px;
      opacity: 0.7;
      line-height: 1.6;
    }

    /* Canvas */
    #canvas-container {
      flex: 1;
      position: relative;
      overflow: hidden;
    }
    #toolbar {
      position: absolute;
      top: 12px;
      right: 12px;
      display: flex;
      gap: 4px;
      z-index: 10;
    }
    .toolbar-btn {
      background: var(--node-bg);
      border: 1px solid var(--node-border);
      color: var(--fg);
      width: 28px;
      height: 28px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }
    .toolbar-btn:hover { background: var(--node-selected); }

    #canvas {
      width: 100%;
      height: 100%;
      cursor: grab;
    }
    #canvas.dragging { cursor: grabbing; }
    #canvas.node-drag { cursor: move; }

    /* Nodes */
    .graph-node {
      position: absolute;
      background: var(--node-bg);
      border: 1px solid var(--node-border);
      border-radius: 6px;
      padding: 8px 12px;
      min-width: 120px;
      max-width: 220px;
      cursor: pointer;
      user-select: none;
      font-size: 12px;
      transition: box-shadow 0.15s;
      z-index: 2;
    }
    .graph-node:hover { box-shadow: 0 0 0 1px var(--accent); }
    .graph-node.selected {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent);
    }
    .node-label {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .node-meta {
      font-size: 10px;
      opacity: 0.6;
      margin-top: 2px;
    }
    .node-badge {
      position: absolute;
      top: -6px;
      right: -6px;
      background: var(--accent);
      color: #fff;
      border-radius: 8px;
      padding: 0 5px;
      font-size: 10px;
      font-weight: 600;
      line-height: 16px;
    }
    .node-group-indicator {
      width: 100%;
      height: 3px;
      border-radius: 0 0 4px 4px;
      margin-top: 6px;
      margin-left: -12px;
      margin-bottom: -8px;
      width: calc(100% + 24px);
    }

    /* Detail panel */
    #detail-panel {
      display: none;
      position: absolute;
      bottom: 12px;
      left: 12px;
      right: 12px;
      background: var(--node-bg);
      border: 1px solid var(--node-border);
      border-radius: 6px;
      padding: 12px 16px;
      z-index: 10;
      max-height: 200px;
      overflow-y: auto;
      font-size: 12px;
    }
    #detail-panel.visible { display: block; }
    #detail-panel h3 {
      margin-bottom: 6px;
      font-size: 13px;
    }
    #detail-panel .detail-row {
      display: flex;
      gap: 12px;
      padding: 2px 0;
    }
    #detail-panel .detail-label {
      opacity: 0.6;
      min-width: 60px;
    }
    .detail-symbols {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }
    .symbol-tag {
      background: var(--badge-bg);
      color: var(--badge-fg);
      border-radius: 3px;
      padding: 1px 6px;
      font-size: 10px;
    }
    .detail-close {
      position: absolute;
      top: 8px;
      right: 8px;
      background: none;
      border: none;
      color: var(--fg);
      cursor: pointer;
      font-size: 14px;
      opacity: 0.6;
    }
    .detail-close:hover { opacity: 1; }
    .detail-link {
      color: var(--accent);
      cursor: pointer;
      text-decoration: underline;
    }

    /* Loading */
    #loading {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      font-size: 14px;
      opacity: 0.5;
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--border);
      border-top: 2px solid var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 10px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Edges drawn on SVG */
    #edges-svg {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 1;
    }
    .edge-line {
      stroke: var(--border);
      stroke-width: 1.5;
      fill: none;
      opacity: 0.5;
    }
    .edge-line.highlighted {
      stroke: var(--accent);
      stroke-width: 2;
      opacity: 0.9;
    }
    .edge-arrow {
      fill: var(--border);
      opacity: 0.5;
    }
    .edge-arrow.highlighted {
      fill: var(--accent);
      opacity: 0.9;
    }
  </style>
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

function getBaseStyles(): string {
  return `
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #d4d4d4);
      --border: var(--vscode-panel-border, #444);
      --accent: var(--vscode-focusBorder, #007acc);
      --node-bg: var(--vscode-editorWidget-background, #252526);
      --node-border: var(--vscode-editorWidget-border, #454545);
      --node-selected: var(--vscode-list-activeSelectionBackground, #094771);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #fff);
      --sidebar-bg: var(--vscode-sideBar-background, #1e1e1e);
      --input-bg: var(--vscode-input-background, #3c3c3c);
      --input-border: var(--vscode-input-border, #555);
      --input-fg: var(--vscode-input-foreground, #ccc);
      --scrollbar: var(--vscode-scrollbarSlider-background, rgba(121,121,121,.4));
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      overflow: hidden;
      width: 100vw;
      height: 100vh;
    }
    #root { width: 100%; height: 100%; }
    .app {
      display: flex;
      width: 100%;
      height: 100%;
    }

    /* Sidebar */
    .sidebar {
      width: 240px;
      min-width: 200px;
      max-width: 360px;
      background: var(--sidebar-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .sidebar-header {
      padding: 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .sidebar-header h2 {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }
    .search-input {
      width: 100%;
      padding: 4px 8px;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--input-fg);
      border-radius: 2px;
      font-size: 12px;
      outline: none;
    }
    .search-input:focus { border-color: var(--accent); }
    .subsystem-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 0;
    }
    .subsystem-list::-webkit-scrollbar { width: 6px; }
    .subsystem-list::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 3px; }
    .subsystem-item {
      padding: 6px 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      user-select: none;
    }
    .subsystem-item:hover { background: rgba(255,255,255,0.05); }
    .subsystem-item.active { background: var(--node-selected); }
    .subsystem-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .subsystem-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .subsystem-count {
      margin-left: auto;
      background: var(--badge-bg);
      color: var(--badge-fg);
      border-radius: 8px;
      padding: 1px 6px;
      font-size: 11px;
      flex-shrink: 0;
    }
    .empty-state {
      padding: 12px;
      opacity: 0.5;
      font-size: 12px;
    }
    .stats {
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      font-size: 11px;
      opacity: 0.7;
      line-height: 1.6;
    }

    /* Main content */
    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
    }

    /* Toolbar */
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--sidebar-bg);
      z-index: 10;
      gap: 8px;
    }
    .toolbar-group {
      display: flex;
      gap: 4px;
    }
    .toolbar-btn {
      background: var(--node-bg);
      border: 1px solid var(--node-border);
      color: var(--fg);
      padding: 3px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }
    .toolbar-btn:hover { background: var(--node-selected); }
    .toolbar-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }

    /* Loading */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      font-size: 14px;
      opacity: 0.5;
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid var(--border);
      border-top: 2px solid var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 10px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* React Flow container */
    .reactflow-container {
      flex: 1;
      width: 100%;
      height: 100%;
    }
    .react-flow__node { cursor: pointer; }
    .react-flow__minimap { border-radius: 4px; border: 1px solid var(--border); }
    .react-flow__controls { border-radius: 4px; border: 1px solid var(--border); }
    .react-flow__controls button {
      background: var(--node-bg) !important;
      border-color: var(--node-border) !important;
      color: var(--fg) !important;
    }
    .react-flow__controls button:hover { background: var(--node-selected) !important; }
    .react-flow__background { opacity: 0.3; }

    /* Module node (React Flow custom) */
    .module-node {
      background: var(--node-bg);
      border: 1px solid var(--node-border);
      border-left-width: 3px;
      border-radius: 6px;
      padding: 8px 12px;
      min-width: 130px;
      max-width: 220px;
      font-size: 12px;
      position: relative;
      transition: box-shadow 0.15s, opacity 0.2s;
    }
    .module-node:hover { box-shadow: 0 0 0 1px var(--accent); }
    .module-node.selected {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent);
    }
    .module-node.dimmed { opacity: 0.15; }
    .module-node-label {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .module-node-meta {
      font-size: 10px;
      opacity: 0.6;
      margin-top: 2px;
    }
    .module-node-badge {
      position: absolute;
      top: -6px;
      right: -6px;
      background: var(--accent);
      color: #fff;
      border-radius: 8px;
      padding: 0 5px;
      font-size: 10px;
      font-weight: 600;
      line-height: 16px;
    }
    .module-node-group-bar {
      height: 3px;
      border-radius: 0 0 4px 4px;
      margin: 6px -12px -8px;
    }
    .handle { opacity: 0; width: 6px; height: 6px; }

    /* Subsystem header node */
    .subsystem-header-node {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.7;
      border: 1px dashed;
      border-radius: 4px;
      background: rgba(255,255,255,0.03);
    }
    .subsystem-header-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .subsystem-header-count {
      background: var(--badge-bg);
      color: var(--badge-fg);
      border-radius: 8px;
      padding: 0 5px;
      font-size: 10px;
      margin-left: 4px;
    }

    /* Cytoscape container */
    .cytoscape-container {
      flex: 1;
      position: relative;
      width: 100%;
      height: 100%;
    }
    .cytoscape-canvas {
      width: 100%;
      height: 100%;
    }
    .cy-fit-btn {
      position: absolute;
      top: 12px;
      right: 12px;
      background: var(--node-bg);
      border: 1px solid var(--node-border);
      color: var(--fg);
      width: 28px;
      height: 28px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      z-index: 10;
    }
    .cy-fit-btn:hover { background: var(--node-selected); }

    /* Detail panel */
    .detail-panel {
      position: absolute;
      bottom: 12px;
      left: 12px;
      right: 12px;
      background: var(--node-bg);
      border: 1px solid var(--node-border);
      border-radius: 6px;
      padding: 12px 16px;
      z-index: 10;
      max-height: 220px;
      overflow-y: auto;
      font-size: 12px;
    }
    .detail-panel h3 {
      margin-bottom: 6px;
      font-size: 13px;
    }
    .detail-close {
      position: absolute;
      top: 8px;
      right: 8px;
      background: none;
      border: none;
      color: var(--fg);
      cursor: pointer;
      font-size: 14px;
      opacity: 0.6;
    }
    .detail-close:hover { opacity: 1; }
    .detail-row {
      display: flex;
      gap: 12px;
      padding: 2px 0;
    }
    .detail-label {
      opacity: 0.6;
      min-width: 60px;
    }
    .detail-link {
      color: var(--accent);
      cursor: pointer;
      text-decoration: underline;
    }
    .detail-section-label {
      margin-top: 6px;
      opacity: 0.6;
    }
    .detail-symbols {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }
    .symbol-tag {
      background: var(--badge-bg);
      color: var(--badge-fg);
      border-radius: 3px;
      padding: 1px 6px;
      font-size: 10px;
      cursor: pointer;
    }
    .symbol-tag:hover { opacity: 0.8; }
    .detail-deps {
      margin-top: 4px;
      font-size: 11px;
    }
    .dep-item {
      display: flex;
      gap: 6px;
      padding: 1px 0;
      opacity: 0.7;
    }
    .dep-arrow { font-weight: bold; }
  `;
}
