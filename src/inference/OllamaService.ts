import * as http from 'http';
import { ArchitectureGraph, GraphNode, GraphEdge } from '../types';

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
        onChunk?: (text: string) => void
    ): Promise<SystemArchitecture> {
        const prompt = this.buildArchitecturePrompt(graph);

        const fullResponse = await this.generate(modelTag, prompt, onChunk);

        return this.parseArchitectureResponse(fullResponse, graph);
    }

    /** Chat with the AI about the architecture */
    async chat(
        message: string,
        modelTag: string,
        onChunk?: (text: string) => void
    ): Promise<string> {
        this.conversationHistory.push({
            role: 'user',
            content: message,
            timestamp: Date.now(),
        });

        const systemPrompt = this.buildChatSystemPrompt();
        const messages = [
            { role: 'system', content: systemPrompt },
            ...this.conversationHistory.slice(-10).map((m) => ({
                role: m.role,
                content: m.content,
            })),
        ];

        const response = await this.chatCompletion(modelTag, messages, onChunk);

        this.conversationHistory.push({
            role: 'assistant',
            content: response,
            timestamp: Date.now(),
        });

        return response;
    }

    /** Set the architecture context for chat conversations */
    setArchitectureContext(graph: ArchitectureGraph): void {
        this.architectureContext = this.summarizeGraph(graph);
    }

    /** Clear conversation history */
    clearConversation(): void {
        this.conversationHistory = [];
    }

    getConversationHistory(): ChatMessage[] {
        return [...this.conversationHistory];
    }

    // --- Prompt Construction ---

    private buildArchitecturePrompt(graph: ArchitectureGraph): string {
        const treeSummary = this.summarizeGraph(graph);

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

    private summarizeGraph(graph: ArchitectureGraph): string {
        const lines: string[] = [];

        lines.push(`Files: ${graph.metadata.fileCount} | Symbols: ${graph.metadata.totalSymbols} | Languages: ${graph.metadata.languages.join(', ')}`);
        lines.push('');

        // Group by subsystem
        for (const sub of graph.subsystems) {
            lines.push(`## ${sub.name} (${sub.nodeIds.length} modules)`);
            const subNodes = graph.nodes.filter((n) => sub.nodeIds.includes(n.id));
            for (const node of subNodes.slice(0, 15)) {
                const symbolNames = node.symbols.slice(0, 5).map((s) => s.name).join(', ');
                lines.push(`  - ${node.id}: ${node.symbols.length} symbols [${symbolNames}]`);
            }
            if (subNodes.length > 15) {
                lines.push(`  ... and ${subNodes.length - 15} more modules`);
            }
        }

        lines.push('');
        lines.push('## Dependencies:');
        for (const edge of graph.edges.slice(0, 50)) {
            lines.push(`  ${edge.source} → ${edge.target}`);
        }
        if (graph.edges.length > 50) {
            lines.push(`  ... and ${graph.edges.length - 50} more dependencies`);
        }

        return lines.join('\n');
    }

    // --- Ollama API Calls ---

    private async generate(
        model: string,
        prompt: string,
        onChunk?: (text: string) => void
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                model,
                prompt,
                stream: true,
                options: {
                    temperature: 0.3,
                    num_predict: 4096,
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
        onChunk?: (text: string) => void
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({
                model,
                messages,
                stream: true,
                options: {
                    temperature: 0.5,
                    num_predict: 2048,
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
