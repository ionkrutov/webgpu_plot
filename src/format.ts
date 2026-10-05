import type { LineStyle, MarkerShape, RGB, RGBA } from "./styles.js";

/** MATLAB's default ColorOrder. */
export const COLOR_ORDER: readonly RGB[] = [
    [0.000, 0.447, 0.741],
    [0.850, 0.325, 0.098],
    [0.929, 0.694, 0.125],
    [0.494, 0.184, 0.556],
    [0.466, 0.674, 0.188],
    [0.301, 0.745, 0.933],
    [0.635, 0.078, 0.184],
];

const NAMED: Record<string, RGB> = {
    r: [1, 0, 0], g: [0, 1, 0], b: [0, 0, 1], c: [0, 1, 1],
    m: [1, 0, 1], y: [1, 1, 0], k: [0, 0, 0], w: [1, 1, 1],
    red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], cyan: [0, 1, 1],
    magenta: [1, 0, 1], yellow: [1, 1, 0], black: [0, 0, 0], white: [1, 1, 1],
};

/** Accepts [r,g,b(,a)] in 0..1, a MATLAB short/long colour name, or '#rgb' / '#rrggbb'. */
export function parseColor(c: string | readonly number[]): RGBA {
    if (typeof c !== 'string') {
        if (c.length !== 3 && c.length !== 4) throw new Error(`Colour must have 3 or 4 components, got ${c.length}`);
        return c.length === 4 ? [c[0]!, c[1]!, c[2]!, c[3]!] : [c[0]!, c[1]!, c[2]!];
    }
    const named = NAMED[c.toLowerCase()];
    if (named) return [...named];
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (m) {
        let hex = m[1]!;
        if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
        const n = parseInt(hex, 16);
        return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
    }
    throw new Error(`Unknown colour "${c}"`);
}

export interface ParsedFormat {
    color?: RGB;
    lineStyle?: LineStyle;
    marker?: MarkerShape;
}

const MARKER_CHARS: Record<string, MarkerShape> = {
    'o': 'o', '+': '+', '*': '*', '.': '.', 'x': 'x', '_': '_', '|': '|',
    's': 'square', 'd': 'diamond', '^': '^', 'v': 'v', '>': '>', '<': '<',
    'p': 'pentagram', 'h': 'hexagram',
};

const COLOR_CHARS = 'rgbcmykw';

/**
 * Parses a MATLAB line spec such as 'r--o', 'k:', 'bs', '-.g*'.
 * A marker without a line style draws markers only, as in MATLAB.
 */
export function parseFormat(fmt: string): ParsedFormat {
    const out: ParsedFormat = {};
    for (let i = 0; i < fmt.length; i++) {
        const ch = fmt[i]!;
        const two = fmt.slice(i, i + 2);
        if (two === '--' || two === '-.') { setOnce(out, 'lineStyle', two, fmt); i++; }
        else if (ch === '-' || ch === ':') setOnce(out, 'lineStyle', ch, fmt);
        else if (COLOR_CHARS.includes(ch)) setOnce(out, 'color', NAMED[ch] as RGB, fmt);
        else if (ch in MARKER_CHARS) setOnce(out, 'marker', MARKER_CHARS[ch]!, fmt);
        else throw new Error(`Invalid line specification "${fmt}" (unexpected "${ch}")`);
    }
    if (out.marker && out.lineStyle === undefined) out.lineStyle = 'none';
    return out;
}

function setOnce<K extends keyof ParsedFormat>(o: ParsedFormat, k: K, v: NonNullable<ParsedFormat[K]>, fmt: string): void {
    if (o[k] !== undefined) throw new Error(`Invalid line specification "${fmt}" (duplicate ${k})`);
    o[k] = v;
}

/** True if the string looks like a line spec rather than a property name. */
export function isFormatString(s: string): boolean {
    try { parseFormat(s); return true; } catch { return false; }
}
