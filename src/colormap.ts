import type { RGB } from "./styles.js";

const BASE_NAMES = [
    'parula', 'viridis', 'plasma', 'inferno', 'magma', 'cividis', 'turbo', 'coolwarm',
    'jet', 'hot', 'gray', 'bone', 'copper', 'cool', 'spring', 'summer', 'autumn', 'winter', 'hsv',
] as const;

type BaseName = typeof BASE_NAMES[number];

/** A built-in colormap; append `_r` to reverse it (e.g. 'viridis_r'). */
export type ColormapName = BaseName | `${BaseName}_r`;

export const COLORMAP_NAMES: readonly BaseName[] = BASE_NAMES;

const STOPS: Partial<Record<BaseName, readonly RGB[]>> = {
    parula: [
        [0.2422, 0.1504, 0.6603], [0.2810, 0.3228, 0.9579], [0.1786, 0.5289, 0.9682], [0.0689, 0.6948, 0.8394],
        [0.2161, 0.7843, 0.5923], [0.6720, 0.7793, 0.2227], [0.9970, 0.7659, 0.2199], [0.9769, 0.9839, 0.0805],
    ],
    viridis: [
        [0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.530], [0.207, 0.372, 0.553],
        [0.164, 0.471, 0.558], [0.128, 0.567, 0.551], [0.135, 0.659, 0.518], [0.267, 0.749, 0.441],
        [0.478, 0.821, 0.318], [0.741, 0.873, 0.150], [0.993, 0.906, 0.144],
    ],
    plasma: [
        [0.050, 0.030, 0.528], [0.254, 0.014, 0.615], [0.417, 0.001, 0.658], [0.562, 0.052, 0.641],
        [0.692, 0.165, 0.564], [0.798, 0.280, 0.470], [0.881, 0.392, 0.383], [0.949, 0.517, 0.295],
        [0.988, 0.652, 0.211], [0.994, 0.805, 0.145], [0.940, 0.975, 0.131],
    ],
    inferno: [
        [0.001, 0.000, 0.014], [0.087, 0.044, 0.224], [0.258, 0.039, 0.406], [0.416, 0.090, 0.433],
        [0.578, 0.148, 0.404], [0.735, 0.216, 0.330], [0.865, 0.317, 0.226], [0.954, 0.468, 0.100],
        [0.988, 0.645, 0.040], [0.964, 0.843, 0.273], [0.988, 0.998, 0.645],
    ],
    magma: [
        [0.001, 0.000, 0.014], [0.079, 0.054, 0.211], [0.232, 0.059, 0.437], [0.390, 0.100, 0.502],
        [0.550, 0.161, 0.506], [0.716, 0.215, 0.475], [0.869, 0.288, 0.409], [0.967, 0.439, 0.360],
        [0.995, 0.624, 0.427], [0.996, 0.812, 0.572], [0.987, 0.991, 0.749],
    ],
    cividis: [
        [0.000, 0.135, 0.305], [0.000, 0.200, 0.430], [0.235, 0.270, 0.430], [0.340, 0.340, 0.430],
        [0.430, 0.410, 0.425], [0.520, 0.485, 0.420], [0.610, 0.560, 0.410], [0.710, 0.640, 0.385],
        [0.810, 0.725, 0.345], [0.910, 0.815, 0.280], [0.995, 0.910, 0.220],
    ],
    coolwarm: [
        [0.230, 0.299, 0.754], [0.552, 0.691, 0.996], [0.865, 0.865, 0.865], [0.957, 0.598, 0.476], [0.706, 0.016, 0.150],
    ],
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function fromStops(stops: readonly RGB[], t: number): RGB {
    const x = clamp01(t) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    const a = stops[i]!, b = stops[i + 1]!;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function hsv(h: number): RGB {
    const f = (n: number) => {
        const k = (n + h * 6) % 6;
        return 1 - Math.max(Math.min(k, 4 - k, 1), 0);
    };
    return [f(5), f(3), f(1)];
}

/** Polynomial fit of the Turbo colormap (Mikhailov, Google). */
function turbo(t: number): RGB {
    const p = (c: number[]) => c.reduceRight((acc, k) => acc * t + k, 0);
    return [
        clamp01(p([0.13572138, 4.61539260, -42.66032258, 132.13108234, -152.94239396, 59.28637943])),
        clamp01(p([0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604])),
        clamp01(p([0.10667330, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973])),
    ];
}

function builtin(name: BaseName, t: number): RGB {
    t = clamp01(t);
    switch (name) {
        case 'jet':    return [clamp01(1.5 - Math.abs(4 * t - 3)), clamp01(1.5 - Math.abs(4 * t - 2)), clamp01(1.5 - Math.abs(4 * t - 1))];
        case 'hot':    return [clamp01(t / 0.375), clamp01((t - 0.375) / 0.375), clamp01((t - 0.75) / 0.25)];
        case 'gray':   return [t, t, t];
        case 'bone':   return [7 / 8 * t + clamp01((t - 0.75) / 0.25) / 8, 7 / 8 * t + clamp01((t - 0.375) / 0.375) / 8, 7 / 8 * t + clamp01(t / 0.375) / 8];
        case 'copper': return [clamp01(1.25 * t), 0.7812 * t, 0.4975 * t];
        case 'cool':   return [t, 1 - t, 1];
        case 'spring': return [1, t, 1 - t];
        case 'summer': return [t, 0.5 + t / 2, 0.4];
        case 'autumn': return [1, t, 0];
        case 'winter': return [0, t, 1 - t / 2];
        case 'hsv':    return hsv(t);
        case 'turbo':  return turbo(t);
        default:       return fromStops(STOPS[name]!, t);
    }
}

export const LUT_SIZE = 256;

/** Colormap lookup table: LUT_SIZE entries of r, g, b. `spec` is a built-in name or a list of colours. */
export function buildLut(spec: ColormapName | readonly RGB[]): Float32Array {
    if (typeof spec !== 'string' && spec.length < 2) throw new Error('colormap: need at least two colours');
    const reversed = typeof spec === 'string' && spec.endsWith('_r');
    const base = typeof spec === 'string' ? (reversed ? spec.slice(0, -2) : spec) as BaseName : null;
    if (base !== null && !BASE_NAMES.includes(base)) {
        throw new Error(`Unknown colormap "${spec as string}"; available: ${BASE_NAMES.join(', ')} (append _r to reverse)`);
    }
    const lut = new Float32Array(LUT_SIZE * 3);
    for (let i = 0; i < LUT_SIZE; i++) {
        const t = reversed ? 1 - i / (LUT_SIZE - 1) : i / (LUT_SIZE - 1);
        const c = base !== null ? builtin(base, t) : fromStops(spec as readonly RGB[], t);
        lut[i * 3] = c[0]; lut[i * 3 + 1] = c[1]; lut[i * 3 + 2] = c[2];
    }
    return lut;
}

/** Writes the colour for value `v` in [lo, hi] into `out[o..o+2]`; NaN maps to the first colour. */
export function lookup(lut: Float32Array, v: number, lo: number, hi: number, out: ArrayLike<number> & { [i: number]: number }, o: number): void {
    const t = hi > lo && Number.isFinite(v) ? clamp01((v - lo) / (hi - lo)) : 0;
    const i = Math.round(t * (LUT_SIZE - 1)) * 3;
    out[o] = lut[i]!; out[o + 1] = lut[i + 1]!; out[o + 2] = lut[i + 2]!;
}
