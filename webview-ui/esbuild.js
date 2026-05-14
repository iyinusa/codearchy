const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

/**
 * Remove all files in dist/chunks/ before each build so that stale
 * content-hashed chunks from previous builds (e.g. old kokoroEngine-*.js
 * files after the chunk was renamed) do not accumulate and end up packaged
 * in the VSIX.
 */
function cleanChunks() {
    const chunksDir = path.join(__dirname, 'dist', 'chunks');
    if (!fs.existsSync(chunksDir)) return;
    for (const entry of fs.readdirSync(chunksDir)) {
        try { fs.unlinkSync(path.join(chunksDir, entry)); } catch { /* ignore */ }
    }
    console.log('[esbuild] Cleaned dist/chunks/');
}

/**
 * Copy the ONNX Runtime Web wasm binary shipped by @huggingface/transformers
 * into dist/ort/ so ORT can fetch it from the webview's own origin.
 */
function copyOrtAssets() {
    const src = path.join(__dirname, 'node_modules', '@huggingface', 'transformers', 'dist');
    const dest = path.join(__dirname, 'dist', 'ort');
    const assets = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs'];
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const name of assets) {
        const from = path.join(src, name);
        const to = path.join(dest, name);
        if (!fs.existsSync(from)) {
            console.warn(`[esbuild] ORT asset missing: ${from}`);
            continue;
        }
        fs.copyFileSync(from, to);
        const size = fs.statSync(to).size;
        console.log(`[esbuild] Copied ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
}

// ── Main webview bundle (UI) ────────────────────────────────────────────────

const mainOptions = {
    entryPoints: [path.join(__dirname, 'src', 'index.tsx')],
    bundle: true,
    format: 'esm',
    splitting: true,
    outdir: path.join(__dirname, 'dist'),
    entryNames: 'webview',
    chunkNames: 'chunks/[name]-[hash]',
    assetNames: 'assets/[name]-[hash]',
    platform: 'browser',
    target: 'es2020',
    minify: !isWatch,
    sourcemap: isWatch,
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css', '.wasm': 'file' },
    define: { 'process.env.NODE_ENV': isWatch ? '"development"' : '"production"' },
    // kokoro-js and transformers live exclusively in the worker bundle.
    external: ['kokoro-js', '@huggingface/transformers'],
};

// ── Kokoro inference worker (ML stack runs here, off the UI thread) ─────────

const workerOptions = {
    entryPoints: [path.join(__dirname, 'src', 'voice', 'kokoroWorker.ts')],
    bundle: true,
    // IIFE format avoids type:"module" worker quirks in the VS Code webview.
    format: 'iife',
    outfile: path.join(__dirname, 'dist', 'kokoroWorker.js'),
    platform: 'browser',
    target: 'es2020',
    minify: !isWatch,
    sourcemap: isWatch,
    loader: { '.ts': 'ts', '.wasm': 'file' },
    define: { 'process.env.NODE_ENV': isWatch ? '"development"' : '"production"' },
};

async function build() {
    // Always clean stale chunks before building so old content-hashed files
    // from previous runs don't end up in the VSIX.
    cleanChunks();
    if (isWatch) {
        const mainCtx = await esbuild.context(mainOptions);
        const workerCtx = await esbuild.context(workerOptions);
        await Promise.all([mainCtx.watch(), workerCtx.watch()]);
        copyOrtAssets();
        console.log('Watching webview-ui for changes...');
    } else {
        await esbuild.build(mainOptions);
        await esbuild.build(workerOptions);
        copyOrtAssets();
        console.log('Webview UI built successfully.');
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
