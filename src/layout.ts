export interface Rect { x: number; y: number; w: number; h: number }
export interface Insets { l: number; r: number; t: number; b: number }

/** A rectangular block of cells in a rows × cols grid (0-based). */
export interface GridSlot {
    rows: number; cols: number;
    row: number;  col: number;
    rowSpan: number; colSpan: number;
}

/** Converts MATLAB's 1-based row-major index (or list of indices → bounding box) to a slot. */
export function slotFromIndex(rows: number, cols: number, p: number | readonly number[]): GridSlot {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
        throw new Error(`subplot: grid must be positive integers, got ${rows}×${cols}`);
    }
    const list = typeof p === 'number' ? [p] : p;
    if (list.length === 0) throw new Error('subplot: empty index list');
    let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
    for (const idx of list) {
        if (!Number.isInteger(idx) || idx < 1 || idx > rows * cols) {
            throw new Error(`subplot: index ${idx} is outside 1..${rows * cols}`);
        }
        const r = Math.floor((idx - 1) / cols), c = (idx - 1) % cols;
        r0 = Math.min(r0, r); r1 = Math.max(r1, r);
        c0 = Math.min(c0, c); c1 = Math.max(c1, c);
    }
    return { rows, cols, row: r0, col: c0, rowSpan: r1 - r0 + 1, colSpan: c1 - c0 + 1 };
}

/** Slot extent as fractions of the figure area. */
function fractions(s: GridSlot) {
    return { x0: s.col / s.cols, x1: (s.col + s.colSpan) / s.cols, y0: s.row / s.rows, y1: (s.row + s.rowSpan) / s.rows };
}

const EPS = 1e-9;

export function slotsEqual(a: GridSlot, b: GridSlot): boolean {
    const p = fractions(a), q = fractions(b);
    return Math.abs(p.x0 - q.x0) < EPS && Math.abs(p.x1 - q.x1) < EPS && Math.abs(p.y0 - q.y0) < EPS && Math.abs(p.y1 - q.y1) < EPS;
}

export function slotsOverlap(a: GridSlot, b: GridSlot): boolean {
    const p = fractions(a), q = fractions(b);
    return p.x0 < q.x1 - EPS && q.x0 < p.x1 - EPS && p.y0 < q.y1 - EPS && q.y0 < p.y1 - EPS;
}

export interface LayoutItem { slot: GridSlot; insets: Insets }
export interface LayoutResult {
    /** Grid cell in px relative to the figure. */
    cell: Rect;
    /** Plot-area insets inside the cell, aligned with the other axes of the same grid. */
    plot: Insets;
}

const MIN_PLOT_PX = 24;

/**
 * Places axes on a grid. Cells tile `region`; inside each cell the plot area is inset by the
 * axes' own label/tick margins. Axes that share a grid and a column (row) get identical
 * left/right (top/bottom) insets so their plot panels line up.
 */
export function solveLayout(region: Rect, items: readonly LayoutItem[]): LayoutResult[] {
    interface Aligned { colL: number[]; colR: number[]; rowT: number[]; rowB: number[] }
    const groups = new Map<string, Aligned>();
    const key = (s: GridSlot) => `${s.rows}x${s.cols}`;

    for (const { slot: s, insets } of items) {
        let g = groups.get(key(s));
        if (!g) {
            g = { colL: Array(s.cols).fill(0), colR: Array(s.cols).fill(0), rowT: Array(s.rows).fill(0), rowB: Array(s.rows).fill(0) };
            groups.set(key(s), g);
        }
        const c1 = s.col + s.colSpan - 1, r1 = s.row + s.rowSpan - 1;
        g.colL[s.col] = Math.max(g.colL[s.col]!, insets.l);
        g.colR[c1]    = Math.max(g.colR[c1]!,    insets.r);
        g.rowT[s.row] = Math.max(g.rowT[s.row]!, insets.t);
        g.rowB[r1]    = Math.max(g.rowB[r1]!,    insets.b);
    }

    return items.map(({ slot: s }) => {
        const f = fractions(s);
        const x0 = Math.round(region.x + f.x0 * region.w), x1 = Math.round(region.x + f.x1 * region.w);
        const y0 = Math.round(region.y + f.y0 * region.h), y1 = Math.round(region.y + f.y1 * region.h);
        const cell: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

        const g = groups.get(key(s))!;
        const plot: Insets = {
            l: g.colL[s.col]!, r: g.colR[s.col + s.colSpan - 1]!,
            t: g.rowT[s.row]!, b: g.rowB[s.row + s.rowSpan - 1]!,
        };
        const kx = plot.l + plot.r > cell.w - MIN_PLOT_PX ? Math.max(0, cell.w - MIN_PLOT_PX) / (plot.l + plot.r) : 1;
        const ky = plot.t + plot.b > cell.h - MIN_PLOT_PX ? Math.max(0, cell.h - MIN_PLOT_PX) / (plot.t + plot.b) : 1;
        return { cell, plot: { l: plot.l * kx, r: plot.r * kx, t: plot.t * ky, b: plot.b * ky } };
    });
}
