// Shared SVG/PNG export helpers that render from *already laid-out* React Flow
// nodes and edges. This guarantees the exported diagram matches what the user
// sees on screen (ELK-computed positions, smoothstep routing, subsystem
// grouping) instead of producing a naive grid that turns large graphs into a
// tangle of crossing edges.

import type { Node, Edge } from '@xyflow/react';

export interface FlowSubsystem {
    id: string;
    name: string;
    color: string;
    nodeIds: string[];
}

export interface FlowNodeVisual {
    /** Primary title drawn inside the node. */
    title: string;
    /** Optional secondary line (e.g. "python · 12 symbols"). */
    subtitle?: string;
    /** Optional tertiary line (e.g. node type tag). */
    caption?: string;
    /** Accent color for the left bar / border. */
    color: string;
    /** Render style: flat module card vs. system architecture card. */
    variant: 'module' | 'system';
}

export interface FlowEdgeVisual {
    color: string;
    label?: string;
    strokeWidth?: number;
    dashed?: boolean;
}

export interface BuildFlowSvgOptions {
    background?: string;
    /** Absolute padding around the whole diagram. */
    padding?: number;
    /** Optional top banner text (e.g. architectural pattern). */
    banner?: string;
    /** Subsystems to draw as dashed group rectangles behind module nodes. */
    groups?: FlowSubsystem[];
    /** Per-node visual info. */
    getNodeVisual: (node: Node) => FlowNodeVisual;
    /** Per-edge visual info. */
    getEdgeVisual?: (edge: Edge) => FlowEdgeVisual;
}

/**
 * Build an SVG string from React Flow nodes that already have ELK positions
 * and computed width/height. Edges are rendered as smoothstep-style cubic
 * beziers between the source's bottom-center and the target's top-center,
 * mirroring the on-screen React Flow appearance.
 */
export function buildFlowSvg(
    nodes: Node[],
    edges: Edge[],
    options: BuildFlowSvgOptions
): string {
    const {
        background = '#1e1e1e',
        padding = 40,
        banner,
        groups,
        getNodeVisual,
        getEdgeVisual,
    } = options;

    // Filter to nodes with valid layout info; fall back to defaults so a
    // degenerate node never breaks the whole export.
    const laidOut = nodes
        .filter(n => n && n.position && typeof n.position.x === 'number')
        .map(n => ({
            id: n.id,
            node: n,
            x: n.position.x,
            y: n.position.y,
            width: (n.width as number | undefined) ?? readStyleNumber(n.style, 'width') ?? 200,
            height: (n.height as number | undefined) ?? readStyleNumber(n.style, 'height') ?? 80,
        }));

    if (laidOut.length === 0) {
        return emptySvg(background);
    }

    const posById = new Map(laidOut.map(p => [p.id, p]));

    // Compute overall bounding box.
    const minX = Math.min(...laidOut.map(p => p.x));
    const minY = Math.min(...laidOut.map(p => p.y));
    const maxX = Math.max(...laidOut.map(p => p.x + p.width));
    const maxY = Math.max(...laidOut.map(p => p.y + p.height));

    // Translate so the diagram starts at (padding, padding + bannerHeight).
    const bannerHeight = banner ? 32 : 0;
    const tx = -minX + padding;
    const ty = -minY + padding + bannerHeight;

    const svgWidth = Math.ceil(maxX - minX + padding * 2);
    const svgHeight = Math.ceil(maxY - minY + padding * 2 + bannerHeight);

    const parts: string[] = [];
    parts.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">`
    );
    parts.push(`<rect width="${svgWidth}" height="${svgHeight}" fill="${background}"/>`);
    parts.push(
        '<defs>' +
        '<marker id="arrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">' +
        '<polygon points="0 0, 10 3.5, 0 7" fill="currentColor"/>' +
        '</marker>' +
        '</defs>'
    );

    if (banner) {
        parts.push(
            `<text x="${padding}" y="22" fill="#888" font-size="12" font-family="sans-serif" font-weight="600">${escapeXml(
                banner
            )}</text>`
        );
    }

    // Subsystem group rectangles (drawn behind everything else).
    if (groups && groups.length > 0) {
        for (const group of groups) {
            const memberPositions = group.nodeIds
                .map(id => posById.get(id))
                .filter((p): p is NonNullable<typeof p> => !!p);
            if (memberPositions.length === 0) continue;
            const gMinX = Math.min(...memberPositions.map(p => p.x)) + tx - 16;
            const gMinY = Math.min(...memberPositions.map(p => p.y)) + ty - 28;
            const gMaxX = Math.max(...memberPositions.map(p => p.x + p.width)) + tx + 16;
            const gMaxY = Math.max(...memberPositions.map(p => p.y + p.height)) + ty + 16;
            const w = gMaxX - gMinX;
            const h = gMaxY - gMinY;
            parts.push(
                `<rect x="${gMinX}" y="${gMinY}" width="${w}" height="${h}" rx="10" ` +
                `fill="${group.color}14" stroke="${group.color}" stroke-width="1" stroke-dasharray="6 4" opacity="0.6"/>`
            );
            parts.push(
                `<text x="${gMinX + 10}" y="${gMinY + 18}" fill="${group.color}" ` +
                `font-size="12" font-weight="700" font-family="sans-serif">${escapeXml(group.name)}</text>`
            );
        }
    }

    // Edges (drawn before nodes so nodes sit on top).
    for (const edge of edges) {
        const s = posById.get(edge.source);
        const t = posById.get(edge.target);
        if (!s || !t) continue;
        const visual = getEdgeVisual
            ? getEdgeVisual(edge)
            : { color: '#555', strokeWidth: 1.5 };
        const { path, labelX, labelY } = routeEdgePath(
            s.x + tx,
            s.y + ty,
            s.width,
            s.height,
            t.x + tx,
            t.y + ty,
            t.width,
            t.height
        );
        const dash = visual.dashed ? ' stroke-dasharray="5 4"' : '';
        parts.push(
            `<g color="${visual.color}">` +
            `<path d="${path}" fill="none" stroke="${visual.color}" ` +
            `stroke-width="${visual.strokeWidth ?? 1.5}" opacity="0.85"${dash} marker-end="url(#arrow)"/>` +
            `</g>`
        );
        if (visual.label) {
            const labelText = truncate(visual.label, 32);
            const textW = Math.max(28, labelText.length * 6.2);
            parts.push(
                `<rect x="${labelX - textW / 2}" y="${labelY - 9}" width="${textW}" height="15" rx="3" ` +
                `fill="${background}" stroke="${visual.color}" stroke-width="0.5" opacity="0.9"/>` +
                `<text x="${labelX}" y="${labelY + 2}" fill="#bbb" font-size="10" ` +
                `font-family="sans-serif" text-anchor="middle">${escapeXml(labelText)}</text>`
            );
        }
    }

    // Nodes.
    for (const p of laidOut) {
        const visual = getNodeVisual(p.node);
        const x = p.x + tx;
        const y = p.y + ty;
        parts.push(renderNodeSvg(visual, x, y, p.width, p.height));
    }

    parts.push('</svg>');
    return parts.join('');
}

/**
 * Render an SVG string to a PNG base64 string via an offscreen canvas.
 * Returns the base64 payload without the `data:image/png;base64,` prefix.
 */
export function svgToPngBase64(
    svgContent: string,
    onDone: (base64: string) => void,
    background = '#1e1e1e'
): void {
    const img = new Image();
    const svgBlob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = 2;
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            URL.revokeObjectURL(url);
            return;
        }
        ctx.scale(scale, scale);
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, img.width, img.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const dataUrl = canvas.toDataURL('image/png');
        onDone(dataUrl.replace(/^data:image\/png;base64,/, ''));
    };
    img.onerror = () => {
        URL.revokeObjectURL(url);
    };
    img.src = url;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Route a smoothstep-style cubic bezier between two rectangles, exiting the
 *  source's bottom-center and entering the target's top-center. Falls back to
 *  a centered routing when the target is above the source. */
function routeEdgePath(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    tx: number,
    ty: number,
    tw: number,
    th: number
): { path: string; labelX: number; labelY: number } {
    const sxC = sx + sw / 2;
    const syBottom = sy + sh;
    const txC = tx + tw / 2;
    const tyTop = ty;

    // If the target sits above or beside the source, use a side-to-side path.
    const verticalGap = tyTop - syBottom;
    if (verticalGap > 20) {
        const midY = syBottom + verticalGap / 2;
        const path = `M ${sxC} ${syBottom} C ${sxC} ${midY}, ${txC} ${midY}, ${txC} ${tyTop}`;
        return { path, labelX: (sxC + txC) / 2, labelY: midY };
    }

    // Otherwise route horizontally out of the closest side.
    const sxRight = sx + sw;
    const syMid = sy + sh / 2;
    const txLeft = tx;
    const tyMid = ty + th / 2;
    const midX = (sxRight + txLeft) / 2;
    const path = `M ${sxRight} ${syMid} C ${midX} ${syMid}, ${midX} ${tyMid}, ${txLeft} ${tyMid}`;
    return { path, labelX: midX, labelY: (syMid + tyMid) / 2 };
}

function renderNodeSvg(
    visual: FlowNodeVisual,
    x: number,
    y: number,
    w: number,
    h: number
): string {
    const fill = visual.variant === 'system' ? '#252526' : '#252526';
    const strokeWidth = visual.variant === 'system' ? 2 : 1.5;
    const corner = visual.variant === 'system' ? 10 : 8;
    const titleSize = visual.variant === 'system' ? 13 : 12;
    const subtitleSize = 10;
    const accent = visual.color || '#454545';

    let s = '';
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${corner}" ` +
        `fill="${fill}" stroke="${accent}" stroke-width="${strokeWidth}"/>`;
    // Accent bar on the left.
    s += `<rect x="${x}" y="${y}" width="4" height="${h}" rx="2" fill="${accent}"/>`;

    const textX = x + 14;
    s += `<text x="${textX}" y="${y + 22}" fill="#e0e0e0" font-size="${titleSize}" ` +
        `font-weight="700" font-family="sans-serif">${escapeXml(
            truncate(visual.title, Math.max(10, Math.floor((w - 20) / 7)))
        )}</text>`;
    if (visual.subtitle) {
        s += `<text x="${textX}" y="${y + 40}" fill="#a0a0a0" font-size="${subtitleSize}" ` +
            `font-family="sans-serif">${escapeXml(
                truncate(visual.subtitle, Math.max(14, Math.floor((w - 20) / 6)))
            )}</text>`;
    }
    if (visual.caption) {
        s += `<text x="${textX}" y="${y + h - 10}" fill="${accent}" font-size="9" ` +
            `font-weight="600" font-family="sans-serif">${escapeXml(
                truncate(visual.caption, Math.max(12, Math.floor((w - 20) / 6)))
            )}</text>`;
    }
    return s;
}

function readStyleNumber(
    style: React.CSSProperties | undefined,
    key: 'width' | 'height'
): number | undefined {
    const value = style?.[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function emptySvg(background: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="${background}"/><text x="100" y="55" fill="#888" font-size="12" font-family="sans-serif" text-anchor="middle">No diagram to export</text></svg>`;
}

function escapeXml(str: string): string {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function truncate(str: string, max: number): string {
    if (!str) return '';
    return str.length > max ? str.slice(0, Math.max(1, max - 1)) + '…' : str;
}
