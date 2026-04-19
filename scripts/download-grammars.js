#!/usr/bin/env node
/**
 * Downloads pre-built Tree-sitter WASM grammar files for supported languages.
 * Run: node scripts/download-grammars.js
 * 
 * Grammars are stored in the `parsers/` directory at the extension root.
 * These are required for full AST fidelity parsing. Without them,
 * the extension falls back to regex-based parsing.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PARSERS_DIR = path.join(__dirname, '..', 'parsers');

// Pre-built WASM grammar sources from tree-sitter GitHub releases
const GRAMMARS = {
    'tree-sitter-javascript.wasm': 'https://github.com/tree-sitter/tree-sitter.github.io/tree/master/tree-sitter-javascript.wasm',
    'tree-sitter-typescript.wasm': 'https://github.com/tree-sitter/tree-sitter.github.io/tree/master/tree-sitter-typescript.wasm',
    'tree-sitter-tsx.wasm': 'https://github.com/tree-sitter/tree-sitter.github.io/tree/master/tree-sitter-tsx.wasm',
    'tree-sitter-python.wasm': 'https://github.com/tree-sitter/tree-sitter.github.io/tree/master/tree-sitter-python.wasm',
    'tree-sitter-java.wasm': 'https://github.com/tree-sitter/tree-sitter.github.io/tree/master/tree-sitter-java.wasm',
    'tree-sitter-go.wasm': 'https://github.com/tree-sitter/tree-sitter.github.io/tree/master/tree-sitter-go.wasm',
    'tree-sitter-rust.wasm': 'https://github.com/tree-sitter/tree-sitter.github.io/tree/master/tree-sitter-rust.wasm',
};

function download(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const request = (url.startsWith('https') ? https : http).get(url, (response) => {
            // Handle redirects
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                file.close();
                fs.unlinkSync(destPath);
                download(response.headers.location, destPath).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destPath);
                reject(new Error(`HTTP ${response.statusCode} for ${url}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        });
        request.on('error', (err) => {
            file.close();
            fs.unlinkSync(destPath);
            reject(err);
        });
    });
}

async function main() {
    if (!fs.existsSync(PARSERS_DIR)) {
        fs.mkdirSync(PARSERS_DIR, { recursive: true });
    }

    console.log('Downloading Tree-sitter WASM grammars...\n');

    for (const [filename, url] of Object.entries(GRAMMARS)) {
        const destPath = path.join(PARSERS_DIR, filename);
        if (fs.existsSync(destPath)) {
            console.log(`  ✓ ${filename} (already exists)`);
            continue;
        }
        process.stdout.write(`  ↓ ${filename}...`);
        try {
            await download(url, destPath);
            const stats = fs.statSync(destPath);
            console.log(` done (${(stats.size / 1024).toFixed(0)} KB)`);
        } catch (err) {
            console.log(` FAILED: ${err.message}`);
        }
    }

    console.log('\nDone. Grammars saved to parsers/');
    console.log('The extension will use regex fallback for any missing grammars.');
}

main().catch(console.error);
