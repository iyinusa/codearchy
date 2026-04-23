import * as vscode from 'vscode';
import * as path from 'path';
import {
    AnalysisProgress,
    ArchitectureGraph,
    FileAnalysis,
    getConfig,
    getLanguageFromExtension,
} from '../types';
import { IncrementalParser } from '../parser/IncrementalParser';
import { SymbolExtractor } from '../extractor/SymbolExtractor';
import { GraphBuilder } from '../graph/GraphBuilder';
import { ArchitectureInference } from '../inference/ArchitectureInference';

export class AnalysisPipeline {
    private parser: IncrementalParser;
    private extractor: SymbolExtractor;
    private inference: ArchitectureInference;

    constructor(extensionPath?: string) {
        this.parser = new IncrementalParser();
        if (extensionPath) {
            this.parser.setExtensionPath(extensionPath);
        }
        this.extractor = new SymbolExtractor();
        this.inference = new ArchitectureInference();
    }

    async initParser(): Promise<void> {
        await this.parser.initTreeSitter();
    }

    isTreeSitterAvailable(): boolean {
        return this.parser.isTreeSitterAvailable();
    }

    async analyze(
        workspaceUri: vscode.Uri,
        onProgress: (progress: AnalysisProgress) => void,
        token: vscode.CancellationToken
    ): Promise<ArchitectureGraph> {
        const config = getConfig();
        const workspaceRoot = workspaceUri.fsPath;

        // Phase 1: Discover files
        onProgress({ phase: 'discovery', current: 0, total: 1, message: 'Discovering files...' });
        const files = await this.discoverFiles(workspaceUri, config.includedLanguages, config.excludePatterns);

        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        // Phase 2: Parse files
        const analyses: FileAnalysis[] = [];
        const allFilePaths = files.map((f) => f.fsPath);

        for (let i = 0; i < files.length; i++) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const file = files[i];
            onProgress({
                phase: 'parsing',
                current: i + 1,
                total: files.length,
                message: `Parsing: ${path.relative(workspaceRoot, file.fsPath)}`,
            });

            try {
                const stat = await vscode.workspace.fs.stat(file);
                if (stat.size > config.maxFileSize) continue;

                const tree = await this.parser.parseFile(file);
                if (tree) {
                    const analysis = this.extractor.extract(tree, file.fsPath);
                    analyses.push(analysis);
                }
            } catch {
                // Skip files that can't be parsed
            }
        }

        // Phase 3: Build graph
        onProgress({ phase: 'graphing', current: 0, total: 1, message: 'Building dependency graph...' });
        const graphBuilder = new GraphBuilder(workspaceRoot);
        let graph = graphBuilder.build(analyses, allFilePaths);

        // Phase 4: Architecture inference
        onProgress({ phase: 'inference', current: 0, total: 1, message: 'Inferring architecture...' });
        graph = this.inference.inferSubsystems(graph);

        // Attach project identity for persistence in the webview DB. Keeping
        // this on the metadata lets the webview key every persisted record
        // (positions, conversations, system arch) against the workspace root.
        graph.metadata = {
            ...graph.metadata,
            projectId: workspaceRoot,
            projectName: path.basename(workspaceRoot),
            projectPath: workspaceRoot,
        };

        onProgress({ phase: 'complete', current: 1, total: 1, message: 'Analysis complete.' });
        return graph;
    }

    async handleFileChange(
        uri: vscode.Uri,
        currentGraph: ArchitectureGraph
    ): Promise<ArchitectureGraph | undefined> {
        const ext = path.extname(uri.fsPath);
        const language = getLanguageFromExtension(ext);
        if (!language) return undefined;

        this.parser.invalidate(uri);

        try {
            const tree = await this.parser.parseFile(uri);
            if (!tree) return undefined;

            const analysis = this.extractor.extract(tree, uri.fsPath);
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
            if (!workspaceFolder) return undefined;

            const workspaceRoot = workspaceFolder.uri.fsPath;
            const relativePath = path.relative(workspaceRoot, uri.fsPath);

            // Update the node in the existing graph
            const nodeIndex = currentGraph.nodes.findIndex((n) => n.id === relativePath);
            if (nodeIndex >= 0) {
                currentGraph.nodes[nodeIndex] = {
                    ...currentGraph.nodes[nodeIndex],
                    symbols: analysis.symbols,
                    metadata: {
                        ...currentGraph.nodes[nodeIndex].metadata,
                        symbolCount: analysis.symbols.length,
                        exportCount: analysis.exports.length,
                        importCount: analysis.imports.length,
                    },
                };
            }

            // Re-run inference for updated groupings
            return this.inference.inferSubsystems(currentGraph);
        } catch {
            return undefined;
        }
    }

    private async discoverFiles(
        workspaceUri: vscode.Uri,
        languages: string[],
        excludePatterns: string[]
    ): Promise<vscode.Uri[]> {
        const extensions: string[] = [];
        const langExtMap: Record<string, string[]> = {
            typescript: ['ts', 'tsx'],
            javascript: ['js', 'jsx', 'mjs', 'cjs'],
            python: ['py'],
            java: ['java'],
            go: ['go'],
            rust: ['rs'],
        };

        for (const lang of languages) {
            const exts = langExtMap[lang];
            if (exts) extensions.push(...exts);
        }

        if (extensions.length === 0) return [];

        const pattern = `**/*.{${extensions.join(',')}}`;
        const exclude = excludePatterns.length > 0 ? `{${excludePatterns.join(',')}}` : undefined;

        return vscode.workspace.findFiles(
            new vscode.RelativePattern(workspaceUri, pattern),
            exclude ? new vscode.RelativePattern(workspaceUri, exclude) : undefined,
            5000
        );
    }
}
