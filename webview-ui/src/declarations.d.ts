// Allow CSS file imports (handled by esbuild at build time)
declare module '*.css' {
    const content: Record<string, string>;
    export default content;
}
