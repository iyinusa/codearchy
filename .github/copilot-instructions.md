# CodeArchy - Copilot Instructions

Welcome to the **CodeArchy** project! This file provides context, architectural guidelines, and coding standards for AI coding assistants (like GitHub Copilot) working on this repository.

## Project Overview
**CodeArchy** is an open-source, offline-first VS Code Extension designed to visualize codebases as high-level architectural structures. It parses local code, generates dependency graphs, and uses local AI inference to interpret and group subsystems intelligently.

## Tech Stack & Architecture
When writing code or suggesting architecture for CodeArchy, adhere to the following core stack:

- **Extension Runtime:** 
  - **TypeScript** using the VS Code Extension API.
  - **Webviews** for the UI layer. Ensure clear message passing between the extension host and webview context.
- **Code Understanding:** 
  - **Tree-sitter** (local WASM/native parser) for incremental AST parsing, suited for offline use.
- **Dependency Analysis:** 
  - **Graph Builders** (`dependency-cruiser`) to build file/module dependency graphs.
  - Must support popular programming languages.
- **Rendering (Webview UI):** 
  - **React Flow** for rendering the core functional flow locally inside the extension UI.
  - **Cytoscape.js** as an optional extended view for complex, dense architectural graphs.
- **AI Inference (Gemma 4):**
  - High-level interpretation using **Gemma 4** (options to select E2B or E4B models).
  - Use AI purposely for semantic grouping (e.g., mapping low-level functions into clearly defined subsystems such as "billing" or "auth") and summarizing architectural paths.
  - Must respect the offline-first requirement.

## Coding Standards & Best Practices

1. **TypeScript Strictness:** Always write strict TypeScript. Use proper typings for all AST nodes, VS Code API events, and webview message payloads.
2. **Offline-First:** Propose solutions that do not require an active internet connection at runtime (excluding the initial download of Gemma models or Tree-sitter WASM binaries).
3. **Webview Sandboxing:** Maintain strict separation of concerns. Keep business logic and file system access in the Extension Host, and UI rendering in the Webview. Use VS Code's `postMessage` API for communication.
4. **Performance:** AST parsing and dependency map generation can block the thread. Delegate heavy lifting to worker threads or background processes to keep the VS Code UI responsive.
5. **AI Prompt Engineering:** When interacting with Gemma 4, ensure prompts are optimized for small, local parameter models. Avoid overly verbose context-stuffing.

## Role of the AI Assistant
Whenever you are providing code, debugging, or brainstorming:
- Assume the user is building for an **offline** environment.
- Prioritize **performance** when handling large source trees.
- Align UI code with **React Flow** patterns and VS Code's design language.
