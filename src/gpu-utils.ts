/// <reference types="@webgpu/types" />

// ---------------------------------------------------------------------------
// GPU adapter enumeration
// ---------------------------------------------------------------------------

export interface AdapterOption {
    label: string;
    powerPreference: GPUPowerPreference | undefined;
    forceFallbackAdapter?: boolean;
}

let adapterCache: Promise<AdapterOption[]> | null = null;

/** Enumerates available GPU adapters once and caches the result. */
export function enumerateAdapters(): Promise<AdapterOption[]> {
    adapterCache ??= probeAdapters();
    return adapterCache;
}

async function probeAdapters(): Promise<AdapterOption[]> {
    const prefs: Array<GPUPowerPreference | undefined> = ['low-power', 'high-performance', undefined];
    const seen = new Set<string>();
    const options: AdapterOption[] = [];
    for (const pref of prefs) {
        const a = await navigator.gpu.requestAdapter(
            pref !== undefined ? { powerPreference: pref } : undefined
        );
        if (!a) continue;
        const info = a.info;
        const key = `${info.vendor}|${info.architecture}|${info.device}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const parts: string[] = [];
        if (info.description) parts.push(info.description);
        else if (info.vendor)  parts.push(info.vendor);
        if (info.architecture) parts.push(`(${info.architecture})`);
        const fallback = pref === 'high-performance' ? 'High-performance GPU'
                       : pref === 'low-power'        ? 'Low-power GPU'
                       :                               'Default GPU';
        options.push({ label: parts.length > 0 ? parts.join(' ') : fallback, powerPreference: pref });
    }

    // Software fallback (SwiftShader / Mesa LLVMpipe) — works when no native
    // WebGPU-capable driver is exposed (e.g. AMD iGPU in Brave without flags).
    if (options.length === 0) {
        const a = await navigator.gpu.requestAdapter({ forceFallbackAdapter: true });
        if (a) {
            const info = a.info;
            const parts: string[] = [];
            if (info.description) parts.push(info.description);
            else if (info.vendor)  parts.push(info.vendor);
            if (info.architecture) parts.push(`(${info.architecture})`);
            options.push({
                label: (parts.length > 0 ? parts.join(' ') : 'Software renderer') + ' (software)',
                powerPreference: undefined,
                forceFallbackAdapter: true,
            });
        }
    }

    return options;
}

// ---------------------------------------------------------------------------
// GrowBuffer — vertex buffer reused across frames; re-allocated only when too small
// ---------------------------------------------------------------------------

export class GrowBuffer {
    private buf: GPUBuffer | null = null;
    private cap = 0;
    private owner: GPUDevice | null = null;
    /** Number of vertices written by the last write(). */
    count = 0;

    constructor(private readonly label: string) {}

    get buffer(): GPUBuffer | null { return this.buf; }

    write(device: GPUDevice, data: number[], floatsPerVertex: number): void {
        const bytes = data.length * 4;
        if (bytes === 0) { this.count = 0; return; }
        if (!this.buf || this.owner !== device || this.cap < bytes) {
            this.buf?.destroy();
            this.cap = Math.max(bytes, this.cap * 2, 4096);
            this.buf = device.createBuffer({
                label: this.label,
                size: this.cap,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            this.owner = device;
        }
        device.queue.writeBuffer(this.buf, 0, new Float32Array(data));
        this.count = data.length / floatsPerVertex;
    }

    /** Drops the GPU buffer (e.g. after a device switch). */
    destroy(): void {
        this.buf?.destroy();
        this.buf = null; this.cap = 0; this.owner = null; this.count = 0;
    }
}

