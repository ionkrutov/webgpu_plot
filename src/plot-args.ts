import { MarkerStyle } from "./styles.js";
import type { AxisData, LineStyle, MarkerShape, PlotSeries, RGBA } from "./styles.js";
import { parseColor, parseFormat } from "./format.js";

export interface LineProps {
    color?: RGBA;
    lineStyle?: LineStyle;
    lineWidth?: number;
    marker?: MarkerShape | MarkerStyle;
    markerSize?: number;
    markerFaceColor?: RGBA | 'none' | 'auto';
    markerEdgeColor?: RGBA | 'none' | 'auto';
    displayName?: string;
}

export interface SeriesSpec {
    /** null → 1..n */
    x: AxisData | null;
    y: AxisData;
    props: LineProps;
}

const LINE_STYLES = new Set<string>(['-', '--', ':', '-.', 'none']);
const MARKER_SHAPES = new Set<string>([
    'o', '+', '*', '.', 'x', '_', '|', 'square', 'diamond', '^', 'v', '>', '<', 'pentagram', 'hexagram', 'none',
]);

function isTyped(v: unknown): v is ArrayLike<number> {
    return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

export function isData(v: unknown): v is AxisData {
    return Array.isArray(v) || isTyped(v);
}

function isMatrix(v: unknown): v is readonly AxisData[] {
    return Array.isArray(v) && v.length > 0 && v.every(row => Array.isArray(row) || isTyped(row));
}

function isOptionsObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v) && !(v instanceof Date);
}

function isSeriesObject(v: unknown): v is PlotSeries {
    return isOptionsObject(v) && 'y' in v && isData(v['y']);
}

function colorProp(v: unknown, what: string, allowKeywords: boolean): RGBA | 'none' | 'auto' {
    if (allowKeywords && (v === 'none' || v === 'auto')) return v;
    if (typeof v === 'string' || Array.isArray(v)) return parseColor(v as string | number[]);
    throw new Error(`${what} must be a colour`);
}

export function markerShapeOf(s: string): MarkerShape {
    if (MARKER_SHAPES.has(s)) return s as MarkerShape;
    const m = parseFormat(s).marker;
    if (!m) throw new Error(`Unknown marker "${s}"`);
    return m;
}

/** Reads MATLAB-style property names (case-insensitive) and the lower-camel equivalents. */
export function normalizeProps(o: Record<string, unknown>): LineProps {
    const p: LineProps = {};
    for (const [rawKey, v] of Object.entries(o)) {
        if (v === undefined) continue;
        switch (rawKey.toLowerCase()) {
            case 'color':
                p.color = colorProp(v, 'Color', false) as RGBA; break;
            case 'linestyle':
                if (typeof v !== 'string' || !LINE_STYLES.has(v)) throw new Error(`Invalid LineStyle "${String(v)}"`);
                p.lineStyle = v as LineStyle; break;
            case 'linewidth':
                if (typeof v !== 'number' || !(v >= 0)) throw new Error('LineWidth must be a non-negative number');
                p.lineWidth = v; break;
            case 'marker':
                p.marker = v instanceof MarkerStyle ? v : markerShapeOf(String(v)); break;
            case 'markersize':
                if (typeof v !== 'number' || !(v > 0)) throw new Error('MarkerSize must be a positive number');
                p.markerSize = v; break;
            case 'markerfacecolor':
                p.markerFaceColor = colorProp(v, 'MarkerFaceColor', true); break;
            case 'markeredgecolor':
                p.markerEdgeColor = colorProp(v, 'MarkerEdgeColor', true); break;
            case 'displayname': case 'name':
                p.displayName = String(v); break;
            case 'x': case 'y': break;    // PlotSeries payload, not a property
            default:
                throw new Error(`Unknown line property "${rawKey}"`);
        }
    }
    return p;
}

function merge(a: LineProps, b: LineProps): LineProps { return { ...a, ...b }; }

/**
 * Parses MATLAB-style plot() arguments:
 *   plot(y)  plot(x, y)  plot(x, y, 'r--o')  plot(x1, y1, 'r', x2, y2, 'b')
 *   plot(x, Y)  where Y is an array of rows (one series per row)
 *   plot(x, y, 'r', { LineWidth: 2 })
 *   plot([{ x, y, color, ... }])           (object form)
 */
export function parsePlotArgs(args: readonly unknown[]): SeriesSpec[] {
    const out: SeriesSpec[] = [];

    const first = args[0];
    if (isSeriesObject(first) || (Array.isArray(first) && first.length > 0 && first.every(isSeriesObject))) {
        const list = (Array.isArray(first) ? first : [first]) as PlotSeries[];
        const shared = isOptionsObject(args[1]) ? normalizeProps(args[1]) : {};
        for (const s of list) {
            const props: LineProps = {};
            if (s.color !== undefined) props.color = s.color;
            if (s.lineStyle !== undefined) props.lineStyle = s.lineStyle;
            if (s.lineWidth !== undefined) props.lineWidth = s.lineWidth;
            if (s.marker !== undefined) props.marker = s.marker;
            out.push({ x: s.x, y: s.y, props: merge(props, shared) });
        }
        return out;
    }

    let i = 0;
    while (i < args.length) {
        const a = args[i];
        if (!isData(a)) throw new Error(`plot: argument ${i + 1} must be an array of numbers, strings or Dates`);

        let x: AxisData | null = null;
        let y: AxisData | readonly AxisData[];
        if (isData(args[i + 1])) { x = a; y = args[i + 1] as AxisData; i += 2; }
        else { y = a; i += 1; }

        let props: LineProps = {};
        if (typeof args[i] === 'string') {
            const f = parseFormat(args[i] as string);
            if (f.color)     props.color = [...f.color];
            if (f.lineStyle) props.lineStyle = f.lineStyle;
            if (f.marker)    props.marker = f.marker;
            i++;
        }
        if (isOptionsObject(args[i])) { props = merge(props, normalizeProps(args[i] as Record<string, unknown>)); i++; }

        const yRows = isMatrix(y) ? y : [y as AxisData];
        const xRows = x !== null && isMatrix(x) ? x : null;
        if (xRows && xRows.length !== yRows.length) throw new Error('plot: X and Y matrices must have the same number of rows');
        yRows.forEach((row, k) => out.push({ x: xRows ? xRows[k]! : x as AxisData | null, y: row, props }));
    }
    if (out.length === 0) throw new Error('plot: no data given');
    return out;
}
