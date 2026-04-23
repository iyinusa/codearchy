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

export class OllamaService {
    private conversationHistory: ChatMessage[] = [];
    private architectureContext: string = '';

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
     * Pre-load the model into memory so the first real call doesn't pay the
     * 2–10 s cold-start cost. Sends a single-token request and asks Ollama to
     * keep the model resident for `keep_alive`. Safe to call repeatedly.
     */
    async warmUp(modelTag: string, mode: ProcessingMode = 'moderate'): Promise<void> {
        const profile = getProcessingProfile(mode);
        const body = JSON.stringify({
            model: modelTag,
            prompt: 'ok',
            stream: false,
            keep_alive: profile.keepAlive,
            options: {
                num_predict: 1,
                temperature: 0,
            },
        });
        try {
            await this.httpPost('/api/generate', body, 60000);
        } catch {
            // Warm-up is best-effort — never surface errors to the UI.
        }
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
        return `You are CodeArchy, an AI architecture assistant. You help developers understand their codebase architecture.

You have access to the following codebase architecture:
${this.architectureContext}

GUIDELINES:
- Answer questions about the architecture, subsystems, dependencies, and design patterns.
- Explain complex relationships in simple terms.
- When asked about specific modules, reference their role in the overall architecture.
- Be concise but thorough. Use bullet points for lists.
- If asked about code specifics you don't have, say so honestly.`;
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
        onChunk?: (text: string) => void
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
