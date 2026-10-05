/// <reference types="@webgpu/types" />
import { DASHED_BYTES_PER_QUAD, MARKER_BYTES_PER_PT, SOLID_BYTES_PER_SEG } from "./gpu-context.js";
import type { GpuContext } from "./gpu-context.js";
import type { LineStyle } from "./styles.js";

export type LineMode = 'solid' | 'dashed' | 'none';

/** On/off pixel lengths (CSS px) for each line style. */
export const DASH_PATTERNS: Record<string, number[]> = {
    '-':  [],
    '--': [8, 8],
    ':':  [2, 4],
    '-.': [8, 4, 4, 6],
};

export function modeOf(style: LineStyle): LineMode {
    if (style === 'none') return 'none';
    return (DASH_PATTERNS[style]?.length ?? 0) === 0 ? 'solid' : 'dashed';
}

/** Marks "no point here" (NaN/Inf) inside float32 storage; the compute shaders treat it as a gap. */
export const GAP = 1e38;

/** GPU resources of one series on one device. */
export class LineGpu {
    readonly raw: GPUBuffer;
    dataVersion = -1;
    originVersion = -1;

    readonly maxSegs: number;
    readonly maxMarkers: number;

    readonly solid: { out: GPUBuffer; param: GPUBuffer; bind: GPUBindGroup } | null = null;
    readonly marker: { out: GPUBuffer; param: GPUBuffer; bind: GPUBindGroup } | null = null;
    readonly dashed: { out: GPUBuffer; param: GPUBuffer; args: GPUBuffer; bind: GPUBindGroup } | null = null;

    /** Vertices to draw this frame (set by Axes.prepare). */
    solidVerts = 0;
    markerVerts = 0;
    dashedSegs = 0;

    constructor(
        readonly gpu: GpuContext,
        readonly n: number,
        readonly mode: LineMode,
        readonly hasMarker: boolean,
    ) {
        const dev = gpu.device;
        this.maxSegs    = Math.max(1, Math.min(n - 1, gpu.maxSegs));
        this.maxMarkers = Math.max(1, Math.min(n, gpu.maxMarkers));

        this.raw = dev.createBuffer({
            label: 'series raw',
            size: Math.max(n * 8, 8),
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        const uniform = (size: number, label: string) => dev.createBuffer({
            label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const outBuf = (size: number, label: string) => dev.createBuffer({
            label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
        });

        if (mode === 'solid') {
            const out = outBuf(this.maxSegs * SOLID_BYTES_PER_SEG, 'solid out');
            const param = uniform(80, 'solid params');
            const bind = dev.createBindGroup({
                layout: gpu.solidComputePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: param } },
                    { binding: 1, resource: { buffer: this.raw } },
                    { binding: 2, resource: { buffer: out } },
                ],
            });
            this.solid = { out, param, bind };
        }

        if (hasMarker) {
            const out = outBuf(this.maxMarkers * MARKER_BYTES_PER_PT, 'marker out');
            const param = uniform(112, 'marker params');
            const bind = dev.createBindGroup({
                layout: gpu.markerComputePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: param } },
                    { binding: 1, resource: { buffer: this.raw } },
                    { binding: 2, resource: { buffer: out } },
                ],
            });
            this.marker = { out, param, bind };
        }

        if (mode === 'dashed') {
            const out = outBuf(gpu.maxDashQuads * DASHED_BYTES_PER_QUAD, 'dashed out');
            const param = uniform(128, 'dashed params');
            const args = dev.createBuffer({
                label: 'dashed draw args', size: 16,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
            });
            dev.queue.writeBuffer(args, 0, new Uint32Array([0, 1, 0, 0]));
            const bind = dev.createBindGroup({
                layout: gpu.dashedComputePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: param } },
                    { binding: 1, resource: { buffer: this.raw } },
                    { binding: 2, resource: { buffer: out } },
                    { binding: 3, resource: { buffer: args } },
                ],
            });
            this.dashed = { out, param, args, bind };
        }
    }

    matches(n: number, mode: LineMode, hasMarker: boolean): boolean {
        return this.n === n && this.mode === mode && this.hasMarker === hasMarker;
    }

    /** Uploads x/y relative to (ox, oy) so float32 keeps full precision for dates and large offsets. */
    upload(xs: Float64Array, ys: Float64Array, ox: number, oy: number): void {
        const raw = new Float32Array(this.n * 2);
        for (let i = 0; i < this.n; i++) {
            const x = xs[i]!, y = ys[i]!;
            if (Number.isFinite(x) && Number.isFinite(y)) { raw[i * 2] = x - ox; raw[i * 2 + 1] = y - oy; }
            else { raw[i * 2] = GAP; raw[i * 2 + 1] = GAP; }
        }
        if (raw.byteLength > 0) this.gpu.device.queue.writeBuffer(this.raw, 0, raw);
    }

    /** Resets the indirect draw so a series that is currently off-screen draws nothing. */
    clearDashed(): void {
        if (this.dashed) this.gpu.device.queue.writeBuffer(this.dashed.args, 0, new Uint32Array([0, 1, 0, 0]));
    }

    destroy(): void {
        this.raw.destroy();
        for (const g of [this.solid, this.marker, this.dashed]) {
            g?.out.destroy();
            g?.param.destroy();
        }
        this.dashed?.args.destroy();
    }
}
