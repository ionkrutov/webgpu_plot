import { contourLevels, contourSegments } from "./contour.js";
import { parseColor, parseFormat } from "./format.js";
import { isData, markerShapeOf, normalizeProps } from "./plot-args.js";
import type { LineProps } from "./plot-args.js";
import type { MarkerShape, RGB } from "./styles.js";

export interface Mat { d: Float64Array; rows: number; cols: number }

const isTyped = (v: unknown): v is ArrayLike<number> => ArrayBuffer.isView(v) && !(v instanceof DataView);
const isRow = (v: unknown): boolean => Array.isArray(v) || isTyped(v);

/** True for an array of rows (a matrix), false for a flat vector. */
export function isMatrix(v: unknown): v is ArrayLike<ArrayLike<number>> {
    return Array.isArray(v) && v.length > 0 && isRow(v[0]);
}

export function toVec(v: unknown, what: string): Float64Array {
    if (!isData(v) || isMatrix(v)) throw new Error(`${what} must be a flat array of numbers`);
    const src = v as ArrayLike<number | null | undefined>;
    const out = new Float64Array(src.length);
    for (let i = 0; i < src.length; i++) { const e = src[i]; out[i] = e === null || e === undefined ? NaN : +e; }
    return out;
}

export function toMat(v: unknown, what: string): Mat {
    if (!isMatrix(v)) throw new Error(`${what} must be a matrix (an array of rows)`);
    const rows = v.length, cols = v[0]!.length;
    const d = new Float64Array(rows * cols);
    for (let i = 0; i < rows; i++) {
        const row = v[i]!;
        if (!isRow(row) || row.length !== cols) throw new Error(`${what}: all rows must have the same length`);
        for (let j = 0; j < cols; j++) { const e = (row as ArrayLike<number | null | undefined>)[j]; d[i * cols + j] = e === null || e === undefined ? NaN : +e; }
    }
    return { d, rows, cols };
}

export interface Plot3Spec { x: Float64Array; y: Float64Array; z: Float64Array; props: LineProps }

/** plot3(x, y, z), plot3(x, y, z, 'r--o'), plot3(x, y, z, { LineWidth: 2 }), repeated; matrices plot one line per column. */
export function parsePlot3Args(args: readonly unknown[]): Plot3Spec[] {
    const out: Plot3Spec[] = [];
    let i = 0;
    while (i < args.length) {
        const [a, b, c] = [args[i], args[i + 1], args[i + 2]];
        if (!isData(a) || !isData(b) || !isData(c)) throw new Error('plot3: expected x, y, z arrays');
        i += 3;
        let props: LineProps = {};
        if (typeof args[i] === 'string') {
            const f = parseFormat(args[i] as string);
            if (f.color) props.color = [...f.color];
            if (f.lineStyle) props.lineStyle = f.lineStyle;
            if (f.marker) props.marker = f.marker;
            i++;
        }
        const opt = args[i];
        if (typeof opt === 'object' && opt !== null && !isData(opt)) { props = { ...props, ...normalizeProps(opt as Record<string, unknown>) }; i++; }

        if (isMatrix(a) || isMatrix(b) || isMatrix(c)) {
            const [X, Y, Z] = [toMat(a, 'x'), toMat(b, 'y'), toMat(c, 'z')];
            if (X.rows !== Y.rows || X.rows !== Z.rows || X.cols !== Y.cols || X.cols !== Z.cols) throw new Error('plot3: x, y and z must have the same size');
            for (let j = 0; j < X.cols; j++) {
                const col = (m: Mat) => Float64Array.from({ length: m.rows }, (_, r) => m.d[r * m.cols + j]!);
                out.push({ x: col(X), y: col(Y), z: col(Z), props });
            }
        } else {
            const [x, y, z] = [toVec(a, 'x'), toVec(b, 'y'), toVec(c, 'z')];
            if (x.length !== y.length || x.length !== z.length) throw new Error('plot3: x, y and z must have the same length');
            out.push({ x, y, z, props });
        }
    }
    if (out.length === 0) throw new Error('plot3: no data');
    return out;
}

export interface ScatterSpec {
    x: Float64Array; y: Float64Array; z: Float64Array;
    size?: number | Float64Array;
    color?: RGB | Float64Array;
    filled: boolean;
    marker?: MarkerShape;
}

/** scatter3(x, y, z [, area [, color]] [, 'filled'] [, { Marker, MarkerSize (diameter px), Color }]). */
export function parseScatter3Args(args: readonly unknown[]): ScatterSpec {
    const [a, b, c] = args;
    if (!isData(a) || !isData(b) || !isData(c)) throw new Error('scatter3: expected x, y, z arrays');
    const x = toVec(a, 'x'), y = toVec(b, 'y'), z = toVec(c, 'z');
    if (x.length !== y.length || x.length !== z.length) throw new Error('scatter3: x, y and z must have the same length');
    const spec: ScatterSpec = { x, y, z, filled: false };

    let numeric = 0;
    for (const t of args.slice(3)) {
        if (typeof t === 'number' || isData(t)) {
            const slot = numeric++;
            const v = typeof t === 'number' ? Float64Array.of(t) : toVec(t, 'scatter3 argument');
            if (v.length === 0) continue;
            if (slot === 0) {   // MATLAB's S is an area in points²; store the marker diameter
                spec.size = v.length === 1 ? Math.sqrt(v[0]!) : v.map(Math.sqrt);
            }
            else spec.color = v.length === 3 && x.length !== 3 ? [v[0]!, v[1]!, v[2]!] : v;
        } else if (typeof t === 'string') {
            if (t === 'filled') { spec.filled = true; continue; }
            try { spec.color = parseColor(t).slice(0, 3) as RGB; } catch { spec.marker = markerShapeOf(t); }
        } else if (typeof t === 'object' && t !== null) {
            for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
                switch (k.toLowerCase()) {
                    case 'marker': spec.marker = markerShapeOf(String(v)); break;
                    case 'markersize': case 'size': spec.size = +(v as number); break;
                    case 'color': spec.color = parseColor(v as string | number[]).slice(0, 3) as RGB; break;
                    case 'filled': spec.filled = !!v; break;
                    default: throw new Error(`scatter3: unknown property "${k}"`);
                }
            }
        }
    }
    if (spec.size instanceof Float64Array && spec.size.length !== x.length) throw new Error('scatter3: size must be a scalar or one value per point');
    if (spec.color instanceof Float64Array && spec.color.length !== x.length && spec.color.length !== 3) {
        throw new Error('scatter3: colour must be an RGB triplet or one value per point');
    }
    return spec;
}

export interface GridSpec {
    x: Float64Array; y: Float64Array; z: Float64Array; c: Float64Array;
    rows: number; cols: number;
    /** contour only: explicit levels or a level count. */
    levels?: number | readonly number[] | undefined;
    /** Trailing property arguments (name/value pairs or an options object). */
    rest: unknown[];
}

/**
 * Grid arguments shared by surf/mesh/contour:
 *   (Z) (Z, C) (X, Y, Z) (X, Y, Z, C)       — X, Y are vectors or matrices
 *   contour: (Z, levels) (X, Y, Z, levels)   — levels is a count or a list
 */
export function parseGridArgs(fn: string, args: readonly unknown[], contour: boolean): GridSpec {
    const lead: unknown[] = [];
    let i = 0;
    while (i < args.length && (isData(args[i]) || (contour && typeof args[i] === 'number'))) lead.push(args[i++]);
    const rest = args.slice(i);

    let X: unknown, Y: unknown, Zin: unknown, C: unknown, levels: number | readonly number[] | undefined;
    const isLevelArg = (v: unknown) => typeof v === 'number' || (isData(v) && !isMatrix(v));
    const n = lead.length;
    if (contour && ((n === 2 && isLevelArg(lead[1])) || (n === 4 && isLevelArg(lead[3])))) {
        const lv = lead.pop();
        levels = typeof lv === 'number' ? lv : Array.from(toVec(lv, 'levels'));
    }
    switch (lead.length) {
        case 1: [Zin] = lead; break;
        case 2: [Zin, C] = lead; break;
        case 3: [X, Y, Zin] = lead; break;
        case 4: [X, Y, Zin, C] = lead; break;
        default: throw new Error(`${fn}: expected (Z), (X, Y, Z) or (X, Y, Z, C)`);
    }
    if (contour) C = undefined;

    const Z = toMat(Zin, `${fn}: Z`);
    const { rows, cols } = Z;
    const full = (v: unknown, what: string, axis: 'x' | 'y'): Float64Array => {
        if (v === undefined) {
            return Float64Array.from({ length: rows * cols }, (_, k) => axis === 'x' ? k % cols + 1 : Math.floor(k / cols) + 1);
        }
        if (isMatrix(v)) {
            const m = toMat(v, what);
            if (m.rows !== rows || m.cols !== cols) throw new Error(`${fn}: ${what} must be ${rows}×${cols} like Z`);
            return m.d;
        }
        const vec = toVec(v, what);
        if (vec.length !== (axis === 'x' ? cols : rows)) {
            throw new Error(`${fn}: ${what} has ${vec.length} elements, expected ${axis === 'x' ? cols : rows} (Z is ${rows}×${cols})`);
        }
        return Float64Array.from({ length: rows * cols }, (_, k) => axis === 'x' ? vec[k % cols]! : vec[Math.floor(k / cols)]!);
    };
    const c = C === undefined ? Z.d : (() => {
        const m = toMat(C, `${fn}: C`);
        if (m.rows !== rows || m.cols !== cols) throw new Error(`${fn}: C must be ${rows}×${cols} like Z`);
        return m.d;
    })();
    return { x: full(X, 'X', 'x'), y: full(Y, 'Y', 'y'), z: Z.d, c, rows, cols, levels, rest };
}

/** Contour segments per level for contour()/contour3() arguments. */
export function contourData(args: readonly unknown[]): { levels: number[]; segments: number[][]; rest: unknown[] } {
    const g = parseGridArgs('contour', args, true);
    let zmin = Infinity, zmax = -Infinity;
    for (const v of g.z) if (Number.isFinite(v)) { if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
    const levels = contourLevels(zmin, zmax, g.levels);
    return { levels, segments: levels.map(l => contourSegments(g, l)), rest: g.rest };
}
