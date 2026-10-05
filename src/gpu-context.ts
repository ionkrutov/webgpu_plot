/// <reference types="@webgpu/types" />
import {
    blitShaderCode, shaderCode, seriesLineShaderCode,
    computeShaderCode, markerComputeShaderCode, markerShaderCode,
    dashedComputeShaderCode,
} from "./shaders.js";
import type { AdapterOption } from "./gpu-utils.js";

/** Bytes written by the solid-line compute shader per segment (6 verts × 6 floats). */
export const SOLID_BYTES_PER_SEG = 36 * 4;
/** Bytes written by the marker compute shader per marker (6 verts × 15 floats). */
export const MARKER_BYTES_PER_PT = 90 * 4;
/** Bytes written by the dashed compute shader per dash quad. */
export const DASHED_BYTES_PER_QUAD = 36 * 4;

const MAX_SEGS_CAP    = 1_000_000;
const MAX_MARKERS_CAP = 150_000;
const MAX_DASH_QUADS  = 65_536;

/** MSAA sample count of the scene render target (4 is the only count WebGPU guarantees). */
export const MSAA_SAMPLES = 4;

type Listener = () => void;

/**
 * One GPUDevice plus every pipeline the library needs. Shared by all figures that use
 * the same adapter; reference counted so the device is destroyed with the last figure.
 */
export class GpuContext {
    private static cache = new Map<string, Promise<GpuContext>>();

    readonly format: GPUTextureFormat;
    readonly sampler: GPUSampler;

    readonly textPipeline: GPURenderPipeline;
    readonly linePipeline: GPURenderPipeline;
    readonly seriesLinePipeline: GPURenderPipeline;
    readonly markerRenderPipeline: GPURenderPipeline;
    readonly blitPipeline: GPURenderPipeline;
    readonly solidComputePipeline: GPUComputePipeline;
    readonly markerComputePipeline: GPUComputePipeline;
    readonly dashedComputePipeline: GPUComputePipeline;

    /** Largest number of line segments / markers / dash quads a single series may emit per frame. */
    readonly maxSegs: number;
    readonly maxMarkers: number;
    readonly maxDashQuads: number;

    private refs = 0;
    private destroyed = false;
    private readonly lostListeners = new Set<Listener>();

    private constructor(readonly device: GPUDevice, readonly key: string) {
        this.format = navigator.gpu.getPreferredCanvasFormat();

        const storageLimit = Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
        this.maxSegs      = Math.max(1, Math.min(MAX_SEGS_CAP,    Math.floor(storageLimit / SOLID_BYTES_PER_SEG)));
        this.maxMarkers   = Math.max(1, Math.min(MAX_MARKERS_CAP, Math.floor(storageLimit / MARKER_BYTES_PER_PT)));
        this.maxDashQuads = Math.max(1, Math.min(MAX_DASH_QUADS,  Math.floor(storageLimit / DASHED_BYTES_PER_QUAD)));

        const fmt = this.format;
        const alphaBlend: GPUBlendState = {
            color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { operation: 'add', srcFactor: 'one',       dstFactor: 'zero' },
        };

        const flatModule = device.createShaderModule({ code: shaderCode });
        const flatLayout: GPUVertexBufferLayout = {
            arrayStride: 20,
            attributes: [
                { format: "float32x2", offset: 0, shaderLocation: 0 },
                { format: "float32x3", offset: 8, shaderLocation: 1 },
            ],
        };
        const flat = (topology: GPUPrimitiveTopology): GPURenderPipeline => device.createRenderPipeline({
            layout: "auto",
            vertex:   { module: flatModule, entryPoint: "vertexMain",   buffers: [flatLayout] },
            fragment: { module: flatModule, entryPoint: "fragmentMain", targets: [{ format: fmt }] },
            primitive: { topology },
            multisample: { count: MSAA_SAMPLES },
        });
        this.linePipeline = flat("line-list");
        this.textPipeline = flat("triangle-list");

        const seriesModule = device.createShaderModule({ code: seriesLineShaderCode });
        this.seriesLinePipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: seriesModule, entryPoint: 'vsSeriesLine',
                buffers: [{
                    arrayStride: 24,
                    attributes: [
                        { format: 'float32x2', offset: 0, shaderLocation: 0 },
                        { format: 'float32x4', offset: 8, shaderLocation: 1 },
                    ],
                }],
            },
            fragment: { module: seriesModule, entryPoint: 'fsSeriesLine', targets: [{ format: fmt, blend: alphaBlend }] },
            primitive: { topology: 'triangle-list' },
            multisample: { count: MSAA_SAMPLES },
        });

        const markerModule = device.createShaderModule({ code: markerShaderCode });
        this.markerRenderPipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: markerModule, entryPoint: 'vsMarker',
                buffers: [{
                    arrayStride: 15 * 4,
                    attributes: [
                        { shaderLocation: 0, offset:  0, format: 'float32x2' },  // clipPos
                        { shaderLocation: 1, offset:  8, format: 'float32x2' },  // localPos (ssaa px)
                        { shaderLocation: 2, offset: 16, format: 'float32x2' },  // radii
                        { shaderLocation: 3, offset: 24, format: 'float32x4' },  // face rgba
                        { shaderLocation: 4, offset: 40, format: 'float32x4' },  // edge rgba
                        { shaderLocation: 5, offset: 56, format: 'float32'   },  // shapeId
                    ],
                }],
            },
            fragment: { module: markerModule, entryPoint: 'fsMarker', targets: [{ format: fmt, blend: alphaBlend }] },
            primitive: { topology: 'triangle-list' },
            multisample: { count: MSAA_SAMPLES },
        });

        const blitModule = device.createShaderModule({ code: blitShaderCode });
        this.blitPipeline = device.createRenderPipeline({
            layout: "auto",
            vertex:   { module: blitModule, entryPoint: "vsMain" },
            fragment: { module: blitModule, entryPoint: "fsMain", targets: [{ format: fmt }] },
            primitive: { topology: "triangle-list" },
        });
        this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });

        const compute = (code: string, entryPoint: string): GPUComputePipeline => device.createComputePipeline({
            layout: "auto",
            compute: { module: device.createShaderModule({ code }), entryPoint },
        });
        this.solidComputePipeline  = compute(computeShaderCode,       "csMain");
        this.markerComputePipeline = compute(markerComputeShaderCode, "csMarker");
        this.dashedComputePipeline = compute(dashedComputeShaderCode, "csDashed");

        void device.lost.then(() => {
            if (this.destroyed) return;
            this.destroyed = true;
            GpuContext.cache.delete(key);
            for (const cb of [...this.lostListeners]) cb();
        });
    }

    /** Returns the shared context for an adapter option; call release() when done. */
    static acquire(option: AdapterOption): Promise<GpuContext> {
        const key = `${option.powerPreference ?? 'default'}|${option.forceFallbackAdapter ? 'fallback' : 'hw'}`;
        let pending = GpuContext.cache.get(key);
        if (!pending) {
            pending = GpuContext.create(option, key);
            GpuContext.cache.set(key, pending);
            pending.catch(() => GpuContext.cache.delete(key));
        }
        return pending.then(ctx => { ctx.refs++; return ctx; });
    }

    private static async create(option: AdapterOption, key: string): Promise<GpuContext> {
        if (!navigator.gpu) throw new Error("WebGPU is not supported in this browser");
        const adapterOpts: GPURequestAdapterOptions = {};
        if (option.powerPreference !== undefined) adapterOpts.powerPreference = option.powerPreference;
        if (option.forceFallbackAdapter) adapterOpts.forceFallbackAdapter = true;
        const adapter = await navigator.gpu.requestAdapter(
            Object.keys(adapterOpts).length > 0 ? adapterOpts : undefined
        );
        if (!adapter) throw new Error("No GPUAdapter found");
        const device = await adapter.requestDevice({
            requiredLimits: {
                maxBufferSize: adapter.limits.maxBufferSize,
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            },
        });
        return new GpuContext(device, key);
    }

    get isLost(): boolean { return this.destroyed; }

    /** Called when the device is lost for any reason other than release(). */
    onLost(cb: Listener): () => void {
        this.lostListeners.add(cb);
        return () => { this.lostListeners.delete(cb); };
    }

    release(): void {
        if (--this.refs > 0 || this.destroyed) return;
        this.destroyed = true;
        GpuContext.cache.delete(this.key);
        this.device.destroy();
    }
}
