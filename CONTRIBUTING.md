# Contributing to CodeArchy

Thank you for your interest in contributing to CodeArchy! This document provides guidelines and information for contributors.

## Development Setup

### Prerequisites

- Node.js 18+ and npm
- VS Code 1.85+
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/iyinusa/codearchy.git
cd codearchy

# Install dependencies
npm install

# Compile
npm run compile

# Launch extension in development mode
# Press F5 in VS Code (uses .vscode/launch.json)
```

### Project Structure

```
src/
├── extension.ts              # Extension entry point
├── types.ts                  # Shared types and configuration
├── parser/
│   └── IncrementalParser.ts  # AST parsing (multi-language)
├── extractor/
│   └── SymbolExtractor.ts    # Symbol & dependency extraction
├── graph/
│   └── GraphBuilder.ts       # Dependency graph construction
├── inference/
│   └── ArchitectureInference.ts  # Subsystem grouping & inference
├── pipeline/
│   └── AnalysisPipeline.ts   # Orchestrates the full pipeline
├── views/
│   └── ModulesTreeProvider.ts # Activity bar tree view
└── webview/
    └── ArchitecturePanel.ts  # Webview panel & visualization UI
```

## Architecture

The analysis pipeline flows through these stages:

```
VS Code Events → Incremental Parser → Symbol Extractor →
Graph Builder → Architecture Inference → Webview Visualization
```

### Key Principles

1. **Offline-First**: All operations must work without internet. External downloads (WASM binaries, AI models) happen at install time only.
2. **Performance**: Heavy parsing is cached and incremental. Never block the VS Code UI thread unnecessarily.
3. **Separation of Concerns**: Business logic stays in the Extension Host. The Webview only handles rendering and user interaction via `postMessage`.

## Code Standards

- Write strict TypeScript with proper types
- Follow existing patterns and naming conventions
- No `any` unless absolutely necessary (use `unknown` + type guards)
- Keep functions focused and small

## Submitting Changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes with clear commit messages
4. Run `npm run lint` and `npm run compile` before submitting
5. Open a Pull Request with a clear description

## Reporting Issues

Open an issue on GitHub with:

- VS Code version
- Operating system
- Steps to reproduce
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
