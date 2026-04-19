import * as vscode from 'vscode';
import { getLanguageFromExtension } from '../types';
import * as path from 'path';
import * as fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TreeSitterModule = require('web-tree-sitter');

interface ParsedTree {
    rootNode: TreeNode;
    language: string;
}

interface TreeNode {
    type: string;
    text: string;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    children: TreeNode[];
    namedChildren: TreeNode[];
    childForFieldName(name: string): TreeNode | null;
}

// Tree-sitter WASM grammar file name mapping
const TREESITTER_GRAMMAR_FILES: Record<string, string> = {
    typescript: 'tree-sitter-typescript.wasm',
    javascript: 'tree-sitter-javascript.wasm',
    python: 'tree-sitter-python.wasm',
    java: 'tree-sitter-java.wasm',
    go: 'tree-sitter-go.wasm',
    rust: 'tree-sitter-rust.wasm',
};

// TSX uses typescript grammar with TSX dialect
const TSX_GRAMMAR = 'tree-sitter-tsx.wasm';

export class IncrementalParser {
    private cache: Map<string, { version: number; tree: ParsedTree }> = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private treeSitterParser: any | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private loadedLanguages: Map<string, any> = new Map();
    private treeSitterReady = false;
    private treeSitterInitPromise: Promise<void> | undefined;
    private extensionPath: string | undefined;

    setExtensionPath(extensionPath: string) {
        this.extensionPath = extensionPath;
    }

    async initTreeSitter(): Promise<void> {
        if (this.treeSitterReady) return;
        if (this.treeSitterInitPromise) return this.treeSitterInitPromise;

        this.treeSitterInitPromise = this._initTreeSitter();
        return this.treeSitterInitPromise;
    }

    private async _initTreeSitter(): Promise<void> {
        try {
            await TreeSitterModule.init();
            this.treeSitterParser = new TreeSitterModule();
            this.treeSitterReady = true;
        } catch {
            this.treeSitterReady = false;
        }
    }

    private getGrammarPath(language: string, ext: string): string | undefined {
        if (!this.extensionPath) return undefined;

        const parsersDir = path.join(this.extensionPath, 'parsers');
        if (!fs.existsSync(parsersDir)) return undefined;

        // Handle TSX separately
        if (ext === '.tsx') {
            const tsxPath = path.join(parsersDir, TSX_GRAMMAR);
            return fs.existsSync(tsxPath) ? tsxPath : undefined;
        }

        const grammarFile = TREESITTER_GRAMMAR_FILES[language];
        if (!grammarFile) return undefined;

        const grammarPath = path.join(parsersDir, grammarFile);
        return fs.existsSync(grammarPath) ? grammarPath : undefined;
    }

    private async loadLanguageGrammar(language: string, ext: string): Promise<boolean> {
        if (!this.treeSitterReady || !this.treeSitterParser) return false;

        const langKey = ext === '.tsx' ? 'tsx' : language;
        if (this.loadedLanguages.has(langKey)) return true;

        const grammarPath = this.getGrammarPath(language, ext);
        if (!grammarPath) return false;

        try {
            const lang = await TreeSitterModule.Language.load(grammarPath);
            this.loadedLanguages.set(langKey, lang);
            return true;
        } catch {
            return false;
        }
    }

    async parseFile(uri: vscode.Uri): Promise<ParsedTree | undefined> {
        const ext = path.extname(uri.fsPath);
        const language = getLanguageFromExtension(ext);
        if (!language) {
            return undefined;
        }

        const doc = await vscode.workspace.openTextDocument(uri);
        const cacheKey = uri.toString();
        const cached = this.cache.get(cacheKey);

        if (cached && cached.version === doc.version) {
            return cached.tree;
        }

        const source = doc.getText();
        let tree: ParsedTree | undefined;

        // Try tree-sitter first
        if (this.treeSitterReady) {
            tree = await this.parseWithTreeSitter(source, language, ext);
        }

        // Fall back to regex-based parsing
        if (!tree) {
            tree = this.buildLightweightTree(source, language);
        }

        if (tree) {
            this.cache.set(cacheKey, { version: doc.version, tree });
        }
        return tree;
    }

    private async parseWithTreeSitter(source: string, language: string, ext: string): Promise<ParsedTree | undefined> {
        if (!this.treeSitterParser) return undefined;

        const langKey = ext === '.tsx' ? 'tsx' : language;
        const loaded = await this.loadLanguageGrammar(language, ext);
        if (!loaded) return undefined;

        const lang = this.loadedLanguages.get(langKey);
        if (!lang) return undefined;

        try {
            this.treeSitterParser.setLanguage(lang);
            const tsTree = this.treeSitterParser.parse(source);
            if (!tsTree) return undefined;

            const rootNode = this.convertTreeSitterNode(tsTree.rootNode);
            return { rootNode, language };
        } catch {
            return undefined;
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private convertTreeSitterNode(tsNode: any): TreeNode {
        const children: TreeNode[] = [];
        const namedChildren: TreeNode[] = [];

        for (let i = 0; i < tsNode.childCount; i++) {
            const child = tsNode.child(i);
            if (!child) continue;
            const converted = this.convertTreeSitterNode(child);
            children.push(converted);
            if (child.isNamed) {
                namedChildren.push(converted);
            }
        }

        // Build a field lookup for childForFieldName
        const fieldMap = new Map<string, TreeNode>();
        for (const fieldName of ['source', 'name', 'body', 'value', 'left', 'right', 'declarator', 'declaration']) {
            const fieldChild = tsNode.childForFieldName?.(fieldName);
            if (fieldChild) {
                fieldMap.set(fieldName, this.convertTreeSitterNode(fieldChild));
            }
        }

        return {
            type: tsNode.type,
            text: tsNode.text,
            startPosition: { row: tsNode.startPosition.row, column: tsNode.startPosition.column },
            endPosition: { row: tsNode.endPosition.row, column: tsNode.endPosition.column },
            children,
            namedChildren,
            childForFieldName: (name: string) => fieldMap.get(name) ?? null,
        };
    }

    isTreeSitterAvailable(): boolean {
        return this.treeSitterReady;
    }

    getLoadedLanguages(): string[] {
        return [...this.loadedLanguages.keys()];
    }

    private buildLightweightTree(source: string, language: string): ParsedTree | undefined {
        const lines = source.split('\n');
        const rootChildren: TreeNode[] = [];

        switch (language) {
            case 'typescript':
            case 'javascript':
                this.parseTypeScriptLike(lines, source, rootChildren);
                break;
            case 'python':
                this.parsePython(lines, source, rootChildren);
                break;
            case 'java':
                this.parseJava(lines, source, rootChildren);
                break;
            case 'go':
                this.parseGo(lines, source, rootChildren);
                break;
            case 'rust':
                this.parseRust(lines, source, rootChildren);
                break;
            default:
                return undefined;
        }

        return {
            language,
            rootNode: {
                type: 'program',
                text: source,
                startPosition: { row: 0, column: 0 },
                endPosition: { row: lines.length - 1, column: lines[lines.length - 1]?.length ?? 0 },
                children: rootChildren,
                namedChildren: rootChildren,
                childForFieldName: () => null,
            },
        };
    }

    private parseTypeScriptLike(lines: string[], _source: string, nodes: TreeNode[]) {
        const importRegex = /^import\s+(?:(\{[^}]*\})|(\*\s+as\s+\w+)|(\w+))(?:\s*,\s*(?:(\{[^}]*\})|(\w+)))?\s+from\s+['"]([^'"]+)['"]/;
        const requireRegex = /(?:const|let|var)\s+(?:(\{[^}]*\})|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/;
        const exportFuncRegex = /^export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/;
        const exportClassRegex = /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/;
        const exportInterfaceRegex = /^export\s+(?:default\s+)?interface\s+(\w+)/;
        const exportTypeRegex = /^export\s+(?:default\s+)?type\s+(\w+)/;
        const exportEnumRegex = /^export\s+(?:default\s+)?enum\s+(\w+)/;
        const exportConstRegex = /^export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)/;
        const funcRegex = /^(?:async\s+)?function\s+(\w+)/;
        const classRegex = /^(?:abstract\s+)?class\s+(\w+)/;
        const interfaceRegex = /^interface\s+(\w+)/;
        const typeRegex = /^type\s+(\w+)/;
        const enumRegex = /^enum\s+(\w+)/;
        const constRegex = /^(?:const|let|var)\s+(\w+)/;
        const reExportRegex = /^export\s+(?:(\{[^}]*\})|(\*))\s+from\s+['"]([^'"]+)['"]/;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

            let match: RegExpMatchArray | null;

            if ((match = trimmed.match(importRegex))) {
                nodes.push(this.makeNode('import_statement', lines[i], i, match[6], lines[i]));
            } else if ((match = trimmed.match(requireRegex))) {
                nodes.push(this.makeNode('import_statement', lines[i], i, match[3], lines[i]));
            } else if ((match = trimmed.match(reExportRegex))) {
                nodes.push(this.makeNode('export_statement', lines[i], i, match[3], lines[i]));
            } else if ((match = trimmed.match(exportFuncRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('export_function_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(exportClassRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('export_class_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(exportInterfaceRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('export_interface_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(exportTypeRegex))) {
                nodes.push(this.makeNode('export_type_declaration', match[1], i, undefined, lines[i]));
            } else if ((match = trimmed.match(exportEnumRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('export_enum_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(exportConstRegex))) {
                nodes.push(this.makeNode('export_variable_declaration', match[1], i, undefined, lines[i]));
            } else if ((match = trimmed.match(funcRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('function_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(classRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('class_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(interfaceRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('interface_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(typeRegex))) {
                nodes.push(this.makeNode('type_declaration', match[1], i, undefined, lines[i]));
            } else if ((match = trimmed.match(enumRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('enum_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(constRegex))) {
                nodes.push(this.makeNode('variable_declaration', match[1], i, undefined, lines[i]));
            }
        }
    }

    private parsePython(lines: string[], _source: string, nodes: TreeNode[]) {
        const importRegex = /^(?:from\s+(\S+)\s+)?import\s+(.+)/;
        const funcRegex = /^def\s+(\w+)/;
        const classRegex = /^class\s+(\w+)/;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed || trimmed.startsWith('#')) continue;

            let match: RegExpMatchArray | null;

            if ((match = trimmed.match(importRegex))) {
                const source = match[1] || match[2].split(',')[0].trim();
                nodes.push(this.makeNode('import_statement', lines[i], i, source, lines[i]));
            } else if ((match = trimmed.match(funcRegex))) {
                const endLine = this.findPythonBlockEnd(lines, i);
                nodes.push(this.makeNode('function_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(classRegex))) {
                const endLine = this.findPythonBlockEnd(lines, i);
                nodes.push(this.makeNode('class_declaration', match[1], i, undefined, lines[i], endLine));
            }
        }
    }

    private parseJava(lines: string[], _source: string, nodes: TreeNode[]) {
        const importRegex = /^import\s+(?:static\s+)?([^;]+);/;
        const classRegex = /(?:public|private|protected)?\s*(?:abstract\s+)?(?:class|interface|enum)\s+(\w+)/;
        const methodRegex = /(?:public|private|protected)\s+(?:static\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

            let match: RegExpMatchArray | null;

            if ((match = trimmed.match(importRegex))) {
                nodes.push(this.makeNode('import_statement', lines[i], i, match[1], lines[i]));
            } else if ((match = trimmed.match(classRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('class_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(methodRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('function_declaration', match[1], i, undefined, lines[i], endLine));
            }
        }
    }

    private parseGo(lines: string[], _source: string, nodes: TreeNode[]) {
        const importRegex = /^import\s+(?:\(|"([^"]+)")/;
        const importLineRegex = /^\s*"([^"]+)"/;
        const funcRegex = /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/;
        const typeRegex = /^type\s+(\w+)\s+(?:struct|interface)/;

        let inImportBlock = false;
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed || trimmed.startsWith('//')) continue;

            let match: RegExpMatchArray | null;

            if (inImportBlock) {
                if (trimmed === ')') {
                    inImportBlock = false;
                    continue;
                }
                if ((match = trimmed.match(importLineRegex))) {
                    nodes.push(this.makeNode('import_statement', lines[i], i, match[1], lines[i]));
                }
                continue;
            }

            if ((match = trimmed.match(importRegex))) {
                if (match[1]) {
                    nodes.push(this.makeNode('import_statement', lines[i], i, match[1], lines[i]));
                } else {
                    inImportBlock = true;
                }
            } else if ((match = trimmed.match(funcRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('function_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(typeRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('class_declaration', match[1], i, undefined, lines[i], endLine));
            }
        }
    }

    private parseRust(lines: string[], _source: string, nodes: TreeNode[]) {
        const useRegex = /^(?:pub\s+)?use\s+([^;]+);/;
        const fnRegex = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/;
        const structRegex = /^(?:pub\s+)?struct\s+(\w+)/;
        const enumRegex = /^(?:pub\s+)?enum\s+(\w+)/;
        const traitRegex = /^(?:pub\s+)?trait\s+(\w+)/;
        const implRegex = /^impl(?:<[^>]+>)?\s+(\w+)/;

        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed || trimmed.startsWith('//')) continue;

            let match: RegExpMatchArray | null;

            if ((match = trimmed.match(useRegex))) {
                nodes.push(this.makeNode('import_statement', lines[i], i, match[1], lines[i]));
            } else if ((match = trimmed.match(fnRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('function_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(structRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('class_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(enumRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('enum_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(traitRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('interface_declaration', match[1], i, undefined, lines[i], endLine));
            } else if ((match = trimmed.match(implRegex))) {
                const endLine = this.findBlockEnd(lines, i);
                nodes.push(this.makeNode('class_declaration', `impl_${match[1]}`, i, undefined, lines[i], endLine));
            }
        }
    }

    private makeNode(type: string, text: string, row: number, source?: string, fullLine?: string, endRow?: number): TreeNode {
        const node: TreeNode = {
            type,
            text: text.trim(),
            startPosition: { row, column: 0 },
            endPosition: { row: endRow ?? row, column: fullLine?.length ?? 0 },
            children: [],
            namedChildren: [],
            childForFieldName: (name: string) => {
                if (name === 'source' && source) {
                    return {
                        type: 'string',
                        text: source,
                        startPosition: { row, column: 0 },
                        endPosition: { row, column: source.length },
                        children: [],
                        namedChildren: [],
                        childForFieldName: () => null,
                    };
                }
                return null;
            },
        };
        return node;
    }

    private findBlockEnd(lines: string[], startLine: number): number {
        let depth = 0;
        let foundOpening = false;
        for (let i = startLine; i < lines.length; i++) {
            for (const ch of lines[i]) {
                if (ch === '{') {
                    depth++;
                    foundOpening = true;
                } else if (ch === '}') {
                    depth--;
                    if (foundOpening && depth === 0) {
                        return i;
                    }
                }
            }
        }
        return startLine;
    }

    private findPythonBlockEnd(lines: string[], startLine: number): number {
        const baseIndent = lines[startLine].search(/\S/);
        for (let i = startLine + 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.trim() === '') continue;
            const indent = line.search(/\S/);
            if (indent <= baseIndent) {
                return i - 1;
            }
        }
        return lines.length - 1;
    }

    invalidate(uri: vscode.Uri) {
        this.cache.delete(uri.toString());
    }

    clearCache() {
        this.cache.clear();
    }
}
