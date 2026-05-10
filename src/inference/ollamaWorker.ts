/**
 * Ollama worker thread — runs all HTTP communication with Ollama off the
 * extension host main thread, keeping VS Code's event loop free while models
 * load into GPU/CPU memory and while long streaming responses are parsed.
 *
 * This file is compiled by TypeScript alongside the rest of the extension
 * (rootDir = src/, outDir = out/).  OllamaService references the compiled
 * output at:  path.join(__dirname, 'ollamaWorker.js')
 */

import { parentPort } from 'worker_threads';
import * as http from 'http';

const OLLAMA_BASE = 'http://localhost:11434';

/* ── Shared message types ──────────────────────────────────────────────── */

export interface WorkerProfile {
    numPredict: number;
    numCtx: number;
    topK: number;
    topP: number;
    think: boolean;
    keepAlive: string;
    temperature: number;
}

/** The payload portion of each request (no correlation id). */
export type WorkerRequestBody =
    | { op: 'generate'; model: string; prompt: string; profile: WorkerProfile; extraBodyFields?: Record<string, unknown> }
    | { op: 'chatCompletion'; model: string; messages: Array<{ role: string; content: string }>; profile: WorkerProfile }
    | { op: 'httpGet'; url: string }
    | { op: 'httpPost'; path: string; body: string; timeoutMs: number }
    | { op: 'warmUp'; model: string; keepAlive: string }
    | { op: 'pullModel'; model: string }
    | { op: 'cancelRequest'; targetId: string }
    | { op: 'httpDelete'; model: string };

/** Full request sent to the worker thread (body + correlation id). */
export type WorkerRequest = WorkerRequestBody & { id: string };

export type WorkerResponse =
    | { id: string; type: 'chunk'; text: string }
    | { id: string; type: 'thinkChunk'; text: string }
    | { id: string; type: 'result'; data: string }
    | { id: string; type: 'error'; message: string }
    | { id: string; type: 'pullProgress'; status: string; completed: number; total: number };

/* ── Guard: must only run inside a worker_thread ────────────────────────── */

if (!parentPort) {
    throw new Error('[ollamaWorker] Must be started as a worker_thread, not run directly.');
}

parentPort.on('message', (req: WorkerRequest) => {
    switch (req.op) {
        case 'generate': handleGenerate(req); break;
        case 'chatCompletion': handleChatCompletion(req); break;
        case 'httpGet': handleHttpGet(req); break;
        case 'httpPost': handleHttpPost(req); break;
        case 'warmUp': handleWarmUp(req); break;
        case 'pullModel': handlePullModel(req); break;
        case 'cancelRequest': handleCancelRequest(req); break;
        case 'httpDelete': handleHttpDelete(req); break;
    }
});

function send(msg: WorkerResponse): void {
    parentPort!.postMessage(msg);
}

/* ── /api/generate  (streaming) ─────────────────────────────────────────── */

function handleGenerate(req: Extract<WorkerRequest, { op: 'generate' }>): void {
    const { id, model, prompt, profile, extraBodyFields } = req;
    const bodyStr = JSON.stringify({
        model,
        prompt,
        stream: true,
        keep_alive: profile.keepAlive,
        options: {
            temperature: profile.temperature,
            num_predict: profile.numPredict,
            num_ctx: profile.numCtx,
            top_k: profile.topK,
            top_p: profile.topP,
        },
        ...(extraBodyFields ?? {}),
    });

    let done = false;
    // 5-minute timeout: the first call after a cold start is silent for the
    // entire duration that Ollama spends loading model weights into memory
    // before it emits a single token.  120 s is not enough on CPU-only or
    // slow-storage machines — increase to 300 s so the first generation
    // survives the loading phase without timing out.
    streamPost(id, '/api/generate', bodyStr, 300_000, (line, acc) => {
        if (line !== null) {
            if (typeof line.response === 'string' && line.response) {
                acc.text += line.response;
                send({ id, type: 'chunk', text: line.response });
            }
        } else if (!done) {
            done = true;
            send({ id, type: 'result', data: acc.text });
        }
    });
}

/* ── /api/chat  (streaming) ─────────────────────────────────────────────── */

function handleChatCompletion(req: Extract<WorkerRequest, { op: 'chatCompletion' }>): void {
    const { id, model, messages, profile } = req;
    const bodyStr = JSON.stringify({
        model,
        messages,
        stream: true,
        think: profile.think,
        keep_alive: profile.keepAlive,
        options: {
            temperature: Math.max(profile.temperature, 0.0),
            num_predict: profile.numPredict,
            num_ctx: profile.numCtx,
            top_k: profile.topK,
            top_p: profile.topP,
        },
    });

    let done = false;
    // 4-minute timeout for the same cold-start reason as /api/generate.
    streamPost(id, '/api/chat', bodyStr, 240_000, (line, acc) => {
        if (line !== null) {
            if (line.message && typeof line.message === 'object') {
                const msg = line.message as Record<string, unknown>;
                if (typeof msg.thinking === 'string' && msg.thinking) {
                    send({ id, type: 'thinkChunk', text: msg.thinking });
                }
                if (typeof msg.content === 'string' && msg.content) {
                    acc.text += msg.content;
                    send({ id, type: 'chunk', text: msg.content });
                }
            }
        } else if (!done) {
            done = true;
            send({ id, type: 'result', data: acc.text });
        }
    });
}

/* ── Simple GET ─────────────────────────────────────────────────────────── */

function handleHttpGet(req: Extract<WorkerRequest, { op: 'httpGet' }>): void {
    const { id, url: urlStr } = req;
    try {
        const url = new URL(urlStr);
        const opts: http.RequestOptions = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'GET',
            timeout: 5000,
        };
        let data = '';
        const r = http.request(opts, (res) => {
            res.setEncoding('utf-8');
            res.on('data', (c: string) => { data += c; });
            res.on('end', () => send({ id, type: 'result', data }));
            res.on('error', (e) => send({ id, type: 'error', message: e.message }));
        });
        r.on('error', (e) => send({ id, type: 'error', message: e.message }));
        r.on('timeout', () => {
            r.destroy();
            send({ id, type: 'error', message: 'Request timed out' });
        });
        r.end();
    } catch (e) {
        send({ id, type: 'error', message: (e instanceof Error ? e.message : String(e)) });
    }
}

/* ── Non-streaming POST ──────────────────────────────────────────────────── */

function handleHttpPost(req: Extract<WorkerRequest, { op: 'httpPost' }>): void {
    const { id, path: pathName, body, timeoutMs } = req;
    try {
        const url = new URL(`${OLLAMA_BASE}${pathName}`);
        const opts: http.RequestOptions = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: timeoutMs,
        };
        let data = '';
        const r = http.request(opts, (res) => {
            res.setEncoding('utf-8');
            res.on('data', (c: string) => { data += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    send({ id, type: 'error', message: `Ollama returned status ${res.statusCode}: ${data}` });
                } else {
                    send({ id, type: 'result', data });
                }
            });
            res.on('error', (e) => send({ id, type: 'error', message: e.message }));
        });
        r.on('error', (e) => send({ id, type: 'error', message: `Cannot connect to Ollama: ${e.message}` }));
        r.on('timeout', () => {
            r.destroy();
            send({ id, type: 'error', message: 'Ollama request timed out' });
        });
        r.write(body);
        r.end();
    } catch (e) {
        send({ id, type: 'error', message: (e instanceof Error ? e.message : String(e)) });
    }
}

/* ── Warm-up (tiny non-streaming generate to pre-load the model) ────────── */

function handleWarmUp(req: Extract<WorkerRequest, { op: 'warmUp' }>): void {
    const { id, model, keepAlive } = req;
    const body = JSON.stringify({
        model,
        prompt: ' ',
        stream: false,
        keep_alive: keepAlive,
        options: { num_predict: 1 },
    });
    // Warm-up is a non-streaming POST that blocks until the model is loaded.
    // Allow the same 5 minutes as the generate path so it reliably pre-warms
    // the model before the user's first real request.
    handleHttpPost({ id, op: 'httpPost', path: '/api/generate', body, timeoutMs: 300_000 });
}

/* ── /api/pull (streaming pull with progress) ───────────────────────────── */

/** Map of active HTTP requests keyed by request id — enables cancel. */
const activeRequests = new Map<string, http.ClientRequest>();

function handlePullModel(req: Extract<WorkerRequest, { op: 'pullModel' }>): void {
    const { id, model } = req;
    const body = JSON.stringify({ model, stream: true });
    const url = new URL(`${OLLAMA_BASE}/api/pull`);
    const opts: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
    };

    const r = http.request(opts, (res) => {
        activeRequests.delete(id);
        if (res.statusCode !== 200) {
            send({ id, type: 'error', message: `Ollama pull returned status ${res.statusCode}` });
            return;
        }
        res.setEncoding('utf-8');
        let buf = '';
        res.on('data', (chunk: string) => {
            buf += chunk;
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line) as Record<string, unknown>;
                    const status = typeof parsed.status === 'string' ? parsed.status : '';
                    const completed = typeof parsed.completed === 'number' ? parsed.completed : 0;
                    const total = typeof parsed.total === 'number' ? parsed.total : 0;
                    send({ id, type: 'pullProgress', status, completed, total });
                } catch { /* skip malformed lines */ }
            }
        });
        res.on('end', () => {
            if (buf.trim()) {
                try {
                    const parsed = JSON.parse(buf) as Record<string, unknown>;
                    const status = typeof parsed.status === 'string' ? parsed.status : '';
                    send({ id, type: 'pullProgress', status, completed: 0, total: 0 });
                } catch { /* ignore */ }
            }
            send({ id, type: 'result', data: 'success' });
        });
        res.on('error', (e) => send({ id, type: 'error', message: e.message }));
    });

    activeRequests.set(id, r);
    r.on('error', (e) => {
        activeRequests.delete(id);
        const msg = e.message.includes('socket hang up') || e.message.includes('ECONNRESET')
            ? 'Download cancelled'
            : `Cannot connect to Ollama: ${e.message}`;
        send({ id, type: 'error', message: msg });
    });
    r.write(body);
    r.end();
}

function handleCancelRequest(req: Extract<WorkerRequest, { op: 'cancelRequest' }>): void {
    const { targetId } = req;
    const r = activeRequests.get(targetId);
    if (r) {
        activeRequests.delete(targetId);
        r.destroy();
    }
    // No result sent back — the destroyed pull will emit its own error event.
}

/* ── DELETE /api/delete ──────────────────────────────────────────────────── */

function handleHttpDelete(req: Extract<WorkerRequest, { op: 'httpDelete' }>): void {
    const { id, model } = req;
    const body = JSON.stringify({ model });
    const url = new URL(`${OLLAMA_BASE}/api/delete`);
    const opts: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'DELETE',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
    };
    let data = '';
    const r = http.request(opts, (res) => {
        res.setEncoding('utf-8');
        res.on('data', (c: string) => { data += c; });
        res.on('end', () => {
            if (res.statusCode !== 200) {
                send({ id, type: 'error', message: `Ollama delete returned status ${res.statusCode}: ${data}` });
            } else {
                send({ id, type: 'result', data: 'deleted' });
            }
        });
        res.on('error', (e) => send({ id, type: 'error', message: e.message }));
    });
    r.on('error', (e) => send({ id, type: 'error', message: `Cannot connect to Ollama: ${e.message}` }));
    r.on('timeout', () => { r.destroy(); send({ id, type: 'error', message: 'Delete request timed out' }); });
    r.write(body);
    r.end();
}

/* ── Shared streaming helper ────────────────────────────────────────────── */

/**
 * Opens a streaming POST to Ollama and calls `onLine` for every parsed JSON
 * line received.  When the response stream ends, calls `onLine(null, acc)` so
 * the caller can emit the final `result` message.
 *
 * All CPU work (JSON.parse for every chunk, Buffer allocation) runs here in
 * the worker thread — the extension host main thread receives only the already-
 * parsed text strings via postMessage.
 */
function streamPost(
    id: string,
    pathName: string,
    bodyStr: string,
    timeoutMs: number,
    onLine: (parsed: Record<string, unknown> | null, acc: { text: string }) => void
): void {
    const url = new URL(`${OLLAMA_BASE}${pathName}`);
    const opts: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
        },
        timeout: timeoutMs,
    };

    const acc = { text: '' };

    const r = http.request(opts, (res) => {
        if (res.statusCode !== 200) {
            send({ id, type: 'error', message: `Ollama returned status ${res.statusCode}` });
            return;
        }

        res.setEncoding('utf-8');
        let buf = '';

        res.on('data', (chunk: string) => {
            buf += chunk;
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) { continue; }
                try {
                    onLine(JSON.parse(line) as Record<string, unknown>, acc);
                } catch { /* skip malformed JSON lines */ }
            }
        });

        res.on('end', () => {
            if (buf.trim()) {
                try {
                    onLine(JSON.parse(buf) as Record<string, unknown>, acc);
                } catch { /* ignore trailing incomplete line */ }
            }
            onLine(null, acc); // signal stream completion
        });

        res.on('error', (e) => send({ id, type: 'error', message: e.message }));
    });

    r.on('error', (e) => send({ id, type: 'error', message: `Cannot connect to Ollama: ${e.message}` }));
    r.on('timeout', () => {
        r.destroy();
        send({ id, type: 'error', message: 'Ollama request timed out' });
    });

    r.write(bodyStr);
    r.end();
}
