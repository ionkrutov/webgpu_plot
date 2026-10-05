import { niceNum } from "./ticks.js";

/** A rectangular grid stored row-major: element (i, j) is at i * cols + j. */
export interface Grid { x: Float64Array; y: Float64Array; z: Float64Array; rows: number; cols: number }

/** Marching squares: returns line segments [x0, y0, x1, y1, ...] where z crosses `level`. */
export function contourSegments(g: Grid, level: number): number[] {
    const { x, y, z, rows, cols } = g;
    const out: number[] = [];
    const edge = (p: number, q: number, e: number[]) => {
        const t = (level - z[p]!) / (z[q]! - z[p]!);
        e.push(x[p]! + (x[q]! - x[p]!) * t, y[p]! + (y[q]! - y[p]!) * t);
    };
    for (let i = 0; i < rows - 1; i++) {
        for (let j = 0; j < cols - 1; j++) {
            const a = i * cols + j, b = a + 1, c = a + cols + 1, d = a + cols;
            const za = z[a]!, zb = z[b]!, zc = z[c]!, zd = z[d]!;
            if (!(Number.isFinite(za) && Number.isFinite(zb) && Number.isFinite(zc) && Number.isFinite(zd))) continue;
            const k = (za >= level ? 1 : 0) | (zb >= level ? 2 : 0) | (zc >= level ? 4 : 0) | (zd >= level ? 8 : 0);
            if (k === 0 || k === 15) continue;

            // Edge points: 0 a-b, 1 b-c, 2 c-d, 3 d-a
            const ends: [number, number][] = [[a, b], [b, c], [c, d], [d, a]];
            const seg = (e0: number, e1: number) => {
                edge(ends[e0]![0], ends[e0]![1], out);
                edge(ends[e1]![0], ends[e1]![1], out);
            };
            switch (k) {
                case 1: case 14: seg(3, 0); break;
                case 2: case 13: seg(0, 1); break;
                case 3: case 12: seg(3, 1); break;
                case 4: case 11: seg(1, 2); break;
                case 6: case 9:  seg(0, 2); break;
                case 7: case 8:  seg(3, 2); break;
                case 5: case 10: {
                    const centerHigh = (za + zb + zc + zd) / 4 >= level;
                    if ((k === 5) === centerHigh) { seg(0, 1); seg(2, 3); } else { seg(3, 0); seg(1, 2); }
                    break;
                }
            }
        }
    }
    return out;
}

/** Level values: an explicit list, or about `count` "nice" levels strictly inside (zmin, zmax). */
export function contourLevels(zmin: number, zmax: number, spec: number | readonly number[] | undefined): number[] {
    if (Array.isArray(spec)) return [...spec as readonly number[]].sort((p, q) => p - q);
    if (!(zmax > zmin)) return [];
    const count = typeof spec === 'number' ? Math.max(1, Math.round(spec)) : 10;
    const step = niceNum((zmax - zmin) / count, true);
    const levels: number[] = [];
    for (let v = Math.ceil(zmin / step) * step; v < zmax; v += step) {
        if (v > zmin) levels.push(Math.round(v / step) * step);
    }
    return levels;
}
