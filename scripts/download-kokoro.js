#!/usr/bin/env node
/**
 * Pre-download Kokoro-82M (q8 ONNX) model + tokenizer files directly into
 *   webview-ui/dist/kokoro-model/onnx-community/Kokoro-82M-v1.0-ONNX/
 *
 * Writing to dist/ directly (not a staging folder) means there is only ONE
 * copy of the model on disk. esbuild no longer needs to copy it. The dist/
 * folder is gitignored; run this script once per machine after cloning.
 *
 * Idempotent — already-cached files are skipped.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const REVISION = 'main';
const MODEL_BASE = `https://huggingface.co/${REPO}/resolve/${REVISION}`;

// Files needed for KokoroTTS.from_pretrained(REPO).
// Voice .bin files are NOT downloaded here — they come from the kokoro-js
// package (which bundles all 50+ voices already on disk).
//
// Two ONNX models are downloaded:
//
//   model_quantized.onnx  (~88 MB, INT8)  — WASM/CPU backend.
//     Always required. Used when WebGPU is unavailable or model.onnx is
//     absent. Reliable, offline, no GPU needed.
//
//   model.onnx  (~330 MB, FP32)  — WebGPU/GPU backend (optional).
//     Required for hardware-accelerated synthesis. The extension detects
//     WebGPU at runtime and loads this model automatically when present;
//     if absent it falls back to model_quantized.onnx (WASM) silently.
//     GPU synthesis is ~3–5× faster than WASM — worth downloading once.
//
//   model_q4f16.onnx was removed: ORT's WebGPU EP does not reliably handle
//   MatMulNBits (INT4) ops and falls back to WASM with broken f16 emulation,
//   producing garbled audio. fp32 is the correct dtype for WebGPU.
const MODEL_FILES = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    // CPU/WASM backend — always downloaded, always used as fallback.
    'onnx/model_quantized.onnx',
    // GPU/WebGPU backend (model.onnx, ~330 MB FP32) is intentionally NOT
    // downloaded here because it is excluded from the packaged VSIX via
    // .vscodeignore.  The worker gracefully falls back to WASM when this
    // file is absent.
    //
    // To enable local GPU-accelerated TTS for development, uncomment the
    // line below and re-run `npm run download-kokoro`:
    // 'onnx/model.onnx',
];

// All English voices bundled with kokoro-js (American + British, F + M).
// These are copied from the kokoro-js package — no network download needed.
const VOICES = [
    // American Female
    'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica',
    'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
    // American Male
    'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
    'am_michael', 'am_onyx', 'am_puck', 'am_santa',
    // British Female
    'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
    // British Male
    'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'webview-ui', 'dist', 'kokoro-model', REPO);
const VOICES_OUT_DIR = path.join(OUT_DIR, 'voices');
const KOKORO_PKG_VOICES = path.join(
    ROOT, 'webview-ui', 'node_modules', 'kokoro-js', 'voices'
);

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        let parsed;
        try { parsed = new URL(url); } catch (e) {
            file.close();
            try { fs.unlinkSync(dest); } catch { /* ignore */ }
            reject(new Error(`Invalid URL: ${url}`));
            return;
        }
        const req = https.get(parsed, { headers: { 'User-Agent': 'codearchy-build' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                try { fs.unlinkSync(dest); } catch { /* ignore */ }
                const next = new URL(res.headers.location, parsed).href;
                download(next, dest).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(dest); } catch { /* ignore */ }
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            const total = parseInt(res.headers['content-length'] ?? '0', 10);
            let received = 0;
            res.on('data', (chunk) => {
                received += chunk.length;
                if (total > 1024 * 1024) {
                    const pct = ((received / total) * 100).toFixed(0);
                    process.stdout.write(`\r    ↓ ${path.basename(dest)} ${pct}%   `);
                }
            });
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                if (total > 1024 * 1024) process.stdout.write('\n');
                resolve();
            });
        });
        req.on('error', (err) => {
            file.close();
            try { fs.unlinkSync(dest); } catch { /* ignore */ }
            reject(err);
        });
    });
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function main() {
    ensureDir(OUT_DIR);
    ensureDir(VOICES_OUT_DIR);
    ensureDir(path.join(OUT_DIR, 'onnx'));

    console.log(`Pre-bundling Kokoro-82M into ${path.relative(ROOT, OUT_DIR)}`);

    // 1. Model + tokenizer files from HuggingFace.
    for (const rel of MODEL_FILES) {
        const dest = path.join(OUT_DIR, rel);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
            console.log(`  ✓ ${rel} (cached)`);
            continue;
        }
        ensureDir(path.dirname(dest));
        const url = `${MODEL_BASE}/${rel}`;
        try {
            await download(url, dest);
            const size = fs.statSync(dest).size;
            console.log(`  ✓ ${rel} (${(size / 1024 / 1024).toFixed(1)} MB)`);
        } catch (err) {
            console.error(`  ✗ ${rel}: ${err.message}`);
            process.exitCode = 1;
            return;
        }
    }

    // 2. Voice .bin files copied from kokoro-js node_modules.
    if (!fs.existsSync(KOKORO_PKG_VOICES)) {
        console.error(`  ✗ kokoro-js voices folder missing at ${KOKORO_PKG_VOICES}`);
        console.error('    Run "cd webview-ui && npm install" first.');
        process.exitCode = 1;
        return;
    }
    for (const v of VOICES) {
        const src = path.join(KOKORO_PKG_VOICES, `${v}.bin`);
        const dest = path.join(VOICES_OUT_DIR, `${v}.bin`);
        if (!fs.existsSync(src)) {
            console.warn(`  ! voice ${v}.bin not found in kokoro-js package — skipping`);
            continue;
        }
        if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) {
            console.log(`  ✓ voices/${v}.bin (cached)`);
            continue;
        }
        fs.copyFileSync(src, dest);
        console.log(`  ✓ voices/${v}.bin (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
    }

    console.log('Done. Kokoro-82M assets are pre-bundled.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
