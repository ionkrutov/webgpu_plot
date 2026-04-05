/// <reference types="@webgpu/types" />

// ---------------------------------------------------------------------------
// GPU adapter enumeration
// ---------------------------------------------------------------------------

export interface AdapterOption {
    label: string;
    powerPreference: GPUPowerPreference | undefined;
}

export async function enumerateAdapters(): Promise<AdapterOption[]> {
    const prefs: Array<GPUPowerPreference | undefined> = ['high-performance', 'low-power', undefined];
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
    return options;
}

