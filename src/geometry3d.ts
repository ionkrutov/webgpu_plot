import { Contour3D, Line3D, Scatter3D, Surface3D } from "./artists3d.js";
import type { Artist3D } from "./artists3d.js";
import { lookup } from "./colormap.js";
import type { MarkerShape, RGB } from "./styles.js";

/** Axis normalisation and colour mapping used while building GPU geometry. */
export interface BuildCtx {
    norm: readonly [(v: number) => number, (v: number) => number, (v: number) => number];
    lut: Float32Array;
    cLo: number; cHi: number;
    /** Colour of hidden-line faces (mesh). */
    panel: RGB;
}

export interface Built { tri: Float32Array<ArrayBuffer>; lines: Float32Array<ArrayBuffer>; markers: Float32Array<ArrayBuffer> }

class FloatList {
    private data = new Float32Array(4096);
    private len = 0;
    push(...v: number[]): void {
        if (this.len + v.length > this.data.length) {
            const next = new Float32Array(Math.max(this.data.length * 2, this.len + v.length));
            next.set(this.data.subarray(0, this.len));
            this.data = next;
        }
        for (let i = 0; i < v.length; i++) this.data[this.len++] = v[i]!;
    }
    finish(): Float32Array<ArrayBuffer> { return this.data.slice(0, this.len); }
}

/** On/off lengths in px; 0 means solid. */
const DASH: Record<string, [number, number]> = { '-': [0, 0], '--': [8, 6], ':': [2, 4], '-.': [8, 6] };

function shapeId(s: MarkerShape): number {
    return s === 'square' ? 1 : s === 'diamond' ? 2 : 0;
}

const finite3 = (a: number, b: number, c: number) => Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c);

export function buildGeometry(artists: readonly Artist3D[], ctx: BuildCtx): Built {
    const tri = new FloatList(), lines = new FloatList(), markers = new FloatList();
    for (const a of artists) {
        if (!a.visible) continue;
        if (a instanceof Surface3D) surface(a, ctx, tri, lines);
        else if (a instanceof Line3D) line(a, ctx, lines, markers);
        else if (a instanceof Scatter3D) scatter(a, ctx, markers);
        else if (a instanceof Contour3D) contour(a, ctx, lines);
    }
    return { tri: tri.finish(), lines: lines.finish(), markers: markers.finish() };
}

function line(l: Line3D, ctx: BuildCtx, lines: FloatList, markers: FloatList): void {
    const [nx, ny, nz] = ctx.norm;
    const n = l.x.length;
    const [dash, gap] = DASH[l.lineStyle] ?? [0, 0];
    const hw = l.lineWidth / 2;
    const [r, g, b] = l.color;
    if (l.lineStyle !== 'none' && hw > 0) {
        let arc = 0;
        for (let i = 0; i + 1 < n; i++) {
            const ok = finite3(l.x[i]!, l.y[i]!, l.z[i]!) && finite3(l.x[i + 1]!, l.y[i + 1]!, l.z[i + 1]!);
            if (!ok) continue;
            const x0 = nx(l.x[i]!), y0 = ny(l.y[i]!), z0 = nz(l.z[i]!);
            const x1 = nx(l.x[i + 1]!), y1 = ny(l.y[i + 1]!), z1 = nz(l.z[i + 1]!);
            lines.push(x0, y0, z0, x1, y1, z1, r, g, b, 1, arc, hw, dash, gap);
            arc += Math.hypot(x1 - x0, y1 - y0, z1 - z0);
        }
    }
    if (l.marker !== 'none') {
        const face: RGB | null = l.markerFaceColor === 'none' ? null : l.markerFaceColor === 'auto' ? l.color : l.markerFaceColor;
        for (let i = 0; i < n; i++) {
            if (!finite3(l.x[i]!, l.y[i]!, l.z[i]!)) continue;
            markers.push(nx(l.x[i]!), ny(l.y[i]!), nz(l.z[i]!),
                face ? face[0] : 0, face ? face[1] : 0, face ? face[2] : 0, face ? 1 : 0,
                r, g, b, 1, l.markerSize, shapeId(l.marker), 1, 0);
        }
    }
}

function scatter(s: Scatter3D, ctx: BuildCtx, markers: FloatList): void {
    const [nx, ny, nz] = ctx.norm;
    const rgb = [0, 0, 0];
    for (let i = 0; i < s.x.length; i++) {
        if (!finite3(s.x[i]!, s.y[i]!, s.z[i]!)) continue;
        if (s.color instanceof Float64Array) lookup(ctx.lut, s.color[i]!, ctx.cLo, ctx.cHi, rgb, 0);
        else { rgb[0] = s.color[0]; rgb[1] = s.color[1]; rgb[2] = s.color[2]; }
        const size = typeof s.size === 'number' ? s.size : s.size[i]!;
        markers.push(nx(s.x[i]!), ny(s.y[i]!), nz(s.z[i]!),
            rgb[0]!, rgb[1]!, rgb[2]!, s.filled ? 1 : 0,
            rgb[0]!, rgb[1]!, rgb[2]!, 1, size, shapeId(s.marker), 1, 0);
    }
}

function contour(c: Contour3D, ctx: BuildCtx, lines: FloatList): void {
    const [nx, ny, nz] = ctx.norm;
    const rgb = [0, 0, 0];
    c.levels.forEach((level, k) => {
        lookup(ctx.lut, level, ctx.cLo, ctx.cHi, rgb, 0);
        const seg = c.segments[k]!;
        for (let i = 0; i + 5 < seg.length; i += 6) {
            lines.push(nx(seg[i]!), ny(seg[i + 1]!), nz(seg[i + 2]!), nx(seg[i + 3]!), ny(seg[i + 4]!), nz(seg[i + 5]!),
                rgb[0]!, rgb[1]!, rgb[2]!, 1, 0, c.lineWidth / 2, 0, 0);
        }
    });
}

function surface(s: Surface3D, ctx: BuildCtx, tri: FloatList, lines: FloatList): void {
    const [nx, ny, nz] = ctx.norm;
    const { rows: M, cols: N } = s;
    const count = M * N;
    const P = new Float32Array(count * 3);
    const ok = new Uint8Array(count);
    const col = new Float32Array(count * 3);
    for (let k = 0; k < count; k++) {
        if (!finite3(s.x[k]!, s.y[k]!, s.z[k]!)) continue;
        ok[k] = 1;
        P[k * 3] = nx(s.x[k]!); P[k * 3 + 1] = ny(s.y[k]!); P[k * 3 + 2] = nz(s.z[k]!);
        lookup(ctx.lut, s.c[k]!, ctx.cLo, ctx.cHi, col, k * 3);
    }
    const quadOk = (a: number, b: number, c: number, d: number) => ok[a]! && ok[b]! && ok[c]! && ok[d]!;

    // Quad normal from its diagonals.
    const quadNormal = (a: number, b: number, c: number, d: number): [number, number, number] => {
        const ux = P[c * 3]! - P[a * 3]!, uy = P[c * 3 + 1]! - P[a * 3 + 1]!, uz = P[c * 3 + 2]! - P[a * 3 + 2]!;
        const vx = P[d * 3]! - P[b * 3]!, vy = P[d * 3 + 1]! - P[b * 3 + 1]!, vz = P[d * 3 + 2]! - P[b * 3 + 2]!;
        return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    };
    const unit = (n: readonly number[]): [number, number, number] => {
        const l = Math.hypot(n[0]!, n[1]!, n[2]!);
        return l > 1e-12 ? [n[0]! / l, n[1]! / l, n[2]! / l] : [0, 0, 0];
    };

    const mode = s.faceColor;
    if (mode !== 'none') {
        const smooth = mode === 'interp';
        const vn = smooth ? new Float32Array(count * 3) : null;
        if (vn) {
            for (let i = 0; i < M - 1; i++) for (let j = 0; j < N - 1; j++) {
                const a = i * N + j, b = a + 1, c = a + N + 1, d = a + N;
                if (!quadOk(a, b, c, d)) continue;
                const n = unit(quadNormal(a, b, c, d));
                for (const v of [a, b, c, d]) {
                    vn[v * 3] = vn[v * 3]! + n[0]; vn[v * 3 + 1] = vn[v * 3 + 1]! + n[1]; vn[v * 3 + 2] = vn[v * 3 + 2]! + n[2];
                }
            }
        }
        const constant: RGB | null = mode === 'background' ? ctx.panel : Array.isArray(mode) ? mode : null;
        const unlit = mode === 'background';

        for (let i = 0; i < M - 1; i++) for (let j = 0; j < N - 1; j++) {
            const a = i * N + j, b = a + 1, c = a + N + 1, d = a + N;
            if (!quadOk(a, b, c, d)) continue;
            const fn = unlit ? [0, 0, 0] : unit(quadNormal(a, b, c, d));
            let fr = 0, fg = 0, fb = 0;
            if (constant) { fr = constant[0]; fg = constant[1]; fb = constant[2]; }
            else if (!smooth) {
                for (const v of [a, b, c, d]) { fr += col[v * 3]! / 4; fg += col[v * 3 + 1]! / 4; fb += col[v * 3 + 2]! / 4; }
            }
            const emit = (v: number) => {
                let n: readonly number[] = fn, r = fr, g = fg, bl = fb;
                if (vn) {
                    n = unit([vn[v * 3]!, vn[v * 3 + 1]!, vn[v * 3 + 2]!]);
                    if (!constant) { r = col[v * 3]!; g = col[v * 3 + 1]!; bl = col[v * 3 + 2]!; }
                }
                tri.push(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!, n[0]!, n[1]!, n[2]!, r, g, bl, 1);
            };
            emit(a); emit(b); emit(c);
            emit(a); emit(c); emit(d);
        }
    }

    const edge = s.edgeColor;
    if (edge !== 'none' && s.lineWidth > 0) {
        const hw = s.lineWidth / 2;
        const seg = (p: number, q: number) => {
            if (!ok[p] || !ok[q]) return;
            const flat = edge === 'flat';
            const r = flat ? col[p * 3]! : edge[0], g = flat ? col[p * 3 + 1]! : edge[1], b = flat ? col[p * 3 + 2]! : edge[2];
            lines.push(P[p * 3]!, P[p * 3 + 1]!, P[p * 3 + 2]!, P[q * 3]!, P[q * 3 + 1]!, P[q * 3 + 2]!, r, g, b, 1, 0, hw, 0, 0);
        };
        for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) {
            const p = i * N + j;
            if (j + 1 < N) seg(p, p + 1);
            if (i + 1 < M) seg(p, p + N);
        }
    }
}
