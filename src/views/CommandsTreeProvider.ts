import * as vscode from 'vscode';

interface CommandItem {
    kind: 'header' | 'info' | 'command' | 'link';
    label: string;
    description?: string;
    tooltip?: string;
    icon?: string;
    command?: string;
    commandArgs?: unknown[];
    url?: string;
}

/**
 * Provides the header section shown above the Modules tree in the
 * CodeArchy primary sidebar. Presents extension info and one-click
 * access to all contributed commands.
 */
export class CommandsTreeProvider implements vscode.TreeDataProvider<CommandItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<CommandItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly extensionVersion: string) { }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: CommandItem): vscode.TreeItem {
        const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
        item.description = element.description;
        item.tooltip = element.tooltip ?? element.label;
        if (element.icon) {
            item.iconPath = new vscode.ThemeIcon(element.icon);
        }
        if (element.kind === 'command' && element.command) {
            item.command = {
                command: element.command,
                title: element.label,
                arguments: element.commandArgs,
            };
            item.contextValue = 'codearchy.command';
        } else if (element.kind === 'link' && element.url) {
            item.command = {
                command: 'vscode.open',
                title: element.label,
                arguments: [vscode.Uri.parse(element.url)],
            };
            item.contextValue = 'codearchy.link';
        } else if (element.kind === 'header') {
            item.contextValue = 'codearchy.header';
        } else {
            item.contextValue = 'codearchy.info';
        }
        return item;
    }

    getChildren(element?: CommandItem): CommandItem[] {
        if (element) {
            return [];
        }
        return [
            {
                kind: 'command',
                label: 'Show Architecture',
                icon: 'type-hierarchy',
                command: 'codearchy.showArchitecture',
                tooltip: 'Open the interactive architecture diagram.',
            },
            {
                kind: 'command',
                label: 'Analyze Workspace',
                icon: 'search',
                command: 'codearchy.analyzeWorkspace',
                tooltip: 'Scan the current workspace and build the architecture graph.',
            },
            {
                kind: 'command',
                label: 'Refresh Architecture',
                icon: 'refresh',
                command: 'codearchy.refreshView',
                tooltip: 'Re-analyze the workspace and refresh the diagram.',
            },
            {
                kind: 'command',
                label: 'Export as PNG',
                icon: 'device-camera',
                command: 'codearchy.exportPNG',
                tooltip: 'Export the current architecture diagram as a PNG image.',
            },
            {
                kind: 'command',
                label: 'Export as SVG',
                icon: 'file-media',
                command: 'codearchy.exportSVG',
                tooltip: 'Export the current architecture diagram as an SVG file.',
            },
            {
                kind: 'command',
                label: 'Settings',
                icon: 'settings-gear',
                command: 'workbench.action.openSettings',
                commandArgs: ['codearchy'],
                tooltip: 'Open CodeArchy configuration (languages, excludes, AI model).',
            },
        ];
    }
}
