import * as vscode from 'vscode';
import { ArchitectureGraph, SubsystemInfo } from '../types';

interface ModuleTreeItem {
    label: string;
    id: string;
    children?: ModuleTreeItem[];
    filePath?: string;
    symbolCount?: number;
    subsystem?: string;
}

export class ModulesTreeProvider implements vscode.TreeDataProvider<ModuleTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ModuleTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private rootItems: ModuleTreeItem[] = [];

    refresh(graph: ArchitectureGraph) {
        this.rootItems = this.buildTree(graph);
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ModuleTreeItem): vscode.TreeItem {
        const hasChildren = element.children && element.children.length > 0;
        const item = new vscode.TreeItem(
            element.label,
            hasChildren
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        if (element.filePath) {
            item.command = {
                command: 'vscode.open',
                title: 'Open File',
                arguments: [vscode.Uri.file(element.filePath)],
            };
            item.tooltip = `${element.id} (${element.symbolCount ?? 0} symbols)`;
            item.iconPath = new vscode.ThemeIcon('file-code');
        } else {
            item.tooltip = element.subsystem ? `Subsystem: ${element.subsystem}` : element.label;
            item.iconPath = new vscode.ThemeIcon('folder');
        }

        if (element.symbolCount !== undefined) {
            item.description = `${element.symbolCount} symbols`;
        }

        return item;
    }

    getChildren(element?: ModuleTreeItem): ModuleTreeItem[] {
        if (!element) {
            return this.rootItems;
        }
        return element.children || [];
    }

    private buildTree(graph: ArchitectureGraph): ModuleTreeItem[] {
        if (graph.subsystems.length === 0) {
            return graph.nodes.map((node) => ({
                label: node.label,
                id: node.id,
                filePath: node.filePath,
                symbolCount: node.symbols.length,
            }));
        }

        return graph.subsystems.map((subsystem: SubsystemInfo) => ({
            label: `${subsystem.name} (${subsystem.nodeIds.length})`,
            id: subsystem.id,
            subsystem: subsystem.name,
            children: subsystem.nodeIds
                .map((nodeId): ModuleTreeItem | undefined => {
                    const node = graph.nodes.find((n) => n.id === nodeId);
                    if (!node) return undefined;
                    return {
                        label: node.label,
                        id: node.id,
                        filePath: node.filePath,
                        symbolCount: node.symbols.length,
                    };
                })
                .filter((item): item is ModuleTreeItem => item !== undefined),
        }));
    }
}
