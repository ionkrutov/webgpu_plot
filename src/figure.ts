/// <reference types="@webgpu/types" />
import type { Font } from "opentype.js";
import { Axes } from "./axes.js";
import type { FigureHost } from "./axes.js";
import { Axes3D } from "./axes3d.js";
import { DEPTH_FORMAT } from "./gpu-3d.js";
import { injectStyles } from "./dom-styles.js";
import { loadFont } from "./font.js";
import type { FontSource } from "./font.js";
import { pushText, textMesh } from "./font-utils.js";
import { GpuContext, MSAA_SAMPLES } from "./gpu-context.js";
import { enumerateAdapters, GrowBuffer } from "./gpu-utils.js";
import type { AdapterOption } from "./gpu-utils.js";
import { slotFromIndex, slotsEqual, slotsOverlap, solveLayout } from "./layout.js";
import type { GridSlot } from "./layout.js";
import { buildSimplePdf } from "./pdf.js";
import type { PlotSeries, FigureOptions, ResolvedOptions } from "./styles.js";
import type { Line } from "./line.js";

type Mode = 'pan' | 'zoomRegion' | 'inspect';
export type ExportFormat = 'png' | 'jpeg' | 'pdf';

const ICONS = {
    home: `<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
        <polyline points="2,9 9,2.5 16,9"/><polyline points="4,8 4,15.5 14,15.5 14,8"/><polyline points="7.5,15.5 7.5,11 10.5,11 10.5,15.5"/></svg>`,
    zoomRegion: `<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="1" y="1" width="12" height="12" stroke-dasharray="3 2"/>
        <line x1="11" y1="11" x2="17" y2="17"/>
        <line x1="14" y1="17" x2="17" y2="17"/><line x1="17" y1="14" x2="17" y2="17"/></svg>`,
    inspect: `<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8">
        <circle cx="9" cy="9" r="4"/>
        <line x1="9" y1="1" x2="9" y2="5"/><line x1="9" y1="13" x2="9" y2="17"/>
        <line x1="1" y1="9" x2="5" y2="9"/><line x1="13" y1="9" x2="17" y2="9"/></svg>`,
    save: `<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="9" y1="2" x2="9" y2="12"/><polyline points="5,8 9,13 13,8"/><line x1="2" y1="16" x2="16" y2="16"/></svg>`,
};

function cssLength(v: number | string): string { return typeof v === 'number' ? `${v}px` : v; }

/**
 * A figure window: one WebGPU canvas hosting one or more Axes laid out on a grid.
 * Create with Plotter.figure() or the MATLAB-style figure() function.
 */
export class Figure implements FigureHost {
    readonly windowEl: HTMLDivElement;
    readonly canvas: HTMLCanvasElement;
    /** Resolves when the GPU is initialised; rejects if WebGPU is unavailable. */
    readonly ready: Promise<void>;

    readonly opts: ResolvedOptions;
    font: Font | null = null;
    gpu: GpuContext | null = null;
    texScale = 2;

    private readonly container: HTMLDivElement;
    private readonly zoomRectEl: HTMLDivElement;
    private readonly crosshairV: HTMLDivElement;
    private readonly crosshairH: HTMLDivElement;
    private readonly tooltip: HTMLDivElement;
    private readonly titleLabel: HTMLSpanElement | null = null;
    private readonly gpuSelect: HTMLSelectElement | null = null;
    private readonly btnZoomRegion: HTMLButtonElement | null = null;
    private readonly btnInspect: HTMLButtonElement | null = null;

    private readonly fontSource: FontSource;
    private readonly abort = new AbortController();
    private readonly resizeObserver: ResizeObserver;
    private readonly suptitleBuf = new GrowBuffer('suptitle');
    private canvasCtx: GPUCanvasContext | null = null;
    private adapters: AdapterOption[] = [];
    private currentAdapter: AdapterOption | null = null;
    private unsubLost: (() => void) | null = null;
    private target: { tex: GPUTexture; msaa: GPUTexture; depth: GPUTexture | null; bind: GPUBindGroup; w: number; h: number } | null = null;

    private _axes: Axes[] = [];
    private current: Axes | null = null;
    private active: Axes | null = null;
    private tile: { rows: number; cols: number; next: number } | null = null;
    private suptitle = '';

    private mode: Mode = 'pan';
    private panDrag: { ax: Axes; snap: ReturnType<Axes['getView']>; x: number; y: number; pan: boolean } | null = null;
    private zoomDrag: { ax: Axes; x: number; y: number } | null = null;

    private rafId = 0;
    private destroyed = false;

    constructor(
        opts: ResolvedOptions, fontSource: FontSource,
        figOpts: FigureOptions = {}, container?: HTMLElement | string,
    ) {
        injectStyles();
        this.opts = opts;
        this.fontSource = fontSource;

        const toolbar = figOpts.toolbar ?? true;
        this.windowEl = document.createElement('div');
        this.windowEl.className = toolbar ? 'wgp-window' : 'wgp-window wgp-embedded';
        const width = figOpts.width ?? (toolbar ? undefined : '100%');
        const height = figOpts.height ?? (toolbar ? undefined : '100%');
        if (width !== undefined) this.windowEl.style.width = cssLength(width);
        if (height !== undefined) this.windowEl.style.height = cssLength(height);

        this.container = document.createElement('div');
        this.container.className = 'wgp-canvas-container';
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'wgp-canvas';
        this.canvas.style.touchAction = 'none';
        this.canvas.style.cursor = 'grab';
        this.zoomRectEl = this.div('wgp-zoom-rect');
        this.crosshairV = this.div('wgp-crosshair-v');
        this.crosshairH = this.div('wgp-crosshair-h');
        this.tooltip = this.div('wgp-tooltip');
        this.container.append(this.canvas, this.zoomRectEl, this.crosshairV, this.crosshairH, this.tooltip);

        if (toolbar) {
            const header = document.createElement('div');
            header.className = 'wgp-header';
            this.titleLabel = document.createElement('span');
            this.titleLabel.className = 'wgp-title';
            this.titleLabel.textContent = figOpts.name ?? figOpts.title ?? '';

            const bar = document.createElement('div');
            bar.className = 'wgp-toolbar';
            const mkBtn = (title: string, html: string, onClick: () => void): HTMLButtonElement => {
                const b = document.createElement('button');
                b.className = 'wgp-btn'; b.type = 'button'; b.title = title; b.innerHTML = html;
                b.addEventListener('click', onClick, { signal: this.abort.signal });
                return b;
            };
            const target = () => this.targetAxes();
            const btnIn  = mkBtn('Zoom In', '+', () => target()?.zoomCentered(1 / 1.5));
            const btnOut = mkBtn('Zoom Out', '&#8722;', () => target()?.zoomCentered(1.5));
            this.btnZoomRegion = mkBtn('Zoom Region', ICONS.zoomRegion, () => this.setMode(this.mode === 'zoomRegion' ? 'pan' : 'zoomRegion'));
            const btnHome = mkBtn('Reset View', ICONS.home, () => { for (const a of this._axes) a.resetView(); });
            this.btnInspect = mkBtn('Inspect Values', ICONS.inspect, () => this.setMode(this.mode === 'inspect' ? 'pan' : 'inspect'));

            this.gpuSelect = document.createElement('select');
            this.gpuSelect.className = 'wgp-select';
            this.gpuSelect.title = 'GPU Adapter';
            this.gpuSelect.addEventListener('change', () => {
                const opt = this.adapters[parseInt(this.gpuSelect!.value, 10)];
                if (opt) this.useAdapter(opt).catch(e => this.showError(e));
            }, { signal: this.abort.signal });

            const save = document.createElement('div');
            save.className = 'wgp-save';
            const menu = document.createElement('div');
            menu.className = 'wgp-save-menu';
            for (const fmt of ['png', 'jpeg', 'pdf'] as const) {
                const item = document.createElement('button');
                item.className = 'wgp-save-item'; item.type = 'button'; item.textContent = fmt.toUpperCase();
                item.addEventListener('click', e => {
                    e.stopPropagation();
                    menu.classList.remove('wgp-open');
                    this.download(fmt).catch(err => console.error(err));
                }, { signal: this.abort.signal });
                menu.appendChild(item);
            }
            const btnSave = mkBtn('Save as Image', ICONS.save, () => menu.classList.toggle('wgp-open'));
            btnSave.addEventListener('click', e => e.stopPropagation(), { signal: this.abort.signal });
            window.addEventListener('click', () => menu.classList.remove('wgp-open'), { signal: this.abort.signal });
            save.append(btnSave, menu);

            bar.append(btnIn, btnOut, this.btnZoomRegion, btnHome, this.btnInspect, save, this.gpuSelect);
            header.append(this.titleLabel, bar);
            this.windowEl.append(header);
        }
        this.windowEl.append(this.container);

        this.bindPointerEvents();
        this.resizeObserver = new ResizeObserver(() => this.requestRender());
        this.resizeObserver.observe(this.container);

        const host = typeof container === 'string' ? document.querySelector(container) : container ?? document.body;
        if (!host) throw new Error(`Figure: container "${String(container)}" not found`);
        host.appendChild(this.windowEl);

        if (figOpts.title || figOpts.xlabel || figOpts.ylabel) {
            const ax = this.gca();
            if (figOpts.title)  ax.title(figOpts.title);
            if (figOpts.xlabel) ax.xlabel(figOpts.xlabel);
            if (figOpts.ylabel) ax.ylabel(figOpts.ylabel);
        }

        this.ready = this.init();
        this.ready.catch(e => this.showError(e));
    }

    private div(cls: string): HTMLDivElement {
        const d = document.createElement('div');
        d.className = cls;
        return d;
    }

    // =====================================================================
    // Axes management
    // =====================================================================

    get axes(): readonly Axes[] { return this._axes; }

    /** Current axes; creates a 1×1 subplot when the figure is empty. */
    gca(): Axes { return this.current ?? this.subplot(1, 1, 1); }

    /**
     * MATLAB subplot(m, n, p): selects (creating if needed) the p-th cell of an m×n grid.
     * `p` may be an array of indices; the axes then spans their bounding box.
     * Axes that overlap the new one are removed.
     */
    subplot(rows: number, cols: number, p: number | readonly number[]): Axes {
        const slot = slotFromIndex(rows, cols, p);
        const same = this._axes.find(a => slotsEqual(a.slot, slot));
        if (same) { same.slot = slot; this.current = same; return same; }
        for (const a of this._axes.filter(a => slotsOverlap(a.slot, slot))) this.removeAxes(a);
        return this.addAxes(slot);
    }

    /** Starts an m×n tiled layout (removes existing axes); fill it with nexttile(). */
    tiledlayout(rows: number, cols: number): this {
        slotFromIndex(rows, cols, 1);
        this.clf();
        this.tile = { rows, cols, next: 0 };
        return this;
    }

    /** Next free tile of the current tiledlayout (or an explicit 1-based index). */
    nexttile(p?: number | readonly number[]): Axes {
        const t = this.tile;
        if (!t) throw new Error('nexttile: call tiledlayout(rows, cols) first');
        if (p === undefined) {
            if (t.next >= t.rows * t.cols) throw new Error('nexttile: the layout is full');
            p = ++t.next;
        }
        return this.subplot(t.rows, t.cols, p);
    }

    private addAxes(slot: GridSlot): Axes { return this.attach(new Axes(this, slot)); }

    private attach<T extends Axes>(ax: T): T {
        this._axes.push(ax);
        this.current = ax;
        this.requestRender();
        return ax;
    }

    private swap<T extends Axes>(old: Axes, next: T): T {
        this.removeAxes(old);
        return this.attach(next);
    }

    /** Current axes as 3-D axes; empty 2-D axes (or 2-D axes without hold) are replaced in place. */
    gca3(): Axes3D {
        const cur = this.current;
        if (cur instanceof Axes3D) return cur;
        if (!cur) return this.attach(new Axes3D(this, slotFromIndex(1, 1, 1)));
        if (cur.holding && cur.lines.length > 0) {
            throw new Error('Cannot add a 3-D plot to 2-D axes with hold on; use subplot() for new axes');
        }
        return this.swap(cur, new Axes3D(this, cur.slot));
    }

    /** Current axes for 2-D plotting; 3-D axes without hold are replaced in place, as in MATLAB. */
    gca2d(): Axes {
        const cur = this.gca();
        if (!(cur instanceof Axes3D)) return cur;
        if (cur.holding) throw new Error('Cannot plot 2-D data into 3-D axes with hold on; use subplot() for new axes');
        return this.swap(cur, new Axes(this, cur.slot));
    }

    private removeAxes(ax: Axes): void {
        ax.unlink();
        ax.releaseGpu();
        this._axes = this._axes.filter(a => a !== ax);
        if (this.current === ax) this.current = this._axes[this._axes.length - 1] ?? null;
        if (this.active === ax) this.active = null;
        this.requestRender();
    }

    /** Removes all axes and the figure title. */
    clf(): this {
        for (const a of [...this._axes]) this.removeAxes(a);
        this.suptitle = '';
        this.tile = null;
        this.requestRender();
        return this;
    }

    /** Title above all axes. */
    sgtitle(text: string): this { this.suptitle = text; this.requestRender(); return this; }

    /** Synchronises pan/zoom of several axes ('x', 'y' or 'xy'). */
    linkaxes(axes: readonly Axes[], dim: 'x' | 'y' | 'xy' = 'xy'): this { Axes.link(axes, dim); return this; }

    // Shortcuts that act on the current axes
    plot(...args: unknown[]): Line[]            { return this.gca2d().plot(...args); }
    hold(state?: Parameters<Axes['hold']>[0]): this { this.gca().hold(state); return this; }
    title(text: string): this                   { this.gca().title(text); return this; }
    xlabel(text: string): this                  { this.gca().xlabel(text); return this; }
    ylabel(text: string): this                  { this.gca().ylabel(text); return this; }
    legend(...a: Parameters<Axes['legend']>): this { this.gca().legend(...a); return this; }
    grid(state?: Parameters<Axes['grid']>[0]): this { this.gca().grid(state); return this; }
    axis(mode: Parameters<Axes['axis']>[0]): this   { this.gca().axis(mode); return this; }

    /** Replaces the content of the current axes with the given series. */
    setData(series: PlotSeries[]): void { this.gca2d().hold(false).plot(series); }

    private targetAxes(): Axes | null { return this.active ?? this.current ?? this._axes[0] ?? null; }

    // =====================================================================
    // GPU lifecycle
    // =====================================================================

    private async init(): Promise<void> {
        if (!navigator.gpu) throw new Error('WebGPU is not supported in this browser');
        const [font, adapters] = await Promise.all([loadFont(this.fontSource), enumerateAdapters()]);
        if (this.destroyed) return;
        this.font = font;
        this.adapters = adapters;
        if (adapters.length === 0) throw new Error('No GPUAdapter found');

        this.canvasCtx = this.canvas.getContext('webgpu');
        if (!this.canvasCtx) throw new Error('Could not obtain a WebGPU canvas context');

        if (this.gpuSelect) {
            adapters.forEach((a, i) => {
                const o = document.createElement('option');
                o.value = String(i); o.textContent = a.label;
                this.gpuSelect!.appendChild(o);
            });
            this.gpuSelect.disabled = adapters.length <= 1;
        }
        await this.useAdapter(adapters[0]!);
    }

    private async useAdapter(option: AdapterOption): Promise<void> {
        const ctx = await GpuContext.acquire(option);
        if (this.destroyed || !this.canvasCtx) { ctx.release(); return; }

        const old = this.gpu;
        for (const a of this._axes) a.releaseGpu();
        this.suptitleBuf.destroy();
        this.dropTarget();
        this.unsubLost?.();

        this.gpu = ctx;
        this.currentAdapter = option;
        this.unsubLost = ctx.onLost(() => this.onDeviceLost());
        this.canvasCtx.configure({ device: ctx.device, format: ctx.format, alphaMode: 'opaque' });
        old?.release();
        this.requestRender();
    }

    private onDeviceLost(): void {
        if (this.destroyed || !this.currentAdapter) return;
        this.gpu = null;
        this.dropTarget();
        for (const a of this._axes) a.releaseGpu();
        this.useAdapter(this.currentAdapter).catch(e => this.showError(e));
    }

    private dropTarget(): void {
        this.target?.tex.destroy();
        this.target?.msaa.destroy();
        this.target?.depth?.destroy();
        this.target = null;
    }

    private showError(e: unknown): void {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(e);
        let box = this.container.querySelector('.wgp-error');
        if (!box) { box = this.div('wgp-error'); this.container.appendChild(box); }
        box.textContent = msg;
    }

    // =====================================================================
    // Rendering
    // =====================================================================

    /** Schedules a render on the next animation frame (coalesces multiple calls). */
    requestRender(): void {
        if (this.destroyed || this.rafId) return;
        this.rafId = requestAnimationFrame(() => { this.rafId = 0; this.render(); });
    }

    /** @deprecated use requestRender() */
    scheduleRender(): void { this.requestRender(); }

    render(): void {
        const gpu = this.gpu, font = this.font, ctx = this.canvasCtx;
        if (this.destroyed || !gpu || !font || !ctx) return;
        const cw = this.container.clientWidth, ch = this.container.clientHeight;
        if (cw === 0 || ch === 0) return;
        const dev = gpu.device;
        const o = this.opts, style = o.style;

        const dpr = window.devicePixelRatio || 1;
        this.texScale = Math.max(2, dpr);
        const pw = Math.max(1, Math.round(cw * dpr)), ph = Math.max(1, Math.round(ch * dpr));
        if (this.canvas.width !== pw || this.canvas.height !== ph) { this.canvas.width = pw; this.canvas.height = ph; }
        const tw = Math.max(1, Math.round(cw * this.texScale)), th = Math.max(1, Math.round(ch * this.texScale));
        const target = this.ensureTarget(gpu, tw, th);

        // Layout: measure every axes, then align panels on the grid
        const [cr, cg, cb] = style.axisColor;
        const topMargin = this.suptitle ? o.titleFontSize * 0.75 + 16 : 0;
        for (const a of this._axes) a.updateTicks();
        const placed = solveLayout(
            { x: 0, y: topMargin, w: cw, h: Math.max(0, ch - topMargin) },
            this._axes.map(a => ({ slot: a.slot, insets: a.insets() })),
        );
        this._axes.forEach((a, i) => a.applyLayout(placed[i]!.cell, placed[i]!.plot));
        for (const a of this._axes) a.prepare();

        const suptitle: number[] = [];
        if (this.suptitle) {
            const m = textMesh(this.suptitle, font, o.titleFontSize);
            pushText(suptitle, m, (cw - m.width) / 2, 8 + o.titleFontSize * 0.75, cw, ch, cr, cg, cb);
        }
        this.suptitleBuf.write(dev, suptitle, 5);

        const enc = dev.createCommandEncoder();
        const cp = enc.beginComputePass();
        for (const a of this._axes) a.encodeCompute(cp);
        cp.end();

        const [fr, fg, fb] = style.background.figureColor;
        const threeD = this._axes.filter((a): a is Axes3D => a instanceof Axes3D);
        const color: GPURenderPassColorAttachment = {
            view: target.msaa.createView(), loadOp: 'clear', storeOp: threeD.length > 0 ? 'store' : 'discard',
            clearValue: { r: fr, g: fg, b: fb, a: 1 },
        };
        if (threeD.length === 0) color.resolveTarget = target.tex.createView();
        const rp = enc.beginRenderPass({ colorAttachments: [color] });
        for (const a of this._axes) a.encodeDraw(rp, tw, th);
        if (this.suptitleBuf.buffer && this.suptitleBuf.count > 0) {
            rp.setViewport(0, 0, tw, th, 0, 1);
            rp.setScissorRect(0, 0, tw, th);
            rp.setPipeline(gpu.textPipeline);
            rp.setVertexBuffer(0, this.suptitleBuf.buffer);
            rp.draw(this.suptitleBuf.count);
        }
        rp.end();

        if (threeD.length > 0) {
            target.depth ??= dev.createTexture({
                size: [tw, th], format: DEPTH_FORMAT, sampleCount: MSAA_SAMPLES,
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });
            const rp3 = enc.beginRenderPass({
                colorAttachments: [{
                    view: target.msaa.createView(), resolveTarget: target.tex.createView(), loadOp: 'load', storeOp: 'discard',
                }],
                depthStencilAttachment: {
                    view: target.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard',
                },
            });
            for (const a of threeD) a.encodeDraw3D(rp3, tw, th);
            rp3.end();
        }

        const blit = enc.beginRenderPass({
            colorAttachments: [{
                view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
            }],
        });
        blit.setPipeline(gpu.blitPipeline);
        blit.setBindGroup(0, target.bind);
        blit.draw(6);
        blit.end();

        dev.queue.submit([enc.finish()]);
    }

    private ensureTarget(gpu: GpuContext, w: number, h: number) {
        if (this.target && this.target.w === w && this.target.h === h) return this.target;
        this.dropTarget();
        const tex = gpu.device.createTexture({
            size: [w, h], format: gpu.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        const msaa = gpu.device.createTexture({
            size: [w, h], format: gpu.format, sampleCount: MSAA_SAMPLES,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        const bind = gpu.device.createBindGroup({
            layout: gpu.blitPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: gpu.sampler },
                { binding: 1, resource: tex.createView() },
            ],
        });
        return (this.target = { tex, msaa, depth: null, bind, w, h });
    }

    // =====================================================================
    // Pointer interaction
    // =====================================================================

    private setMode(mode: Mode): void {
        this.mode = mode;
        this.btnZoomRegion?.classList.toggle('wgp-active', mode === 'zoomRegion');
        this.btnInspect?.classList.toggle('wgp-active', mode === 'inspect');
        this.hideInspector();
        this.canvas.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
    }

    private axesAt(x: number, y: number): Axes | null {
        for (let i = this._axes.length - 1; i >= 0; i--) if (this._axes[i]!.containsPx(x, y)) return this._axes[i]!;
        return null;
    }

    private bindPointerEvents(): void {
        const signal = this.abort.signal;
        const pos = (e: MouseEvent) => {
            const r = this.canvas.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
        };
        const clampToPlot = (ax: Axes, x: number, y: number) => {
            const r = ax.plotRectPx();
            return { x: Math.min(Math.max(x, r.x), r.x + r.w), y: Math.min(Math.max(y, r.y), r.y + r.h) };
        };

        this.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            const p = pos(e), ax = this.axesAt(p.x, p.y);
            if (!ax) return;
            this.active = ax;
            const d = ax.pxToData(p.x, p.y);
            ax.zoomAround(d.x, d.y, e.deltaY > 0 ? 1.15 : 1 / 1.15);
        }, { passive: false, signal });

        this.canvas.addEventListener('contextmenu', e => {
            const p = pos(e);
            if (this.axesAt(p.x, p.y) instanceof Axes3D) e.preventDefault();
        }, { signal });

        this.canvas.addEventListener('pointerdown', e => {
            if (e.button !== 0 && e.button !== 2) return;
            const p = pos(e), ax = this.axesAt(p.x, p.y);
            if (!ax || (e.button === 2 && !(ax instanceof Axes3D))) return;
            e.preventDefault();
            this.active = ax;
            if (this.mode === 'zoomRegion' && !(ax instanceof Axes3D)) {
                const s = clampToPlot(ax, p.x, p.y);
                this.zoomDrag = { ax, x: s.x, y: s.y };
                Object.assign(this.zoomRectEl.style, { left: `${s.x}px`, top: `${s.y}px`, width: '0px', height: '0px', display: 'block' });
            } else if (this.mode === 'pan' || ax instanceof Axes3D) {
                this.panDrag = { ax, snap: ax.getView(), x: p.x, y: p.y, pan: e.shiftKey || e.button === 2 };
                this.canvas.style.cursor = 'grabbing';
            } else {
                return;
            }
            this.canvas.setPointerCapture(e.pointerId);
        }, { signal });

        this.canvas.addEventListener('pointermove', e => {
            const p = pos(e);
            if (this.zoomDrag) {
                const q = clampToPlot(this.zoomDrag.ax, p.x, p.y);
                Object.assign(this.zoomRectEl.style, {
                    left: `${Math.min(this.zoomDrag.x, q.x)}px`, top: `${Math.min(this.zoomDrag.y, q.y)}px`,
                    width: `${Math.abs(q.x - this.zoomDrag.x)}px`, height: `${Math.abs(q.y - this.zoomDrag.y)}px`,
                });
            } else if (this.panDrag) {
                const { ax, snap, x, y, pan } = this.panDrag;
                if (ax instanceof Axes3D) ax.dragFrom(snap, p.x - x, p.y - y, pan);
                else ax.panFrom(snap, p.x - x, p.y - y);
            } else {
                const ax = this.axesAt(p.x, p.y);
                if (ax) this.active = ax;
                if (this.mode === 'inspect') { if (ax) this.updateInspector(ax, p.x, p.y); else this.hideInspector(); }
            }
        }, { signal });

        const finish = (e: PointerEvent) => {
            if (this.zoomDrag) {
                const { ax, x, y } = this.zoomDrag;
                this.zoomDrag = null;
                this.zoomRectEl.style.display = 'none';
                const q = clampToPlot(ax, pos(e).x, pos(e).y);
                if (Math.abs(q.x - x) > 5 && Math.abs(q.y - y) > 5) ax.zoomToPx(x, y, q.x, q.y);
            }
            if (this.panDrag) {
                this.panDrag = null;
                this.canvas.style.cursor = 'grab';
            }
            if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
        };
        this.canvas.addEventListener('pointerup', finish, { signal });
        this.canvas.addEventListener('pointercancel', finish, { signal });
        this.canvas.addEventListener('pointerleave', () => { if (!this.panDrag && !this.zoomDrag) this.hideInspector(); }, { signal });
        this.canvas.addEventListener('dblclick', e => {
            const p = pos(e);
            this.axesAt(p.x, p.y)?.resetView();
        }, { signal });
    }

    private hideInspector(): void {
        this.crosshairV.style.display = 'none';
        this.crosshairH.style.display = 'none';
        this.tooltip.style.display = 'none';
    }

    private updateInspector(ax: Axes, mx: number, my: number): void {
        const hit = ax.nearest(mx, my);
        if (!hit) { this.hideInspector(); return; }
        const c = ax.plotRectPx();
        Object.assign(this.crosshairV.style, { display: 'block', left: `${hit.x}px`, top: `${c.y}px`, height: `${c.h}px` });
        Object.assign(this.crosshairH.style, { display: 'block', top: `${hit.y}px`, left: `${c.x}px`, width: `${c.w}px` });

        const tip = this.tooltip;
        tip.textContent = hit.text;
        tip.style.display = 'block';
        let tx = mx + 14, ty = my - tip.offsetHeight - 6;
        if (tx + tip.offsetWidth > this.container.clientWidth - 4) tx = mx - tip.offsetWidth - 14;
        if (ty < 4) ty = my + 14;
        tip.style.left = `${Math.max(4, tx)}px`;
        tip.style.top = `${ty}px`;
    }

    // =====================================================================
    // Export
    // =====================================================================

    /** Renders the figure and returns it as an image Blob. */
    async toBlob(type: 'image/png' | 'image/jpeg' = 'image/png', quality = 0.92): Promise<Blob> {
        await this.ready;
        this.render();
        const off = document.createElement('canvas');
        off.width = this.canvas.width; off.height = this.canvas.height;
        // The WebGPU canvas must be read in the same task as the render that filled it.
        off.getContext('2d')!.drawImage(this.canvas, 0, 0);
        return new Promise((res, rej) => off.toBlob(b => b ? res(b) : rej(new Error('Image export failed')), type, quality));
    }

    /** Saves the figure as PNG, JPEG or PDF through a browser download. */
    async download(format: ExportFormat = 'png', filename?: string): Promise<void> {
        let blob: Blob, ext: string;
        if (format === 'pdf') {
            const jpeg = new Uint8Array(await (await this.toBlob('image/jpeg')).arrayBuffer());
            blob = buildSimplePdf(jpeg, this.canvas.width, this.canvas.height);
            ext = 'pdf';
        } else {
            blob = await this.toBlob(format === 'png' ? 'image/png' : 'image/jpeg');
            ext = format === 'png' ? 'png' : 'jpg';
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename ?? `${this.titleLabel?.textContent || 'plot'}.${ext}`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    // =====================================================================
    // Teardown
    // =====================================================================

    get isDestroyed(): boolean { return this.destroyed; }

    /** Removes the figure from the DOM and frees all GPU resources and listeners. */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.abort.abort();
        this.resizeObserver.disconnect();
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.unsubLost?.();
        for (const a of this._axes) { a.unlink(); a.releaseGpu(); }
        this._axes = []; this.current = null; this.active = null;
        this.suptitleBuf.destroy();
        this.dropTarget();
        this.canvasCtx?.unconfigure();
        this.gpu?.release();
        this.gpu = null;
        this.windowEl.remove();
    }
}
