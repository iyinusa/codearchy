import * as vscode from 'vscode';
import { ArchitecturePanel } from './webview/ArchitecturePanel';
import { AnalysisPipeline } from './pipeline/AnalysisPipeline';
import { ModulesTreeProvider } from './views/ModulesTreeProvider';
import { ArchitectureGraph } from './types';

let currentGraph: ArchitectureGraph | undefined;
let pipeline: AnalysisPipeline | undefined;
let modulesTreeProvider: ModulesTreeProvider;

export function activate(context: vscode.ExtensionContext) {
    pipeline = new AnalysisPipeline(context.extensionPath);
    pipeline.initParser().catch(() => {
        // Tree-sitter init failed; regex fallback will be used
    });
    modulesTreeProvider = new ModulesTreeProvider();

    const treeView = vscode.window.createTreeView('codearchy.modulesView', {
        treeDataProvider: modulesTreeProvider,
        showCollapseAll: true,
    });

    const showArchitectureCmd = vscode.commands.registerCommand(
        'codearchy.showArchitecture',
        async () => {
            if (!currentGraph) {
                await runAnalysis(context);
            }
            if (currentGraph) {
                ArchitecturePanel.createOrShow(context.extensionUri, currentGraph);
            }
        }
    );

    const analyzeWorkspaceCmd = vscode.commands.registerCommand(
        'codearchy.analyzeWorkspace',
        async () => {
            await runAnalysis(context);
        }
    );

    const refreshViewCmd = vscode.commands.registerCommand(
        'codearchy.refreshView',
        async () => {
            await runAnalysis(context);
            if (currentGraph) {
                ArchitecturePanel.update(currentGraph);
            }
        }
    );

    const exportSVGCmd = vscode.commands.registerCommand(
        'codearchy.exportSVG',
        () => {
            ArchitecturePanel.triggerExport('svg');
        }
    );

    const exportPNGCmd = vscode.commands.registerCommand(
        'codearchy.exportPNG',
        () => {
            ArchitecturePanel.triggerExport('png');
        }
    );

    const onSaveWatcher = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (pipeline && currentGraph) {
            const updated = await pipeline.handleFileChange(doc.uri, currentGraph);
            if (updated) {
                currentGraph = updated;
                modulesTreeProvider.refresh(currentGraph);
                ArchitecturePanel.update(currentGraph);
            }
        }
    });

    context.subscriptions.push(
        treeView,
        showArchitectureCmd,
        analyzeWorkspaceCmd,
        refreshViewCmd,
        exportSVGCmd,
        exportPNGCmd,
        onSaveWatcher
    );
}

async function runAnalysis(context: vscode.ExtensionContext): Promise<void> {
    if (!pipeline) {
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('CodeArchy: No workspace folder open.');
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'CodeArchy: Analyzing workspace...',
            cancellable: true,
        },
        async (progress, token) => {
            try {
                currentGraph = await pipeline!.analyze(
                    workspaceFolders[0].uri,
                    (p) => {
                        progress.report({
                            message: p.message,
                            increment: (p.current / p.total) * 100,
                        });
                    },
                    token
                );
                modulesTreeProvider.refresh(currentGraph);
                vscode.window.showInformationMessage(
                    `CodeArchy: Analysis complete — ${currentGraph.nodes.length} modules, ${currentGraph.edges.length} dependencies.`
                );
            } catch (err) {
                if (err instanceof vscode.CancellationError) {
                    return;
                }
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`CodeArchy: Analysis failed — ${message}`);
            }
        }
    );
}

export function deactivate() {
    ArchitecturePanel.dispose();
    currentGraph = undefined;
    pipeline = undefined;
}
