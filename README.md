# CodeArchy

**Offline-first privacy VS Code extension that visualizes your codebase as a high-level architecture diagram.**

CodeArchy is an open-source offline-first privacy AI system that parse codebase into explainable system architecture for education, onboarding, and safer software development/maintenance.

![License](https://img.shields.io/badge/license-MIT-green) ![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white) ![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB) ![Visual Studio Code](https://img.shields.io/badge/VS%20Code-007ACC?style=flat&logo=visual-studio-code&logoColor=white) ![Tree-sitter](https://img.shields.io/badge/Tree--sitter-Parsing-blueviolet) ![React Flow](https://img.shields.io/badge/React%20Flow-UI-ff007f) ![Gemma 4](https://img.shields.io/badge/Gemma%204-AI%20Inference-ff69b4)

## Features

- **Multi-Language Parsing** — TypeScript, JavaScript, Python, Java, Go, Rust
- **Dependency Graph** — Automatic import/dependency detection and resolution
- **Architecture Inference** — Heuristic grouping of modules into semantic subsystems (API, Services, Models, Auth, etc.)
- **Interactive Visualization** — Pan, zoom, drag nodes, click to inspect, double-click to open files
- **Incremental Updates** — Re-analyzes only changed files on save
- **Activity Bar** — Browse modules and subsystems in a dedicated tree view
- **Offline-First** — Zero network calls at runtime

## Quick Start

1. Open a project in VS Code
2. Run **CodeArchy: Show Architecture** from the Command Palette (`Cmd+Shift+P`)
3. Explore the interactive dependency graph

## Commands

| Command | Description |
|---------|-------------|
| `CodeArchy: Show Architecture` | Open the architecture visualization |
| `CodeArchy: Analyze Workspace` | Run a full workspace analysis |
| `CodeArchy: Refresh Architecture` | Re-analyze and update the view |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `codearchy.includedLanguages` | `["typescript", "javascript", "python", "java", "go", "rust"]` | Languages to analyze |
| `codearchy.excludePatterns` | `["**/node_modules/**", ...]` | Glob patterns to exclude |
| `codearchy.maxFileSize` | `500000` | Max file size (bytes) to analyze |
| `codearchy.aiModel` | `"none"` | AI model for inference (`none`, `gemma-e2b`, `gemma-e4b`) |

## Architecture

```
VS Code Events
     ↓
Incremental Parser (multi-language AST)
     ↓
Symbol & Dependency Extractor
     ↓
Graph Builder (nodes + edges)
     ↓
Architecture Inference Layer (heuristic grouping)
     ↓
Interactive Webview Visualization
```

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Lint
npm run lint

# Press F5 in VS Code to launch in dev mode
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full development guidelines.

## Roadmap

- [X] Tree-sitter WASM integration for full AST fidelity
- [X] React Flow rendering engine
- [X] Cytoscape.js optional dense-graph view
- [X] Export architecture diagrams (SVG, PNG)
- [ ] Gemma 4 local AI inference for semantic subsystem naming
- [ ] Multi-root workspace support
- [ ] Custom subsystem rules

## License

[MIT](LICENSE)
