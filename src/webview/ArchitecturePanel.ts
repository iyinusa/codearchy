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

      case WebviewMessageType.VoiceInputAudio: {
        const audioPayload = message.payload as { audio: string; mimeType: string };
        this.handleVoiceInput(audioPayload);
        break;
      }
    }
  }

  // --- Voice Input Handler ---

  private async handleVoiceInput(payload: { audio: string; mimeType: string }) {
    const modelOpt = MODEL_OPTIONS.find((m) => m.id === this.selectedModel);
    if (!modelOpt) {
      this.panel.webview.postMessage({
        type: WebviewMessageType.VoiceTranscript,
        payload: {
          error: 'No AI model selected. Select Gemma 4 E2B or E4B to use voice input.',
        },
      });
      return;
    }

    try {
      const available = await this.ollamaService.isAvailable();
      if (!available) {
        this.panel.webview.postMessage({
          type: WebviewMessageType.VoiceTranscript,
          payload: { error: 'Cannot connect to Ollama. Make sure it is running at localhost:11434.' },
        });
        return;
      }

      const transcript = await this.ollamaService.transcribeAudio(
        payload.audio,
        payload.mimeType,
        modelOpt.ollamaTag
      );

      if (!transcript.trim()) {
        this.panel.webview.postMessage({
          type: WebviewMessageType.VoiceTranscript,
          payload: {
            error: 'No speech could be transcribed from the recorded audio.',
          },
        });
        return;
      }

      this.panel.webview.postMessage({
        type: WebviewMessageType.VoiceTranscript,
        payload: { transcript: transcript.trim() },
      });
    } catch (err) {
      this.panel.webview.postMessage({
        type: WebviewMessageType.VoiceTranscript,
        payload: {
          error: `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
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
        (_chunk) => {
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:; font-src data:; media-src ${webview.cspSource} blob: mediastream:;">
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
    // return this.getFallbackWebviewContent(nonce);
    return '';
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
