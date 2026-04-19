import * as path from 'path';
import {
    FileAnalysis,
    SymbolInfo,
    SymbolKind,
    ImportInfo,
} from '../types';

interface TreeNode {
    type: string;
    text: string;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    children: TreeNode[];
    namedChildren: TreeNode[];
    childForFieldName(name: string): TreeNode | null;
}

interface ParsedTree {
    rootNode: TreeNode;
    language: string;
}

export class SymbolExtractor {
    extract(tree: ParsedTree, filePath: string): FileAnalysis {
        const symbols: SymbolInfo[] = [];
        const imports: ImportInfo[] = [];
        const exports: string[] = [];

        for (const node of tree.rootNode.namedChildren) {
            switch (node.type) {
                case 'import_statement': {
                    const imp = this.extractImport(node, filePath);
                    if (imp) imports.push(imp);
                    break;
                }

                case 'export_function_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Function, filePath, true));
                    exports.push(node.text);
                    break;

                case 'export_class_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Class, filePath, true));
                    exports.push(node.text);
                    break;

                case 'export_interface_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Interface, filePath, true));
                    exports.push(node.text);
                    break;

                case 'export_type_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Type, filePath, true));
                    exports.push(node.text);
                    break;

                case 'export_enum_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Enum, filePath, true));
                    exports.push(node.text);
                    break;

                case 'export_variable_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Variable, filePath, true));
                    exports.push(node.text);
                    break;

                case 'export_statement': {
                    const source = node.childForFieldName('source');
                    if (source) {
                        imports.push({
                            source: source.text,
                            specifiers: [],
                            isDefault: false,
                            isNamespace: true,
                            filePath,
                        });
                    }
                    break;
                }

                case 'function_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Function, filePath, false));
                    break;

                case 'class_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Class, filePath, false));
                    break;

                case 'interface_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Interface, filePath, false));
                    break;

                case 'type_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Type, filePath, false));
                    break;

                case 'enum_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Enum, filePath, false));
                    break;

                case 'variable_declaration':
                    symbols.push(this.makeSymbol(node, SymbolKind.Variable, filePath, false));
                    break;
            }
        }

        return {
            filePath,
            language: tree.language,
            symbols,
            imports,
            exports,
        };
    }

    private extractImport(node: TreeNode, filePath: string): ImportInfo | undefined {
        const sourceNode = node.childForFieldName('source');
        if (!sourceNode) return undefined;

        const source = sourceNode.text.replace(/['"]/g, '');
        const text = node.text;

        const specifiers: string[] = [];
        let isDefault = false;
        let isNamespace = false;

        const braceMatch = text.match(/\{([^}]+)\}/);
        if (braceMatch) {
            specifiers.push(
                ...braceMatch[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
            );
        }

        if (text.match(/import\s+\w+\s+from/) || text.match(/import\s+\w+\s*,/)) {
            isDefault = true;
        }

        if (text.includes('* as ') || text.includes('* from')) {
            isNamespace = true;
        }

        return {
            source,
            specifiers,
            isDefault,
            isNamespace,
            filePath,
        };
    }

    private makeSymbol(node: TreeNode, kind: SymbolKind, filePath: string, exported: boolean): SymbolInfo {
        return {
            name: node.text,
            kind,
            filePath,
            startLine: node.startPosition.row,
            endLine: node.endPosition.row,
            exported,
        };
    }
}

export class DependencyResolver {
    private workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    resolveImportPath(importSource: string, fromFile: string, allFiles: string[]): string | undefined {
        if (this.isExternalModule(importSource)) {
            return undefined;
        }

        const fromDir = path.dirname(fromFile);
        let resolved = path.resolve(fromDir, importSource);

        const candidates = [
            resolved,
            resolved + '.ts',
            resolved + '.tsx',
            resolved + '.js',
            resolved + '.jsx',
            resolved + '.py',
            resolved + '.java',
            resolved + '.go',
            resolved + '.rs',
            path.join(resolved, 'index.ts'),
            path.join(resolved, 'index.js'),
            path.join(resolved, 'mod.rs'),
            path.join(resolved, '__init__.py'),
        ];

        for (const candidate of candidates) {
            if (allFiles.includes(candidate)) {
                return candidate;
            }
        }

        return undefined;
    }

    private isExternalModule(source: string): boolean {
        return !source.startsWith('.') && !source.startsWith('/');
    }

    getRelativePath(filePath: string): string {
        return path.relative(this.workspaceRoot, filePath);
    }
}
