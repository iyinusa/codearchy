const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

const buildOptions = {
    entryPoints: [path.join(__dirname, 'src', 'index.tsx')],
    bundle: true,
    outfile: path.join(__dirname, 'dist', 'webview.js'),
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: !isWatch,
    sourcemap: isWatch,
    loader: {
        '.tsx': 'tsx',
        '.ts': 'ts',
        '.css': 'css',
    },
    define: {
        'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
    },
    // Bundle CSS into JS (injected via style tag)
    // React Flow CSS is imported inline
};

async function build() {
    if (isWatch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('Watching webview-ui for changes...');
    } else {
        await esbuild.build(buildOptions);
        console.log('Webview UI built successfully.');
    }
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
