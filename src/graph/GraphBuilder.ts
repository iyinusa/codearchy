import {
    FileAnalysis,
    GraphNode,
    GraphEdge,
    NodeType,
    EdgeType,
    ArchitectureGraph,
    GraphMetadata,
} from '../types';
import { DependencyResolver } from '../extractor/SymbolExtractor';

export class GraphBuilder {
    private resolver: DependencyResolver;

    constructor(workspaceRoot: string) {
        this.resolver = new DependencyResolver(workspaceRoot);
    }

    build(analyses: FileAnalysis[], allFiles: string[]): ArchitectureGraph {
        const nodes = this.buildNodes(analyses);
        const edges = this.buildEdges(analyses, allFiles);

        const languages = [...new Set(analyses.map((a) => a.language))];
        const totalSymbols = analyses.reduce((sum, a) => sum + a.symbols.length, 0);

        const metadata: GraphMetadata = {
            analyzedAt: Date.now(),
            fileCount: analyses.length,
            totalSymbols,
            totalEdges: edges.length,
            languages,
        };

        return {
            nodes,
            edges,
            subsystems: [],
            metadata,
        };
    }

    private buildNodes(analyses: FileAnalysis[]): GraphNode[] {
        return analyses.map((analysis) => {
            const relativePath = this.resolver.getRelativePath(analysis.filePath);
            const label = this.getFileLabel(relativePath);

            return {
                id: relativePath,
                label,
                filePath: analysis.filePath,
                type: NodeType.File,
                symbols: analysis.symbols,
                metadata: {
                    language: analysis.language,
                    symbolCount: analysis.symbols.length,
                    exportCount: analysis.exports.length,
                    importCount: analysis.imports.length,
                },
            };
        });
    }

    private buildEdges(analyses: FileAnalysis[], allFiles: string[]): GraphEdge[] {
        const edges: GraphEdge[] = [];
        const edgeSet = new Set<string>();

        for (const analysis of analyses) {
            const sourceId = this.resolver.getRelativePath(analysis.filePath);

            for (const imp of analysis.imports) {
                const resolvedPath = this.resolver.resolveImportPath(
                    imp.source,
                    analysis.filePath,
                    allFiles
                );

                if (resolvedPath) {
                    const targetId = this.resolver.getRelativePath(resolvedPath);
                    const edgeKey = `${sourceId}:${targetId}`;

                    if (!edgeSet.has(edgeKey) && sourceId !== targetId) {
                        edgeSet.add(edgeKey);
                        edges.push({
                            id: edgeKey,
                            source: sourceId,
                            target: targetId,
                            type: EdgeType.Import,
                            weight: imp.specifiers.length || 1,
                            metadata: {
                                specifiers: imp.specifiers,
                                importSource: imp.source,
                            },
                        });
                    }
                }
            }
        }

        return edges;
    }

    private getFileLabel(relativePath: string): string {
        const parts = relativePath.split('/');
        if (parts.length <= 2) {
            return relativePath;
        }
        return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    }
}
