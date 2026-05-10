import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { ArchitectureGraph, WebviewMessage, WebviewMessageType } from '../types';
import { OllamaService, MODEL_OPTIONS, SystemArchitecture, ProcessingMode } from '../inference/OllamaService';
import { HostAudioRecorder } from '../audio/HostAudioRecorder';

/**
 * Detect which diagram the user wants the narrator to walk through, based on
 * keywords in their question. Defaults to the Flow Diagram (reactflow) — it's
 * the most granular view and gives the deepest explanation of the codebase.
 *
 *   - "system"  → System Diagram (high-level subsystems)
 *   - "flow"    → Flow Diagram (default, file-level modules + subsystems)
 *   - "dense"   → Dense Graph (Cytoscape rendering of the same flow data)
 */
function detectViewHint(question: string): 'system' | 'flow' | 'dense' {
  const q = question.toLowerCase();
  // Use word-boundary matches so a casual word like "systematic" doesn't
  // hijack the narrator into the System Diagram.
  if (/\bsystem\b/.test(q)) return 'system';
  if (/\bdense\b/.test(q)) return 'dense';
  if (/\bflow\b/.test(q)) return 'flow';
  return 'flow';
}

export class ArchitecturePanel {
  private static instance: ArchitecturePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  private currentGraph: ArchitectureGraph | undefined;
  private currentSystemArch: SystemArchitecture | undefined;
  private ollamaService: OllamaService;
  private selectedModel: string | null = null;
  private processingMode: ProcessingMode = 'moderate';
  private hostRecorder: HostAudioRecorder = new HostAudioRecorder();
  private extensionContext: vscode.ExtensionContext;
  /** Localhost HTTP server that serves pre-bundled Kokoro model + ORT WASM files.
   *  Bypasses the VS Code webview resource server which returns HTTP 408 for large
   *  binary files (the ~82 MB ONNX) when fetched from a blob: worker context. */
  private modelServer: http.Server | null = null;
  private modelServerPort = 0;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.extensionContext = context;
    this.ollamaService = new OllamaService();

    // Load saved model selection
    const config = vscode.workspace.getConfiguration('codearchy');
    const aiModel = config.get<string>('aiModel', 'none');
    if (aiModel !== 'none') {
      this.selectedModel = aiModel;
    }
    this.processingMode = config.get<ProcessingMode>('aiProcessing', 'moderate');

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Start the localhost model server asynchronously; set the webview HTML
    // once the port is known (address() returns null until 'listening' fires).
    this.startModelServer().then(port => {
      this.modelServerPort = port;
      this.panel.webview.html = this.getWebviewContent();
      if (this.currentGraph) {
        this.sendGraphData(this.currentGraph);
      }
    });

    this.panel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(message),
      null,
      this.disposables
    );
  }

  static createOrShow(context: vscode.ExtensionContext, graph: ArchitectureGraph) {
    const extensionUri = context.extensionUri;
    const column = vscode.ViewColumn.Beside;

    if (ArchitecturePanel.instance) {
      ArchitecturePanel.instance.panel.reveal(column);
      ArchitecturePanel.instance.sendGraphData(graph);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'codearchArchitecture',
      'CodeArchy: Explainable Architecture',
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

    ArchitecturePanel.instance = new ArchitecturePanel(panel, extensionUri, context);
    ArchitecturePanel.instance.panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
    ArchitecturePanel.instance.currentGraph = graph;
    // webview.html is set asynchronously inside the constructor once the
    // localhost model server has started and its port is known.
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
    // Pre-build the architecture context cache so the first chat message
    // doesn't have to do it synchronously on the hot path.
    this.ollamaService.setArchitectureContext(graph, this.processingMode);
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
        // Send the persisted processing mode so the Sidebar reflects it.
        this.panel.webview.postMessage({
          type: WebviewMessageType.SetProcessingMode,
          payload: { mode: this.processingMode },
        });
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

      case WebviewMessageType.SetProcessingMode: {
        const payload = message.payload as { mode: ProcessingMode };
        if (payload && (payload.mode === 'fast' || payload.mode === 'moderate' || payload.mode === 'indepth')) {
          this.processingMode = payload.mode;
          const config = vscode.workspace.getConfiguration('codearchy');
          config.update('aiProcessing', payload.mode, vscode.ConfigurationTarget.Workspace);
        }
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

      case WebviewMessageType.SyncChatHistory: {
        const payload = message.payload as {
          history: Array<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: number }>;
        };
        if (payload && Array.isArray(payload.history)) {
          this.ollamaService.setConversationHistory(payload.history);
        }
        break;
      }

      case WebviewMessageType.SyncSystemArch: {
        // The webview loaded a cached system architecture from IndexedDB and
        // is pushing it here so subsequent chat messages have subsystem data
        // even without re-running AI generation.
        const payload = message.payload as { architecture: SystemArchitecture };
        if (payload?.architecture) {
          this.currentSystemArch = payload.architecture;
          this.ollamaService.setSystemArchitecture(payload.architecture);
        }
        break;
      }

      case WebviewMessageType.StartVoiceRecording:
        this.handleStartVoiceRecording();
        break;

      case WebviewMessageType.StopVoiceRecording:
        this.handleStopVoiceRecording();
        break;

      case WebviewMessageType.VoiceConfigPersist: {
        const vcPayload = message.payload as { kokoroActivated?: boolean };
        if (vcPayload && typeof vcPayload === 'object') {
          const current = (this.extensionContext.globalState.get<object>('codearchy.voiceConfig') ?? {}) as Record<string, unknown>;
          this.extensionContext.globalState.update('codearchy.voiceConfig', { ...current, ...vcPayload });
        }
        break;
      }

      case WebviewMessageType.GenerateNarrator: {
        const narratorPayload = message.payload as {
          question: string;
          answer: string;
          messageTimestamp?: number;
        };
        if (narratorPayload && narratorPayload.question && narratorPayload.answer) {
          // Intentionally not awaited — narrator runs silently in the background.
          this.handleGenerateNarrator(narratorPayload);
        }
        break;
      }
    }
  }

  // --- Voice Input Handler ---

  private async handleStartVoiceRecording() {
    // Pre-flight: ensure a model is selected so transcription will succeed later.
    const modelOpt = MODEL_OPTIONS.find((m) => m.id === this.selectedModel);
    if (!modelOpt) {
      this.panel.webview.postMessage({
        type: WebviewMessageType.VoiceRecordingState,
        payload: {
          state: 'error',
          error: 'No AI model selected. Select Gemma 4 E2B or E4B to use voice input.',
        },
      });
      return;
    }

    try {
      const recorder = await this.hostRecorder.start();
      this.panel.webview.postMessage({
        type: WebviewMessageType.VoiceRecordingState,
        payload: { state: 'recording', recorder: recorder.kind },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.panel.webview.postMessage({
        type: WebviewMessageType.VoiceRecordingState,
        payload: { state: 'error', error: msg },
      });
    }
  }

  private async handleStopVoiceRecording() {
    if (!this.hostRecorder.isRecording()) {
      return;
    }

    let audio: string;
    let mimeType: string;
    try {
      const result = await this.hostRecorder.stop();
      audio = result.audio;
      mimeType = result.mimeType;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.panel.webview.postMessage({
        type: WebviewMessageType.VoiceRecordingState,
        payload: { state: 'error', error: `Recording failed: ${msg}` },
      });
      return;
    }

    // Signal transcribing state so the UI can show a spinner.
    this.panel.webview.postMessage({
      type: WebviewMessageType.VoiceRecordingState,
      payload: { state: 'transcribing' },
    });

    const modelOpt = MODEL_OPTIONS.find((m) => m.id === this.selectedModel);
    if (!modelOpt) {
      this.panel.webview.postMessage({
        type: WebviewMessageType.VoiceTranscript,
        payload: { error: 'No AI model selected.' },
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

      const transcript = await this.ollamaService.transcribeAudio(audio, mimeType, modelOpt.ollamaTag);

      if (!transcript.trim()) {
        this.panel.webview.postMessage({
          type: WebviewMessageType.VoiceTranscript,
          payload: { error: 'No speech could be transcribed from the recorded audio.' },
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

    // Pre-warm: fire a minimal request to Ollama so the model is loaded into
    // memory before the user sends their first chat message.  Runs silently
    // in the background — any failure is swallowed by warmUp() itself.
    const opt = MODEL_OPTIONS.find(m => m.id === modelId);
    if (opt) {
      this.ollamaService.warmUp(opt.ollamaTag).catch(() => { /* ignore */ });
    }
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
      this.currentSystemArch = fallbackArch;
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
        payload: { message: `Analyzing codebase with ${modelOpt.label}…` },
      });

      // Escalate the progress message if Gemma is cold-loading its weights
      // and hasn't emitted a first chunk within 600 ms.
      let firstArchChunk = false;
      const archHintTimer = setTimeout(() => {
        if (!firstArchChunk) {
          this.panel.webview.postMessage({
            type: WebviewMessageType.SystemArchProgress,
            payload: { message: 'AI processing, please wait…' },
          });
        }
      }, 600);

      const architecture = await this.ollamaService.generateSystemArchitecture(
        this.currentGraph,
        modelOpt.ollamaTag,
        (chunk) => {
          if (!firstArchChunk) {
            firstArchChunk = true;
            clearTimeout(archHintTimer);
            // Switch to a "generating" message once tokens are flowing.
            this.panel.webview.postMessage({
              type: WebviewMessageType.SystemArchProgress,
              payload: { message: `Generating architecture with ${modelOpt.label}…` },
            });
          }
          this.panel.webview.postMessage({
            type: WebviewMessageType.SystemArchStream,
            payload: { chunk },
          });
        },
        this.processingMode
      );
      clearTimeout(archHintTimer);

      this.currentSystemArch = architecture;

      // Keep the OllamaService chat context up to date so subsequent chat
      // messages automatically include the freshly-generated subsystem data.
      this.ollamaService.setSystemArchitecture(architecture);

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

  // --- Narrator Handler ---

  private async handleGenerateNarrator(payload: {
    question: string;
    answer: string;
    messageTimestamp?: number;
  }) {
    // Fire-and-forget. Any failure is logged but never surfaced — narration
    // is an enhancement layer on top of the chat response.
    try {
      const modelOpt = MODEL_OPTIONS.find((m) => m.id === this.selectedModel);
      if (!modelOpt) return;
      if (!this.currentGraph && !this.currentSystemArch) return;

      // Skip the isAvailable() check here — Ollama may still be processing
      // the preceding chat response and will report "unavailable" even though
      // it can queue a second request just fine.  We rely on the HTTP timeout
      // inside generate() to handle genuine outages.

      // Small delay so the chat-completion response is fully drained before
      // we issue the narration request, reducing queue contention on the model.
      await new Promise<void>((r) => setTimeout(r, 500));

      // Detect requested diagram from the user's question. Defaults to the
      // Flow Diagram (reactflow) — it walks individual modules and is the
      // most in-depth view. The user can opt into the System Diagram or
      // the Dense Graph by saying "system", "flow", or "dense" in their
      // prompt.
      const viewHint = detectViewHint(payload.question);

      // Build the candidate node list scoped to the chosen diagram so the
      // AI doesn't pick ids from a view the user wasn't asking about.

      const FLOW_NODE_CAP = 60;
      const SYS_NODE_CAP = 20;

      const nodes: Array<{ id: string; label: string; description?: string }> = [];

      if (viewHint === 'system' && this.currentSystemArch?.nodes.length) {
        for (const n of this.currentSystemArch.nodes.slice(0, SYS_NODE_CAP)) {
          nodes.push({ id: n.id, label: n.label, description: n.description });
        }
      } else if (this.currentGraph) {
        // Flow / Dense → walk through file-level modules + subsystem groups.
        for (const n of this.currentGraph.nodes.slice(0, FLOW_NODE_CAP)) {
          nodes.push({
            id: n.id,
            label: n.label,
            description: (n.metadata?.language as string) || undefined,
          });
        }
        if (nodes.length < FLOW_NODE_CAP) {
          for (const s of this.currentGraph.subsystems) {
            if (!nodes.some(n => n.id === s.id)) {
              nodes.push({ id: s.id, label: s.name, description: s.description });
            }
          }
        }
      }

      // Ultimate fallback: if the requested view has no nodes (e.g. user
      // asked for "system" before generating one), fall back to whichever
      // dataset is available so the narrator still produces something.
      if (nodes.length === 0) {
        if (this.currentGraph) {
          for (const n of this.currentGraph.nodes.slice(0, FLOW_NODE_CAP)) {
            nodes.push({
              id: n.id,
              label: n.label,
              description: (n.metadata?.language as string) || undefined,
            });
          }
        } else if (this.currentSystemArch?.nodes.length) {
          for (const n of this.currentSystemArch.nodes.slice(0, SYS_NODE_CAP)) {
            nodes.push({ id: n.id, label: n.label, description: n.description });
          }
        }
      }

      if (nodes.length === 0) return;

      // Two-stage narration pipeline:
      //   1. Distil the assistant's full answer down to a compact, ordered
      //      list of architectural flow steps. This survives chunking far
      //      better than truncating the raw answer because the model has
      //      already filtered out prose, examples, and rationale.
      //   2. Pass that distilled flow + the candidate node list to the
      //      narrator generator, which now has more headroom to map each
      //      flow step to a node and produce a coherent walkthrough.
      let keyFlow = '';
      try {
        keyFlow = await this.ollamaService.extractKeyFlow(
          { question: payload.question, answer: payload.answer },
          modelOpt.ollamaTag,
          this.processingMode,
        );
      } catch (err) {
        console.warn('[CodeArchy] key-flow extraction failed, using raw answer', err);
      }

      // The preferredView in the payload is what App.tsx should auto-switch
      // to when the narrator starts. For 'dense' we still send 'reactflow'
      // (the type only has two values) — the dense graph is rendered by
      // CytoscapeView but App.tsx routes node-id matches there separately.
      const preferredView: 'system' | 'reactflow' =
        viewHint === 'system' ? 'system' : 'reactflow';

      const result = await this.ollamaService.generateNarration(
        {
          question: payload.question,
          // Prefer the distilled flow; fall back to the raw answer if the
          // extraction step failed.
          answer: keyFlow.trim() || payload.answer,
          nodes,
          preferredView,
        },
        modelOpt.ollamaTag,
        this.processingMode,
      );

      if (!result.steps.length) return;

      this.panel.webview.postMessage({
        type: WebviewMessageType.NarratorGenerated,
        payload: {
          title: result.title,
          question: payload.question,
          steps: result.steps,
          preferredView,
          messageTimestamp: payload.messageTimestamp,
        },
      });
    } catch (err) {
      console.warn('[CodeArchy] narrator generation failed', err);
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

    // Signal "thinking" immediately — before any network round-trip (including
    // the isAvailable() check below) so the spinner appears the instant the
    // user sends a message.
    this.panel.webview.postMessage({
      type: WebviewMessageType.ChatThinking,
      payload: { content: '' },
    });

    // If Gemma is cold-loading its model weights, the first token can take
    // many seconds.  Escalate the hint after a short delay so the user knows
    // the request is in-flight rather than frozen.
    let firstChunkReceived = false;
    const loadingHintTimer = setTimeout(() => {
      if (!firstChunkReceived) {
        this.panel.webview.postMessage({
          type: WebviewMessageType.ChatThinking,
          payload: { content: 'AI Processing, please wait…' },
        });
      }
    }, 600);

    try {
      const available = await this.ollamaService.isAvailable();
      if (!available) {
        clearTimeout(loadingHintTimer);
        this.panel.webview.postMessage({
          type: WebviewMessageType.ChatResponse,
          payload: { content: '', error: 'Cannot connect to Ollama. Make sure it\'s running.' },
        });
        return;
      }

      // Set architecture context for chat (both graph + system arch)
      this.ollamaService.setArchitectureContext(this.currentGraph, this.processingMode);
      this.ollamaService.setSystemArchitecture(this.currentSystemArch);

      const response = await this.ollamaService.chat(
        content,
        modelOpt.ollamaTag,
        (chunk) => {
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            clearTimeout(loadingHintTimer);
          }
          this.panel.webview.postMessage({
            type: WebviewMessageType.ChatChunk,
            payload: { content: chunk },
          });
        },
        (thinkChunk) => {
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            clearTimeout(loadingHintTimer);
          }
          this.panel.webview.postMessage({
            type: WebviewMessageType.ChatThinking,
            payload: { content: thinkChunk },
          });
        },
        this.processingMode
      );

      clearTimeout(loadingHintTimer);

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
    this.ollamaService.dispose();
    this.hostRecorder.cancel();
    this.modelServer?.close();
    this.modelServer = null;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  /**
   * Start a minimal localhost HTTP server to serve Kokoro model files and ORT
   * WASM binaries from `webview-ui/dist/` directly off disk.
   *
   * VS Code's webview resource server returns HTTP 408 for large binary files
   * (e.g., the ~82 MB quantized ONNX) when they are requested from a blob:
   * worker, making it unsuitable for serving model assets. A plain localhost
   * HTTP server has no such limitations and is already whitelisted by the CSP
   * (`connect-src http://127.0.0.1:*`).
   */
  private startModelServer(): Promise<number> {
    const distPath = path.join(this.extensionUri.fsPath, 'webview-ui', 'dist');
    const MIME: Record<string, string> = {
      '.json': 'application/json',
      '.onnx': 'application/octet-stream',
      '.bin': 'application/octet-stream',
      '.wasm': 'application/wasm',
      '.mjs': 'text/javascript',
      '.js': 'text/javascript',
    };

    this.modelServer = http.createServer((req, res) => {
      // Handle preflight (shouldn't be needed but be defensive)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
      }

      const rawPath = req.url?.split('?')[0] ?? '/';
      let relPath: string;
      try {
        relPath = decodeURIComponent(rawPath);
      } catch {
        res.writeHead(400); res.end(); return;
      }
      // Normalise and strip any leading traversal sequences.
      relPath = path.normalize(relPath);
      if (relPath.startsWith('..')) { res.writeHead(403); res.end(); return; }

      const filePath = path.join(distPath, relPath);
      // Belt-and-braces path-traversal guard.
      if (!filePath.startsWith(distPath + path.sep) && filePath !== distPath) {
        res.writeHead(403); res.end(); return;
      }

      let stat: fs.Stats;
      try { stat = fs.statSync(filePath); } catch { res.writeHead(404); res.end(); return; }
      if (!stat.isFile()) { res.writeHead(404); res.end(); return; }

      const ext = path.extname(filePath).toLowerCase();
      // Large immutable assets (ONNX models, WASM binaries, voice .bin files)
      // are cached aggressively so subsequent Kokoro activations skip disk I/O
      // and load from Chromium's in-memory/disk cache — dramatically faster.
      // Config / tokenizer JSON files use no-cache so extension updates are
      // picked up without users needing to clear their cache.
      const isImmutableAsset = ['.onnx', '.wasm', '.bin'].includes(ext);
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': isImmutableAsset ? 'public, max-age=3600, immutable' : 'no-cache',
      });
      fs.createReadStream(filePath).pipe(res);
    });

    return new Promise<number>((resolve) => {
      this.modelServer!.listen(0, '127.0.0.1', () => {
        const addr = this.modelServer!.address() as { port: number };
        resolve(addr.port);
      });
    });
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
      const sidebarStylesUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'sidebar.css')
      );
      const chatStylesUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css')
      );
      const iconUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png')
      );
      // Model files and ORT WASM are served via a localhost HTTP server started
      // in the extension host.  This avoids VS Code webview resource server HTTP 408
      // errors that occur when a blob: worker fetches large binary files (e.g., the
      // ~82 MB quantized ONNX) through the vscode-webview:// scheme.
      const modelServerBase = `http://127.0.0.1:${this.modelServerPort}`;
      const ortBaseUri = `${modelServerBase}/ort`;
      const kokoroModelBaseUri = `${modelServerBase}/kokoro-model/onnx-community/Kokoro-82M-v1.0-ONNX`;
      const kokoroWorkerUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist', 'kokoroWorker.js')
      );

      return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource} blob:; img-src ${webview.cspSource} data: blob:; font-src data:; connect-src ${webview.cspSource} http://localhost:* http://127.0.0.1:* https://huggingface.co; worker-src ${webview.cspSource} blob:; child-src blob:; media-src ${webview.cspSource} data: blob:;">
  <title>CodeArchy Architecture</title>
  <link rel="stylesheet" href="${cssUri}">
  <link rel="stylesheet" href="${baseStylesUri}">
  <link rel="stylesheet" href="${sidebarStylesUri}">
  <link rel="stylesheet" href="${chatStylesUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.CODEARCY_ICON_URI = "${iconUri}"; window.CODEARCHY_ORT_BASE_URI = "${ortBaseUri}/"; window.CODEARCHY_KOKORO_MODEL_BASE_URI = "${kokoroModelBaseUri}/"; window.CODEARCHY_KOKORO_WORKER_URI = "${kokoroWorkerUri}"; window.__CODEARCHY_VOICE_CONFIG = ${JSON.stringify(this.extensionContext.globalState.get<object>('codearchy.voiceConfig') ?? {})};</script>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
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
