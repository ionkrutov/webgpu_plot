/// <reference types="@webgpu/types" />
/// <reference types="opentype.js" />
import * as opentype from "opentype.js";

import {
    blitShaderCode, shaderCode, seriesLineShaderCode,
    computeShaderCode, markerComputeShaderCode, markerShaderCode,
    dashedComputeShaderCode,
} from "./shaders.js";
import {
    glyphToLineSegments, glyphToTriangles, textWidthClip, textToTriVerts,
} from "./font-utils.js";
import {
    niceTicks,
    getInteriorTicks, getTickStep, ticksFromStep,
    categoricalTicks, getDateTickStep, dateTicksFromStep,
    formatTick, formatDateTick,
} from "./ticks.js";
export type { AdapterOption } from "./gpu-utils.js";
export { enumerateAdapters } from "./gpu-utils.js";
export { GridStyle, BackgroundStyle, MarkerStyle, PlotStyle, matlabStyle } from "./styles.js";
export type { MarkerShape, PlotterOptions, FigureOptions, PlotSeries } from "./styles.js";
import type {
    GridStyle, BackgroundStyle, MarkerStyle, MarkerShape,
    PlotStyle, PlotterOptions, FigureOptions, PlotSeries,
} from "./styles.js";
import { matlabStyle } from "./styles.js";
import type { AdapterOption } from "./gpu-utils.js";
import { enumerateAdapters } from "./gpu-utils.js";

/** Normalized series: strings→index, Date→ms. Always numeric x/y. */
interface InternalSeries {
    x: number[];
    y: number[];
    xSorted: boolean;
    color?: [number, number, number, number?];
    lineStyle?: '-' | '--' | ':' | '-.' | 'none';
    lineWidth?: number;
    marker?: MarkerStyle;
}

// ---------------------------------------------------------------------------
// Dash-pattern rendering helper
// ---------------------------------------------------------------------------

/** Pixel-length patterns for each line style: [on, off, ...] */
const DASH_PATTERNS: Record<string, number[]> = {
    '-':  [],
    '--': [8, 8],
    ':':  [2, 4],
    '-.': [8, 4, 4, 6],
};


export class Figure {
    // DOM
    readonly windowEl: HTMLDivElement;
    readonly canvas: HTMLCanvasElement;
    private readonly zoomRectEl: HTMLDivElement;
    private readonly titleLabelEl: HTMLSpanElement;
    private readonly gpuSelectEl: HTMLSelectElement;
    private readonly btnZoomRegion: HTMLButtonElement;
    private readonly btnInspect: HTMLButtonElement;
    private readonly tooltipEl: HTMLDivElement;
    private readonly crosshairVEl: HTMLDivElement;
    private readonly crosshairHEl: HTMLDivElement;

    // Config
    private readonly opts: Required<PlotterOptions>;
    private figureOpts: Required<FigureOptions>;
    private seriesList: PlotSeries[] = [];
    private internalSeries: InternalSeries[] = [];
    private xLabels: string[] | null = null;
    private yLabels: string[] | null = null;
    private xIsDate = false;
    private yIsDate = false;

    // GPU
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private canvasFormat!: GPUTextureFormat;
    private linePipeline!: GPURenderPipeline;
    private textPipeline!: GPURenderPipeline;
    private titlePipeline!: GPURenderPipeline;
    private seriesLinePipeline!: GPURenderPipeline;  // series lines/dashed: triangle-list + alpha blend
    private blitPipeline!: GPURenderPipeline;
    private blitSampler!: GPUSampler;
    private computePipeline!: GPUComputePipeline;
    private adapterOptions: AdapterOption[] = [];

    // Per-series GPU buffers for compute path (solid lines only).
    // Allocated once in uploadSeriesGpuBuffers(); reused across frames.
    //   seriesRawBufs[i]   — raw x/y float32 pairs, STORAGE (uploaded once, shared with marker compute)
    //   seriesOutBufs[i]   — quad verts output, STORAGE | VERTEX (MAX_SEGS * 36 * 4 bytes)
    //   seriesParamBufs[i] — 80-byte SeriesParams uniform, updated per frame via writeBuffer
    //   seriesOutCounts[i] — vertex count to draw this frame (numDispatched * 6)
    private readonly MAX_COMPUTE_SEGS = 50_000;
    private seriesRawBufs:   GPUBuffer[] = [];
    private seriesOutBufs:   (GPUBuffer | null)[] = [];
    private seriesParamBufs: (GPUBuffer | null)[] = [];
    private seriesOutCounts: number[]    = [];

    // Per-series GPU buffers for marker compute path.
    //   markerOutBufs[i]   — SDF quad verts, STORAGE | VERTEX (MAX_MARKERS * 6 * 15 * 4 bytes)
    //   markerParamBufs[i] — 112-byte MarkerParams uniform, updated per frame
    //   markerOutCounts[i] — vertex count to draw (numMarkers * 6)
    // Only allocated for series that have a marker; null otherwise.
    private readonly MAX_MARKER_COUNT = 50_000;
    private markerComputePipeline!: GPUComputePipeline;
    private markerRenderPipeline!:  GPURenderPipeline;
    private markerOutBufs:   (GPUBuffer | null)[] = [];
    private markerParamBufs: (GPUBuffer | null)[] = [];
    private markerOutCounts: number[]              = [];

    // Per-series GPU buffers for dashed-line compute path.
    //   dashedOutBufs[i]      — output quads, STORAGE | VERTEX (MAX_DASHED_OUT_QUADS * 36 * 4 bytes)
    //   dashedParamBufs[i]    — 128-byte DashedParams uniform, updated per frame
    //   dashedDrawArgsBufs[i] — 16-byte indirect draw args, written by compute shader
    //   dashedNumSegs[i]      — number of segments dispatched this frame
    // Only allocated for series that have a non-empty dash pattern; null otherwise.
    private readonly MAX_DASHED_OUT_QUADS = 200_000;
    private dashedComputePipeline!:  GPUComputePipeline;
    private dashedOutBufs:      (GPUBuffer | null)[] = [];
    private dashedParamBufs:    (GPUBuffer | null)[] = [];
    private dashedDrawArgsBufs: (GPUBuffer | null)[] = [];
    private dashedNumSegs:      number[]              = [];

    // Font
    private font!: opentype.Font;

    // View state
    private viewXMin = 0; private viewXMax = 1;
    private viewYMin = 0; private viewYMax = 1;
    private defaultViewXMin = 0; private defaultViewXMax = 1;
    private defaultViewYMin = 0; private defaultViewYMax = 1;
    // Minimum spacing between adjacent data points in data-space coordinates.
    // Used as the hard zoom-in limit so you can never zoom between two points.
    private minDataSpanX = 0;
    private minDataSpanY = 0;

    // Interaction state
    private plotMode: 'pan' | 'zoomRegion' | 'inspect' = 'pan';
    private isDragging = false;
    private dragStartX = 0; private dragStartY = 0;
    private dragViewXMin = 0; private dragViewXMax = 0;
    private dragViewYMin = 0; private dragViewYMax = 0;
    private zbDragging = false;
    private zbStartClientX = 0; private zbStartClientY = 0;

    // Cached plot rect in clip space (updated on render)
    private plotRectX0 = -0.75; private plotRectY0 = -0.78;
    private plotRectX1 =  0.90; private plotRectY1 =  0.78;

    // Cached tick steps — only recomputed when the view span (zoom) changes, not on pan
    private xTickStep = 1; private yTickStep = 1;
    private lastXSpan = -1; private lastYSpan = -1;

    private readonly ssaaScale = 2;
    private rafPending = false;

    constructor(opts: Required<PlotterOptions>, figOpts: Required<FigureOptions>) {
        this.opts = opts;
        this.figureOpts = figOpts;

        // ---- Build DOM ----
        this.windowEl = document.createElement('div');
        this.windowEl.className = 'plot_window';

        // Header
        const header = document.createElement('div');
        header.className = 'plot_header';

        this.titleLabelEl = document.createElement('span');
        this.titleLabelEl.className = 'plot_title_label';
        this.titleLabelEl.textContent = figOpts.title;

        const toolbar = document.createElement('div');
        toolbar.className = 'plot_toolbar';

        const mkBtn = (id: string, title: string, inner: string): HTMLButtonElement => {
            const b = document.createElement('button');
            b.className = 'plot-btn';
            b.id = id;
            b.title = title;
            b.innerHTML = inner;
            return b;
        };

        const btnZoomIn  = mkBtn('', 'Zoom In',    '+');
        const btnZoomOut = mkBtn('', 'Zoom Out',   '&#8722;');
        this.btnZoomRegion = mkBtn('', 'Zoom Region',
            `<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="1" y="1" width="12" height="12" stroke-dasharray="3 2"/>
                <line x1="11" y1="11" x2="17" y2="17"/>
                <line x1="14" y1="17" x2="17" y2="17"/><line x1="17" y1="14" x2="17" y2="17"/>
            </svg>`);
        const btnHome    = mkBtn('', 'Reset View', '&#8962;');
        this.btnInspect  = mkBtn('', 'Inspect Values',
            `<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="9" cy="9" r="4"/>
                <line x1="9" y1="1" x2="9" y2="5"/><line x1="9" y1="13" x2="9" y2="17"/>
                <line x1="1" y1="9" x2="5" y2="9"/><line x1="13" y1="9" x2="17" y2="9"/>
            </svg>`);

        this.gpuSelectEl = document.createElement('select');
        this.gpuSelectEl.title = 'GPU Adapter';
        this.gpuSelectEl.style.cssText = 'height:30px;border:1px solid #bbb;border-radius:5px;background:#fff;font-size:12px;padding:0 6px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.18);max-width:200px;';

        // Save-as dropdown
        const saveWrapper = document.createElement('div');
        saveWrapper.style.cssText = 'position:relative;display:inline-flex;';

        const btnSave = mkBtn('', 'Save as Image',
            `<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="9" y1="2" x2="9" y2="12"/>
                <polyline points="5,8 9,13 13,8"/>
                <line x1="2" y1="16" x2="16" y2="16"/>
            </svg>`);

        const saveMenu = document.createElement('div');
        saveMenu.style.cssText = 'display:none;position:absolute;top:calc(100% + 3px);right:0;z-index:200;background:#fff;border:1px solid #bbb;border-radius:5px;box-shadow:0 3px 10px rgba(0,0,0,0.25);overflow:hidden;white-space:nowrap;';

        (['PNG', 'JPEG', 'PDF'] as const).forEach(fmt => {
            const item = document.createElement('button');
            item.textContent = fmt;
            item.style.cssText = 'display:block;width:100%;padding:7px 18px;background:none;border:none;border-bottom:1px solid #eee;text-align:left;cursor:pointer;font-size:13px;font-family:sans-serif;color:#333;';
            item.addEventListener('mouseover', () => { item.style.background = '#f0f4ff'; });
            item.addEventListener('mouseout',  () => { item.style.background = '';        });
            item.addEventListener('click', e => {
                e.stopPropagation();
                saveMenu.style.display = 'none';
                void this.saveAs(fmt.toLowerCase() as 'png' | 'jpeg' | 'pdf');
            });
            saveMenu.appendChild(item);
        });
        (saveMenu.lastElementChild as HTMLElement).style.borderBottom = 'none';

        saveWrapper.append(btnSave, saveMenu);

        btnSave.addEventListener('click', e => {
            e.stopPropagation();
            saveMenu.style.display = saveMenu.style.display === 'none' ? 'block' : 'none';
        });
        window.addEventListener('click', () => { saveMenu.style.display = 'none'; });

        toolbar.append(btnZoomIn, btnZoomOut, this.btnZoomRegion, btnHome, this.btnInspect, saveWrapper, this.gpuSelectEl);
        header.append(this.titleLabelEl, toolbar);

        // Canvas container
        const canvasContainer = document.createElement('div');
        canvasContainer.className = 'canvas_container';

        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'display:block;width:100%;height:100%;';

        this.zoomRectEl = document.createElement('div');
        this.zoomRectEl.className = 'zoom_rect';

        this.crosshairVEl = document.createElement('div');
        this.crosshairVEl.style.cssText = 'position:absolute;pointer-events:none;top:0;bottom:0;width:1px;background:rgba(0,0,0,0.4);display:none;transform:translateX(-0.5px);';
        this.crosshairHEl = document.createElement('div');
        this.crosshairHEl.style.cssText = 'position:absolute;pointer-events:none;left:0;right:0;height:1px;background:rgba(0,0,0,0.4);display:none;transform:translateY(-0.5px);';
        this.tooltipEl = document.createElement('div');
        this.tooltipEl.style.cssText = 'position:absolute;pointer-events:none;background:rgba(20,20,20,0.85);color:#fff;font-size:12px;font-family:monospace;padding:5px 9px;border-radius:5px;white-space:pre;display:none;z-index:10;line-height:1.6;box-shadow:0 2px 8px rgba(0,0,0,0.3);';

        canvasContainer.append(this.canvas, this.zoomRectEl, this.crosshairVEl, this.crosshairHEl, this.tooltipEl);
        this.windowEl.append(header, canvasContainer);

        // ---- Toolbar events ----
        btnZoomIn.addEventListener('click', () => {
            const cx = (this.viewXMin + this.viewXMax) / 2;
            const cy = (this.viewYMin + this.viewYMax) / 2;
            this.zoomAround(cx, cy, 1 / 1.5);
            this.scheduleRender();
        });
        btnZoomOut.addEventListener('click', () => {
            const cx = (this.viewXMin + this.viewXMax) / 2;
            const cy = (this.viewYMin + this.viewYMax) / 2;
            this.zoomAround(cx, cy, 1.5);
            this.scheduleRender();
        });
        this.btnZoomRegion.addEventListener('click', () => {
            this.setMode(this.plotMode === 'zoomRegion' ? 'pan' : 'zoomRegion');
        });
        btnHome.addEventListener('click', () => {
            this.viewXMin = this.defaultViewXMin; this.viewXMax = this.defaultViewXMax;
            this.viewYMin = this.defaultViewYMin; this.viewYMax = this.defaultViewYMax;
            this.scheduleRender();
        });
        this.btnInspect.addEventListener('click', () => {
            this.setMode(this.plotMode === 'inspect' ? 'pan' : 'inspect');
        });
        this.gpuSelectEl.addEventListener('change', async () => {
            const idx = parseInt(this.gpuSelectEl.value, 10);
            const opt = this.adapterOptions[idx];
            if (!opt) return;
            await this.initGPUResources(opt);
            this.render();
        });

        // ---- Mouse / wheel events ----
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
            const data = this.clientToData(e.clientX, e.clientY);
            this.zoomAround(data.x, data.y, factor);
            this.scheduleRender();
        }, { passive: false });

        this.canvas.addEventListener('mousedown', (e) => {
            e.preventDefault();
            if (this.plotMode === 'zoomRegion') {
                this.zbDragging = true;
                this.zbStartClientX = e.clientX;
                this.zbStartClientY = e.clientY;
                const cr = this.canvas.getBoundingClientRect();
                const x = e.clientX - cr.left;
                const y = e.clientY - cr.top;
                this.zoomRectEl.style.left = x + 'px';
                this.zoomRectEl.style.top  = y + 'px';
                this.zoomRectEl.style.width  = '0px';
                this.zoomRectEl.style.height = '0px';
                this.zoomRectEl.style.display = 'block';
            } else if (this.plotMode === 'pan') {
                this.isDragging = true;
                this.dragStartX = e.clientX;
                this.dragStartY = e.clientY;
                this.dragViewXMin = this.viewXMin; this.dragViewXMax = this.viewXMax;
                this.dragViewYMin = this.viewYMin; this.dragViewYMax = this.viewYMax;
                this.canvas.style.cursor = 'grabbing';
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (this.zbDragging) {
                const cr = this.canvas.getBoundingClientRect();
                const x0 = this.zbStartClientX - cr.left;
                const y0 = this.zbStartClientY - cr.top;
                const x1 = e.clientX - cr.left;
                const y1 = e.clientY - cr.top;
                this.zoomRectEl.style.left   = Math.min(x0, x1) + 'px';
                this.zoomRectEl.style.top    = Math.min(y0, y1) + 'px';
                this.zoomRectEl.style.width  = Math.abs(x1 - x0) + 'px';
                this.zoomRectEl.style.height = Math.abs(y1 - y0) + 'px';
                return;
            }
            if (this.plotMode === 'inspect') {
                this.updateInspector(e.clientX, e.clientY);
                return;
            }
            if (!this.isDragging) return;
            const rect = this.canvas.getBoundingClientRect();
            const dxClip =  (e.clientX - this.dragStartX) / rect.width  * 2;
            const dyClip = -(e.clientY - this.dragStartY) / rect.height * 2;
            const dxData = dxClip / (this.plotRectX1 - this.plotRectX0) * (this.dragViewXMax - this.dragViewXMin);
            const dyData = dyClip / (this.plotRectY1 - this.plotRectY0) * (this.dragViewYMax - this.dragViewYMin);
            this.viewXMin = this.dragViewXMin - dxData;
            this.viewXMax = this.dragViewXMax - dxData;
            this.viewYMin = this.dragViewYMin - dyData;
            this.viewYMax = this.dragViewYMax - dyData;
            this.scheduleRender();
        });

        window.addEventListener('mouseup', (e) => {
            if (this.zbDragging) {
                this.zbDragging = false;
                this.zoomRectEl.style.display = 'none';
                const x0 = this.zbStartClientX, y0 = this.zbStartClientY;
                const x1 = e.clientX,           y1 = e.clientY;
                if (Math.abs(x1 - x0) > 5 && Math.abs(y1 - y0) > 5) {
                    const topLeft     = this.clientToData(Math.min(x0, x1), Math.min(y0, y1));
                    const bottomRight = this.clientToData(Math.max(x0, x1), Math.max(y0, y1));
                    this.viewXMin = topLeft.x;     this.viewXMax = bottomRight.x;
                    this.viewYMin = bottomRight.y; this.viewYMax = topLeft.y;
                    this.scheduleRender();
                }
                return;
            }
            if (this.isDragging) {
                this.isDragging = false;
                this.canvas.style.cursor = 'grab';
            }
        });

        this.canvas.addEventListener('mouseleave', () => {
            this.crosshairVEl.style.display = 'none';
            this.crosshairHEl.style.display = 'none';
            this.tooltipEl.style.display = 'none';
        });

        this.canvas.style.cursor = 'grab';

        // Resize observer
        const ro = new ResizeObserver(() => this.render());
        ro.observe(canvasContainer);
    }

    // ---- GPU initialisation ----

    async init(font: opentype.Font): Promise<void> {
        this.font = font;

        if (!navigator.gpu) throw new Error("WebGPU not supported");

        const contextOrNull = this.canvas.getContext("webgpu");
        if (!contextOrNull) throw new Error("Could not obtain WebGPU context");
        this.context = contextOrNull;
        this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();

        this.adapterOptions = await enumerateAdapters();
        for (let i = 0; i < this.adapterOptions.length; i++) {
            const el = document.createElement('option');
            el.value = String(i);
            el.textContent = this.adapterOptions[i]!.label;
            this.gpuSelectEl.appendChild(el);
        }
        if (this.adapterOptions.length === 0) {
            const el = document.createElement('option');
            el.value = '0'; el.textContent = 'Default GPU';
            this.gpuSelectEl.appendChild(el);
        }
        this.gpuSelectEl.disabled = this.adapterOptions.length <= 1;

        if (this.adapterOptions.length === 0) throw new Error("No GPUAdapter found");
        await this.initGPUResources(this.adapterOptions[0]!);
    }

    private async initGPUResources(option: AdapterOption): Promise<void> {
        const oldDevice: GPUDevice | undefined = this.device;

        const adapterOpts: GPURequestAdapterOptions = {};
        if (option.powerPreference !== undefined) adapterOpts.powerPreference = option.powerPreference;
        if (option.forceFallbackAdapter) adapterOpts.forceFallbackAdapter = true;
        const adapter = await navigator.gpu.requestAdapter(
            Object.keys(adapterOpts).length > 0 ? adapterOpts : undefined
        );
        if (!adapter) throw new Error("No GPUAdapter found");
        // Запрашиваем максимальный поддерживаемый размер буфера
        this.device = await adapter.requestDevice({
            requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize }
        });
        if (!this.device) throw new Error("Failed to create a GPUDevice");

        if (oldDevice) {
            this.destroySeriesGpuBuffers();
            await oldDevice.queue.onSubmittedWorkDone();
            this.context.unconfigure();
            const oldLost = oldDevice.lost;
            oldDevice.destroy();
            await oldLost;
        }

        this.context.configure({ device: this.device, format: this.canvasFormat });

        const shaderModule = this.device.createShaderModule({ code: shaderCode });
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 20,
            attributes: [
                { format: "float32x2", offset: 0,  shaderLocation: 0 },
                { format: "float32x3", offset: 8,  shaderLocation: 1 },
            ]
        };
        const makePipeline = (topology: GPUPrimitiveTopology): GPURenderPipeline =>
            this.device.createRenderPipeline({
                layout: "auto",
                vertex:   { module: shaderModule, entryPoint: "vertexMain",   buffers: [vertexBufferLayout] },
                fragment: { module: shaderModule, entryPoint: "fragmentMain", targets: [{ format: this.canvasFormat }] },
                primitive: { topology }
            });

        this.linePipeline  = makePipeline("line-list");
        this.textPipeline  = makePipeline("triangle-list");
        this.titlePipeline = makePipeline("triangle-list");

        // Render pipeline for series lines/dashed: RGBA vertex color, alpha blending
        const seriesLineModule = this.device.createShaderModule({ code: seriesLineShaderCode });
        const seriesLineVertLayout: GPUVertexBufferLayout = {
            arrayStride: 24,  // 6 floats × 4 bytes
            attributes: [
                { format: 'float32x2', offset:  0, shaderLocation: 0 },  // coords
                { format: 'float32x4', offset:  8, shaderLocation: 1 },  // color rgba
            ]
        };
        this.seriesLinePipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex:   { module: seriesLineModule, entryPoint: 'vsSeriesLine', buffers: [seriesLineVertLayout] },
            fragment: {
                module: seriesLineModule, entryPoint: 'fsSeriesLine',
                targets: [{
                    format: this.canvasFormat,
                    blend: {
                        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                        alpha: { operation: 'add', srcFactor: 'one',       dstFactor: 'zero' },
                    }
                }]
            },
            primitive: { topology: 'triangle-list' }
        });

        const blitShaderModule = this.device.createShaderModule({ code: blitShaderCode });
        this.blitPipeline = this.device.createRenderPipeline({
            layout: "auto",
            vertex:   { module: blitShaderModule, entryPoint: "vsMain" },
            fragment: { module: blitShaderModule, entryPoint: "fsMain", targets: [{ format: this.canvasFormat }] },
            primitive: { topology: "triangle-list" }
        });
        this.blitSampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });

        // Compute pipeline for GPU-side solid-line quad generation
        const computeModule = this.device.createShaderModule({ code: computeShaderCode });
        this.computePipeline = this.device.createComputePipeline({
            layout: "auto",
            compute: { module: computeModule, entryPoint: "csMain" }
        });

        // Compute pipeline for GPU-side marker quad generation (SDF circles)
        const markerComputeModule = this.device.createShaderModule({ code: markerComputeShaderCode });
        this.markerComputePipeline = this.device.createComputePipeline({
            layout: "auto",
            compute: { module: markerComputeModule, entryPoint: "csMarker" }
        });

        // Render pipeline for SDF marker shapes (triangle-list, alpha blending)
        const markerModule = this.device.createShaderModule({ code: markerShaderCode });
        const markerVertexLayout: GPUVertexBufferLayout = {
            arrayStride: 15 * 4,  // 15 floats × 4 bytes
            attributes: [
                { shaderLocation: 0, offset:  0, format: 'float32x2' },  // clipPos
                { shaderLocation: 1, offset:  8, format: 'float32x2' },  // localPos: offset from centre (ssaa px)
                { shaderLocation: 2, offset: 16, format: 'float32x2' },  // radii
                { shaderLocation: 3, offset: 24, format: 'float32x4' },  // faceColor rgba
                { shaderLocation: 4, offset: 40, format: 'float32x4' },  // edgeColor rgba
                { shaderLocation: 5, offset: 56, format: 'float32'   },  // shapeId
            ]
        };
        this.markerRenderPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex:   { module: markerModule, entryPoint: 'vsMarker', buffers: [markerVertexLayout] },
            fragment: {
                module: markerModule, entryPoint: 'fsMarker',
                targets: [{
                    format: this.canvasFormat,
                    blend: {
                        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                        alpha: { operation: 'add', srcFactor: 'one',       dstFactor: 'zero' },
                    }
                }]
            },
            primitive: { topology: 'triangle-list' }
        });

        // Dashed-line compute pipeline (single-threaded sequential, writes drawArgs directly)
        const dashedComputeModule = this.device.createShaderModule({ code: dashedComputeShaderCode });
        this.dashedComputePipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: { module: dashedComputeModule, entryPoint: 'csDashed' },
        });

        // Re-upload series data onto the new device (e.g. after adapter switch)
        if (this.internalSeries.length > 0) {
            this.uploadSeriesGpuBuffers();
        }
    }

    // ---- Data / view management ----

    setData(seriesList: PlotSeries[]): void {
        this.seriesList = seriesList;

        // Detect axis types from the first non-empty value in each axis
        const xSample = seriesList.flatMap(s => s.x as (number | string | Date)[]);
        const ySample = seriesList.flatMap(s => s.y as (number | string | Date)[]);
        const xIsString = xSample.length > 0 && typeof xSample[0] === 'string';
        const xIsDate   = xSample.length > 0 && xSample[0] instanceof Date;
        const yIsString = ySample.length > 0 && typeof ySample[0] === 'string';
        const yIsDate   = ySample.length > 0 && ySample[0] instanceof Date;

        this.xIsDate = xIsDate;
        this.yIsDate = yIsDate;

        // Build sorted category label arrays (union across all series)
        this.xLabels = xIsString ? [...new Set(xSample as string[])].sort() : null;
        this.yLabels = yIsString ? [...new Set(ySample as string[])].sort() : null;

        const xMap = this.xLabels ? new Map(this.xLabels.map((l, i) => [l, i])) : null;
        const yMap = this.yLabels ? new Map(this.yLabels.map((l, i) => [l, i])) : null;

        // Normalize each series to numeric x/y
        this.internalSeries = seriesList.map(s => {
            let xn: number[] = xIsString ? (s.x as string[]).map(v => xMap!.get(v) ?? 0)
                             : xIsDate   ? (s.x as Date[]).map(d => d.getTime())
                             : s.x as number[];
            let yn: number[] = yIsString ? (s.y as string[]).map(v => yMap!.get(v) ?? 0)
                             : yIsDate   ? (s.y as Date[]).map(d => d.getTime())
                             : s.y as number[];

            // Sort by x when x has an intrinsic ordering (string/date)
            if ((xIsString || xIsDate) && xn.length > 1) {
                const idx = Array.from({length: xn.length}, (_, i) => i).sort((a, b) => xn[a]! - xn[b]!);
                xn = idx.map(i => xn[i]!);
                yn = idx.map(i => yn[i]!);
            }

            return {
                x: xn, y: yn,
                xSorted: xIsString || xIsDate || (() => {
                    for (let i = 1; i < xn.length; i++) {
                        if (xn[i]! < xn[i - 1]!) return false;
                    }
                    return true;
                })(),
                ...(s.color     !== undefined && { color:     s.color }),
                ...(s.lineStyle !== undefined && { lineStyle: s.lineStyle }),
                ...(s.lineWidth !== undefined && { lineWidth: s.lineWidth }),
                ...(s.marker    !== undefined && { marker:    s.marker }),
            };
        });

        this.resetDefaultView();

        // Upload raw data to GPU if device is already initialised
        if (this.device) {
            this.uploadSeriesGpuBuffers();
        }
    }

    private destroySeriesGpuBuffers(): void {
        for (const b of this.seriesRawBufs)      b.destroy();
        for (const b of this.seriesOutBufs)      b?.destroy();
        for (const b of this.seriesParamBufs)    b?.destroy();
        for (const b of this.markerOutBufs)      b?.destroy();
        for (const b of this.markerParamBufs)    b?.destroy();
        for (const b of this.dashedOutBufs)      b?.destroy();
        for (const b of this.dashedParamBufs)    b?.destroy();
        for (const b of this.dashedDrawArgsBufs) b?.destroy();
        this.seriesRawBufs      = [];
        this.seriesOutBufs      = [];
        this.seriesParamBufs    = [];
        this.seriesOutCounts    = [];
        this.markerOutBufs      = [];
        this.markerParamBufs    = [];
        this.markerOutCounts    = [];
        this.dashedOutBufs      = [];
        this.dashedParamBufs    = [];
        this.dashedDrawArgsBufs = [];
        this.dashedNumSegs      = [];
    }

    /** Creates (or recreates) per-series GPU buffers.
     *  Raw x/y data is uploaded here and never touched again until setData() is called.
     *  Output buffers are fixed size (MAX_COMPUTE_SEGS segments). */
    private uploadSeriesGpuBuffers(): void {
        this.destroySeriesGpuBuffers();
        const MAX = this.MAX_COMPUTE_SEGS;
        for (const series of this.internalSeries) {
            const n = series.x.length;

            // Raw interleaved x,y buffer (STORAGE | COPY_DST)
            const rawData = new Float32Array(n * 2);
            for (let i = 0; i < n; i++) { rawData[i * 2] = series.x[i]!; rawData[i * 2 + 1] = series.y[i]!; }
            const rawBuf = this.device.createBuffer({
                size: Math.max(rawData.byteLength, 8),
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            if (rawData.byteLength > 0) this.device.queue.writeBuffer(rawBuf, 0, rawData);

            // Output vertex buffer and params uniform — skipped for markers-only series
            const markersOnly = series.lineStyle === 'none';
            if (!markersOnly) {
                const outBuf = this.device.createBuffer({
                    size: MAX * 36 * 4,  // MAX_SEGS * 6 verts * 6 floats * 4 bytes
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
                });
                const paramBuf = this.device.createBuffer({
                    size: 80,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                this.seriesOutBufs.push(outBuf);
                this.seriesParamBufs.push(paramBuf);
            } else {
                this.seriesOutBufs.push(null);
                this.seriesParamBufs.push(null);
            }

            this.seriesRawBufs.push(rawBuf);
            this.seriesOutCounts.push(0);

            // Marker GPU buffers — only when series has a marker style
            if (series.marker && series.marker.shape !== 'none') {
                const MAX_M = this.MAX_MARKER_COUNT;
                const mOutBuf = this.device.createBuffer({
                    // 6 verts × 15 floats × 4 bytes per marker
                    size: MAX_M * 6 * 15 * 4,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
                });
                const mParamBuf = this.device.createBuffer({
                    size: 112,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                this.markerOutBufs.push(mOutBuf);
                this.markerParamBufs.push(mParamBuf);
            } else {
                this.markerOutBufs.push(null);
                this.markerParamBufs.push(null);
            }
            this.markerOutCounts.push(0);

            // Dashed-line GPU buffers — only for series with a non-empty dash pattern
            const pattern = DASH_PATTERNS[series.lineStyle ?? '-'] ?? [];
            if (pattern.length > 0) {
                const dOutBuf = this.device.createBuffer({
                    label: 'dashed out',
                    size: this.MAX_DASHED_OUT_QUADS * 36 * 4,   // quads * 6 verts * 6 floats * 4 bytes
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
                });
                const dParamBuf = this.device.createBuffer({
                    label: 'dashed param',
                    size: 128,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                const dDrawArgsBuf = this.device.createBuffer({
                    label: 'dashed draw args',
                    size: 16,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
                });
                this.dashedOutBufs.push(dOutBuf);
                this.dashedParamBufs.push(dParamBuf);
                this.dashedDrawArgsBufs.push(dDrawArgsBuf);
            } else {
                this.dashedOutBufs.push(null);
                this.dashedParamBufs.push(null);
                this.dashedDrawArgsBufs.push(null);
            }
            this.dashedNumSegs.push(0);
        }
    }

    private resetDefaultView(): void {
        // Compute minimum adjacent-point spacing to serve as the data-resolution zoom-in limit.
        let minDX = Infinity, minDY = Infinity;
        for (const s of this.internalSeries) {
            const n = s.x.length;
            for (let i = 1; i < n; i++) {
                const dx = Math.abs(s.x[i]! - s.x[i - 1]!);
                const dy = Math.abs(s.y[i]! - s.y[i - 1]!);
                if (dx > 1e-300 && dx < minDX) minDX = dx;
                if (dy > 1e-300 && dy < minDY) minDY = dy;
            }
        }
        this.minDataSpanX = isFinite(minDX) ? minDX : 1e-9;
        this.minDataSpanY = isFinite(minDY) ? minDY : 1e-9;

        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (const s of this.internalSeries) {
            for (let i = 0; i < s.x.length; i++) {
                if (s.x[i]! < xMin) xMin = s.x[i]!;
                if (s.x[i]! > xMax) xMax = s.x[i]!;
                if (s.y[i]! < yMin) yMin = s.y[i]!;
                if (s.y[i]! > yMax) yMax = s.y[i]!;
            }
        }
        if (!isFinite(xMin)) { xMin = 0; xMax = 1; yMin = 0; yMax = 1; }

        if (this.xLabels) {
            this.defaultViewXMin = -0.5;
            this.defaultViewXMax = this.xLabels.length - 0.5;
        } else if (this.xIsDate) {
            const margin = (xMax - xMin) * 0.05 || 3_600_000;
            this.defaultViewXMin = xMin - margin;
            this.defaultViewXMax = xMax + margin;
        } else {
            const xTicks = niceTicks(xMin, xMax, 5);
            this.defaultViewXMin = xTicks[0]!;
            this.defaultViewXMax = xTicks[xTicks.length - 1]!;
        }

        if (this.yLabels) {
            this.defaultViewYMin = -0.5;
            this.defaultViewYMax = this.yLabels.length - 0.5;
        } else if (this.yIsDate) {
            const margin = (yMax - yMin) * 0.05 || 3_600_000;
            this.defaultViewYMin = yMin - margin;
            this.defaultViewYMax = yMax + margin;
        } else {
            const yTicks = niceTicks(yMin, yMax, 5);
            this.defaultViewYMin = yTicks[0]!;
            this.defaultViewYMax = yTicks[yTicks.length - 1]!;
        }

        this.viewXMin = this.defaultViewXMin; this.viewXMax = this.defaultViewXMax;
        this.viewYMin = this.defaultViewYMin; this.viewYMax = this.defaultViewYMax;
    }

    private zoomAround(dataX: number, dataY: number, factor: number): void {
        const xRange = this.viewXMax - this.viewXMin;
        const yRange = this.viewYMax - this.viewYMin;
        const tx = (dataX - this.viewXMin) / xRange;
        const ty = (dataY - this.viewYMin) / yRange;

        // --- Zoom limits ---
        // Minimum view span = distance between two adjacent data points (zoom-in hard stop).
        // Maximum view span = data span × plot size in pixels:
        //   allows zooming out until the entire dataset occupies ~1 CSS pixel on screen.
        const minSpanX = this.minDataSpanX || 1e-9;
        const minSpanY = this.minDataSpanY || 1e-9;
        const plotWidthPx  = (this.plotRectX1 - this.plotRectX0) / 2 * this.canvas.clientWidth;
        const plotHeightPx = (this.plotRectY1 - this.plotRectY0) / 2 * this.canvas.clientHeight;
        const dataSpanX = this.defaultViewXMax - this.defaultViewXMin;
        const dataSpanY = this.defaultViewYMax - this.defaultViewYMin;
        const maxSpanX = dataSpanX * Math.max(plotWidthPx, 1);
        const maxSpanY = dataSpanY * Math.max(plotHeightPx, 1);

        let newXMin = dataX - tx * xRange * factor;
        let newXMax = newXMin + xRange * factor;
        let newYMin = dataY - ty * yRange * factor;
        let newYMax = newYMin + yRange * factor;

        // Clamp X span to [minSpanX, maxSpanX]
        if (newXMax - newXMin < minSpanX) {
            const mid = (newXMin + newXMax) / 2;
            newXMin = mid - minSpanX / 2;
            newXMax = mid + minSpanX / 2;
        } else if (maxSpanX > 0 && newXMax - newXMin > maxSpanX) {
            const mid = (newXMin + newXMax) / 2;
            newXMin = mid - maxSpanX / 2;
            newXMax = mid + maxSpanX / 2;
        }
        // Clamp Y span to [minSpanY, maxSpanY]
        if (newYMax - newYMin < minSpanY) {
            const mid = (newYMin + newYMax) / 2;
            newYMin = mid - minSpanY / 2;
            newYMax = mid + minSpanY / 2;
        } else if (maxSpanY > 0 && newYMax - newYMin > maxSpanY) {
            const mid = (newYMin + newYMax) / 2;
            newYMin = mid - maxSpanY / 2;
            newYMax = mid + maxSpanY / 2;
        }

        this.viewXMin = newXMin;
        this.viewXMax = newXMax;
        this.viewYMin = newYMin;
        this.viewYMax = newYMax;
    }

    private clientToData(clientX: number, clientY: number): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        const clipX = (clientX - rect.left) / rect.width  *  2 - 1;
        const clipY = 1 - (clientY - rect.top)  / rect.height * 2;
        const tx = (clipX - this.plotRectX0) / (this.plotRectX1 - this.plotRectX0);
        const ty = (clipY - this.plotRectY0) / (this.plotRectY1 - this.plotRectY0);
        return {
            x: this.viewXMin + tx * (this.viewXMax - this.viewXMin),
            y: this.viewYMin + ty * (this.viewYMax - this.viewYMin),
        };
    }

    private setMode(mode: 'pan' | 'zoomRegion' | 'inspect'): void {
        this.plotMode = mode;
        this.btnZoomRegion.classList.remove('active');
        this.btnInspect.classList.remove('active');
        this.crosshairVEl.style.display = 'none';
        this.crosshairHEl.style.display = 'none';
        this.tooltipEl.style.display = 'none';
        if (mode === 'zoomRegion') {
            this.canvas.style.cursor = 'crosshair';
            this.btnZoomRegion.classList.add('active');
        } else if (mode === 'inspect') {
            this.canvas.style.cursor = 'crosshair';
            this.btnInspect.classList.add('active');
        } else {
            this.canvas.style.cursor = 'grab';
        }
    }

    private formatXInspect(v: number): string {
        if (this.xLabels) return this.xLabels[Math.round(v)] ?? String(Math.round(v));
        if (this.xIsDate) return new Date(v).toLocaleString();
        return parseFloat(v.toPrecision(6)).toString();
    }

    private formatYInspect(v: number): string {
        if (this.yLabels) return this.yLabels[Math.round(v)] ?? String(Math.round(v));
        if (this.yIsDate) return new Date(v).toLocaleString();
        return parseFloat(v.toPrecision(6)).toString();
    }

    private updateInspector(mouseClientX: number, mouseClientY: number): void {
        const rect = this.canvas.getBoundingClientRect();
        const w = rect.width, h = rect.height;
        const mousePxX = mouseClientX - rect.left;
        const mousePxY = mouseClientY - rect.top;

        const plotPxX0 = (this.plotRectX0 + 1) / 2 * w;
        const plotPxX1 = (this.plotRectX1 + 1) / 2 * w;
        const plotPxY0 = (1 - this.plotRectY1) / 2 * h;  // top of plot in CSS px
        const plotPxY1 = (1 - this.plotRectY0) / 2 * h;  // bottom of plot in CSS px

        const hide = () => {
            this.crosshairVEl.style.display = 'none';
            this.crosshairHEl.style.display = 'none';
            this.tooltipEl.style.display = 'none';
        };

        if (mousePxX < plotPxX0 || mousePxX > plotPxX1 ||
            mousePxY < plotPxY0 || mousePxY > plotPxY1) { hide(); return; }

        const mouseDataX = this.viewXMin + (mousePxX - plotPxX0) / (plotPxX1 - plotPxX0) * (this.viewXMax - this.viewXMin);

        const dtoPxX = (x: number) =>
            plotPxX0 + (x - this.viewXMin) / (this.viewXMax - this.viewXMin) * (plotPxX1 - plotPxX0);
        const dtoPxY = (y: number) => {
            const t = (y - this.viewYMin) / (this.viewYMax - this.viewYMin);
            return (1 - (this.plotRectY0 + t * (this.plotRectY1 - this.plotRectY0))) / 2 * h;
        };

        let bestDist2 = 30 * 30;  // 30 px snap radius
        let bestSeries = -1, bestPt = -1;

        for (let si = 0; si < this.internalSeries.length; si++) {
            const s = this.internalSeries[si]!;
            if (s.x.length === 0) continue;
            // Binary search to find the index with x closest to mouseDataX
            let lo = 0, hi = s.x.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (s.x[mid]! < mouseDataX) lo = mid + 1;
                else hi = mid;
            }
            // Scan a window around that index (covers dense & sparse data alike)
            const W = 200;
            for (let i = Math.max(0, lo - W); i <= Math.min(s.x.length - 1, lo + W); i++) {
                const dx = dtoPxX(s.x[i]!) - mousePxX;
                const dy = dtoPxY(s.y[i]!) - mousePxY;
                const d2 = dx*dx + dy*dy;
                if (d2 < bestDist2) { bestDist2 = d2; bestSeries = si; bestPt = i; }
            }
        }

        if (bestSeries < 0) { hide(); return; }

        const dataX = this.internalSeries[bestSeries]!.x[bestPt]!;
        const dataY = this.internalSeries[bestSeries]!.y[bestPt]!;
        const ptPxX = dtoPxX(dataX);
        const ptPxY = dtoPxY(dataY);

        this.crosshairVEl.style.display = 'block';
        this.crosshairVEl.style.left = ptPxX + 'px';
        this.crosshairHEl.style.display = 'block';
        this.crosshairHEl.style.top  = ptPxY + 'px';

        const label = this.internalSeries.length > 1
            ? `x: ${this.formatXInspect(dataX)}\ny: ${this.formatYInspect(dataY)}\nseries: ${bestSeries + 1}`
            : `x: ${this.formatXInspect(dataX)}\ny: ${this.formatYInspect(dataY)}`;
        this.tooltipEl.textContent = label;
        this.tooltipEl.style.display = 'block';

        // Position tooltip near the mouse — flip if too close to an edge
        let tipX = mousePxX + 14;
        let tipY = mousePxY - this.tooltipEl.offsetHeight - 6;
        if (tipX + this.tooltipEl.offsetWidth > w - 4) tipX = mousePxX - this.tooltipEl.offsetWidth - 14;
        if (tipY < 4) tipY = mousePxY + 14;
        if (tipX < 4) tipX = 4;
        this.tooltipEl.style.left = tipX + 'px';
        this.tooltipEl.style.top  = tipY + 'px';
    }

    // ---- Compute plot rectangle from padding options (in clip space) ----
    private computePlotRect(
        w: number, h: number,
        yTickMaxWidthPx: number
    ): { x0: number; y0: number; x1: number; y1: number } {
        const o = this.opts;
        const fs = o.fontSize;
        const titleFs = o.titleFontSize;

        // All lengths converted from pixels to clip-space units
        const pxX = 2.0 / w;  // 1 pixel in clip-space X
        const pxY = 2.0 / h;  // 1 pixel in clip-space Y

        // Estimated rendered heights/widths in pixels (cap-height ≈ 0.75 * fontSize)
        const capH = fs * 0.75;
        const titleCapH = titleFs * 0.75;

        // Y-axis label width (rotated, so it occupies width = capH pixels)
        const yLabelWidth = capH;  // rotated text occupies one cap-height in X

        // Left boundary:
        //   paddingLeft  →  y-label  →  paddingYLabelToYTicks  →  y-tick values  →  gap  →  plot edge
        // For 'out'/'both' ticks the tick itself (8px) is outside the plot border and
        // must be included in the gap between the label text and the plot edge.
        const tickDir = o.style.tickDirection;
        const tickOutPx = (tickDir === 'out' || tickDir === 'both') ? 8 : 0;  // outward tick length
        const tickToPlotGapPx = tickOutPx + 4;  // tick + 4px label gap
        const leftPx = o.paddingLeft + yLabelWidth + o.paddingYLabelToYTicks + yTickMaxWidthPx + tickToPlotGapPx;

        // Right boundary= paddingRight from right edge
        const rightPx = w - o.paddingRight;

        // Top boundary = paddingTop + titleCapH + paddingTitleToPlot
        const topPx = o.paddingTop + titleCapH + o.paddingTitleToPlot;

        // Bottom boundary = paddingBottom + xLabelCapH + paddingXLabelToPlot + xTickLabelCapH + tick space
        const xTickLabelHeightPx = capH;
        const tickLenPx = 8;
        const tickDir2 = o.style.tickDirection;
        const xTickOutPx = (tickDir2 === 'out' || tickDir2 === 'both') ? tickLenPx : 0;
        const bottomPx = h - (o.paddingBottom + capH + o.paddingXLabelToPlot + xTickLabelHeightPx + xTickOutPx + 4);

        // Convert from pixel coordinates (origin top-left) to clip space (origin center, Y-up)
        const x0 = leftPx  * pxX - 1;
        const x1 = rightPx * pxX - 1;
        const y1 = 1 - topPx    * pxY;  // top of plot in clip space
        const y0 = 1 - bottomPx * pxY;  // bottom of plot in clip space (must be < y1 but > -1)

        return { x0, y0, x1, y1 };
    }

    // ---- Save as image / PDF ----

    private async saveAs(format: 'png' | 'jpeg' | 'pdf'): Promise<void> {
        this.render();  // ensure latest frame is on canvas
        const w = this.canvas.width;
        const h = this.canvas.height;
        const offscreen = document.createElement('canvas');
        offscreen.width  = w;
        offscreen.height = h;
        offscreen.getContext('2d')!.drawImage(this.canvas, 0, 0);

        let blob: Blob;
        let filename: string;

        if (format === 'png') {
            blob = await new Promise<Blob>(res => offscreen.toBlob(b => res(b!), 'image/png'));
            filename = 'plot.png';
        } else if (format === 'jpeg') {
            blob = await new Promise<Blob>(res => offscreen.toBlob(b => res(b!), 'image/jpeg', 0.92));
            filename = 'plot.jpg';
        } else {
            // PDF: embed JPEG in a minimal hand-crafted PDF
            const jpegBlob = await new Promise<Blob>(res => offscreen.toBlob(b => res(b!), 'image/jpeg', 0.92));
            const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
            blob = this.buildSimplePdf(jpegBytes, w, h);
            filename = 'plot.pdf';
        }

        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    /** Builds a minimal single-page PDF that embeds the supplied JPEG bytes. */
    private buildSimplePdf(jpegBytes: Uint8Array, imgW: number, imgH: number): Blob {
        const enc = new TextEncoder();
        const e = (s: string) => enc.encode(s);

        const contStr   = `q ${imgW} 0 0 ${imgH} 0 0 cm /Im0 Do Q\n`;
        const contBytes = e(contStr);

        const parts: Uint8Array[] = [];
        const xref: number[] = [0]; // xref[0] is always the free object
        let pos = 0;

        const add = (...chunks: Uint8Array[]): void => {
            for (const c of chunks) { parts.push(c); pos += c.byteLength; }
        };

        add(e('%PDF-1.4\n'));

        xref.push(pos);
        add(e('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));

        xref.push(pos);
        add(e('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'));

        xref.push(pos);
        add(e(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${imgW} ${imgH}]` +
              ` /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`));

        // Image XObject (JPEG, DCTDecode filter)
        xref.push(pos);
        add(
            e(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH}` +
              ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.byteLength} >>\nstream\n`),
            jpegBytes,
            e('\nendstream\nendobj\n')
        );

        // Content stream (places the image on the page)
        xref.push(pos);
        add(
            e(`5 0 obj\n<< /Length ${contBytes.byteLength} >>\nstream\n`),
            contBytes,
            e('endstream\nendobj\n')
        );

        // Cross-reference table
        const xrefPos  = pos;
        const xrefSect = xref.map((o, i) =>
            i === 0 ? '0000000000 65535 f \n' : `${String(o).padStart(10, '0')} 00000 n \n`
        ).join('');
        add(e(`xref\n0 ${xref.length}\n${xrefSect}` +
              `trailer\n<< /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`));

        // Assemble all chunks into a single Uint8Array
        const total = parts.reduce((s, p) => s + p.byteLength, 0);
        const pdf   = new Uint8Array(total);
        let offset  = 0;
        for (const p of parts) { pdf.set(p, offset); offset += p.byteLength; }
        return new Blob([pdf], { type: 'application/pdf' });
    }

    // ---- Main render ----

    /** Schedules a render on the next animation frame, deduplicating multiple calls per frame. */
    scheduleRender(): void {
        if (this.rafPending) return;
        this.rafPending = true;
        requestAnimationFrame(() => { this.rafPending = false; this.render(); });
    }

    render(): void {
        if (!this.device) return;
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (w === 0 || h === 0) return;
        this.canvas.width  = w;
        this.canvas.height = h;

        const ssaaTexture = this.device.createTexture({
            size: [w * this.ssaaScale, h * this.ssaaScale],
            format: this.canvasFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });

        const pixelX = 2.0 / w;
        const pixelY = 2.0 / h;
        const o = this.opts;
        const font = this.font;
        const fs = o.fontSize;
        const titleFs = o.titleFontSize;

        // ---- Ticks ----
        const xSpan = this.viewXMax - this.viewXMin;
        const ySpan = this.viewYMax - this.viewYMin;
        // Use relative tolerance to detect real zoom vs floating-point drift during pan
        const xSpanChanged = this.lastXSpan < 0 || Math.abs(xSpan - this.lastXSpan) / this.lastXSpan > 1e-9;
        const ySpanChanged = this.lastYSpan < 0 || Math.abs(ySpan - this.lastYSpan) / this.lastYSpan > 1e-9;
        let xTicks: number[];
        let yTicks: number[];
        if (this.xLabels) {
            xTicks = categoricalTicks(this.viewXMin, this.viewXMax);
        } else if (this.xIsDate) {
            if (xSpanChanged) { this.xTickStep = getDateTickStep(xSpan); this.lastXSpan = xSpan; }
            xTicks = dateTicksFromStep(this.viewXMin, this.viewXMax, this.xTickStep);
        } else {
            if (xSpanChanged) { this.xTickStep = getTickStep(this.viewXMin, this.viewXMax); this.lastXSpan = xSpan; }
            xTicks = ticksFromStep(this.viewXMin, this.viewXMax, this.xTickStep);
        }
        if (this.yLabels) {
            yTicks = categoricalTicks(this.viewYMin, this.viewYMax);
        } else if (this.yIsDate) {
            if (ySpanChanged) { this.yTickStep = getDateTickStep(ySpan); this.lastYSpan = ySpan; }
            yTicks = dateTicksFromStep(this.viewYMin, this.viewYMax, this.yTickStep);
        } else {
            if (ySpanChanged) { this.yTickStep = getTickStep(this.viewYMin, this.viewYMax); this.lastYSpan = ySpan; }
            yTicks = ticksFromStep(this.viewYMin, this.viewYMax, this.yTickStep);
        }
        const fmtX = (v: number) => this.xLabels ? (this.xLabels[Math.round(v)] ?? '') : this.xIsDate ? formatDateTick(v, this.xTickStep) : formatTick(v);
        const fmtY = (v: number) => this.yLabels ? (this.yLabels[Math.round(v)] ?? '') : this.yIsDate ? formatDateTick(v, this.yTickStep) : formatTick(v);

        // Measure actual max y-tick label width in pixels (clip-space width × w/2)
        const yTickMaxWidthPx = yTicks.reduce((max, tick) => {
            const wClip = textWidthClip(fmtY(tick), font, fs, w);
            return Math.max(max, wClip * w / 2);
        }, fs * 0.6);  // fallback minimum

        // Compute plot rectangle using real tick label widths
        let pr = this.computePlotRect(w, h, yTickMaxWidthPx);

        // Equal aspect ratio: shrink the larger dimension so that
        // 1 data unit on X == 1 data unit on Y in screen pixels.
        if (this.opts.style.aspectRatio === 'equal') {
            const xSpanAR = this.viewXMax - this.viewXMin;
            const ySpanAR = this.viewYMax - this.viewYMin;
            if (xSpanAR > 0 && ySpanAR > 0) {
                const plotWpx = (pr.x1 - pr.x0) * w / 2;  // plot panel width  in px
                const plotHpx = (pr.y1 - pr.y0) * h / 2;  // plot panel height in px
                const pxPerUnitX = plotWpx / xSpanAR;
                const pxPerUnitY = plotHpx / ySpanAR;
                if (pxPerUnitX > pxPerUnitY) {
                    // Panel is too wide → shrink width, keep height
                    const newWpx  = pxPerUnitY * xSpanAR;
                    const cx      = (pr.x0 + pr.x1) / 2;
                    pr = { ...pr, x0: cx - newWpx / w, x1: cx + newWpx / w };
                } else {
                    // Panel is too tall → shrink height, keep width
                    const newHpx  = pxPerUnitX * ySpanAR;
                    const cy      = (pr.y0 + pr.y1) / 2;
                    pr = { ...pr, y0: cy - newHpx / h, y1: cy + newHpx / h };
                }
            }
        }

        this.plotRectX0 = pr.x0; this.plotRectY0 = pr.y0;
        this.plotRectX1 = pr.x1; this.plotRectY1 = pr.y1;
        const { x0: rectX0, y0: rectY0, x1: rectX1, y1: rectY1 } = pr;

        const style = this.opts.style;
        const [cr, cg, cb] = style.axisColor;  // axes/tick color

        const verts: number[] = [];
        const textVerts: number[] = [];
        const titleVerts: number[] = [];

        // ---- Panel background (filled rectangle, ggplot2 grey92 by default) ----
        const [bgR, bgG, bgB] = style.background.panelColor;
        const bgVerts: number[] = [
            rectX0, rectY0, bgR, bgG, bgB,
            rectX1, rectY0, bgR, bgG, bgB,
            rectX1, rectY1, bgR, bgG, bgB,
            rectX0, rectY0, bgR, bgG, bgB,
            rectX1, rectY1, bgR, bgG, bgB,
            rectX0, rectY1, bgR, bgG, bgB,
        ];

        // ---- Plot border (2px thick) ----
        const lineWidth = 2;
        for (let i = 0; i < lineWidth; i++) {
            const bx0 = rectX0 + pixelX * i, by0 = rectY0 + pixelY * i;
            const bx1 = rectX1 - pixelX * i, by1 = rectY1 - pixelY * i;
            const ex = pixelX * 0.5;
            verts.push(bx0 - ex, by0, cr, cg, cb,  bx1 + ex, by0, cr, cg, cb);
            verts.push(bx0 - ex, by1, cr, cg, cb,  bx1 + ex, by1, cr, cg, cb);
            verts.push(bx0, by0, cr, cg, cb,  bx0, by1, cr, cg, cb);
            verts.push(bx1, by0, cr, cg, cb,  bx1, by1, cr, cg, cb);
        }

        // ---- Ticks ----
        const dataToClipX = (x: number) =>
            rectX0 + (x - this.viewXMin) / (this.viewXMax - this.viewXMin) * (rectX1 - rectX0);
        const dataToClipY = (y: number) =>
            rectY0 + (y - this.viewYMin) / (this.viewYMax - this.viewYMin) * (rectY1 - rectY0);

        const tickLenX = pixelX * 8;
        const tickLenY = pixelY * 8;
        const tickDir = style.tickDirection;
        // Inward/outward extents for each tick line endpoint relative to the border
        const xTickIn  = (tickDir === 'in'   || tickDir === 'both') ?  tickLenY : 0;  // into panel (Y+)
        const xTickOut = (tickDir === 'out'  || tickDir === 'both') ? -tickLenY : 0;  // outside panel (Y-)
        const yTickIn  = (tickDir === 'in'   || tickDir === 'both') ?  tickLenX : 0;  // into panel (X+)
        const yTickOut = (tickDir === 'out'  || tickDir === 'both') ? -tickLenX : 0;  // outside panel (X-)
        // Label offset: labels always sit beyond the outer end of the tick
        const xLabelOffsetPx = (tickDir === 'in' ? 4 : 8 + 4);  // px below the border
        const yLabelOffsetPx = (tickDir === 'in' ? 4 : 8 + 4);  // px left of the border

        // ---- Grid lines first (so tick marks render on top) ----
        if (style.grid.show) {
            const [gridR, gridG, gridB] = style.grid.color;
            for (const tick of xTicks) {
                const tx = dataToClipX(tick);
                verts.push(tx, rectY0, gridR, gridG, gridB,  tx, rectY1, gridR, gridG, gridB);
            }
            for (const tick of yTicks) {
                const ty = dataToClipY(tick);
                verts.push(rectX0, ty, gridR, gridG, gridB,  rectX1, ty, gridR, gridG, gridB);
            }
        }

        // ---- Tick marks (drawn after grid so they appear on top) ----
        for (const tick of xTicks) {
            const tx = dataToClipX(tick);
            verts.push(tx, rectY0 + xTickOut, cr, cg, cb,  tx, rectY0 + xTickIn, cr, cg, cb);
            const label = fmtX(tick);
            const lw = textWidthClip(label, font, fs, w);
            textVerts.push(...textToTriVerts(
                label, font,
                tx - lw / 2,
                rectY0 - pixelY * (fs * 0.75 + xLabelOffsetPx),
                fs, w, h, cr, cg, cb
            ));
        }

        for (const tick of yTicks) {
            const ty = dataToClipY(tick);
            verts.push(rectX0 + yTickOut, ty, cr, cg, cb,  rectX0 + yTickIn, ty, cr, cg, cb);
            const label = fmtY(tick);
            const lw = textWidthClip(label, font, fs, w);
            textVerts.push(...textToTriVerts(
                label, font,
                rectX0 - lw - pixelX * yLabelOffsetPx,
                ty - pixelY * fs * 0.35,
                fs, w, h, cr, cg, cb
            ));
        }

        // ---- Data series ----
        // Solid lines  → GPU compute path (no JS iteration, only binary-search + 80-byte write).
        // Dashed lines → GPU compute path (dashed compute shader + finalize shader + drawIndirect).

        const MAX = this.MAX_COMPUTE_SEGS;
        const MAX_DASHED = 5_000;   // max decimated segments per dashed series

        for (let si = 0; si < this.internalSeries.length; si++) {
            const series = this.internalSeries[si]!;
            const pattern = DASH_PATTERNS[series.lineStyle ?? '-'] ?? [];
            const isSolid = pattern.length === 0;
            const [dr, dg, db] = series.color ?? [0, 0.447, 0.741];  // MATLAB default blue
            const seriesAlpha = series.color?.[3] ?? 1.0;

            if (!isSolid) {
                // GPU compute path for dashed lines
                const dParamBuf = this.dashedParamBufs[si];
                if (!dParamBuf) { this.dashedNumSegs[si] = 0; continue; }

                const n = series.x.length;
                if (n < 2) { this.dashedNumSegs[si] = 0; continue; }

                // Binary search for visible X range
                let startI = 0, endI = n - 1;
                if (series.xSorted) {
                    let lo = 0, hi = n;
                    while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! < this.viewXMin) lo = mid + 1; else hi = mid; }
                    startI = Math.max(0, lo - 1);
                    lo = 0; hi = n;
                    while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! <= this.viewXMax) lo = mid + 1; else hi = mid; }
                    endI = Math.min(n - 1, lo);
                }
                const visibleSegs = endI - startI;
                const stride  = Math.max(1, Math.ceil(visibleSegs / MAX_DASHED));
                const numSegs = Math.ceil(visibleSegs / stride);
                this.dashedNumSegs[si] = numSegs;

                // Pad pattern array to 8 elements
                // Pattern values are in CSS pixels — no SSAA scaling needed
                const patPadded = new Float32Array(8);
                for (let k = 0; k < pattern.length; k++) patPadded[k] = pattern[k]!;

                // Fill 128-byte DashedParams uniform
                const dAB = new ArrayBuffer(128);
                const df  = new Float32Array(dAB);
                const du  = new Uint32Array(dAB);
                df[0]  = this.viewXMin; df[1]  = this.viewXMax; df[2]  = this.viewYMin; df[3]  = this.viewYMax;
                df[4]  = rectX0;        df[5]  = rectX1;        df[6]  = rectY0;        df[7]  = rectY1;
                df[8]  = w;             df[9]  = h;
                df[10] = (series.lineWidth ?? 1) / 2;   df[11] = dr!;
                df[12] = dg!;           df[13] = db!;   df[14] = seriesAlpha;
                // df[15] = _p1
                du[16] = startI;        du[17] = stride;        du[18] = numSegs;
                du[19] = this.MAX_DASHED_OUT_QUADS;
                du[20] = pattern.length;
                // du[21..23] = _pad
                df.set(patPadded, 24);  // pattern[8] at byte offset 96
                this.device.queue.writeBuffer(dParamBuf, 0, dAB);

                this.seriesOutCounts[si] = 0;
                continue;
            }

            // --- Compute path for solid lines ---
            const n = series.x.length;
            if (n < 2 || !this.seriesParamBufs[si]) { this.seriesOutCounts[si] = 0; continue; }

            // Binary search for visible X range (O(log N))
            let startI = 0, endI = n - 1;
            if (series.xSorted) {
                let lo = 0, hi = n;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! < this.viewXMin) lo = mid + 1; else hi = mid; }
                startI = Math.max(0, lo - 1);
                lo = 0; hi = n;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! <= this.viewXMax) lo = mid + 1; else hi = mid; }
                endI = Math.min(n - 1, lo);
            }
            const visibleSegs = endI - startI;
            const stride   = Math.max(1, Math.ceil(visibleSegs / MAX));
            const numSegs  = Math.ceil(visibleSegs / stride);
            this.seriesOutCounts[si] = numSegs * 6;

            // Fill 80-byte SeriesParams uniform
            const paramAB = new ArrayBuffer(80);
            const pf = new Float32Array(paramAB);
            const pu = new Uint32Array(paramAB);
            pf[0] = this.viewXMin; pf[1] = this.viewXMax; pf[2] = this.viewYMin; pf[3] = this.viewYMax;
            pf[4] = rectX0;        pf[5] = rectX1;        pf[6] = rectY0;        pf[7] = rectY1;
            pf[8] = w;             pf[9] = h;             pf[10] = (series.lineWidth ?? 1) / 2;  pf[11] = dr!;
            pf[12] = dg!;          pf[13] = db!;          pf[14] = seriesAlpha;
            // pf[15] = _pad1 (zero)
            pu[16] = startI;       pu[17] = stride;       pu[18] = numSegs;
            this.device.queue.writeBuffer(this.seriesParamBufs[si]!, 0, paramAB);
        }

        // ---- Marker params: binary-search visible range + write MarkerParams uniform ----
        for (let si = 0; si < this.internalSeries.length; si++) {
            const series  = this.internalSeries[si]!;
            const mkStyle = series.marker;
            if (!mkStyle || mkStyle.shape === 'none' || !this.markerParamBufs[si]) {
                this.markerOutCounts[si] = 0;
                continue;
            }
            const n = series.x.length;
            if (n === 0) { this.markerOutCounts[si] = 0; continue; }

            const [dr, dg, db] = series.color ?? [0, 0.447, 0.741];
            const seriesAlpha = series.color?.[3] ?? 1.0;

            // Resolve colours and alphas (null = inherit series color/alpha)
            const [fr, fg, fb] = mkStyle.faceColor ?? [dr!, dg!, db!];
            const faceA = mkStyle.faceColor === null ? 0.0 : (mkStyle.faceColor[3] ?? 1.0);
            const [er, eg, eb] = mkStyle.edgeColor ?? [dr!, dg!, db!];
            const edgeA = mkStyle.edgeColor === null ? seriesAlpha : (mkStyle.edgeColor[3] ?? 1.0);

            // Outer radius and inner radius in CSS pixels
            const outerR = mkStyle.size / 2;
            const ew     = mkStyle.edgeWidth;
            // innerR < 0 means no fill (hollow marker)
            // For hollow markers (faceColor === null): innerR is stored as -(outerR - edgeWidth).
            // Negative innerR signals "hollow" to the shader; its absolute value is the ring inner boundary.
            const innerR = mkStyle.faceColor === null ? -Math.max(0, outerR - ew) : Math.max(0, outerR - ew);

            // Binary search for visible X range
            let startI = 0, endI = n - 1;
            if (series.xSorted) {
                let lo = 0, hi = n;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! < this.viewXMin) lo = mid + 1; else hi = mid; }
                startI = Math.max(0, lo - 1);
                lo = 0; hi = n;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! <= this.viewXMax) lo = mid + 1; else hi = mid; }
                endI = Math.min(n - 1, lo);
            }
            const visiblePts = endI - startI + 1;
            const MAX_M  = this.MAX_MARKER_COUNT;
            const stride = Math.max(1, Math.ceil(visiblePts / MAX_M));
            const numPts = Math.ceil(visiblePts / stride);
            this.markerOutCounts[si] = numPts * 6;

            // Shape ID lookup
            const SHAPE_IDS: Record<string, number> = {
                'o': 0, '+': 1, '*': 2, '.': 3, 'x': 4, '_': 5, '|': 6,
                'square': 7, 'diamond': 8,
                '^': 9, 'v': 10, '>': 11, '<': 12,
                'pentagram': 13, 'hexagram': 14,
            };
            const shapeId = SHAPE_IDS[mkStyle.shape] ?? 0;

            // Fill 112-byte MarkerParams uniform
            const mAB = new ArrayBuffer(112);
            const mf  = new Float32Array(mAB);
            const mu  = new Uint32Array(mAB);
            mf[0]  = this.viewXMin; mf[1]  = this.viewXMax; mf[2]  = this.viewYMin; mf[3]  = this.viewYMax;
            mf[4]  = rectX0;       mf[5]  = rectX1;        mf[6]  = rectY0;        mf[7]  = rectY1;
            mf[8]  = w;            mf[9]  = h;             mf[10] = this.ssaaScale; mf[11] = outerR;
            mf[12] = innerR;       mf[13] = fr!;           mf[14] = fg!;           mf[15] = fb!;
            mf[16] = faceA;        mf[17] = er!;           mf[18] = eg!;           mf[19] = eb!;
            mu[20] = startI;       mu[21] = stride;        mu[22] = numPts;        mf[23] = edgeA;
            mu[24] = shapeId;      // mu[25..27] = _pad
            this.device.queue.writeBuffer(this.markerParamBufs[si]!, 0, mAB);
        }

        // ---- Title ----
        const titleText = this.figureOpts.title;
        if (titleText) {
            const titleW = textWidthClip(titleText, font, titleFs, w);
            const titleX = (rectX0 + rectX1) / 2 - titleW / 2;
            // Top of canvas in clip space = 1.0; title baseline is below paddingTop + titleCapH
            const titleBaselineClip = 1 - (o.paddingTop + titleFs * 0.75) * pixelY;
            // Use title baseline clip Y directly
            const titleY = 1 - o.paddingTop * pixelY;  // top of title cap
            titleVerts.push(...textToTriVerts(
                titleText, font,
                titleX,
                titleY - titleFs * 0.75 * pixelY,
                titleFs, w, h, cr, cg, cb
            ));
            void titleBaselineClip;
        }

        // ---- X Axis label ----
        const xAxisLabel = this.figureOpts.xlabel;
        if (xAxisLabel) {
            const lw = textWidthClip(xAxisLabel, font, fs, w);
            const lx = (rectX0 + rectX1) / 2 - lw / 2;
            // baseline sits paddingBottom pixels above canvas bottom
            const baselinePxFromTop = h - o.paddingBottom;
            const ly = 1 - baselinePxFromTop * pixelY;
            textVerts.push(...textToTriVerts(xAxisLabel, font, lx, ly, fs, w, h, cr, cg, cb));
        }

        // ---- Y Axis label (rotated 90° CCW) ----
        const yAxisLabel = this.figureOpts.ylabel;
        if (yAxisLabel) {
            const scalePx = fs / font.unitsPerEm;
            const sfX = 2.0 / w;
            const sfY = 2.0 / h;

            const pxVerts: number[] = [];
            let penPx = 0;
            for (const char of yAxisLabel) {
                const glyph = font.charToGlyph(char);
                const path  = glyph.getPath(0, 0, fs);
                const triXY = glyphToTriangles(path);
                for (let i = 0; i < triXY.length; i += 2) {
                    pxVerts.push(triXY[i]! + penPx, triXY[i+1]!, cr, cg, cb);
                }
                penPx += (glyph.advanceWidth ?? 0) * scalePx;
            }
            const labelWPx = penPx;
            for (let i = 0; i < pxVerts.length; i += 5) pxVerts[i]! - labelWPx / 2;

            // Center of the y-axis label: vertically centered on the plot
            const yLabelCenterClipY = (rectY0 + rectY1) / 2;
            // X position: paddingLeft + capH/2 from left in clip space
            const yLabelCenterClipX = -1 + (o.paddingLeft + fs * 0.75 / 2) * pixelX;

            for (let i = 0; i < pxVerts.length; i += 5) {
                const px = pxVerts[i]! - labelWPx / 2;
                const py = pxVerts[i+1]!;
                textVerts.push(
                     py * sfX + yLabelCenterClipX,
                     px * sfY + yLabelCenterClipY,
                    cr, cg, cb
                );
            }
        }

        // ---- Upload to GPU ----
        const mkBuf = (data: Float32Array, label: string): GPUBuffer => {
            const buf = this.device.createBuffer({
                label,
                size: Math.max(data.byteLength, 4),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
            });
            if (data.byteLength > 0) this.device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
            return buf;
        };

        const bgBuf       = mkBuf(new Float32Array(bgVerts),       "Panel BG verts");
        const vertexBuf   = mkBuf(new Float32Array(verts),        "Line verts");
        const textBuf     = mkBuf(new Float32Array(textVerts),     "Text verts");
        const titleBuf    = mkBuf(new Float32Array(titleVerts),    "Title verts");

        // Scissor rect for data clipping
        const W = w * this.ssaaScale, H = h * this.ssaaScale;
        const sci_x = Math.ceil ((rectX0 + 1) / 2 * W);
        const sci_y = Math.ceil ((1 - rectY1) / 2 * H);
        const sci_w = Math.floor((rectX1 + 1) / 2 * W) - sci_x;
        const sci_h = Math.floor((1 - rectY0) / 2 * H) - sci_y;

        const encoder = this.device.createCommandEncoder();

        // ---- Compute passes: one per solid series (before render pass) ----
        for (let si = 0; si < this.internalSeries.length; si++) {
            const numSegs = (this.seriesOutCounts[si] ?? 0) / 6;
            if (numSegs <= 0 || !this.seriesParamBufs[si]) continue;
            const pattern = DASH_PATTERNS[this.internalSeries[si]!.lineStyle ?? '-'] ?? [];
            if (pattern.length !== 0) continue;  // skip dashed series

            const bindGroup = this.device.createBindGroup({
                layout: this.computePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.seriesParamBufs[si]! } },
                    { binding: 1, resource: { buffer: this.seriesRawBufs[si]!   } },
                    { binding: 2, resource: { buffer: this.seriesOutBufs[si]!   } },
                ]
            });
            const computePass = encoder.beginComputePass();
            computePass.setPipeline(this.computePipeline);
            computePass.setBindGroup(0, bindGroup);
            computePass.dispatchWorkgroups(Math.ceil(numSegs / 64));
            computePass.end();
        }

        // ---- Compute passes: one per series with markers ----
        for (let si = 0; si < this.internalSeries.length; si++) {
            const numPts = (this.markerOutCounts[si] ?? 0) / 6;
            if (numPts <= 0 || !this.markerParamBufs[si] || !this.markerOutBufs[si]) continue;

            const bindGroup = this.device.createBindGroup({
                layout: this.markerComputePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.markerParamBufs[si]! } },
                    { binding: 1, resource: { buffer: this.seriesRawBufs[si]!   } },
                    { binding: 2, resource: { buffer: this.markerOutBufs[si]!   } },
                ]
            });
            const mPass = encoder.beginComputePass();
            mPass.setPipeline(this.markerComputePipeline);
            mPass.setBindGroup(0, bindGroup);
            mPass.dispatchWorkgroups(Math.ceil(numPts / 64));
            mPass.end();
        }

        // ---- Compute passes: one per dashed series ----
        for (let si = 0; si < this.internalSeries.length; si++) {
            const numSegs = this.dashedNumSegs[si] ?? 0;
            const dParamBuf    = this.dashedParamBufs[si];
            const dOutBuf      = this.dashedOutBufs[si];
            const dDrawArgsBuf = this.dashedDrawArgsBufs[si];
            if (numSegs <= 0 || !dParamBuf || !dOutBuf || !dDrawArgsBuf) continue;

            // Dispatch dashed compute shader (1 thread, sequential, writes drawArgs)
            const dBindGroup = this.device.createBindGroup({
                layout: this.dashedComputePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: dParamBuf    } },
                    { binding: 1, resource: { buffer: this.seriesRawBufs[si]! } },
                    { binding: 2, resource: { buffer: dOutBuf      } },
                    { binding: 3, resource: { buffer: dDrawArgsBuf } },
                ]
            });
            const dPass = encoder.beginComputePass();
            dPass.setPipeline(this.dashedComputePipeline);
            dPass.setBindGroup(0, dBindGroup);
            dPass.dispatchWorkgroups(1);   // single-threaded: 1 workgroup × 1 thread
            dPass.end();
        }

        // Pass 1: render into SSAA texture
        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: ssaaTexture.createView(),
                loadOp: "clear",
                clearValue: { r: style.background.figureColor[0], g: style.background.figureColor[1], b: style.background.figureColor[2], a: 1 },
                storeOp: "store"
            }]
        });

        renderPass.setPipeline(this.textPipeline);
        renderPass.setVertexBuffer(0, bgBuf);
        renderPass.draw(bgVerts.length / 5);

        renderPass.setPipeline(this.linePipeline);
        renderPass.setVertexBuffer(0, vertexBuf);
        renderPass.draw(verts.length / 5);

        // Draw data series within scissor rect
        renderPass.setScissorRect(sci_x, sci_y, sci_w, sci_h);
        renderPass.setPipeline(this.seriesLinePipeline);  // triangle-list, alpha blending

        // Solid series — draw from GPU compute output buffers
        for (let si = 0; si < this.internalSeries.length; si++) {
            const vertCount = this.seriesOutCounts[si] ?? 0;
            if (vertCount <= 0 || !this.seriesOutBufs[si]) continue;
            const pattern = DASH_PATTERNS[this.internalSeries[si]!.lineStyle ?? '-'] ?? [];
            if (pattern.length !== 0) continue;
            renderPass.setVertexBuffer(0, this.seriesOutBufs[si]!);
            renderPass.draw(vertCount);
        }

        // Dashed series — draw from GPU compute output buffer via drawIndirect
        for (let si = 0; si < this.internalSeries.length; si++) {
            const dOutBuf      = this.dashedOutBufs[si];
            const dDrawArgsBuf = this.dashedDrawArgsBufs[si];
            if (!dOutBuf || !dDrawArgsBuf) continue;
            renderPass.setVertexBuffer(0, dOutBuf);
            renderPass.drawIndirect(dDrawArgsBuf, 0);
        }

        // Markers — draw SDF quads from GPU compute output buffers
        renderPass.setPipeline(this.markerRenderPipeline);
        for (let si = 0; si < this.internalSeries.length; si++) {
            const vertCount = this.markerOutCounts[si] ?? 0;
            if (vertCount <= 0 || !this.markerOutBufs[si]) continue;
            renderPass.setVertexBuffer(0, this.markerOutBufs[si]!);
            renderPass.draw(vertCount);
        }

        renderPass.setScissorRect(0, 0, W, H);

        if (textVerts.length > 0) {
            renderPass.setPipeline(this.textPipeline);
            renderPass.setVertexBuffer(0, textBuf);
            renderPass.draw(textVerts.length / 5);
        }

        if (titleVerts.length > 0) {
            renderPass.setPipeline(this.titlePipeline);
            renderPass.setVertexBuffer(0, titleBuf);
            renderPass.draw(titleVerts.length / 5);
        }

        renderPass.end();

        // Pass 2: blit SSAA → canvas
        const blitBindGroup = this.device.createBindGroup({
            layout: this.blitPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.blitSampler },
                { binding: 1, resource: ssaaTexture.createView() },
            ]
        });
        const blitPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                loadOp: "clear",
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                storeOp: "store"
            }]
        });
        blitPass.setPipeline(this.blitPipeline);
        blitPass.setBindGroup(0, blitBindGroup);
        blitPass.draw(6);
        blitPass.end();

        this.device.queue.submit([encoder.finish()]);

        ssaaTexture.destroy();
        bgBuf.destroy(); vertexBuf.destroy(); textBuf.destroy(); titleBuf.destroy();
    }
}

// ---------------------------------------------------------------------------
// Plotter — top-level factory for figures
// ---------------------------------------------------------------------------

export class Plotter {
    private readonly opts: Required<PlotterOptions>;
    private font?: opentype.Font;
    private initialized = false;

    /**
     * @param opts  Global styling and layout options.
     *   - fontSize:            Base font size in px (tick labels, axis labels). Default 14.
     *   - titleFontSize:       Title font size in px. Default fontSize * 1.4.
     *   - fontUrl:             URL/path to a TTF/OTF font. Default bundled Roboto.
     *   - grid:                Show grid lines. Default true.
     *   - paddingLeft:         px from left canvas edge to left edge of y-axis label. Default 4.
     *   - paddingYLabelToYTicks: px from right edge of y-axis label to left side of y-tick value text. Default 6.
     *   - paddingTop:          px from top canvas edge to top of title text. Default 8.
     *   - paddingTitleToPlot:  px from bottom of title to top of plot area. Default 8.
     *   - paddingBottom:       px from bottom canvas edge to bottom of x-axis label. Default 4.
     *   - paddingXLabelToPlot: px from top of x-axis label to bottom of plot area. Default 6.
     *   - paddingRight:        px from right edge of plot area to right canvas edge. Default 12.
     */
    constructor(opts: PlotterOptions = {}) {
        const fs = opts.fontSize ?? 16;
        // Resolve style; respect legacy boolean `grid` option when style is not provided
        const style = opts.style ?? matlabStyle();
        // style.aspectRatio = 'equal'
        if (opts.grid !== undefined && opts.style === undefined) {
            style.grid.show = opts.grid;
        }
        this.opts = {
            fontSize:             fs,
            titleFontSize:        opts.titleFontSize        ?? Math.round(fs * 1.4),
            fontUrl:              opts.fontUrl              ?? "fonts/helvetica/roboto-13281/RobotoRegular-3m4L.ttf",
            grid:                 style.grid.show,
            paddingLeft:          opts.paddingLeft          ?? 20,
            paddingYLabelToYTicks:opts.paddingYLabelToYTicks ?? 10,
            paddingTop:           opts.paddingTop           ?? 8,
            paddingTitleToPlot:   opts.paddingTitleToPlot   ?? 8,
            paddingBottom:        opts.paddingBottom        ?? 8,
            paddingXLabelToPlot:  opts.paddingXLabelToPlot  ?? 6,
            paddingRight:         opts.paddingRight         ?? 20,
            style,
        };
    }

    /** Loads the font. Must be called (and awaited) before figure() / plot(). */
    async init(): Promise<void> {
        if (this.initialized) return;
        if (!navigator.gpu) throw new Error("WebGPU not supported");
        this.font = await opentype.load(this.opts.fontUrl);
        this.initialized = true;
    }

    /**
     * Creates a new plot window and appends it to the given container (default: document.body).
     * Returns the Figure instance (call render() on it, or use plot() which does it automatically).
     */
    async figure(figOpts: FigureOptions = {}, container?: HTMLElement): Promise<Figure> {
        if (!this.initialized) await this.init();
        const fullFigOpts: Required<FigureOptions> = {
            title:  figOpts.title  ?? '',
            xlabel: figOpts.xlabel ?? '',
            ylabel: figOpts.ylabel ?? '',
        };
        const fig = new Figure(this.opts, fullFigOpts);
        await fig.init(this.font!);
        (container ?? document.body).appendChild(fig.windowEl);
        return fig;
    }

    /**
     * Convenience method: creates a figure, sets data, and renders.
     * @param data   Array of { x, y } points (or PlotSeries for multi-series).
     * @param figOpts  Figure options (title, xlabel, ylabel).
     * @param container  DOM element to append the window to. Default: document.body.
     */
    async plot(
        data: { x: number | string | Date; y: number | string | Date }[] | PlotSeries[],
        figOpts: FigureOptions = {},
        container?: HTMLElement
    ): Promise<Figure> {
        const fig = await this.figure(figOpts, container);

        // Normalise input to PlotSeries[]
        let series: PlotSeries[];
        if (data.length === 0) {
            series = [];
        } else if ('color' in data[0]! || Array.isArray((data[0] as PlotSeries).x)) {
            series = data as PlotSeries[];
        } else {
            const pts = data as { x: number | string | Date; y: number | string | Date }[];
            series = [{ x: pts.map(p => p.x) as PlotSeries['x'], y: pts.map(p => p.y) as PlotSeries['y'] }];
        }

        fig.setData(series);
        fig.render();
        return fig;
    }
}
