/// <reference types="@webgpu/types" />
import { shader3dCode } from "./shaders3d.js";

export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

/** Floats per vertex / instance of the 3-D vertex streams. */
export const TRI_FLOATS = 10;
export const LINE_FLOATS = 14;
export const MARKER_FLOATS = 15;

export interface Pipelines3D {
    tri: GPURenderPipeline;
    line: GPURenderPipeline;
    marker: GPURenderPipeline;
}

export function createPipelines3D(device: GPUDevice, format: GPUTextureFormat, sampleCount: number): Pipelines3D {
    const module = device.createShaderModule({ code: shader3dCode });
    const blend: GPUBlendState = {
        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    const depth = (bias = 0): GPUDepthStencilState => ({
        format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less-equal',
        depthBias: bias, depthBiasSlopeScale: bias,
    });
    const make = (vs: string, fs: string, layout: GPUVertexBufferLayout, bias = 0): GPURenderPipeline =>
        device.createRenderPipeline({
            layout: 'auto',
            vertex: { module, entryPoint: vs, buffers: [layout] },
            fragment: { module, entryPoint: fs, targets: [{ format, blend }] },
            primitive: { topology: 'triangle-list' },
            depthStencil: depth(bias),
            multisample: { count: sampleCount },
        });

    return {
        // Faces are pushed back slightly so that edges drawn on them stay visible.
        tri: make('vsTri', 'fsTri', {
            arrayStride: TRI_FLOATS * 4,
            attributes: [
                { shaderLocation: 0, offset: 0,  format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
                { shaderLocation: 2, offset: 24, format: 'float32x4' },
            ],
        }, 1),
        line: make('vsLine', 'fsLine', {
            arrayStride: LINE_FLOATS * 4, stepMode: 'instance',
            attributes: [
                { shaderLocation: 0, offset: 0,  format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
                { shaderLocation: 2, offset: 24, format: 'float32x4' },
                { shaderLocation: 3, offset: 40, format: 'float32x4' },
            ],
        }),
        marker: make('vsMarker', 'fsMarker', {
            arrayStride: MARKER_FLOATS * 4, stepMode: 'instance',
            attributes: [
                { shaderLocation: 0, offset: 0,  format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x4' },
                { shaderLocation: 2, offset: 28, format: 'float32x4' },
                { shaderLocation: 3, offset: 44, format: 'float32x4' },
            ],
        }),
    };
}
