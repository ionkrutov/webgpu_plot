/// <reference types="@webgpu/types" />
import { Axes } from "./axes.js";
import type { FigureHost, HoldState, ViewSnapshot } from "./axes.js";
import { Contour3D, Line3D, Scatter3D, Surface3D } from "./artists3d.js";
import type { Artist3D, ArtistOwner, EdgeColor, FaceColor } from "./artists3d.js";
import { contourData, parseGridArgs, parsePlot3Args, parseScatter3Args } from "./args3d.js";
import { buildLut, lookup } from "./colormap.js";
import type { ColormapName } from "./colormap.js";
import { COLOR_ORDER, parseColor } from "./format.js";
import { pushText, textMesh } from "./font-utils.js";
import { LINE_FLOATS, MARKER_FLOATS, TRI_FLOATS } from "./gpu-3d.js";
import { GrowBuffer } from "./gpu-utils.js";
import { buildGeometry } from "./geometry3d.js";
import type { GridSlot, Insets, Rect } from "./layout.js";
import { MarkerStyle } from "./styles.js";
import type { RGB } from "./styles.js";
import { getTickStep, formatTick, niceTicks } from "./ticks.js";

/** Radius (box units) of the sphere that is fitted into the plot area. */
const FIT_RADIUS = 1.75;
/** Half the depth range mapped to [0, 1]; must exceed the box half-diagonal. */
const DEPTH_RADIUS = 2.0;
const DEFAULT_AZ = -37.5, DEFAULT_EL = 30;
const BIG_SURFACE = 10_000;

type V3 = readonly [number, number, number];
const AXIS_NAMES = ['x', 'y', 'z'] as const;

function defaultRange(min: number, max: number): [number, number] {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
    if (max === min) { const d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
    const t = niceTicks(min, max, 5);
    return [t[0]!, t[t.length - 1]!];
}

/** Ticks inside [lo, hi] including the end points when they are tick values. */
function inclusiveTicks(lo: number, hi: number): { values: number[]; step: number } {
    const step = getTickStep(lo, hi);
    const values: number[] = [];
    for (let i = Math.ceil(lo / step - 1e-9); i * step <= hi + step * 1e-9; i++) values.push(parseFloat((i * step).toPrecision(12)));
    return { values, step };
}

const toLimit = (v: number | Date) => v instanceof Date ? v.getTime() : v;

/**
 * 3-D axes (MATLAB's axes in a 3-D view): plot3, scatter3, surf, mesh and contour3 with an
 * orbit camera, depth-tested GPU rendering and a MATLAB-style box with ticks on the back walls.
 * Drag rotates, Shift-drag (or right-drag) pans, the wheel zooms, double-click resets the view.
 */
export class Axes3D extends Axes implements ArtistOwner {
    private readonly host: FigureHost;

    private artists: Artist3D[] = [];
    private holdOn3 = false;
    private colorIdx3 = 0;
    private zlabelText = '';
    private gridOn3 = true;

    // camera
    private az = DEFAULT_AZ; private el = DEFAULT_EL; private zoom3 = 1; private panX = 0; private panY = 0;

    // limits / ticks per axis (x, y, z)
    private limManual: ([number, number] | null)[] = [null, null, null];
    private rng: [number, number][] = [[0, 1], [0, 1], [0, 1]];
    private tickVals: number[][] = [[], [], []];
    private tickText: string[][] = [[], [], []];
    private limDirty = true;

    // colours
    private lut = buildLut('parula');
    private cmapName: ColormapName | 'custom' = 'parula';
    private cLimManual: [number, number] | null = null;
    private cRange: [number, number] = [0, 1];
    private colorbarOn = false;
    private cbTicks: { values: number[]; step: number } = { values: [], step: 1 };

    // layout (px relative to the cell)
    private pL = 0; private pR = 0; private pT = 0; private pB = 0;

    // GPU
    private geomDirty = true;
    private gpuOwner: GPUDevice | null = null;
    private ubuf: GPUBuffer | null = null;
    private binds: { tri: GPUBindGroup; line: GPUBindGroup; marker: GPUBindGroup } | null = null;
    private readonly bufTri = new GrowBuffer('3d triangles');
    private readonly bufLine = new GrowBuffer('3d lines');
    private readonly bufMarker = new GrowBuffer('3d markers');
    private readonly decoBack = new GrowBuffer('3d walls');
    private readonly decoGrid = new GrowBuffer('3d grid');
    private readonly decoEdges = new GrowBuffer('3d box edges');
    private readonly decoFront = new GrowBuffer('3d box and text');

    constructor(host: FigureHost, slot: GridSlot) {
        super(host, slot);
        this.host = host;
    }

    // =====================================================================
    // Content
    // =====================================================================

    get artistList(): readonly Artist3D[] { return this.artists; }

    /** @internal */
    _artistChanged(): void {
        this.limDirty = true; this.geomDirty = true;
        this.host.requestRender();
    }

    private add<T extends Artist3D>(a: T): T {
        a.owner = this;
        this.artists.push(a);
        this._artistChanged();
        return a;
    }

    /** Removes an artist created by this axes. */
    remove(a: Artist3D): this {
        const i = this.artists.indexOf(a);
        if (i >= 0) { this.artists.splice(i, 1); a.owner = null; this._artistChanged(); }
        return this;
    }

    private beginPlot(): void {
        if (this.holdOn3) return;
        for (const a of this.artists) a.owner = null;
        this.artists = [];
        this.colorIdx3 = 0;
        this.limManual = [null, null, null];
    }

    /** plot3(x, y, z [, 'r--o'] [, { LineWidth }]) — see parsePlot3Args. */
    plot3(...args: unknown[]): Line3D[] {
        const specs = parsePlot3Args(args);
        this.beginPlot();
        return specs.map(sp => {
            const l = new Line3D(sp.x, sp.y, sp.z);
            const p = sp.props;
            l.color = p.color ? [p.color[0], p.color[1], p.color[2]] : [...COLOR_ORDER[this.colorIdx3++ % COLOR_ORDER.length]!];
            if (p.lineStyle) l.lineStyle = p.lineStyle;
            if (p.lineWidth !== undefined) l.lineWidth = p.lineWidth;
            if (p.marker instanceof MarkerStyle) { l.marker = p.marker.shape; l.markerSize = p.marker.size; }
            else if (p.marker) l.marker = p.marker;
            if (p.markerSize !== undefined) l.markerSize = p.markerSize;
            if (p.markerFaceColor) l.markerFaceColor = Array.isArray(p.markerFaceColor) ? [p.markerFaceColor[0], p.markerFaceColor[1], p.markerFaceColor[2]] : p.markerFaceColor;
            if (p.displayName) l.displayName = p.displayName;
            return this.add(l);
        });
    }

    /** scatter3(x, y, z [, size [, color]] [, 'filled']). Colour values are mapped through colormap(). */
    scatter3(...args: unknown[]): Scatter3D {
        const sp = parseScatter3Args(args);
        this.beginPlot();
        const s = new Scatter3D(sp.x, sp.y, sp.z);
        if (sp.size !== undefined) s.size = sp.size;
        s.color = sp.color ?? [...COLOR_ORDER[this.colorIdx3++ % COLOR_ORDER.length]!];
        s.filled = sp.filled;
        if (sp.marker) s.marker = sp.marker;
        return this.add(s);
    }

    /**
     * surf(Z) surf(X, Y, Z) surf(X, Y, Z, C) [, 'FaceColor', 'interp' | 'flat' | 'none' | color]
     * [, 'EdgeColor', 'none' | 'flat' | color] [, 'LineWidth', n].
     * Edges are hidden by default on grids larger than 100 × 100.
     */
    surf(...args: unknown[]): Surface3D { return this.makeSurface('surf', args); }

    /** Wireframe surface with hidden-line removal; same arguments as surf(). */
    mesh(...args: unknown[]): Surface3D { return this.makeSurface('mesh', args); }

    private makeSurface(fn: 'surf' | 'mesh', args: unknown[]): Surface3D {
        const g = parseGridArgs(fn, args, false);
        const s = new Surface3D(g.x, g.y, g.z, g.c, g.rows, g.cols);
        if (fn === 'mesh') { s.faceColor = 'background'; s.edgeColor = 'flat'; }
        else if (g.rows * g.cols > BIG_SURFACE) s.edgeColor = 'none';
        for (const [k, v] of propertyPairs(fn, g.rest)) {
            switch (k.toLowerCase()) {
                case 'facecolor': s.faceColor = faceColorOf(v); break;
                case 'edgecolor': s.edgeColor = edgeColorOf(v); break;
                case 'linewidth': s.lineWidth = +(v as number); break;
                default: throw new Error(`${fn}: unknown property "${k}"`);
            }
        }
        this.beginPlot();
        return this.add(s);
    }

    /** contour3(Z [, levels]) contour3(X, Y, Z [, levels]) — levels is a count or a list; lines are coloured by level. */
    contour3(...args: unknown[]): Contour3D {
        const { levels, segments } = contourData(args);
        const xyz = segments.map((seg, k) => {
            const out: number[] = [];
            for (let i = 0; i + 3 < seg.length; i += 4) out.push(seg[i]!, seg[i + 1]!, levels[k]!, seg[i + 2]!, seg[i + 3]!, levels[k]!);
            return out;
        });
        this.beginPlot();
        return this.add(new Contour3D(levels, xyz));
    }

    zlabel(text: string): this { this.zlabelText = text; this.host.requestRender(); return this; }
    get zlabelValue(): string { return this.zlabelText; }

    override plot(..._args: unknown[]): never {
        throw new Error('plot() cannot draw into 3-D axes; use plot3(), or create 2-D axes with subplot()');
    }
    override scatter(..._args: unknown[]): never {
        throw new Error('scatter() cannot draw into 3-D axes; use scatter3()');
    }

    override get holding(): boolean { return this.holdOn3; }
    override hold(state?: HoldState): this {
        this.holdOn3 = state === undefined ? !this.holdOn3 : state === true || state === 'on';
        return this;
    }

    override cla(): this {
        for (const a of this.artists) a.owner = null;
        this.artists = [];
        this.colorIdx3 = 0;
        this.limManual = [null, null, null]; this.cLimManual = null;
        this._artistChanged();
        return this;
    }

    override grid(state?: HoldState): this {
        this.gridOn3 = state === undefined ? !this.gridOn3 : state === true || state === 'on';
        this.host.requestRender();
        return this;
    }

    /** Legends are not drawn for 3-D axes. */
    override legend(..._args: unknown[]): this { return this; }

    // ---- limits ----

    private limits(k: number, range?: readonly [number | Date, number | Date] | 'auto'): [number, number] | this {
        if (range === undefined) { this.ensureRanges(); return [...this.rng[k]!]; }
        if (range === 'auto') this.limManual[k] = null;
        else {
            const a = toLimit(range[0]), b = toLimit(range[1]);
            if (!Number.isFinite(a) || !Number.isFinite(b) || !(a < b)) throw new Error(`${AXIS_NAMES[k]}lim: limits must be finite with min < max`);
            this.limManual[k] = [a, b];
        }
        this._artistChanged();
        return this;
    }

    override xlim(): [number, number];
    override xlim(range: readonly [number | Date, number | Date] | 'auto'): this;
    override xlim(range?: readonly [number | Date, number | Date] | 'auto'): [number, number] | this { return this.limits(0, range); }
    override ylim(): [number, number];
    override ylim(range: readonly [number | Date, number | Date] | 'auto'): this;
    override ylim(range?: readonly [number | Date, number | Date] | 'auto'): [number, number] | this { return this.limits(1, range); }
    zlim(): [number, number];
    zlim(range: readonly [number | Date, number | Date] | 'auto'): this;
    zlim(range?: readonly [number | Date, number | Date] | 'auto'): [number, number] | this { return this.limits(2, range); }

    /** 'tight' fits the limits to the data; 'auto' and 'equal' restore the automatic limits. */
    override axis(mode: 'equal' | 'auto' | 'tight'): this {
        if (mode === 'tight') {
            const e = this.dataExtent();
            this.limManual = e.map(([lo, hi]) => Number.isFinite(lo) ? [lo, hi > lo ? hi : lo + 1] as [number, number] : null);
        } else {
            this.limManual = [null, null, null];
        }
        this._artistChanged();
        return this;
    }

    // ---- colour ----

    /** colormap(name) — see COLORMAP_NAMES, append '_r' to reverse — or a list of [r, g, b]. */
    colormap(spec?: ColormapName | readonly RGB[]): ColormapName | 'custom' | this {
        if (spec === undefined) return this.cmapName;
        this.lut = buildLut(spec);
        this.cmapName = typeof spec === 'string' ? spec : 'custom';
        this.geomDirty = true;
        this.host.requestRender();
        return this;
    }

    /** Colour limits; 'auto' uses the data range. */
    caxis(range?: readonly [number, number] | 'auto'): [number, number] | this {
        if (range === undefined) { this.ensureRanges(); return [...this.cRange]; }
        if (range === 'auto') this.cLimManual = null;
        else {
            if (!(range[0] < range[1])) throw new Error('caxis: need min < max');
            this.cLimManual = [range[0], range[1]];
        }
        this._artistChanged();
        return this;
    }

    colorbar(state?: HoldState): this {
        this.colorbarOn = state === undefined ? !this.colorbarOn : state === true || state === 'on';
        this.host.requestRender();
        return this;
    }

    /** shading('flat' | 'faceted' | 'interp') for all surfaces. */
    shading(mode: 'flat' | 'faceted' | 'interp'): this {
        for (const a of this.artists) {
            if (!(a instanceof Surface3D)) continue;
            a.faceColor = mode === 'interp' ? 'interp' : 'flat';
            a.edgeColor = mode === 'faceted' ? [0, 0, 0] : 'none';
        }
        this._artistChanged();
        return this;
    }

    // ---- camera ----

    /** view(azimuth, elevation) in degrees; view() returns the current angles. */
    view(az?: number, el?: number): [number, number] | this {
        if (az === undefined || el === undefined) return [this.az, this.el];
        if (!Number.isFinite(az) || !Number.isFinite(el)) throw new Error('view: angles must be finite');
        this.az = az; this.el = Math.max(-90, Math.min(90, el));
        this.host.requestRender();
        return this;
    }

    override resetView(): void {
        this.az = DEFAULT_AZ; this.el = DEFAULT_EL; this.zoom3 = 1; this.panX = 0; this.panY = 0;
        this.limDirty = true;
        this.host.requestRender();
    }

    override getView(): ViewSnapshot { return { x0: this.az, x1: this.el, y0: this.panX, y1: this.panY }; }
    override setView(): void { /* 3-D axes are controlled with view() */ }

    /** Rotates (default) or pans the camera, relative to the snapshot taken when the drag began. */
    dragFrom(snap: ViewSnapshot, dxPx: number, dyPx: number, pan: boolean): void {
        if (pan) { this.panX = snap.y0 + dxPx; this.panY = snap.y1 + dyPx; }
        else { this.az = snap.x0 - dxPx * 0.5; this.el = Math.max(-90, Math.min(90, snap.x1 + dyPx * 0.5)); }
        this.host.requestRender();
    }

    override panFrom(snap: ViewSnapshot, dxPx: number, dyPx: number): void { this.dragFrom(snap, dxPx, dyPx, false); }
    override pxToData(): { x: number; y: number } { return { x: 0, y: 0 }; }
    override zoomAround(_x: number, _y: number, factor: number): void { this.zoomCentered(factor); }
    override zoomCentered(factor: number): void {
        this.zoom3 = Math.min(1000, Math.max(0.5, this.zoom3 / factor));
        this.limDirty = true;
        this.host.requestRender();
    }
    override zoomToPx(): void { /* not applicable in 3-D */ }
    override nearest(): null { return null; }

    // =====================================================================
    // Ranges and layout
    // =====================================================================

    private dataExtent(): [number, number][] {
        const ext: [number, number][] = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
        const scan = (k: number, v: ArrayLike<number>, stride = 1, offset = 0) => {
            const e = ext[k]!;
            for (let i = offset; i < v.length; i += stride) {
                const x = v[i]!;
                if (Number.isFinite(x)) { if (x < e[0]) e[0] = x; if (x > e[1]) e[1] = x; }
            }
        };
        for (const a of this.artists) {
            if (!a.visible) continue;
            if (a instanceof Contour3D) for (const seg of a.segments) for (let k = 0; k < 3; k++) scan(k, seg, 3, k);
            else if (a instanceof Line3D || a instanceof Scatter3D || a instanceof Surface3D) { scan(0, a.x); scan(1, a.y); scan(2, a.z); }
        }
        return ext;
    }

    private colorExtent(): [number, number] {
        let lo = Infinity, hi = -Infinity;
        const scan = (v: ArrayLike<number>) => { for (let i = 0; i < v.length; i++) { const x = v[i]!; if (Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; } } };
        for (const a of this.artists) {
            if (!a.visible) continue;
            if (a instanceof Surface3D) scan(a.c);
            else if (a instanceof Scatter3D && a.color instanceof Float64Array) scan(a.color);
            else if (a instanceof Contour3D) scan(a.levels);
        }
        return Number.isFinite(lo) ? [lo, hi > lo ? hi : lo + 1] : [0, 1];
    }

    private ensureRanges(): void {
        if (!this.limDirty) return;
        this.limDirty = false;
        const ext = this.dataExtent();
        for (let k = 0; k < 3; k++) {
            const full = this.limManual[k] ?? defaultRange(ext[k]![0], ext[k]![1]);
            // Zoom shrinks the visible data range around its centre; the box and ticks stay in view.
            const mid = (full[0] + full[1]) / 2, half = (full[1] - full[0]) / 2 / this.zoom3;
            this.rng[k] = [mid - half, mid + half];
            const t = inclusiveTicks(this.rng[k]![0], this.rng[k]![1]);
            this.tickVals[k] = t.values;
            this.tickText[k] = t.values.map(v => formatTick(v, t.step));
        }
        this.cRange = this.cLimManual ?? this.colorExtent();
        this.cbTicks = inclusiveTicks(this.cRange[0], this.cRange[1]);
        this.geomDirty = true;
    }

    override updateTicks(): void { this.ensureRanges(); }

    override insets(): Insets {
        const o = this.host.opts;
        const titleH = this.titleText ? o.titleFontSize * 0.75 + o.paddingTitleToPlot : 0;
        return {
            l: o.paddingLeft + 24,
            r: o.paddingRight + 24 + (this.colorbarOn ? 76 : 0),
            t: o.paddingTop + titleH + 4,
            b: o.paddingBottom + 34,
        };
    }

    override applyLayout(cell: Rect, ins: Insets): void {
        this.cell = cell;
        this.pL = ins.l; this.pR = Math.max(cell.w - ins.r, ins.l + 1);
        this.pT = ins.t; this.pB = Math.max(cell.h - ins.b, ins.t + 1);
    }

    override plotRectPx(): Rect {
        return { x: this.cell.x + this.pL, y: this.cell.y + this.pT, w: this.pR - this.pL, h: this.pB - this.pT };
    }

    // =====================================================================
    // Projection
    // =====================================================================

    private basis(): { r: V3; u: V3; c: V3 } {
        const az = this.az * Math.PI / 180, el = this.el * Math.PI / 180;
        const sa = Math.sin(az), ca = Math.cos(az), se = Math.sin(el), ce = Math.cos(el);
        return { r: [ca, sa, 0], u: [-se * sa, se * ca, ce], c: [sa * ce, -ca * ce, se] };
    }

    private pxPerUnit(): number {
        return Math.max(1, Math.min(this.pR - this.pL, this.pB - this.pT)) / (2 * FIT_RADIUS);
    }

    private projector(): (p: V3) => [number, number] {
        const { r, u } = this.basis();
        const ppu = this.pxPerUnit();
        const cx = (this.pL + this.pR) / 2 + this.panX, cy = (this.pT + this.pB) / 2 + this.panY;
        return p => [
            cx + ppu * (p[0] * r[0] + p[1] * r[1] + p[2] * r[2]),
            cy - ppu * (p[0] * u[0] + p[1] * u[1] + p[2] * u[2]),
        ];
    }

    // =====================================================================
    // Per-frame preparation
    // =====================================================================

    override releaseGpu(): void {
        super.releaseGpu();
        for (const b of [this.bufTri, this.bufLine, this.bufMarker, this.decoBack, this.decoGrid, this.decoEdges, this.decoFront]) b.destroy();
        this.ubuf?.destroy();
        this.ubuf = null; this.binds = null; this.gpuOwner = null;
        this.geomDirty = true;
    }

    override encodeCompute(): void { /* all geometry is built on the CPU */ }

    override prepare(): void {
        const gpu = this.host.gpu, font = this.host.font;
        if (!gpu || !font) return;
        const { w, h } = this.cell;
        if (w <= 0 || h <= 0) return;
        this.ensureRanges();

        const dev = gpu.device;
        if (this.gpuOwner !== dev) { this.releaseGpu(); this.gpuOwner = dev; }
        if (!this.ubuf || !this.binds) {
            const p = gpu.pipelines3d;
            this.ubuf = dev.createBuffer({ label: '3d uniforms', size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            const bind = (pl: GPURenderPipeline) => dev.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.ubuf! } }] });
            this.binds = { tri: bind(p.tri), line: bind(p.line), marker: bind(p.marker) };
        }

        if (this.geomDirty) {
            this.geomDirty = false;
            const norm = (k: number) => { const [lo, hi] = this.rng[k]!; const mid = (lo + hi) / 2, half = (hi - lo) / 2 || 1; return (v: number) => (v - mid) / half; };
            const built = buildGeometry(this.artists, {
                norm: [norm(0), norm(1), norm(2)], lut: this.lut, cLo: this.cRange[0], cHi: this.cRange[1],
                panel: this.host.opts.style.background.panelColor,
            });
            this.bufTri.writeF32(dev, built.tri, TRI_FLOATS);
            this.bufLine.writeF32(dev, built.lines, LINE_FLOATS);
            this.bufMarker.writeF32(dev, built.markers, MARKER_FLOATS);
        }

        this.writeUniforms(dev, w, h);
        this.buildDecoration(dev, font, w, h);
    }

    private writeUniforms(dev: GPUDevice, w: number, h: number): void {
        const { r, u, c } = this.basis();
        const ppu = this.pxPerUnit();
        const cx = (this.pL + this.pR) / 2 + this.panX, cy = (this.pT + this.pB) / 2 + this.panY;
        const kx = 2 * ppu / w, ky = 2 * ppu / h, kz = -1 / (2 * DEPTH_RADIUS);
        const tx = 2 * cx / w - 1, ty = 1 - 2 * cy / h;
        // Row-major rows of the clip transform, stored column-major for WGSL.
        const rows = [
            [kx * r[0], kx * r[1], kx * r[2], tx],
            [ky * u[0], ky * u[1], ky * u[2], ty],
            [kz * c[0], kz * c[1], kz * c[2], 0.5],
            [0, 0, 0, 1],
        ];
        const f = new Float32Array(36);
        for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) f[col * 4 + row] = rows[row]![col]!;
        f.set([r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, c[0], c[1], c[2], 0], 16);
        f.set([0.003, ppu, 1.0005, 0, w, h, 0, 0], 28);
        dev.queue.writeBuffer(this.ubuf!, 0, f);
    }

    /** Back walls, grid, box, tick labels, axis labels, title and colorbar — all in screen space. */
    private buildDecoration(dev: GPUDevice, font: NonNullable<FigureHost['font']>, w: number, h: number): void {
        const o = this.host.opts, style = o.style, fs = o.fontSize;
        const [tr, tg, tb] = style.axisColor;
        const [br, bg, bb] = style.borderColor;
        const cx = (px: number) => px * 2 / w - 1, cy = (py: number) => 1 - py * 2 / h;
        const proj = this.projector();
        const { c } = this.basis();

        const back: number[] = [], grid: number[] = [], edges: number[] = [], front: number[] = [];
        const tri = (out: number[], a: [number, number], b: [number, number], d: [number, number], rgb: V3 | number[]) => {
            for (const p of [a, b, d]) out.push(cx(p[0]), cy(p[1]), rgb[0]!, rgb[1]!, rgb[2]!);
        };
        const thick = (out: number[], a: [number, number], b: [number, number], width: number, rgb: V3) => {
            const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len * width / 2, ny = dx / len * width / 2;
            const p0: [number, number] = [a[0] + nx, a[1] + ny], p1: [number, number] = [a[0] - nx, a[1] - ny];
            const p2: [number, number] = [b[0] - nx, b[1] - ny], p3: [number, number] = [b[0] + nx, b[1] + ny];
            tri(out, p0, p1, p2, rgb); tri(out, p0, p2, p3, rgb);
        };

        const norm = (k: number, v: number) => { const [lo, hi] = this.rng[k]!; return (v - (lo + hi) / 2) / ((hi - lo) / 2 || 1); };
        const ticksN = [0, 1, 2].map(k => this.tickVals[k]!.map(v => norm(k, v)));
        const at = (k: number, t: number, a: number, b: number): V3 => k === 0 ? [t, a, b] : k === 1 ? [a, t, b] : [a, b, t];

        // Back walls: the faces whose outward normal points away from the camera.
        const wall = [0, 1, 2].map(k => c[k]! >= 0 ? -1 : 1);
        const [pr, pg, pb] = style.background.panelColor;
        for (let k = 0; k < 3; k++) {
            const p = (a: number, b: number): [number, number] => {
                const v: number[] = [0, 0, 0]; v[k] = wall[k]!;
                const o1 = (k + 1) % 3, o2 = (k + 2) % 3; v[o1] = a; v[o2] = b;
                return proj(v as unknown as V3);
            };
            tri(back, p(-1, -1), p(1, -1), p(1, 1), [pr, pg, pb]);
            tri(back, p(-1, -1), p(1, 1), p(-1, 1), [pr, pg, pb]);
        }
        if (this.gridOn3) {
            const [gr, gg, gb] = style.grid.color;
            for (let k = 0; k < 3; k++) {
                const o1 = (k + 1) % 3, o2 = (k + 2) % 3;
                const pt = (a: number, b: number): [number, number] => {
                    const v: number[] = [0, 0, 0]; v[k] = wall[k]!; v[o1] = a; v[o2] = b;
                    return proj(v as unknown as V3);
                };
                for (const t of ticksN[o1]!) { const p = pt(t, -1), q = pt(t, 1); grid.push(cx(p[0]), cy(p[1]), gr, gg, gb, cx(q[0]), cy(q[1]), gr, gg, gb); }
                for (const t of ticksN[o2]!) { const p = pt(-1, t), q = pt(1, t); grid.push(cx(p[0]), cy(p[1]), gr, gg, gb, cx(q[0]), cy(q[1]), gr, gg, gb); }
            }
        }

        // Box edges
        const border: V3 = [br, bg, bb];
        const bw = Math.max(1, style.borderWidth);
        for (let i = 0; i < 8; i++) for (let bit = 1; bit < 8; bit <<= 1) {
            if (i & bit) continue;
            const corner = (n: number): V3 => [n & 1 ? 1 : -1, n & 2 ? 1 : -1, n & 4 ? 1 : -1];
            thick(edges, proj(corner(i)), proj(corner(i | bit)), bw, border);
        }

        // Axis edges: x and y along the lowest edges on screen, z along the left-most vertical edge.
        const center = proj([0, 0, 0]);
        const text: number[] = [];
        const capH = fs * 0.75;
        const drawAxis = (k: number, a: number, b: number) => {
            const p0 = proj(at(k, -1, a, b)), p1 = proj(at(k, 1, a, b));
            const mid: [number, number] = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
            const dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy) || 1;
            let nx = -dy / len, ny = dx / len;
            if (nx * (mid[0] - center[0]) + ny * (mid[1] - center[1]) < 0) { nx = -nx; ny = -ny; }
            let maxExtent = 0;
            let last: [number, number] | null = null;
            this.tickVals[k]!.forEach((_, i) => {
                const p = proj(at(k, ticksN[k]![i]!, a, b));
                thick(front, p, [p[0] + nx * 5, p[1] + ny * 5], 1, border);
                const m = textMesh(this.tickText[k]![i]!, font, fs);
                const extent = 0.5 * (Math.abs(nx) * m.width + Math.abs(ny) * capH);
                maxExtent = Math.max(maxExtent, extent);
                const ctr: [number, number] = [p[0] + nx * (9 + extent), p[1] + ny * (9 + extent)];
                if (last && Math.hypot(ctr[0] - last[0], ctr[1] - last[1]) < Math.max(m.width, capH) + 6) return;
                last = ctr;
                pushText(text, m, ctr[0] - m.width / 2, ctr[1] + capH / 2, w, h, tr, tg, tb);
            });
            const name = k === 0 ? this.xlabelText : k === 1 ? this.ylabelText : this.zlabelText;
            if (name) {
                const m = textMesh(name, font, fs);
                const extent = 0.5 * (Math.abs(nx) * m.width + Math.abs(ny) * capH);
                const d = 16 + 2 * maxExtent + extent;
                pushText(text, m, mid[0] + nx * d - m.width / 2, mid[1] + ny * d + capH / 2, w, h, tr, tg, tb);
            }
        };
        for (const k of [0, 1]) {
            let best: [number, number] = [-1, -1], bestY = -Infinity;
            for (const a of [-1, 1]) for (const b of [-1, 1]) {
                const y = (proj(at(k, -1, a, b))[1] + proj(at(k, 1, a, b))[1]) / 2;
                if (y > bestY) { bestY = y; best = [a, b]; }
            }
            drawAxis(k, best[0], best[1]);
        }
        let zBest: [number, number] = [-1, -1], zX = Infinity;
        for (const a of [-1, 1]) for (const b of [-1, 1]) {
            const x = proj([a, b, 0])[0];
            if (x < zX) { zX = x; zBest = [a, b]; }
        }
        drawAxis(2, zBest[0], zBest[1]);

        if (this.titleText) {
            const m = textMesh(this.titleText, font, o.titleFontSize);
            pushText(text, m, (this.pL + this.pR) / 2 - m.width / 2, this.pT - 4 - o.paddingTitleToPlot, w, h, tr, tg, tb);
        }
        if (this.colorbarOn) this.buildColorbar(front, text, font, w, h, cx, cy, thick);

        dev.queue.onSubmittedWorkDone; // keeps the reference for lint; no-op
        dev.queue.onSubmittedWorkDone; // keeps the reference for lint; no-op
        this.decoBack.write(dev, back, 5);
        this.decoGrid.write(dev, grid, 5);
        this.decoEdges.write(dev, edges, 5);
        this.decoFront.write(dev, front.concat(text), 5);
    }

    private colorbarX0(w: number): number {
        const { r } = this.basis();
        const cxCenter = (this.pL + this.pR) / 2 + this.panX;
        return Math.min(cxCenter + this.pxPerUnit() * (Math.abs(r[0]) + Math.abs(r[1])) + 48, w - this.host.opts.paddingRight - 60);
    }

    private buildColorbar(
        front: number[], text: number[], font: NonNullable<FigureHost['font']>, w: number, h: number,
        cx: (v: number) => number, cy: (v: number) => number,
        thick: (out: number[], a: [number, number], b: [number, number], width: number, rgb: V3) => void,
    ): void {
        const o = this.host.opts, style = o.style, fs = o.fontSize;
        const cxCenter = (this.pL + this.pR) / 2 + this.panX;
        const x0 = this.colorbarX0(w), x1 = x0 + 14;
        const y0 = this.pT + 8, y1 = this.pB - 8;
        const [lo, hi] = this.cRange;
        const strips = 64;
        const col = [0, 0, 0], col2 = [0, 0, 0];
        for (let k = 0; k < strips; k++) {
            const ta = y0 + (y1 - y0) * k / strips, tb = y0 + (y1 - y0) * (k + 1) / strips;
            lookup(this.lut, hi - (hi - lo) * k / strips, lo, hi, col, 0);
            lookup(this.lut, hi - (hi - lo) * (k + 1) / strips, lo, hi, col2, 0);
            const v = (x: number, y: number, c: number[]) => front.push(cx(x), cy(y), c[0]!, c[1]!, c[2]!);
            v(x0, ta, col); v(x1, ta, col); v(x1, tb, col2);
            v(x0, ta, col); v(x1, tb, col2); v(x0, tb, col2);
        }
        const border: V3 = style.borderColor;
        const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        for (let i = 0; i < 4; i++) thick(front, corners[i]!, corners[(i + 1) % 4]!, 1, border);
        const [tr, tg, tb] = style.axisColor;
        const capH = fs * 0.75;
        this.cbTicks.values.forEach(v => {
            const y = y1 - (v - lo) / (hi - lo) * (y1 - y0);
            thick(front, [x1, y], [x1 + 4, y], 1, border);
            const m = textMesh(formatTick(v, this.cbTicks.step), font, fs);
            pushText(text, m, x1 + 8, y + capH / 2, w, h, tr, tg, tb);
        });
    }

    // =====================================================================
    // Drawing
    // =====================================================================

    private setCellViewport(pass: GPURenderPassEncoder, texW: number, texH: number): void {
        const s = this.host.texScale, c = this.cell;
        const vx = c.x * s, vy = c.y * s;
        pass.setViewport(vx, vy, Math.min(c.w * s, texW - vx), Math.min(c.h * s, texH - vy), 0, 1);
        const sx = Math.floor(vx), sy = Math.floor(vy);
        pass.setScissorRect(sx, sy, Math.min(texW, Math.ceil(vx + c.w * s)) - sx, Math.min(texH, Math.ceil(vy + c.h * s)) - sy);
    }

    /** Restricts drawing to the plot area, stopping short of the colorbar. */
    private clipToPlot(pass: GPURenderPassEncoder, texW: number, texH: number): void {
        const s = this.host.texScale, c = this.cell, m = 4;
        const right = this.colorbarOn ? Math.min(this.pR, this.colorbarX0(c.w) - 10) : this.pR;
        const x0 = Math.max(0, Math.floor((c.x + this.pL - m) * s)), y0 = Math.max(0, Math.floor((c.y + this.pT - m) * s));
        const x1 = Math.min(texW, Math.ceil((c.x + right + m) * s)), y1 = Math.min(texH, Math.ceil((c.y + this.pB + m) * s));
        pass.setScissorRect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
    }

    /** Pass 1 (no depth): background walls, grid, box and text. */
    override encodeDraw(pass: GPURenderPassEncoder, texW: number, texH: number): void {
        const gpu = this.host.gpu;
        if (!gpu) return;
        this.setCellViewport(pass, texW, texH);
        const draw = (pl: GPURenderPipeline, buf: GrowBuffer) => {
            if (!buf.buffer || buf.count === 0) return;
            pass.setPipeline(pl); pass.setVertexBuffer(0, buf.buffer); pass.draw(buf.count);
        };
        this.clipToPlot(pass, texW, texH);
        draw(gpu.textPipeline, this.decoBack);
        draw(gpu.linePipeline, this.decoGrid);
        draw(gpu.textPipeline, this.decoEdges);
        this.setCellViewport(pass, texW, texH);
        draw(gpu.textPipeline, this.decoFront);
    }

    /** Pass 2 (depth-tested): surfaces, lines and markers. */
    encodeDraw3D(pass: GPURenderPassEncoder, texW: number, texH: number): void {
        const gpu = this.host.gpu;
        if (!gpu || !this.binds || this.cell.w <= 0 || this.cell.h <= 0) return;
        this.setCellViewport(pass, texW, texH);
        this.clipToPlot(pass, texW, texH);
        const p = gpu.pipelines3d;
        if (this.bufTri.buffer && this.bufTri.count > 0) {
            pass.setPipeline(p.tri); pass.setBindGroup(0, this.binds.tri);
            pass.setVertexBuffer(0, this.bufTri.buffer); pass.draw(this.bufTri.count);
        }
        if (this.bufLine.buffer && this.bufLine.count > 0) {
            pass.setPipeline(p.line); pass.setBindGroup(0, this.binds.line);
            pass.setVertexBuffer(0, this.bufLine.buffer); pass.draw(6, this.bufLine.count);
        }
        if (this.bufMarker.buffer && this.bufMarker.count > 0) {
            pass.setPipeline(p.marker); pass.setBindGroup(0, this.binds.marker);
            pass.setVertexBuffer(0, this.bufMarker.buffer); pass.draw(6, this.bufMarker.count);
        }
    }
}

// ---------------------------------------------------------------------------
// Property helpers
// ---------------------------------------------------------------------------

function propertyPairs(fn: string, rest: readonly unknown[]): [string, unknown][] {
    if (rest.length === 1 && typeof rest[0] === 'object' && rest[0] !== null && !Array.isArray(rest[0])) {
        return Object.entries(rest[0] as Record<string, unknown>);
    }
    if (rest.length % 2 !== 0) throw new Error(`${fn}: properties must be name/value pairs`);
    const out: [string, unknown][] = [];
    for (let i = 0; i < rest.length; i += 2) {
        if (typeof rest[i] !== 'string') throw new Error(`${fn}: property names must be strings`);
        out.push([rest[i] as string, rest[i + 1]]);
    }
    return out;
}

const rgbOf = (v: unknown): RGB => parseColor(v as string | number[]).slice(0, 3) as RGB;

function faceColorOf(v: unknown): FaceColor {
    if (v === 'flat' || v === 'interp' || v === 'none') return v;
    return rgbOf(v);
}

function edgeColorOf(v: unknown): EdgeColor {
    if (v === 'none' || v === 'flat') return v;
    if (v === 'interp') return 'flat';
    return rgbOf(v);
}
