import * as http from 'http';
import { ArchitectureGraph } from '../types';

export interface OllamaModelInfo {
    name: string;
    size: number;
    modified_at: string;
}

export interface ModelOption {
    id: 'gemma-e2b' | 'gemma-e4b';
    label: string;
    ollamaTag: string;
    description: string;
    paramSize: string;
    diskSize: string;
    ramRequired: string;
    installed: boolean;
}

export const MODEL_OPTIONS: ModelOption[] = [
    {
        id: 'gemma-e2b',
        label: 'Gemma 4 E2B',
        ollamaTag: 'gemma4:e2b',
        description: 'Fast, lightweight — ideal for quick architecture overviews.',
        paramSize: '5.12B Parameters',
        diskSize: '7.2 GB',
        ramRequired: '~4 GB RAM',
        installed: false,
    },
    {
        id: 'gemma-e4b',
        label: 'Gemma 4 E4B',
        ollamaTag: 'gemma4:e4b',
        description: 'Deeper analysis — richer subsystem detection and naming.',
        paramSize: '8B Parameters',
        diskSize: '9.6 GB',
        ramRequired: '~8 GB RAM',
        installed: false,
    },
];

export interface SystemArchNode {
    id: string;
    label: string;
    description: string;
    type: 'subsystem' | 'layer' | 'service' | 'external';
    color: string;
    children?: string[];
}

export interface SystemArchEdge {
    id: string;
    source: string;
    target: string;
    label: string;
    type: 'dependency' | 'data-flow' | 'api-call' | 'event';
}

export interface SystemArchitecture {
    nodes: SystemArchNode[];
    edges: SystemArchEdge[];
    pattern: string;
    summary: string;
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
}

/**
 * AI processing tier — trades response speed against analytical depth.
 * The user picks one of these from the Sidebar; the host applies the matching
 * profile to every Ollama call so prompt length, num_predict, num_ctx and
 * thinking-token usage scale together.
 */
export type ProcessingMode = 'fast' | 'moderate' | 'indepth';

interface ProcessingProfile {
    /** Hard cap on response tokens — biggest single driver of latency. */
    numPredict: number;
    /** Context window. Larger = slower prefill but more codebase fits. */
    numCtx: number;
    topK: number;
    topP: number;
    /** How many modules to enumerate per subsystem in the architecture prompt. */
    maxModulesPerSubsystem: number;
    /** Symbol names per module (0 = omit symbol identifiers entirely). */
    maxSymbolNames: number;
    /** Cap on edges included in the codebase summary. */
    maxEdges: number;
    /** Conversation turns kept in the chat context window. */
    maxChatHistory: number;
    /** Whether to enable Gemma's hidden "thinking" tokens (slower, deeper). */
    think: boolean;
    /** How long Ollama keeps the model resident after a call. */
    keepAlive: string;
    temperature: number;
}

const PROCESSING_PROFILES: Record<ProcessingMode, ProcessingProfile> = {
    fast: {
        numPredict: 512,
        numCtx: 2048,
        topK: 20,
        topP: 0.9,
        maxModulesPerSubsystem: 0,
        maxSymbolNames: 0,
        maxEdges: 15,
        maxChatHistory: 4,
        think: false,
        keepAlive: '30m',
        temperature: 0.2,
    },
    moderate: {
        numPredict: 1024,
        numCtx: 4096,
        topK: 40,
        topP: 0.95,
        maxModulesPerSubsystem: 5,
        maxSymbolNames: 0,
        maxEdges: 30,
        maxChatHistory: 6,
        think: false,
        keepAlive: '30m',
        temperature: 0.1,
    },
    indepth: {
        numPredict: 4096,
        numCtx: 8192,
        topK: 40,
        topP: 0.95,
        maxModulesPerSubsystem: 15,
        maxSymbolNames: 5,
        maxEdges: 80,
        maxChatHistory: 10,
        think: true,
        keepAlive: '30m',
        temperature: 0.0,
    },
};

export function getProcessingProfile(mode: ProcessingMode): Readonly<ProcessingProfile> {
    return PROCESSING_PROFILES[mode] ?? PROCESSING_PROFILES.moderate;
}

const OLLAMA_BASE = 'http://localhost:11434';

// Strip LaTeX math/text notation from strings so they read as plain English.
// Applied in two stages: named arrows + wrappers first, then $...$-delimited symbols.
function sanitizeLatexCommands(text: string): string {
    let out = text;

    // Stage 1: named arrows with labels (handle before \text{} unwrapping so
    //   \xrightarrow{\text{label}} → \xrightarrow{label} → →[label])
    out = out.replace(/\\xrightarrow\{([^{}]*)\}/g,
        (_, l: string) => l.trim() ? `→[${l.trim()}]` : '→');
    out = out.replace(/\\xleftarrow\{([^{}]*)\}/g,
        (_, l: string) => l.trim() ? `←[${l.trim()}]` : '←');
    out = out.replace(/\\xRightarrow\{([^{}]*)\}/g,
        (_, l: string) => l.trim() ? `⇒[${l.trim()}]` : '⇒');
    out = out.replace(/\\xLeftarrow\{([^{}]*)\}/g,
        (_, l: string) => l.trim() ? `⇐[${l.trim()}]` : '⇐');
    out = out.replace(/\\xleftrightarrow\{([^{}]*)\}/g,
        (_, l: string) => l.trim() ? `↔[${l.trim()}]` : '↔');

    // Stage 2: unwrap \text{…} and common math/text wrappers
    out = out.replace(/\\text\{([^{}]*)\}/g, '$1');
    out = out.replace(/\\(?:mathbf|mathit|mathcal|mathrm|mathsf|mathtt|boldsymbol|textbf|textit|texttt|textrm|emph)\{([^{}]*)\}/g, '$1');

    // Stage 3: $…$ symbol shorthands
    out = out.replace(/\$\\rightarrow\$/g, '→');
    out = out.replace(/\$\\leftarrow\$/g, '←');
    out = out.replace(/\$\\Rightarrow\$/g, '⇒');
    out = out.replace(/\$\\Leftarrow\$/g, '⇐');
    out = out.replace(/\$\\leftrightarrow\$/g, '↔');
    out = out.replace(/\$\\to\$/g, '→');
    out = out.replace(/\$\\gets\$/g, '←');
    out = out.replace(/\$\\geq\$/g, '≥');
    out = out.replace(/\$\\leq\$/g, '≤');
    out = out.replace(/\$\\neq\$/g, '≠');
    out = out.replace(/\$\\approx\$/g, '≈');
    out = out.replace(/\$\\times\$/g, '×');
    out = out.replace(/\$\\cdot\$/g, '·');
    out = out.replace(/\$\\infty\$/g, '∞');
    // Strip remaining $$…$$ or $…$ fences, keeping inner text
    out = out.replace(/\$\$([^$]+)\$\$/g, '$1');
    out = out.replace(/\$([^$\n]+)\$/g, '$1');

    // Stage 4: catch-all — any remaining \command{content} → content
    out = out.replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, '$1');
    // Lone \command (no braces) — remove
    out = out.replace(/\\[a-zA-Z]+\b/g, '');

    return out;
}

function sanitizeNarration(text: string): string {
    return sanitizeLatexCommands(text);
}

export class OllamaService {
    private conversationHistory: ChatMessage[] = [];
    private architectureContext: string = '';
    private systemArchitecture: SystemArchitecture | undefined;

    /** Check if Ollama is running */
    async isAvailable(): Promise<boolean> {
        try {
            await this.httpGet(`${OLLAMA_BASE}/api/tags`);
            return true;
        } catch {
            return false;
        }
    }

    /** List installed models and check which ones are available */
    async getModelStatus(): Promise<{ ollamaRunning: boolean; models: ModelOption[] }> {
        try {
            const response = await this.httpGet(`${OLLAMA_BASE}/api/tags`);
            const data = JSON.parse(response);
            const installedModels: string[] = (data.models || []).map((m: OllamaModelInfo) => m.name);

            const models = MODEL_OPTIONS.map((opt) => ({
                ...opt,
                installed: installedModels.some(
                    (m) => m.startsWith(opt.ollamaTag) || m === opt.ollamaTag
                ),
            }));

            return { ollamaRunning: true, models };
        } catch {
            return {
                ollamaRunning: false,
                models: MODEL_OPTIONS.map((m) => ({ ...m, installed: false })),
            };
        }
    }

    /** Generate high-level system architecture from codebase graph */
    async generateSystemArchitecture(
        graph: ArchitectureGraph,
        modelTag: string,
        onChunk?: (text: string) => void,
        mode: ProcessingMode = 'moderate'
    ): Promise<SystemArchitecture> {
        const profile = getProcessingProfile(mode);
        const prompt = this.buildArchitecturePrompt(graph, profile);

        const fullResponse = await this.generate(modelTag, prompt, profile, onChunk);

        return this.parseArchitectureResponse(fullResponse, graph);
    }

    /** Chat with the AI about the architecture */
    async chat(
        message: string,
        modelTag: string,
        onChunk?: (text: string) => void,
        onThinkChunk?: (text: string) => void,
        mode: ProcessingMode = 'moderate'
    ): Promise<string> {
        const profile = getProcessingProfile(mode);

        this.conversationHistory.push({
            role: 'user',
            content: message,
            timestamp: Date.now(),
        });

        const systemPrompt = this.buildChatSystemPrompt();
        const messages = [
            { role: 'system', content: systemPrompt },
            ...this.conversationHistory.slice(-profile.maxChatHistory).map((m) => ({
                role: m.role,
                content: m.content,
            })),
        ];

        const response = await this.chatCompletion(modelTag, messages, profile, onChunk, onThinkChunk);

        this.conversationHistory.push({
            role: 'assistant',
            content: response,
            timestamp: Date.now(),
        });

        return response;
    }

    /**
     * Distil a verbose chat answer into a compact, ordered list of
     * architectural flow steps. Used as a pre-processing pass before
     * `generateNarration()` so important behaviours aren't lost when the
     * raw answer is later truncated to fit the narration prompt window.
     *
     * Returns plain text (one short bullet per line). Returns an empty
     * string if extraction fails — callers should fall back to the raw
     * answer in that case.
     */
    async extractKeyFlow(
        input: { question: string; answer: string },
        modelTag: string,
        mode: ProcessingMode = 'fast',
    ): Promise<string> {
        const base = getProcessingProfile(mode);
        const profile: ProcessingProfile = {
            ...base,
            // Keep this stage tight — narration extraction should never
            // become the dominant cost. Plenty of headroom for 4-10 short
            // bullets.
            numPredict: Math.min(base.numPredict, 350),
            numCtx: Math.max(base.numCtx, 6144),
            think: false,
            temperature: 0.1,
        };

        const prompt =
            `You are an architecture analyst. Read the assistant's answer below and extract the\n` +
            `essential architectural flow as a SHORT ordered list. Strip prose, examples, code,\n` +
            `and rationale — keep only the steps that describe how the system works.\n` +
            `\nUser question:\n${input.question.slice(0, 800)}\n` +
            `\nAssistant answer:\n${input.answer.slice(0, 6000)}\n` +
            `\nReturn 4–10 plain bullet lines, one per step, in execution order.\n` +
            `Each bullet must be a single sentence (<= 140 chars), no markdown, no numbering,\n` +
            `no headings. Output the bullets only — no preamble, no closing remarks.`;

        try {
            const raw = await this.generate(modelTag, prompt, profile);
            const cleaned = this.cleanKeyFlow(raw);
            return cleaned;
        } catch {
            return '';
        }
    }

    /** Normalise the raw extractKeyFlow response into a tidy bullet list. */
    private cleanKeyFlow(raw: string): string {
        let text = raw.trim();
        // Strip any code fence the model wrapped the bullets in.
        const fence = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
        if (fence) text = fence[1].trim();

        const lines = text
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(Boolean)
            // Drop boilerplate prefaces / closings.
            .filter(l => !/^(here\s+is|here's|sure|okay|the\s+key\s+flow)/i.test(l));

        const bullets: string[] = [];
        for (const line of lines) {
            // Strip any leading markdown bullet, dash, or numbering so the
            // downstream prompt sees consistent "- step" lines.
            const stripped = line
                .replace(/^[-*•]\s+/, '')
                .replace(/^\d+[.)]\s+/, '')
                .trim();
            if (!stripped) continue;
            bullets.push(`- ${stripped.slice(0, 200)}`);
            if (bullets.length >= 12) break;
        }
        return bullets.join('\n');
    }

    /** Produce a narrator timeline from an assistant response, grounded in the
     *  available node ids. Runs silently — the Webview renders the result as
     *  an animated Story Player. Respects the user-selected processing mode
     *  but clamps token budgets so it never blocks the chat UI. */
    async generateNarration(
        input: {
            question: string;
            answer: string;
            nodes: Array<{ id: string; label: string; description?: string }>;
            preferredView: 'system' | 'reactflow';
        },
        modelTag: string,
        mode: ProcessingMode = 'fast',
    ): Promise<{
        title: string;
        steps: Array<{ targetNodeId: string; narration: string; action: 'focus' | 'highlight' | 'zoom' }>;
    }> {
        // Derive from the user's chosen profile but clamp heavy parameters so
        // narration never dominates the model's time budget. thinking tokens are
        // never needed here — we want fast, stable JSON output.
        const base = getProcessingProfile(mode);
        const profile: ProcessingProfile = {
            ...base,
            numPredict: Math.min(base.numPredict, 700),
            numCtx: Math.min(base.numCtx, 4096),
            think: false,
            temperature: Math.min(base.temperature + 0.05, 0.2),
        };
        const MAX_NODES = 60;
        const nodeList = input.nodes.slice(0, MAX_NODES);
        const nodeLines = nodeList
            .map(n => `- ${n.id} :: ${n.label}${n.description ? ' — ' + n.description.slice(0, 140) : ''}`)
            .join('\n');

        const prompt =
            `You are an architecture narrator. Convert the assistant's answer into a short visual walkthrough.\n` +
            `\nUser question:\n${input.question.slice(0, 600)}\n` +
            `\nAssistant answer:\n${input.answer.slice(0, 2000)}\n` +
            `\nAvailable nodes (id :: label):\n${nodeLines}\n` +
            `\nReturn ONLY a valid JSON object — no prose, no markdown fences, no explanation:\n` +
            `{"title":"<short 3-6 word title>","steps":[{"targetNodeId":"<id from list>","narration":"<one plain-text sentence, no LaTeX>","action":"focus"}]}\n` +
            `Rules:\n` +
            `- 2 to 10 steps.\n` +
            `- Every targetNodeId must exactly match an id from the list above.\n` +
            `- action must be one of: focus, highlight, zoom.\n` +
            `- narration must be plain English, <= 180 chars, no special symbols.\n` +
            `- Output the JSON object only. No text before or after it.`;

        const validIds = new Set(nodeList.map(n => n.id));

        // Retry once on empty/invalid parse — the model occasionally emits a
        // preamble on the first attempt that breaks JSON extraction.
        for (let attempt = 0; attempt < 2; attempt++) {
            const raw = await this.generate(modelTag, prompt, profile, undefined, { format: 'json' });
            const result = this.parseNarrationResponse(raw, validIds);
            if (result.steps.length > 0) return result;
            if (attempt === 0) {
                // Brief pause so the model runtime settles before the retry.
                await new Promise<void>(r => setTimeout(r, 300));
            }
        }
        return { title: 'Architecture walkthrough', steps: [] };
    }

    private parseNarrationResponse(
        raw: string,
        validIds: Set<string>,
    ): {
        title: string;
        steps: Array<{ targetNodeId: string; narration: string; action: 'focus' | 'highlight' | 'zoom' }>;
    } {
        // The model sometimes wraps JSON in ```json fences or adds stray prose.
        // Extract the outermost {...} block defensively.
        let text = raw.trim();
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fence) text = fence[1].trim();
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            text = text.slice(firstBrace, lastBrace + 1);
        }

        let parsed: { title?: string; steps?: unknown };
        try {
            parsed = JSON.parse(text);
        } catch {
            return { title: 'Architecture walkthrough', steps: [] };
        }

        const title = typeof parsed.title === 'string' && parsed.title.trim()
            ? parsed.title.trim().slice(0, 80)
            : 'Architecture walkthrough';

        const stepsRaw = Array.isArray(parsed.steps) ? parsed.steps : [];
        const steps: Array<{ targetNodeId: string; narration: string; action: 'focus' | 'highlight' | 'zoom' }> = [];
        for (const s of stepsRaw) {
            if (!s || typeof s !== 'object') continue;
            const step = s as Record<string, unknown>;
            const targetNodeId = typeof step.targetNodeId === 'string' ? step.targetNodeId : '';
            const narration = typeof step.narration === 'string' ? step.narration.trim() : '';
            const actionRaw = typeof step.action === 'string' ? step.action : 'focus';
            const action: 'focus' | 'highlight' | 'zoom' =
                actionRaw === 'highlight' || actionRaw === 'zoom' ? actionRaw : 'focus';
            if (!targetNodeId || !narration) continue;
            if (!validIds.has(targetNodeId)) continue; // drop hallucinated ids
            steps.push({ targetNodeId, narration: sanitizeNarration(narration).slice(0, 240), action });
            if (steps.length >= 7) break;
        }
        return { title, steps };
    }

    /** Transcribe user-recorded audio using local Ollama + Gemma. */
    async transcribeAudio(audioBase64: string, mimeType: string, modelTag: string): Promise<string> {
        const format = this.getAudioFormatFromMime(mimeType);
        const prompt =
            'Transcribe the user speech from this audio. Return only the transcript text. ' +
            'Do not add labels, explanations, or markdown.';

        // Try multiple payload schemas to support evolving Ollama multimodal APIs.
        const attempts: Array<Record<string, unknown>> = [
            {
                model: modelTag,
                stream: false,
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            {
                                type: 'input_audio',
                                input_audio: {
                                    data: audioBase64,
                                    format,
                                },
                            },
                        ],
                    },
                ],
                options: {
                    temperature: 0,
                },
            },
            {
                model: modelTag,
                stream: false,
                messages: [
                    {
                        role: 'user',
                        content: prompt,
                        audio: [audioBase64],
                    },
                ],
                options: {
                    temperature: 0,
                },
            },
            {
                model: modelTag,
                stream: false,
                messages: [
                    {
                        role: 'user',
                        content: prompt,
                        audios: [audioBase64],
                    },
                ],
                options: {
                    temperature: 0,
                },
            },
        ];

        let lastErr: Error | null = null;
        for (const body of attempts) {
            try {
                const raw = await this.httpPost('/api/chat', JSON.stringify(body), 120000);
                const transcript = this.extractTranscriptFromChatResponse(raw);
                if (transcript) {
                    return transcript;
                }
                lastErr = new Error('Model returned an empty transcript.');
            } catch (err) {
                lastErr = err instanceof Error ? err : new Error(String(err));
            }
        }

        throw new Error(
            `Audio transcription via Ollama failed. ${lastErr?.message || 'No supported audio schema worked.'}`
        );
    }

    /** Set the architecture context for chat conversations */
    setArchitectureContext(graph: ArchitectureGraph, mode: ProcessingMode = 'moderate'): void {
        this.architectureContext = this.summarizeGraph(graph, getProcessingProfile(mode));
    }

    /** Store (or clear) the AI-generated system architecture so the chat
     *  system prompt can reference named subsystems and answer diagram-
     *  specific questions intelligently. */
    setSystemArchitecture(arch: SystemArchitecture | undefined): void {
        this.systemArchitecture = arch;
    }

    /** Clear conversation history */
    clearConversation(): void {
        this.conversationHistory = [];
    }

    /** Replace conversation history from an external source (e.g. the webview
     *  DexieJS store) so per-message deletes stay in sync with the model's
     *  in-memory context window. */
    setConversationHistory(history: ChatMessage[]): void {
        this.conversationHistory = history.map(m => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
        }));
    }

    getConversationHistory(): ChatMessage[] {
        return [...this.conversationHistory];
    }

    // --- Prompt Construction ---

    private buildArchitecturePrompt(graph: ArchitectureGraph, profile: ProcessingProfile): string {
        const treeSummary = this.summarizeGraph(graph, profile);

        return `You are a senior software architect. Analyze the following codebase structure and produce a high-level system architecture diagram.

CODEBASE STRUCTURE:
${treeSummary}

INSTRUCTIONS:
1. Identify the major subsystems/layers (e.g., "API Gateway", "Auth Service", "Data Layer", "UI Layer").
2. Name each subsystem professionally — NOT by folder name. Use architect-level names.
3. Describe each subsystem's responsibility in one sentence.
4. Identify the key dependencies and data flows between subsystems.
5. Suggest the overall architectural pattern (e.g., MVC, Layered, Microservices, Event-Driven).

Respond ONLY with valid JSON in this exact format:
{
  "pattern": "Architectural pattern name",
  "summary": "One-paragraph architecture summary",
  "nodes": [
    {
      "id": "unique-id",
      "label": "Subsystem Name",
      "description": "What this subsystem does",
      "type": "subsystem|layer|service|external",
      "children": ["file-ids that belong here"]
    }
  ],
  "edges": [
    {
      "source": "node-id",
      "target": "node-id",
      "label": "relationship description",
      "type": "dependency|data-flow|api-call|event"
    }
  ]
}`;
    }

    private buildChatSystemPrompt(): string {
        const sysSection = this.buildSystemArchSection();

        return `You are CodeArchy, an AI architecture assistant. \
You help developers understand their codebase by referencing the codebase structure and live diagram data shown in the UI.

THREE DIAGRAM VIEWS ARE AVAILABLE IN THE UI:
- Flow Diagram  : Module-level dependency graph. Shows every file/module, imports, exports \
and detected symbols. This is the most granular view.
- System Diagram: AI-generated high-level architecture. Named subsystems (e.g. "Auth Layer", \
"Data Access"), their responsibilities and inter-subsystem dependencies. \
${this.systemArchitecture ? 'Data is included below.' : 'Not yet generated for this project.'}
- Dense Diagram : Full dependency graph — same data as Flow \
but with all edges visible simultaneously.

When a user references any of these diagrams by name (e.g. "From the Flow Diagram…", \
"in the System view", "on the Dense graph"), answer using the matching data provided \
below. You cannot see the visual canvas itself, but you have the complete underlying data.
${sysSection}
FLOW DIAGRAM DATA (module-level graph):
${this.architectureContext}

GUIDELINES:
- Answer questions about the architecture, subsystems, dependencies, and design patterns.
- Explain complex relationships in simple terms.
- When asked about specific modules or diagrams, reference their role in the overall architecture.
- Be concise but thorough. Use bullet points for lists.
- Never say you lack access to a diagram — you have its full data above.`;
    }

    private buildSystemArchSection(): string {
        const arch = this.systemArchitecture;
        if (!arch || !arch.nodes.length) return '';

        const lines: string[] = [
            '',
            'SYSTEM DIAGRAM DATA (AI-generated high-level architecture):',
            `Pattern: ${arch.pattern}`,
            `Summary: ${arch.summary}`,
            'Subsystems:',
        ];
        for (const n of arch.nodes) {
            lines.push(`  - ${n.id} [${n.type}]: ${n.label} — ${n.description}`);
        }
        if (arch.edges.length) {
            lines.push('Dependencies:');
            for (const e of arch.edges.slice(0, 30)) {
                lines.push(`  - ${e.source} → ${e.target}${e.label ? ` (${e.label})` : ''}`);
            }
            if (arch.edges.length > 30) {
                lines.push(`  ... and ${arch.edges.length - 30} more`);
            }
        }
        lines.push('');
        return lines.join('\n');
    }

    private summarizeGraph(graph: ArchitectureGraph, profile: ProcessingProfile): string {
        const lines: string[] = [];
        const { maxModulesPerSubsystem, maxSymbolNames, maxEdges } = profile;

        lines.push(`Files: ${graph.metadata.fileCount} | Symbols: ${graph.metadata.totalSymbols} | Languages: ${graph.metadata.languages.join(', ')}`);
        lines.push('');

        // Group by subsystem — at the lowest tier we only emit subsystem names
        // and module counts, which is enough for the model to infer high-level
        // groupings without burning prefill tokens on file paths.
        for (const sub of graph.subsystems) {
            lines.push(`## ${sub.name} (${sub.nodeIds.length} modules)`);
            if (maxModulesPerSubsystem <= 0) continue;

            const subNodes = graph.nodes.filter((n) => sub.nodeIds.includes(n.id));
            for (const node of subNodes.slice(0, maxModulesPerSubsystem)) {
                if (maxSymbolNames > 0) {
                    const symbolNames = node.symbols.slice(0, maxSymbolNames).map((s) => s.name).join(', ');
                    lines.push(`  - ${node.id}: ${node.symbols.length} symbols [${symbolNames}]`);
                } else {
                    lines.push(`  - ${node.id} (${node.symbols.length} symbols)`);
                }
            }
            if (subNodes.length > maxModulesPerSubsystem) {
                lines.push(`  ... and ${subNodes.length - maxModulesPerSubsystem} more modules`);
            }
        }

        // Aggregate file-level edges into subsystem-to-subsystem edges. This
        // collapses tens of thousands of imports into a handful of meaningful
        // dependencies — the only thing the architect-level prompt needs.
        const nodeToSub = new Map<string, string>();
        for (const sub of graph.subsystems) {
            for (const id of sub.nodeIds) nodeToSub.set(id, sub.name);
        }
        const subEdgeCounts = new Map<string, number>();
        for (const edge of graph.edges) {
            const s = nodeToSub.get(edge.source);
            const t = nodeToSub.get(edge.target);
            if (!s || !t || s === t) continue;
            const key = `${s} → ${t}`;
            subEdgeCounts.set(key, (subEdgeCounts.get(key) || 0) + 1);
        }
        const sortedEdges = [...subEdgeCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxEdges);

        lines.push('');
        lines.push('## Subsystem Dependencies:');
        for (const [key, count] of sortedEdges) {
            lines.push(`  ${key} (${count} refs)`);
        }
        if (subEdgeCounts.size > maxEdges) {
            lines.push(`  ... and ${subEdgeCounts.size - maxEdges} more`);
        }

        return lines.join('\n');
    }

    // --- Ollama API Calls ---

    private async generate(
        model: string,
        prompt: string,
        profile: ProcessingProfile,
        onChunk?: (text: string) => void,
        extraBodyFields?: Record<string, unknown>
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                model,
                prompt,
                stream: true,
                keep_alive: profile.keepAlive,
                options: {
                    temperature: profile.temperature,
                    num_predict: profile.numPredict,
                    num_ctx: profile.numCtx,
                    top_k: profile.topK,
                    top_p: profile.topP,
                },
                ...extraBodyFields,
            });

            const url = new URL(`${OLLAMA_BASE}/api/generate`);
            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 120000,
            };

            let fullResponse = '';

            const req = http.request(options, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Ollama returned status ${res.statusCode}`));
                    return;
                }

                res.setEncoding('utf-8');
                let buffer = '';

                res.on('data', (chunk: string) => {
                    buffer += chunk;
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.response) {
                                fullResponse += parsed.response;
                                onChunk?.(parsed.response);
                            }
                            if (parsed.done) {
                                resolve(fullResponse);
                            }
                        } catch {
                            // skip malformed lines
                        }
                    }
                });

                res.on('end', () => {
                    if (buffer.trim()) {
                        try {
                            const parsed = JSON.parse(buffer);
                            if (parsed.response) {
                                fullResponse += parsed.response;
                                onChunk?.(parsed.response);
                            }
                        } catch {
                            // ignore
                        }
                    }
                    resolve(fullResponse);
                });

                res.on('error', reject);
            });

            req.on('error', (err) => {
                reject(new Error(`Cannot connect to Ollama: ${err.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Ollama request timed out'));
            });

            req.write(body);
            req.end();
        });
    }

    private async chatCompletion(
        model: string,
        messages: Array<{ role: string; content: string }>,
        profile: ProcessingProfile,
        onChunk?: (text: string) => void,
        onThinkChunk?: (text: string) => void
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                model,
                messages,
                stream: true,
                think: profile.think,
                keep_alive: profile.keepAlive,
                options: {
                    temperature: Math.max(profile.temperature, 0.0),
                    num_predict: profile.numPredict,
                    num_ctx: profile.numCtx,
                    top_k: profile.topK,
                    top_p: profile.topP,
                },
            });

            const url = new URL(`${OLLAMA_BASE}/api/chat`);
            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 90000,
            };

            let fullResponse = '';

            const req = http.request(options, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Ollama returned status ${res.statusCode}`));
                    return;
                }

                res.setEncoding('utf-8');
                let buffer = '';

                res.on('data', (chunk: string) => {
                    buffer += chunk;
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            const parsed = JSON.parse(line);
                            // Thinking tokens (models that support think:true)
                            if (parsed.message?.thinking) {
                                onThinkChunk?.(parsed.message.thinking);
                            }
                            if (parsed.message?.content) {
                                fullResponse += parsed.message.content;
                                onChunk?.(parsed.message.content);
                            }
                        } catch {
                            // skip
                        }
                    }
                });

                res.on('end', () => {
                    if (buffer.trim()) {
                        try {
                            const parsed = JSON.parse(buffer);
                            if (parsed.message?.thinking) {
                                onThinkChunk?.(parsed.message.thinking);
                            }
                            if (parsed.message?.content) {
                                fullResponse += parsed.message.content;
                                onChunk?.(parsed.message.content);
                            }
                        } catch {
                            // ignore
                        }
                    }
                    resolve(fullResponse);
                });

                res.on('error', reject);
            });

            req.on('error', (err) => {
                reject(new Error(`Cannot connect to Ollama: ${err.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Chat request timed out'));
            });

            req.write(body);
            req.end();
        });
    }

    private httpGet(urlStr: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const url = new URL(urlStr);
            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'GET',
                timeout: 5000,
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.setEncoding('utf-8');
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => resolve(data));
                res.on('error', reject);
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });
            req.end();
        });
    }

    private httpPost(pathName: string, body: string, timeoutMs: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const url = new URL(`${OLLAMA_BASE}${pathName}`);
            const options: http.RequestOptions = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: timeoutMs,
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.setEncoding('utf-8');
                res.on('data', (chunk: string) => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`Ollama returned status ${res.statusCode}: ${data}`));
                        return;
                    }
                    resolve(data);
                });
                res.on('error', reject);
            });

            req.on('error', (err) => {
                reject(new Error(`Cannot connect to Ollama: ${err.message}`));
            });
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Ollama request timed out'));
            });

            req.write(body);
            req.end();
        });
    }

    private getAudioFormatFromMime(mimeType: string): string {
        if (mimeType.includes('wav')) return 'wav';
        if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
        if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
        if (mimeType.includes('ogg')) return 'ogg';
        return 'webm';
    }

    private extractTranscriptFromChatResponse(raw: string): string {
        const parsed = JSON.parse(raw);
        if (parsed.error) {
            throw new Error(String(parsed.error));
        }

        const content = typeof parsed?.message?.content === 'string'
            ? parsed.message.content.trim()
            : '';

        if (!content) return '';

        // Sometimes models wrap output in JSON or labels despite instructions.
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const json = JSON.parse(jsonMatch[0]);
                if (typeof json.transcript === 'string') {
                    return json.transcript.trim();
                }
                if (typeof json.text === 'string') {
                    return json.text.trim();
                }
            } catch {
                // fall through to raw cleanup
            }
        }

        return content
            .replace(/^```(?:text|json)?\s*/i, '')
            .replace(/```$/i, '')
            .replace(/^transcript\s*:\s*/i, '')
            .trim();
    }

    // --- Response Parsing ---

    private parseArchitectureResponse(
        response: string,
        graph: ArchitectureGraph
    ): SystemArchitecture {
        // Try to extract JSON from the response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                return this.validateAndEnrich(parsed, graph);
            } catch {
                // Fall through to fallback
            }
        }

        // Fallback: build from existing heuristic subsystems
        return this.buildFallbackArchitecture(graph);
    }

    private validateAndEnrich(
        raw: Record<string, unknown>,
        graph: ArchitectureGraph
    ): SystemArchitecture {
        const COLORS = [
            '#4FC3F7', '#81C784', '#FFB74D', '#E57373',
            '#BA68C8', '#4DB6AC', '#FF8A65', '#90A4AE',
            '#AED581', '#FFD54F', '#F06292', '#7986CB',
        ];

        const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
        const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];

        const nodes: SystemArchNode[] = rawNodes.map(
            (n: Record<string, unknown>, i: number) => ({
                id: String(n.id || `sys-${i}`),
                label: String(n.label || `Subsystem ${i + 1}`),
                description: String(n.description || ''),
                type: (['subsystem', 'layer', 'service', 'external'].includes(String(n.type))
                    ? String(n.type) as SystemArchNode['type']
                    : 'subsystem'),
                color: COLORS[i % COLORS.length],
                children: Array.isArray(n.children) ? n.children.map(String) : undefined,
            })
        );

        const nodeIds = new Set(nodes.map((n) => n.id));
        const edges: SystemArchEdge[] = rawEdges
            .filter((e: Record<string, unknown>) =>
                nodeIds.has(String(e.source)) && nodeIds.has(String(e.target))
            )
            .map((e: Record<string, unknown>, i: number) => ({
                id: `sysedge-${i}`,
                source: String(e.source),
                target: String(e.target),
                label: String(e.label || ''),
                type: (['dependency', 'data-flow', 'api-call', 'event'].includes(String(e.type))
                    ? String(e.type) as SystemArchEdge['type']
                    : 'dependency'),
            }));

        return {
            nodes,
            edges,
            pattern: String(raw.pattern || 'Unknown'),
            summary: String(raw.summary || ''),
        };
    }

    private buildFallbackArchitecture(graph: ArchitectureGraph): SystemArchitecture {
        const COLORS = [
            '#4FC3F7', '#81C784', '#FFB74D', '#E57373',
            '#BA68C8', '#4DB6AC', '#FF8A65', '#90A4AE',
        ];

        const nodes: SystemArchNode[] = graph.subsystems.map((sub, i) => ({
            id: sub.id,
            label: sub.name,
            description: sub.description,
            type: 'subsystem' as const,
            color: COLORS[i % COLORS.length],
            children: sub.nodeIds,
        }));

        // Build inter-subsystem edges
        const subsystemMap = new Map<string, string>();
        for (const sub of graph.subsystems) {
            for (const nodeId of sub.nodeIds) {
                subsystemMap.set(nodeId, sub.id);
            }
        }

        const edgeSet = new Set<string>();
        const edges: SystemArchEdge[] = [];
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
            summary: `This codebase contains ${graph.subsystems.length} subsystems with ${graph.metadata.fileCount} files across ${graph.metadata.languages.join(', ')}.`,
        };
    }
}
