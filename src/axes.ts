/// <reference types="@webgpu/types" />
import type { Font } from "opentype.js";
import { GrowBuffer } from "./gpu-utils.js";
import type { GpuContext } from "./gpu-context.js";
import { DASH_PATTERNS, LineGpu, modeOf } from "./line-gpu.js";
import { Line } from "./line.js";
import type { LineInit } from "./line.js";
import { parsePlotArgs } from "./plot-args.js";
import type { LineProps, SeriesSpec } from "./plot-args.js";
import { COLOR_ORDER, parseFormat } from "./format.js";
import { MarkerStyle } from "./styles.js";
import type { AxisData, ResolvedOptions, RGBA } from "./styles.js";
import { pushText, pushTextRotated, textMesh } from "./font-utils.js";
import {
    niceTicks, getTickStep, ticksFromStep, categoricalTicks,
    getDateTickStep, dateTicksFromStep, formatTick, formatDateTick,
} from "./ticks.js";
import type { GridSlot, Insets, Rect } from "./layout.js";
import { pushMarkerQuad, resolveMarker } from "./marker.js";

/** What an Axes needs from its owning Figure. */
export interface FigureHost {
    readonly opts: ResolvedOptions;
    readonly font: Font | null;
    readonly gpu: GpuContext | null;
    /** Framebuffer pixels per CSS pixel of the supersampled render target. */
    readonly texScale: number;
    requestRender(): void;
}

export type LegendLocation = 'northeast' | 'northwest' | 'southeast' | 'southwest';
export type HoldState = boolean | 'on' | 'off';

export interface ViewSnapshot { x0: number; x1: number; y0: number; y1: number }

type AxisKind = 'number' | 'date' | 'category';
interface AxisState { kind: AxisKind | null; labels: string[]; index: Map<string, number> }
const newAxisState = (): AxisState => ({ kind: null, labels: [], index: new Map() });

const MAX_DASHED_SEGS = 5_000;

function detectKind(v: AxisData): AxisKind {
    for (let i = 0; i < v.length; i++) {
        const e = (v as ArrayLike<unknown>)[i];
        if (e === null || e === undefined) continue;
        if (typeof e === 'string') return 'category';
        if (e instanceof Date) return 'date';
        return 'number';
    }
    return 'number';
}

function toNumbers(st: AxisState, v: AxisData, axis: 'x' | 'y'): Float64Array {
    if (v.length === 0) return new Float64Array(0);
    const kind = detectKind(v);
    if (st.kind !== null && st.kind !== kind) {
        throw new Error(`plot: cannot mix ${kind} and ${st.kind} data on the ${axis} axis`);
    }
    st.kind = kind;
    const out = new Float64Array(v.length);
    if (kind === 'category') {
        const src = v as readonly string[];
        for (let i = 0; i < src.length; i++) {
            const s = String(src[i]);
            let idx = st.index.get(s);
            if (idx === undefined) { idx = st.labels.length; st.labels.push(s); st.index.set(s, idx); }
            out[i] = idx;
        }
    } else if (kind === 'date') {
        const src = v as readonly (Date | null | undefined)[];
        for (let i = 0; i < src.length; i++) { const d = src[i]; out[i] = d instanceof Date ? d.getTime() : NaN; }
    } else if (ArrayBuffer.isView(v)) {
        out.set(v as unknown as ArrayLike<number>);
    } else {
        const src = v as readonly (number | null | undefined)[];
        for (let i = 0; i < src.length; i++) { const e = src[i]; out[i] = e === null || e === undefined ? NaN : +e; }
    }
    return out;
}

function isNonDecreasing(x: Float64Array): boolean {
    for (let i = 1; i < x.length; i++) if (!(x[i]! >= x[i - 1]!)) return false;
    return true;
}

function visibleRange(xs: Float64Array, sorted: boolean, vmin: number, vmax: number): [number, number] {
    const n = xs.length;
    if (!sorted) return [0, n - 1];
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid]! < vmin) lo = mid + 1; else hi = mid; }
    const start = Math.max(0, lo - 1);
    lo = 0; hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid]! <= vmax) lo = mid + 1; else hi = mid; }
    return [start, Math.min(n - 1, lo)];
}

function toLimit(v: number | Date): number {
    return v instanceof Date ? v.getTime() : v;
}

/**
 * A coordinate system with its own data, view, ticks and labels (MATLAB's Axes).
 * Created through Figure.subplot() / Figure.gca(); rendering is driven by the Figure.
 */
export class Axes {
    // ---- content ----
    private _lines: Line[] = [];
    private holdOn = false;
    private colorIndex = 0;
    private _title = '';
    private _xlabel = '';
    private _ylabel = '';
    private gridOverride: boolean | null = null;
    private aspect: 'auto' | 'equal' | null = null;
    private legendOn = false;
    private legendLocation: LegendLocation = 'northeast';
    private xAxis = newAxisState();
    private yAxis = newAxisState();

    // ---- limits & view (data units, float64) ----
    private xLimManual: [number, number] | null = null;
    private yLimManual: [number, number] | null = null;
    private limitsDirty = true;
    private vx0 = 0; private vx1 = 1; private vy0 = 0; private vy1 = 1;
    private dx0 = 0; private dx1 = 1; private dy0 = 0; private dy1 = 1;
    private ex0 = 0; private ex1 = 1; private ey0 = 0; private ey1 = 1;
    private minSpanX = 1e-9; private minSpanY = 1e-9;
    /** Data origin subtracted before the float32 upload. */
    private ox = 0; private oy = 0;
    private originVersion = 0;
    private xGroup: Set<Axes> | null = null;
    private yGroup: Set<Axes> | null = null;

    // ---- ticks ----
    private xTicks: number[] = []; private yTicks: number[] = [];
    private xTickLabels: string[] = []; private yTickLabels: string[] = [];
    private xTickStep = 1; private yTickStep = 1;
    private lastXSpan = -1; private lastYSpan = -1;
    private yTickMaxWidthPx = 0;

    // ---- layout (CSS px) ----
    /** Grid cell in figure pixels. */
    cell: Rect = { x: 0, y: 0, w: 0, h: 0 };
    /** Plot area in px relative to the cell. */
    private plotL = 0; private plotT = 0; private plotR = 0; private plotB = 0;

    // ---- GPU ----
    private gpuLines = new Map<Line, LineGpu>();
    private readonly panelTris   = new GrowBuffer('panel tris');
    private readonly panelLines  = new GrowBuffer('panel lines');
    private readonly overlayTris = new GrowBuffer('overlay tris');
    private readonly overlayLines = new GrowBuffer('overlay lines');
    private readonly overlayMarkers = new GrowBuffer('overlay markers');
    private readonly textBuf     = new GrowBuffer('text');

    constructor(private readonly fig: FigureHost, public slot: GridSlot) {}

    // =====================================================================
    // Public API (MATLAB-like)
    // =====================================================================

    get lines(): readonly Line[] { return this._lines; }
    get titleText(): string { return this._title; }
    get xlabelText(): string { return this._xlabel; }
    get ylabelText(): string { return this._ylabel; }

    /**
     * Adds lines. Accepts MATLAB-style arguments:
     *   plot(y)  plot(x, y)  plot(x, y, 'r--o')  plot(x1, y1, 'r', x2, y2, 'b')
     *   plot(x, [y1, y2])  plot(x, y, 'k', { LineWidth: 2 })  plot([{ x, y, color }])
     * Without `hold('on')` existing lines are replaced.
     */
    plot(...args: unknown[]): Line[] {
        const specs = parsePlotArgs(args);

        // Replace mode starts from empty content, but must leave the old plot intact if the new data is invalid.
        const replaced = this.holdOn ? null : {
            lines: this._lines, xAxis: this.xAxis, yAxis: this.yAxis, colorIndex: this.colorIndex,
            xLim: this.xLimManual, yLim: this.yLimManual, legendOn: this.legendOn,
        };
        if (replaced) {
            this._lines = []; this.xAxis = newAxisState(); this.yAxis = newAxisState();
            this.colorIndex = 0; this.xLimManual = null; this.yLimManual = null; this.legendOn = false;
        }
        const startLen = this._lines.length, startColor = this.colorIndex;

        let created: Line[];
        try {
            created = specs.map(s => this.addSeries(s));
        } catch (e) {
            if (replaced) {
                this._lines = replaced.lines; this.xAxis = replaced.xAxis; this.yAxis = replaced.yAxis;
                this.colorIndex = replaced.colorIndex; this.xLimManual = replaced.xLim; this.yLimManual = replaced.yLim;
                this.legendOn = replaced.legendOn;
            } else {
                this._lines.length = startLen; this.colorIndex = startColor;
            }
            throw e;
        }
        if (replaced) this.dropGpu(replaced.lines);
        this.limitsDirty = true;
        this.fig.requestRender();
        return created;
    }

    /** Markers-only plot: scatter(x, y), scatter(x, y, 'r') or scatter(x, y, 'r', { MarkerSize: 6 }). */
    scatter(x: AxisData, y: AxisData, ...rest: unknown[]): Line[] {
        const [spec, ...more] = rest;
        const fmt = typeof spec !== 'string' ? 'o' : parseFormat(spec).marker ? spec : spec + 'o';
        return this.plot(x, y, fmt, ...(typeof spec === 'string' ? more : rest));
    }

    hold(state?: HoldState): this {
        this.holdOn = state === undefined ? !this.holdOn : state === true || state === 'on';
        return this;
    }

    /** Removes all lines and resets limits, keeping titles and labels. */
    cla(): this {
        this.dropGpu(this._lines);
        this._lines = [];
        this.xAxis = newAxisState(); this.yAxis = newAxisState();
        this.colorIndex = 0;
        this.xLimManual = null; this.yLimManual = null;
        this.legendOn = false;
        this.limitsDirty = true;
        this.fig.requestRender();
        return this;
    }

    private dropGpu(lines: readonly Line[]): void {
        for (const l of lines) { this.gpuLines.get(l)?.destroy(); this.gpuLines.delete(l); }
    }

    title(text: string): this  { this._title  = text; this.fig.requestRender(); return this; }
    xlabel(text: string): this { this._xlabel = text; this.fig.requestRender(); return this; }
    ylabel(text: string): this { this._ylabel = text; this.fig.requestRender(); return this; }

    grid(state?: HoldState): this {
        this.gridOverride = state === undefined ? !this.gridVisible() : state === true || state === 'on';
        this.fig.requestRender();
        return this;
    }

    /**
     * legend()                 – show, using each line's displayName ('dataN' if empty)
     * legend('a', 'b')         – name lines in creation order and show
     * legend('off')            – hide
     * legend({ location })     – show at 'northeast' | 'northwest' | 'southeast' | 'southwest'
     */
    legend(...args: Array<string | false | { location?: LegendLocation }>): this {
        const names = args.filter((a): a is string => typeof a === 'string');
        const opt = args.find((a): a is { location?: LegendLocation } => typeof a === 'object');
        if (args[0] === false || (names.length === 1 && names[0] === 'off')) {
            this.legendOn = false;
        } else {
            names.forEach((n, i) => { const l = this._lines[i]; if (l) l.displayName = n; });
            if (opt?.location) this.legendLocation = opt.location;
            this.legendOn = true;
        }
        this.fig.requestRender();
        return this;
    }

    xlim(): [number, number];
    xlim(range: readonly [number | Date, number | Date] | 'auto'): this;
    xlim(range?: readonly [number | Date, number | Date] | 'auto'): [number, number] | this {
        if (range === undefined) { this.ensureLimits(); return [this.vx0, this.vx1]; }
        this.setLimMode('x', range);
        return this;
    }

    ylim(): [number, number];
    ylim(range: readonly [number | Date, number | Date] | 'auto'): this;
    ylim(range?: readonly [number | Date, number | Date] | 'auto'): [number, number] | this {
        if (range === undefined) { this.ensureLimits(); return [this.vy0, this.vy1]; }
        this.setLimMode('y', range);
        return this;
    }

    /** 'equal' – 1 data unit is the same length on both axes; 'auto' – fill the cell; 'tight' – fit data exactly. */
    axis(mode: 'equal' | 'auto' | 'tight'): this {
        this.ensureLimits();
        if (mode === 'tight') {
            this.xLimManual = [this.ex0, this.ex1 > this.ex0 ? this.ex1 : this.ex0 + 1];
            this.yLimManual = [this.ey0, this.ey1 > this.ey0 ? this.ey1 : this.ey0 + 1];
            this.aspect = null;
        } else {
            this.aspect = mode;
        }
        this.limitsDirty = true;
        this.fig.requestRender();
        return this;
    }

    /** Synchronises view limits of several axes ('x', 'y' or 'xy'). */
    static link(axes: readonly Axes[], dim: 'x' | 'y' | 'xy' = 'xy'): void {
        if (axes.length < 2) return;
        if (dim.includes('x')) { const g = new Set(axes); for (const a of axes) a.xGroup = g; }
        if (dim.includes('y')) { const g = new Set(axes); for (const a of axes) a.yGroup = g; }
        const first = axes[0]!;
        first.ensureLimits();
        first.setView(first.vx0, first.vx1, first.vy0, first.vy1);
    }

    /** Detaches this axes from any link group. */
    unlink(): void {
        this.xGroup?.delete(this); this.yGroup?.delete(this);
        this.xGroup = null; this.yGroup = null;
    }

    // =====================================================================
    // Called by Line
    // =====================================================================

    /** @internal */
    _lineStyleChanged(): void { this.fig.requestRender(); }

    /** @internal */
    _removeLine(line: Line): void {
        const i = this._lines.indexOf(line);
        if (i >= 0) this._lines.splice(i, 1);
        this.gpuLines.get(line)?.destroy();
        this.gpuLines.delete(line);
        this.limitsDirty = true;
        this.fig.requestRender();
    }

    /** @internal */
    _replaceData(line: Line, x: AxisData | null, y: AxisData): void {
        const { xs, ys, sorted } = this.prepareXY(x, y);
        line.xs = xs; line.ys = ys; line.sorted = sorted;
        line.dataVersion++;
        this.limitsDirty = true;
        this.fig.requestRender();
    }

    // =====================================================================
    // Data ingestion
    // =====================================================================

    private prepareXY(x: AxisData | null, y: AxisData): { xs: Float64Array; ys: Float64Array; sorted: boolean } {
        const ys = toNumbers(this.yAxis, y, 'y');
        let xs: Float64Array;
        if (x === null) {
            xs = Float64Array.from({ length: ys.length }, (_, i) => i + 1);
            this.xAxis.kind ??= 'number';
        } else {
            xs = toNumbers(this.xAxis, x, 'x');
        }
        if (xs.length !== ys.length) {
            throw new Error(`plot: x and y must have the same length (got ${xs.length} and ${ys.length})`);
        }
        let sorted = isNonDecreasing(xs);
        if (!sorted && (this.xAxis.kind === 'date' || this.xAxis.kind === 'category')) {
            const idx = Array.from({ length: xs.length }, (_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
            const sx = new Float64Array(xs.length), sy = new Float64Array(ys.length);
            idx.forEach((src, dst) => { sx[dst] = xs[src]!; sy[dst] = ys[src]!; });
            return { xs: sx, ys: sy, sorted: true };
        }
        return { xs, ys, sorted };
    }

    private addSeries(spec: SeriesSpec): Line {
        const { xs, ys, sorted } = this.prepareXY(spec.x, spec.y);
        const line = new Line(this, xs, ys, sorted, this.resolveInit(spec.props));
        this._lines.push(line);
        return line;
    }

    private resolveInit(p: LineProps): LineInit {
        let color: RGBA;
        if (p.color) color = p.color;
        else { color = [...COLOR_ORDER[this.colorIndex % COLOR_ORDER.length]!]; this.colorIndex++; }

        let marker: MarkerStyle | null = null;
        if (p.marker instanceof MarkerStyle) marker = p.marker;
        else if (p.marker && p.marker !== 'none') { marker = new MarkerStyle(); marker.shape = p.marker; }
        if (marker) {
            if (p.markerSize !== undefined) marker.size = p.markerSize;
            if (p.markerFaceColor !== undefined) {
                marker.faceColor = p.markerFaceColor === 'none' ? null
                                 : p.markerFaceColor === 'auto' ? [...color] as RGBA
                                 : p.markerFaceColor;
            }
            if (p.markerEdgeColor !== undefined) {
                marker.edgeColor = p.markerEdgeColor === 'none' ? [color[0], color[1], color[2], 0]
                                 : p.markerEdgeColor === 'auto' ? null
                                 : p.markerEdgeColor;
            }
        }
        return {
            color,
            lineStyle: p.lineStyle ?? '-',
            lineWidth: p.lineWidth ?? 1.5,
            marker,
            displayName: p.displayName ?? '',
        };
    }

    // =====================================================================
    // Limits & view
    // =====================================================================

    private setLimMode(axis: 'x' | 'y', range: readonly [number | Date, number | Date] | 'auto'): void {
        this.ensureLimits();
        let manual: [number, number] | null = null;
        if (range !== 'auto') {
            const a = toLimit(range[0]), b = toLimit(range[1]);
            if (!Number.isFinite(a) || !Number.isFinite(b) || !(a < b)) {
                throw new Error(`${axis}lim: limits must be finite with min < max`);
            }
            manual = [a, b];
        }
        if (axis === 'x') this.xLimManual = manual; else this.yLimManual = manual;
        this.computeDefaults();
        if (axis === 'x') this.setView(this.dx0, this.dx1, this.vy0, this.vy1);
        else this.setView(this.vx0, this.vx1, this.dy0, this.dy1);
    }

    private ensureLimits(): void {
        if (!this.limitsDirty) return;
        this.limitsDirty = false;
        this.computeDefaults();
        this.vx0 = this.dx0; this.vx1 = this.dx1; this.vy0 = this.dy0; this.vy1 = this.dy1;
    }

    private computeDefaults(): void {
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        let minDX = Infinity, minDY = Infinity;
        for (const line of this._lines) {
            const { xs, ys } = line;
            for (let i = 0; i < xs.length; i++) {
                const x = xs[i]!, y = ys[i]!;
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                if (x < xMin) xMin = x; if (x > xMax) xMax = x;
                if (y < yMin) yMin = y; if (y > yMax) yMax = y;
                if (i > 0) {
                    const dx = Math.abs(x - xs[i - 1]!), dy = Math.abs(y - ys[i - 1]!);
                    if (dx > 1e-300 && dx < minDX) minDX = dx;
                    if (dy > 1e-300 && dy < minDY) minDY = dy;
                }
            }
        }
        const hasData = Number.isFinite(xMin);
        if (!hasData) { xMin = 0; xMax = 1; yMin = 0; yMax = 1; }
        this.ex0 = xMin; this.ex1 = xMax; this.ey0 = yMin; this.ey1 = yMax;
        this.minSpanX = Number.isFinite(minDX) ? minDX : 1e-9;
        this.minSpanY = Number.isFinite(minDY) ? minDY : 1e-9;

        const ox = hasData ? (xMin + xMax) / 2 : 0, oy = hasData ? (yMin + yMax) / 2 : 0;
        if (ox !== this.ox || oy !== this.oy) { this.ox = ox; this.oy = oy; this.originVersion++; }

        [this.dx0, this.dx1] = this.defaultRange(xMin, xMax, this.xAxis, this.xLimManual);
        [this.dy0, this.dy1] = this.defaultRange(yMin, yMax, this.yAxis, this.yLimManual);
    }

    private defaultRange(min: number, max: number, st: AxisState, manual: [number, number] | null): [number, number] {
        if (manual) return manual;
        if (st.kind === 'category') return [-0.5, st.labels.length - 0.5];
        if (st.kind === 'date') {
            const margin = (max - min) * 0.05 || 3_600_000;
            return [min - margin, max + margin];
        }
        if (max === min) { const d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
        const t = niceTicks(min, max, 5);
        return [t[0]!, t[t.length - 1]!];
    }

    /** Sets the visible range and mirrors it to linked axes. */
    setView(x0: number, x1: number, y0: number, y1: number): void {
        if (!(x1 > x0) || !(y1 > y0) || ![x0, x1, y0, y1].every(Number.isFinite)) return;
        this.vx0 = x0; this.vx1 = x1; this.vy0 = y0; this.vy1 = y1;
        for (const a of this.xGroup ?? []) if (a !== this) a.setRangeFromLink('x', x0, x1);
        for (const a of this.yGroup ?? []) if (a !== this) a.setRangeFromLink('y', y0, y1);
        this.fig.requestRender();
    }

    private setRangeFromLink(axis: 'x' | 'y', a: number, b: number): void {
        this.ensureLimits();
        if (axis === 'x') { this.vx0 = a; this.vx1 = b; } else { this.vy0 = a; this.vy1 = b; }
        this.fig.requestRender();
    }

    resetView(): void {
        this.ensureLimits();
        this.setView(this.dx0, this.dx1, this.dy0, this.dy1);
    }

    getView(): ViewSnapshot { this.ensureLimits(); return { x0: this.vx0, x1: this.vx1, y0: this.vy0, y1: this.vy1 }; }

    // =====================================================================
    // Interaction helpers (coordinates are CSS px relative to the figure canvas)
    // =====================================================================

    containsPx(px: number, py: number): boolean {
        const c = this.cell;
        return px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h;
    }

    /** Plot area in figure px. */
    plotRectPx(): Rect {
        return { x: this.cell.x + this.plotL, y: this.cell.y + this.plotT, w: this.plotR - this.plotL, h: this.plotB - this.plotT };
    }

    pxToData(px: number, py: number): { x: number; y: number } {
        this.ensureLimits();
        const r = this.plotRectPx();
        const tx = r.w > 0 ? (px - r.x) / r.w : 0;
        const ty = r.h > 0 ? 1 - (py - r.y) / r.h : 0;
        return { x: this.vx0 + tx * (this.vx1 - this.vx0), y: this.vy0 + ty * (this.vy1 - this.vy0) };
    }

    zoomAround(dataX: number, dataY: number, factor: number): void {
        this.ensureLimits();
        const xRange = this.vx1 - this.vx0, yRange = this.vy1 - this.vy0;
        const tx = (dataX - this.vx0) / xRange, ty = (dataY - this.vy0) / yRange;

        // Zoom-in stops at the smallest point spacing; zoom-out until the data is ~1px wide.
        const maxSpanX = (this.dx1 - this.dx0) * Math.max(this.plotR - this.plotL, 1);
        const maxSpanY = (this.dy1 - this.dy0) * Math.max(this.plotB - this.plotT, 1);
        const clamp = (min: number, max: number, lo: number, hi: number): [number, number] => {
            const span = max - min, mid = (min + max) / 2;
            if (span < lo) return [mid - lo / 2, mid + lo / 2];
            if (hi > 0 && span > hi) return [mid - hi / 2, mid + hi / 2];
            return [min, max];
        };
        const nx0 = dataX - tx * xRange * factor, ny0 = dataY - ty * yRange * factor;
        const [x0, x1] = clamp(nx0, nx0 + xRange * factor, this.minSpanX, maxSpanX);
        const [y0, y1] = clamp(ny0, ny0 + yRange * factor, this.minSpanY, maxSpanY);
        this.setView(x0, x1, y0, y1);
    }

    zoomCentered(factor: number): void {
        this.ensureLimits();
        this.zoomAround((this.vx0 + this.vx1) / 2, (this.vy0 + this.vy1) / 2, factor);
    }

    /** Zooms to a pixel rectangle (figure px). */
    zoomToPx(x0: number, y0: number, x1: number, y1: number): void {
        const tl = this.pxToData(Math.min(x0, x1), Math.min(y0, y1));
        const br = this.pxToData(Math.max(x0, x1), Math.max(y0, y1));
        this.setView(tl.x, br.x, br.y, tl.y);
    }

    panFrom(snap: ViewSnapshot, dxPx: number, dyPx: number): void {
        const w = Math.max(this.plotR - this.plotL, 1), h = Math.max(this.plotB - this.plotT, 1);
        const dx = dxPx / w * (snap.x1 - snap.x0), dy = dyPx / h * (snap.y1 - snap.y0);
        this.setView(snap.x0 - dx, snap.x1 - dx, snap.y0 + dy, snap.y1 + dy);
    }

    private formatInspect(v: number, st: AxisState): string {
        if (st.kind === 'category') return st.labels[Math.round(v)] ?? String(Math.round(v));
        if (st.kind === 'date') return new Date(v).toLocaleString();
        return parseFloat(v.toPrecision(6)).toString();
    }

    /** Data point closest to the mouse (within 30 px) with its screen position in figure px. */
    nearest(mx: number, my: number): { x: number; y: number; text: string } | null {
        this.ensureLimits();
        const r = this.plotRectPx();
        if (r.w <= 0 || r.h <= 0 || mx < r.x || mx > r.x + r.w || my < r.y || my > r.y + r.h) return null;
        const sx = r.w / (this.vx1 - this.vx0), sy = r.h / (this.vy1 - this.vy0);
        const toX = (v: number) => r.x + (v - this.vx0) * sx;
        const toY = (v: number) => r.y + r.h - (v - this.vy0) * sy;
        const mouseX = this.vx0 + (mx - r.x) / sx;

        let best = 30 * 30, bestLine = -1, bestPt = -1;
        this._lines.forEach((line, li) => {
            const n = line.length;
            if (!line.visible || n === 0) return;
            const test = (i: number) => {
                const dx = toX(line.xs[i]!) - mx, dy = toY(line.ys[i]!) - my;
                const d2 = dx * dx + dy * dy;
                if (d2 < best) { best = d2; bestLine = li; bestPt = i; }
            };
            if (line.sorted) {
                let lo = 0, hi = n - 1;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (line.xs[mid]! < mouseX) lo = mid + 1; else hi = mid; }
                for (let i = Math.max(0, lo - 200); i <= Math.min(n - 1, lo + 200); i++) test(i);
            } else {
                const step = Math.max(1, Math.floor(n / 50_000));
                for (let i = 0; i < n; i += step) test(i);
            }
        });
        if (bestLine < 0) return null;

        const line = this._lines[bestLine]!;
        const x = line.xs[bestPt]!, y = line.ys[bestPt]!;
        let text = `x: ${this.formatInspect(x, this.xAxis)}\ny: ${this.formatInspect(y, this.yAxis)}`;
        if (this._lines.length > 1) text += `\nseries: ${line.displayName || bestLine + 1}`;
        return { x: toX(x), y: toY(y), text };
    }

    // =====================================================================
    // Layout & ticks (called by Figure before drawing)
    // =====================================================================

    private gridVisible(): boolean { return this.gridOverride ?? this.fig.opts.style.grid.show; }
    private aspectMode(): 'auto' | 'equal' { return this.aspect ?? this.fig.opts.style.aspectRatio; }

    updateTicks(): void {
        this.ensureLimits();
        const font = this.fig.font;
        if (!font) return;
        const fs = this.fig.opts.fontSize;

        const xSpan = this.vx1 - this.vx0, ySpan = this.vy1 - this.vy0;
        // Relative tolerance: only real zoom changes (not float drift while panning) recompute the step.
        const xChanged = this.lastXSpan < 0 || Math.abs(xSpan - this.lastXSpan) / this.lastXSpan > 1e-9;
        const yChanged = this.lastYSpan < 0 || Math.abs(ySpan - this.lastYSpan) / this.lastYSpan > 1e-9;

        const axisTicks = (
            st: AxisState, lo: number, hi: number, span: number, changed: boolean, isX: boolean,
        ): number[] => {
            if (st.kind === 'category') return categoricalTicks(lo, hi);
            const step = st.kind === 'date' ? getDateTickStep : (_s: number) => getTickStep(lo, hi);
            if (changed) {
                const s = step(span);
                if (isX) { this.xTickStep = s; this.lastXSpan = span; } else { this.yTickStep = s; this.lastYSpan = span; }
            }
            const cur = isX ? this.xTickStep : this.yTickStep;
            return st.kind === 'date' ? dateTicksFromStep(lo, hi, cur) : ticksFromStep(lo, hi, cur);
        };
        this.xTicks = axisTicks(this.xAxis, this.vx0, this.vx1, xSpan, xChanged, true);
        this.yTicks = axisTicks(this.yAxis, this.vy0, this.vy1, ySpan, yChanged, false);

        const label = (st: AxisState, step: number) => (v: number) =>
            st.kind === 'category' ? (st.labels[Math.round(v)] ?? '')
          : st.kind === 'date'     ? formatDateTick(v, step)
          :                          formatTick(v, step);
        this.xTickLabels = this.xTicks.map(label(this.xAxis, this.xTickStep));
        this.yTickLabels = this.yTicks.map(label(this.yAxis, this.yTickStep));

        // Fixed reserve keeps the plot frame stable while zooming; it grows only for unusually wide labels.
        const reserve = textMesh('-0.000', font, fs).width;
        this.yTickMaxWidthPx = this.yTickLabels.reduce((m, t) => Math.max(m, textMesh(t, font, fs).width), reserve);
    }

    private tickOutPx(): number {
        const d = this.fig.opts.style.tickDirection;
        return d === 'out' || d === 'both' ? 8 : 0;
    }

    /** Space this axes needs around its plot area for ticks, labels and title (CSS px). */
    insets(): Insets {
        const o = this.fig.opts;
        const capH = o.fontSize * 0.75, titleCapH = o.titleFontSize * 0.75;
        const out = this.tickOutPx();
        return {
            l: o.paddingLeft + (this._ylabel ? capH + o.paddingYLabelToYTicks : 0) + this.yTickMaxWidthPx + out + 4,
            r: o.paddingRight,
            t: o.paddingTop + (this._title ? titleCapH + o.paddingTitleToPlot : 0),
            b: o.paddingBottom + (this._xlabel ? capH + o.paddingXLabelToPlot : 0) + capH + out + 4,
        };
    }

    applyLayout(cell: Rect, ins: Insets): void {
        this.cell = cell;
        let l = ins.l, r = cell.w - ins.r, t = ins.t, b = cell.h - ins.b;
        const xSpan = this.vx1 - this.vx0, ySpan = this.vy1 - this.vy0;
        if (this.aspectMode() === 'equal' && xSpan > 0 && ySpan > 0 && r > l && b > t) {
            const pxPerX = (r - l) / xSpan, pxPerY = (b - t) / ySpan;
            if (pxPerX > pxPerY) { const nw = pxPerY * xSpan, c = (l + r) / 2; l = c - nw / 2; r = c + nw / 2; }
            else                 { const nh = pxPerX * ySpan, c = (t + b) / 2; t = c - nh / 2; b = c + nh / 2; }
        }
        this.plotL = l; this.plotR = Math.max(r, l); this.plotT = t; this.plotB = Math.max(b, t);
    }

    // =====================================================================
    // GPU: per-frame preparation
    // =====================================================================

    /** Releases every GPU resource (device change / destroy). */
    releaseGpu(): void {
        for (const lg of this.gpuLines.values()) lg.destroy();
        this.gpuLines.clear();
        for (const b of [this.panelTris, this.panelLines, this.overlayTris, this.overlayLines, this.overlayMarkers, this.textBuf]) b.destroy();
    }

    private gpuFor(line: Line, gpu: GpuContext): LineGpu {
        const mode = modeOf(line.lineStyle);
        const hasMarker = !!line.marker && line.marker.shape !== 'none';
        let lg = this.gpuLines.get(line);
        if (!lg || lg.gpu !== gpu || !lg.matches(line.length, mode, hasMarker)) {
            lg?.destroy();
            lg = new LineGpu(gpu, line.length, mode, hasMarker);
            this.gpuLines.set(line, lg);
        }
        if (lg.dataVersion !== line.dataVersion || lg.originVersion !== this.originVersion) {
            lg.upload(line.xs, line.ys, this.ox, this.oy);
            lg.dataVersion = line.dataVersion;
            lg.originVersion = this.originVersion;
        }
        return lg;
    }

    /** Writes uniforms and builds CPU-side geometry. Requires updateTicks() and applyLayout() first. */
    prepare(): void {
        const fig = this.fig, gpu = fig.gpu, font = fig.font;
        if (!gpu || !font) return;
        const dev = gpu.device;
        const { w, h } = this.cell;
        if (w <= 0 || h <= 0) return;

        const o = fig.opts, style = o.style, fs = o.fontSize, titleFs = o.titleFontSize;
        const [cr, cg, cb] = style.axisColor;
        const [br, bg, bb] = style.borderColor;
        const L = this.plotL, R = this.plotR, T = this.plotT, B = this.plotB;
        const cx = (px: number) => px * 2 / w - 1;
        const cy = (py: number) => 1 - py * 2 / h;
        const vx0 = this.vx0, vx1 = this.vx1, vy0 = this.vy0, vy1 = this.vy1;
        const toX = (v: number) => L + (v - vx0) / (vx1 - vx0) * (R - L);
        const toY = (v: number) => B - (v - vy0) / (vy1 - vy0) * (B - T);

        const rect = (out: number[], x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) => {
            const a = cx(x0), c = cx(x1), t = cy(y0), d = cy(y1);
            out.push(a, t, r, g, b,  c, t, r, g, b,  c, d, r, g, b,  a, t, r, g, b,  c, d, r, g, b,  a, d, r, g, b);
        };
        const seg = (out: number[], x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) =>
            out.push(cx(x0), cy(y0), r, g, b, cx(x1), cy(y1), r, g, b);

        const panelTris: number[] = [], lines: number[] = [], text: number[] = [];
        const [pr, pg, pb] = style.background.panelColor;
        rect(panelTris, L, T, R, B, pr, pg, pb);

        if (this.gridVisible()) {
            const [gr, gg, gb] = style.grid.color;
            for (const t of this.xTicks) { const x = toX(t); seg(lines, x, T, x, B, gr, gg, gb); }
            for (const t of this.yTicks) { const y = toY(t); seg(lines, L, y, R, y, gr, gg, gb); }
        }

        // Tick marks and labels
        const dir = style.tickDirection;
        const tickIn  = dir === 'in'  || dir === 'both' ? 8 : 0;
        const tickOut = this.tickOutPx();
        const labelOffset = dir === 'in' ? 4 : 12;
        let lastLabelEnd = -Infinity;
        this.xTicks.forEach((t, i) => {
            const x = toX(t);
            seg(lines, x, B + tickOut, x, B - tickIn, br, bg, bb);
            const m = textMesh(this.xTickLabels[i]!, font, fs);
            const left = x - m.width / 2;
            if (left < lastLabelEnd + 6) return;   // would overlap the previous label
            lastLabelEnd = left + m.width;
            pushText(text, m, left, B + fs * 0.75 + labelOffset, w, h, cr, cg, cb);
        });
        this.yTicks.forEach((t, i) => {
            const y = toY(t);
            seg(lines, L - tickOut, y, L + tickIn, y, br, bg, bb);
            const m = textMesh(this.yTickLabels[i]!, font, fs);
            pushText(text, m, L - m.width - labelOffset, y + fs * 0.35, w, h, cr, cg, cb);
        });

        const capH = fs * 0.75;
        if (this._title) {
            const m = textMesh(this._title, font, titleFs);
            pushText(text, m, (L + R) / 2 - m.width / 2, T - o.paddingTitleToPlot, w, h, cr, cg, cb);
        }
        if (this._xlabel) {
            const m = textMesh(this._xlabel, font, fs);
            pushText(text, m, (L + R) / 2 - m.width / 2, B + capH + tickOut + 4 + o.paddingXLabelToPlot + capH, w, h, cr, cg, cb);
        }
        if (this._ylabel) {
            const m = textMesh(this._ylabel, font, fs);
            const center = L - (tickOut + 4 + this.yTickMaxWidthPx + o.paddingYLabelToYTicks + capH / 2);
            pushTextRotated(text, m, center + capH / 2, (T + B) / 2, w, h, cr, cg, cb);
        }

        this.writeLineParams(gpu, w, h, cx(L), cx(R), cy(B), cy(T));

        const ovTris: number[] = [], ovLines: number[] = [], ovMarkers: number[] = [];
        // Border is drawn after the series so data never covers it.
        const hb = style.borderWidth / 2;
        rect(ovTris, L - hb, T - hb, R + hb, T + hb, br, bg, bb);
        rect(ovTris, L - hb, B - hb, R + hb, B + hb, br, bg, bb);
        rect(ovTris, L - hb, T + hb, L + hb, B - hb, br, bg, bb);
        rect(ovTris, R - hb, T + hb, R + hb, B - hb, br, bg, bb);
        if (this.legendOn) this.buildLegend(font, ovTris, ovLines, ovMarkers, text, rect, seg);

        this.panelTris.write(dev, panelTris, 5);
        this.panelLines.write(dev, lines, 5);
        this.overlayTris.write(dev, ovTris, 5);
        this.overlayLines.write(dev, ovLines, 5);
        this.overlayMarkers.write(dev, ovMarkers, 15);
        this.textBuf.write(dev, text, 5);
    }

    private writeLineParams(gpu: GpuContext, w: number, h: number, rx0: number, rx1: number, ry0: number, ry1: number): void {
        const dev = gpu.device;
        const ox = this.ox, oy = this.oy;
        const vx0 = this.vx0 - ox, vx1 = this.vx1 - ox, vy0 = this.vy0 - oy, vy1 = this.vy1 - oy;

        for (const line of this._lines) {
            const lg = this.gpuFor(line, gpu);
            lg.solidVerts = 0; lg.markerVerts = 0; lg.dashedSegs = 0;
            if (!line.visible) { lg.clearDashed(); continue; }

            const n = line.length;
            const [dr, dg, db] = line.color;
            const alpha = line.color[3] ?? 1;
            const [startI, endI] = visibleRange(line.xs, line.sorted, this.vx0, this.vx1);

            if (lg.solid && n >= 2) {
                const visibleSegs = endI - startI;
                const stride = Math.max(1, Math.ceil(visibleSegs / lg.maxSegs));
                const numSegs = Math.ceil(visibleSegs / stride);
                lg.solidVerts = numSegs * 6;
                const ab = new ArrayBuffer(80), f = new Float32Array(ab), u = new Uint32Array(ab);
                f[0] = vx0; f[1] = vx1; f[2] = vy0; f[3] = vy1;
                f[4] = rx0; f[5] = rx1; f[6] = ry0; f[7] = ry1;
                f[8] = w; f[9] = h; f[10] = line.lineWidth / 2; f[11] = dr;
                f[12] = dg; f[13] = db; f[14] = alpha;
                u[16] = startI; u[17] = stride; u[18] = numSegs;
                dev.queue.writeBuffer(lg.solid.param, 0, ab);
            }

            if (lg.dashed) {
                const pattern = DASH_PATTERNS[line.lineStyle] ?? [];
                const visibleSegs = endI - startI;
                if (n >= 2 && visibleSegs > 0) {
                    const stride = Math.max(1, Math.ceil(visibleSegs / MAX_DASHED_SEGS));
                    const numSegs = Math.ceil(visibleSegs / stride);
                    lg.dashedSegs = numSegs;
                    const ab = new ArrayBuffer(128), f = new Float32Array(ab), u = new Uint32Array(ab);
                    f[0] = vx0; f[1] = vx1; f[2] = vy0; f[3] = vy1;
                    f[4] = rx0; f[5] = rx1; f[6] = ry0; f[7] = ry1;
                    f[8] = w; f[9] = h; f[10] = line.lineWidth / 2; f[11] = dr;
                    f[12] = dg; f[13] = db; f[14] = alpha;
                    u[16] = startI; u[17] = stride; u[18] = numSegs; u[19] = gpu.maxDashQuads; u[20] = pattern.length;
                    f.set(pattern, 24);
                    dev.queue.writeBuffer(lg.dashed.param, 0, ab);
                } else {
                    lg.clearDashed();
                }
            }

            if (lg.marker && line.marker && n > 0) {
                const m = resolveMarker(line.marker, line.color);
                const visiblePts = endI - startI + 1;
                const stride = Math.max(1, Math.ceil(visiblePts / lg.maxMarkers));
                const numPts = Math.ceil(visiblePts / stride);
                lg.markerVerts = numPts * 6;
                const ab = new ArrayBuffer(112), f = new Float32Array(ab), u = new Uint32Array(ab);
                f[0] = vx0; f[1] = vx1; f[2] = vy0; f[3] = vy1;
                f[4] = rx0; f[5] = rx1; f[6] = ry0; f[7] = ry1;
                f[8] = w; f[9] = h; f[10] = this.fig.texScale; f[11] = m.outerR;
                f[12] = m.innerR; f[13] = m.face[0]; f[14] = m.face[1]; f[15] = m.face[2];
                f[16] = m.face[3]; f[17] = m.edge[0]; f[18] = m.edge[1]; f[19] = m.edge[2];
                u[20] = startI; u[21] = stride; u[22] = numPts; f[23] = m.edge[3];
                u[24] = m.shapeId;
                dev.queue.writeBuffer(lg.marker.param, 0, ab);
            }
        }
    }

    private buildLegend(
        font: Font,
        tris: number[], lines: number[], markers: number[], text: number[],
        rect: (out: number[], x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) => void,
        seg: (out: number[], x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number) => number,
    ): void {
        const entries = this._lines
            .map((line, i) => ({ line, label: line.displayName || `data${i + 1}` }))
            .filter(e => e.line.visible);
        if (entries.length === 0) return;

        const o = this.fig.opts, style = o.style, fs = o.fontSize;
        const { w, h } = this.cell;
        const [ar, ag, ab] = style.axisColor;
        const [pr, pg, pb] = style.background.panelColor;
        const pad = 8, sampleW = 30, gap = 8, rowH = Math.round(fs * 1.5), margin = 8;

        const meshes = entries.map(e => textMesh(e.label, font, fs));
        const boxW = pad * 2 + sampleW + gap + Math.max(...meshes.map(m => m.width));
        const boxH = pad * 2 + rowH * entries.length;
        const east = this.legendLocation.endsWith('east'), north = this.legendLocation.startsWith('north');
        const bx = east ? this.plotR - margin - boxW : this.plotL + margin;
        const by = north ? this.plotT + margin : this.plotB - margin - boxH;

        rect(tris, bx, by, bx + boxW, by + boxH, pr, pg, pb);
        seg(lines, bx, by, bx + boxW, by, ar, ag, ab);
        seg(lines, bx + boxW, by, bx + boxW, by + boxH, ar, ag, ab);
        seg(lines, bx + boxW, by + boxH, bx, by + boxH, ar, ag, ab);
        seg(lines, bx, by + boxH, bx, by, ar, ag, ab);

        entries.forEach(({ line }, i) => {
            const cyPx = by + pad + rowH * (i + 0.5);
            const sx0 = bx + pad;
            const a = line.color[3] ?? 1;
            // The flat pipeline has no blending: pre-mix translucent colours with the panel colour.
            const mix = (c: number, bg: number) => c * a + bg * (1 - a);
            const lr = mix(line.color[0], pr), lg = mix(line.color[1], pg), lb = mix(line.color[2], pb);
            const half = Math.max(0.5, line.lineWidth / 2);

            if (line.lineStyle !== 'none') {
                const pattern = DASH_PATTERNS[line.lineStyle] ?? [];
                if (pattern.length === 0) {
                    rect(tris, sx0, cyPx - half, sx0 + sampleW, cyPx + half, lr, lg, lb);
                } else {
                    let pos = 0, k = 0;
                    while (pos < sampleW) {
                        const len = pattern[k % pattern.length]!;
                        if (k % 2 === 0) rect(tris, sx0 + pos, cyPx - half, sx0 + Math.min(pos + len, sampleW), cyPx + half, lr, lg, lb);
                        pos += len; k++;
                    }
                }
            }
            if (line.marker && line.marker.shape !== 'none') {
                pushMarkerQuad(markers, sx0 + sampleW / 2, cyPx, w, h, this.fig.texScale, resolveMarker(line.marker, line.color));
            }
            pushText(text, meshes[i]!, sx0 + sampleW + gap, cyPx + fs * 0.35, w, h, ar, ag, ab);
        });
    }

    // =====================================================================
    // GPU: encoding
    // =====================================================================

    encodeCompute(pass: GPUComputePassEncoder): void {
        const gpu = this.fig.gpu;
        if (!gpu) return;
        for (const line of this._lines) {
            const lg = this.gpuLines.get(line);
            if (!lg || !line.visible) continue;
            if (lg.solid && lg.solidVerts > 0) {
                pass.setPipeline(gpu.solidComputePipeline);
                pass.setBindGroup(0, lg.solid.bind);
                pass.dispatchWorkgroups(Math.ceil(lg.solidVerts / 6 / 64));
            }
            if (lg.dashed && lg.dashedSegs > 0) {
                pass.setPipeline(gpu.dashedComputePipeline);
                pass.setBindGroup(0, lg.dashed.bind);
                pass.dispatchWorkgroups(1);
            }
            if (lg.marker && lg.markerVerts > 0) {
                pass.setPipeline(gpu.markerComputePipeline);
                pass.setBindGroup(0, lg.marker.bind);
                pass.dispatchWorkgroups(Math.ceil(lg.markerVerts / 6 / 64));
            }
        }
    }

    /** Draws into the shared supersampled target using a viewport/scissor on this axes' cell. */
    encodeDraw(pass: GPURenderPassEncoder, texW: number, texH: number): void {
        const gpu = this.fig.gpu;
        if (!gpu || this.cell.w <= 0 || this.cell.h <= 0) return;
        const s = this.fig.texScale;
        const c = this.cell;

        const vx = c.x * s, vy = c.y * s;
        pass.setViewport(vx, vy, Math.min(c.w * s, texW - vx), Math.min(c.h * s, texH - vy), 0, 1);
        const sx = Math.floor(vx), sy = Math.floor(vy);
        const cellScissor: [number, number, number, number] = [
            sx, sy, Math.min(texW, Math.ceil(vx + c.w * s)) - sx, Math.min(texH, Math.ceil(vy + c.h * s)) - sy,
        ];
        pass.setScissorRect(...cellScissor);

        const draw = (pipeline: GPURenderPipeline, buf: GrowBuffer) => {
            if (!buf.buffer || buf.count === 0) return;
            pass.setPipeline(pipeline);
            pass.setVertexBuffer(0, buf.buffer);
            pass.draw(buf.count);
        };

        draw(gpu.textPipeline, this.panelTris);
        draw(gpu.linePipeline, this.panelLines);

        // Data is clipped to the plot area
        const dx0 = Math.max(cellScissor[0], Math.ceil((c.x + this.plotL) * s));
        const dy0 = Math.max(cellScissor[1], Math.ceil((c.y + this.plotT) * s));
        const dx1 = Math.min(cellScissor[0] + cellScissor[2], Math.floor((c.x + this.plotR) * s));
        const dy1 = Math.min(cellScissor[1] + cellScissor[3], Math.floor((c.y + this.plotB) * s));
        if (dx1 > dx0 && dy1 > dy0) {
            pass.setScissorRect(dx0, dy0, dx1 - dx0, dy1 - dy0);

            pass.setPipeline(gpu.seriesLinePipeline);
            for (const line of this._lines) {
                const lg = this.gpuLines.get(line);
                if (!lg || !line.visible || !lg.solid || lg.solidVerts <= 0) continue;
                pass.setVertexBuffer(0, lg.solid.out);
                pass.draw(lg.solidVerts);
            }
            for (const line of this._lines) {
                const lg = this.gpuLines.get(line);
                if (!lg || !line.visible || !lg.dashed) continue;
                pass.setVertexBuffer(0, lg.dashed.out);
                pass.drawIndirect(lg.dashed.args, 0);
            }

            pass.setPipeline(gpu.markerRenderPipeline);
            for (const line of this._lines) {
                const lg = this.gpuLines.get(line);
                if (!lg || !line.visible || !lg.marker || lg.markerVerts <= 0) continue;
                pass.setVertexBuffer(0, lg.marker.out);
                pass.draw(lg.markerVerts);
            }
            pass.setScissorRect(...cellScissor);
        }

        draw(gpu.textPipeline, this.overlayTris);
        draw(gpu.linePipeline, this.overlayLines);
        draw(gpu.markerRenderPipeline, this.overlayMarkers);
        draw(gpu.textPipeline, this.textBuf);
    }
}
