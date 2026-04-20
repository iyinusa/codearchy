# CodeArchy - Copilot Instructions

Welcome to the **CodeArchy** project! This file provides context, architectural guidelines, and coding standards for AI coding assistants (like GitHub Copilot) working on this repository.

## Project Overview
**CodeArchy** is an open-source, offline AI system that **teaches software architecture by converting real-world codebases into visual, explainable learning experiences**. It is delivered as a VS Code Extension that parses local code, constructs structured dependency node trees, and uses a locally-running Gemma 4 model (via Ollama) to transform that raw codebase graph into a professional, high-level system architecture view — the kind a senior architect would draw on a whiteboard.

Users can then explore and learn from these architectural diagrams through interactive visuals and an integrated AI assistant they can converse with via **text or voice (audio)** — all fully offline and private.

## Core User Journey
1. User opens a codebase in VS Code.
2. CodeArchy parses it (Tree-sitter AST + dependency-cruiser) into a **structured codebase node tree**.
3. The node tree is passed to a local **Gemma 4 model via Ollama**, which produces a **professional high-level system architecture** (e.g., groups like "Auth Service", "Data Layer", "API Gateway") — abstracting away low-level file details into architect-level subsystem diagrams.
4. The architecture is rendered visually in the **Webview** using React Flow / Cytoscape.js.
5. The user can **converse with the AI via text or audio** to ask questions like "What does the Auth subsystem do?" or "Explain the data flow from the API to the database."

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
  - **React Flow** for rendering the high-level architecture diagram as the primary view.
  - **Cytoscape.js** as an optional extended view for complex, dense architectural graphs.
- **AI Inference (Gemma 4 via Ollama):**
  - Run **Gemma 4** locally via **Ollama** (`ollama run gemma4:e2b` or `gemma4:e4b`). Allow the user to select the model variant (E2B for speed, E4B for depth).
  - The AI receives the **structured codebase node tree** (NOT raw source code) as input and outputs a **professional high-level system architecture**: named subsystems, their responsibilities, and the relationships between them.
  - The AI must **abstract away** file-level or function-level details. Its output should resemble a senior architect's system design diagram, not a codebase explorer.
  - The AI also powers an **interactive conversational assistant** (text + audio) so users can ask architecture questions in natural language. Maintain conversation context across turns.
  - All inference runs locally via the Ollama HTTP API (`http://localhost:11434`). No cloud API calls are permitted at runtime.
  - Must respect the offline-first requirement.
- **Audio (Voice I/O):**
  - **Voice Input:** Pass captured user audio directly to **Gemma 4**, which natively processes voice input and responds with text.
  - **Text-to-Speech:** Use the system speech API (e.g., Web Speech API `SpeechSynthesis` in the Webview) to read the AI's text responses aloud to the user.
  - Audio I/O is an enhancement layer on top of the text chat — both must always be available.

## AI Architecture Translation Pipeline
When implementing or working on the AI inference layer, follow this pipeline strictly:

1. **Input:** Receive the structured codebase node tree (files, modules, imports, exports, symbol relationships) — a JSON graph produced by the parser and graph builder.
2. **Pre-processing:** Flatten or summarize the node tree to fit within Gemma 4's context window. Chunk large trees intelligently by module/directory boundaries.
3. **Prompt Construction:** Build a focused prompt instructing the model to act as a software architect. The prompt must request named subsystems, their roles, inter-subsystem dependencies, and a recommended architectural pattern (e.g., MVC, Layered, Event-Driven). Avoid verbose context-stuffing — keep prompts lean for small local models.
4. **Ollama API Call:** POST to `http://localhost:11434/api/generate` with the model and prompt. Stream the response back to the Extension Host.
5. **Output Parsing:** Parse the AI's structured response (JSON preferred; fallback to guided text parsing) into typed `ArchitectureNode` and `ArchitectureEdge` objects.
6. **Rendering:** Send the parsed architecture graph to the Webview via `postMessage` for React Flow / Cytoscape.js to render.

## Coding Standards & Best Practices

1. **TypeScript Strictness:** Always write strict TypeScript. Use proper typings for all AST nodes, VS Code API events, Ollama API payloads, and webview message payloads.
2. **Offline-First:** Propose solutions that do not require an active internet connection at runtime (excluding the initial download of Gemma models via Ollama or Tree-sitter WASM binaries). All Ollama calls target `localhost`.
3. **Webview Sandboxing:** Maintain strict separation of concerns. Keep business logic, file system access, and Ollama API calls in the Extension Host. Keep UI rendering and Web Speech API usage in the Webview. Use VS Code's `postMessage` API for all communication.
4. **Performance:** AST parsing and dependency map generation can block the thread. Delegate heavy lifting to worker threads or background processes to keep the VS Code UI responsive.
5. **AI Prompt Engineering:** When interacting with Gemma 4 via Ollama, ensure prompts instruct the model to produce **architect-level output** (subsystems, not files). Keep prompts concise and structured. Prefer requesting JSON-formatted responses to ease parsing.
6. **Conversation State:** Maintain conversation history in the Extension Host and pass relevant context window slices to Ollama on each conversational turn. Do not re-send the full codebase node tree on every message.
7. **Audio UX:** Voice input and output are progressive enhancements. Always provide a text fallback. Never block the UI thread on speech processing.

## Role of the AI Assistant
Whenever you are providing code, debugging, or brainstorming:
- Assume the user is building for an **offline** environment; all AI runs locally via Ollama.
- The primary AI task is **architectural abstraction**: transforming a low-level code graph into a high-level system architecture that a non-expert can understand.
- The secondary AI task is **conversational teaching**: answering architecture questions in natural language via text and audio.
- Prioritize **performance** when handling large source trees; pre-process and chunk before sending to Ollama.
- Align UI code with **React Flow** patterns and VS Code's design language.
- When suggesting Ollama integration, always target the local REST API and handle errors gracefully (e.g., Ollama not running, model not pulled).
