/**
 * MATLAB-style scripting API: plot(), hold(), subplot(), title() ... operating on the
 * "current figure" and "current axes". Everything is synchronous; GPU setup happens in the background.
 *
 *   figure("#chart");
 *   subplot(2, 1, 1); plot(t, y, "r--"); title("signal"); legend("raw");
 *   subplot(2, 1, 2); plot(t, y2); hold("on"); plot(t, y3, "k");
 */
import { Axes } from "./axes.js";
import type { HoldState, LegendLocation } from "./axes.js";
import { Axes3D } from "./axes3d.js";
import type { Contour3D, Line3D, Scatter3D, Surface3D } from "./artists3d.js";
import { contourData } from "./args3d.js";
import { buildLut, lookup } from "./colormap.js";
import type { ColormapName } from "./colormap.js";
import { parseColor } from "./format.js";
import { Figure } from "./figure.js";
import { Plotter } from "./plotter.js";
import type { Line } from "./line.js";
import type { AxisData, FigureOptions, PlotterOptions, RGB } from "./styles.js";

let defaultPlotter = new Plotter();
const open = new Set<Figure>();
let current: Figure | null = null;

/** Sets fonts/paddings/style used by figures created afterwards. */
export function setup(opts: PlotterOptions): void {
    defaultPlotter = new Plotter(opts);
}

/** Creates a figure and makes it current. `figure(container?, options?)` or `figure(options)`. */
export function figure(containerOrOptions?: HTMLElement | string | FigureOptions, options: FigureOptions = {}): Figure {
    const isContainer = typeof containerOrOptions === 'string' || containerOrOptions instanceof HTMLElement;
    const fig = isContainer
        ? defaultPlotter.figure(options, containerOrOptions)
        : defaultPlotter.figure(containerOrOptions ?? options);
    open.add(fig);
    current = fig;
    return fig;
}

/** Current figure (created on demand). */
export function gcf(): Figure {
    if (!current || current.isDestroyed) {
        current = [...open].reverse().find(f => !f.isDestroyed) ?? figure();
    }
    return current;
}

/** Current axes (created on demand). */
export function gca(): Axes { return gcf().gca(); }

/** Destroys a figure (default: current), or every figure with 'all'. */
export function close(target: Figure | 'all' = gcf()): void {
    const list = target === 'all' ? [...open] : [target];
    for (const f of list) { f.destroy(); open.delete(f); }
    if (current && current.isDestroyed) current = null;
}

export function clf(): Figure { return gcf().clf(); }
export function cla(): Axes { return gca().cla(); }

/** subplot(m, n, p) or the three-digit shorthand subplot(221). `p` may be an array of cells. */
export function subplot(code: number): Axes;
export function subplot(rows: number, cols: number, p: number | readonly number[]): Axes;
export function subplot(a: number, b?: number, p?: number | readonly number[]): Axes {
    if (b === undefined || p === undefined) {
        if (!Number.isInteger(a) || a < 111 || a > 999) throw new Error('subplot: expected subplot(m, n, p) or a three-digit code like 221');
        return gcf().subplot(Math.floor(a / 100), Math.floor(a / 10) % 10, a % 10);
    }
    return gcf().subplot(a, b, p);
}

export function tiledlayout(rows: number, cols: number): Figure { return gcf().tiledlayout(rows, cols); }
export function nexttile(p?: number | readonly number[]): Axes { return gcf().nexttile(p); }
export function sgtitle(text: string): Figure { return gcf().sgtitle(text); }

/** Plots into the current axes; see Axes.plot() for the accepted arguments. */
export function plot(...args: unknown[]): Line[] { return gcf().gca2d().plot(...args); }
export function scatter(x: AxisData, y: AxisData, ...rest: unknown[]): Line[] { return gcf().gca2d().scatter(x, y, ...rest); }

export function hold(state?: HoldState): Axes { return gca().hold(state); }
export function title(text: string): Axes { return gca().title(text); }
export function xlabel(text: string): Axes { return gca().xlabel(text); }
export function ylabel(text: string): Axes { return gca().ylabel(text); }
export function grid(state?: HoldState): Axes { return gca().grid(state); }
export function axis(mode: 'equal' | 'auto' | 'tight'): Axes { return gca().axis(mode); }
export function legend(...args: Array<string | false | { location?: LegendLocation }>): Axes { return gca().legend(...args); }

export function xlim(): [number, number];
export function xlim(range: readonly [number | Date, number | Date] | 'auto'): Axes;
export function xlim(range?: readonly [number | Date, number | Date] | 'auto'): [number, number] | Axes {
    const a = gca();
    return range === undefined ? a.xlim() : a.xlim(range);
}

export function ylim(): [number, number];
export function ylim(range: readonly [number | Date, number | Date] | 'auto'): Axes;
export function ylim(range?: readonly [number | Date, number | Date] | 'auto'): [number, number] | Axes {
    const a = gca();
    return range === undefined ? a.ylim() : a.ylim(range);
}

/** Links pan/zoom of several axes along 'x', 'y' or 'xy'. */
export function linkaxes(axes: readonly Axes[], dim: 'x' | 'y' | 'xy' = 'xy'): void { Axes.link(axes, dim); }

/** Downloads the current figure as png, jpeg or pdf. */
export function saveas(format: 'png' | 'jpeg' | 'pdf' = 'png', filename?: string): Promise<void> {
    return gcf().download(format, filename);
}

// ---------------------------------------------------------------------------
// 3-D plots
// ---------------------------------------------------------------------------

/** Current axes as 3-D axes; empty 2-D axes are converted in place. */
export function gca3(): Axes3D { return gcf().gca3(); }

/** plot3(x, y, z [, 'r--o'] [, { LineWidth }]): lines in 3-D. */
export function plot3(...args: unknown[]): Line3D[] { return gca3().plot3(...args); }
/** scatter3(x, y, z [, size [, color]] [, 'filled']). */
export function scatter3(...args: unknown[]): Scatter3D { return gca3().scatter3(...args); }
/** surf(Z), surf(X, Y, Z [, C]) [, 'EdgeColor', 'none', 'FaceColor', 'interp']: lit, colour-mapped surface. */
export function surf(...args: unknown[]): Surface3D { return gca3().surf(...args); }
/** mesh(Z), mesh(X, Y, Z [, C]): wireframe surface with hidden lines removed. */
export function mesh(...args: unknown[]): Surface3D { return gca3().mesh(...args); }
/** contour3(Z [, levels]), contour3(X, Y, Z [, levels]): contour lines at their z level. */
export function contour3(...args: unknown[]): Contour3D { return gca3().contour3(...args); }

/** contour(Z [, levels]), contour(X, Y, Z [, levels] [, { Colormap, Color, LineWidth }]): 2-D contour lines. */
export function contour(...args: unknown[]): Line[] {
    const { levels, segments, rest } = contourData(args);
    const o = (rest[0] ?? {}) as Record<string, unknown>;
    let cmap: ColormapName | readonly RGB[] = 'parula', fixed: RGB | null = null, width = 1;
    for (const [k, v] of Object.entries(o)) {
        switch (k.toLowerCase()) {
            case 'colormap': cmap = v as ColormapName | readonly RGB[]; break;
            case 'color': fixed = parseColor(v as string | number[]).slice(0, 3) as RGB; break;
            case 'linewidth': width = +(v as number); break;
            default: throw new Error(`contour: unknown property "${k}"`);
        }
    }
    const lut = buildLut(cmap), rgb = [0, 0, 0];
    const lo = levels[0] ?? 0, hi = levels[levels.length - 1] ?? 1;
    const series = levels.flatMap((level, k) => {
        const seg = segments[k]!;
        if (seg.length === 0) return [];
        const x: number[] = [], y: number[] = [];
        for (let i = 0; i + 3 < seg.length; i += 4) x.push(seg[i]!, seg[i + 2]!, NaN), y.push(seg[i + 1]!, seg[i + 3]!, NaN);
        lookup(lut, level, lo, hi, rgb, 0);
        return [{ x, y, color: fixed ?? [rgb[0]!, rgb[1]!, rgb[2]!] as RGB, lineWidth: width }];
    });
    return series.length > 0 ? gcf().gca2d().plot(series) : [];
}

function axes3(fn: string): Axes3D {
    const a = gca();
    if (!(a instanceof Axes3D)) throw new Error(`${fn}: the current axes is 2-D; create 3-D axes with plot3, surf or mesh first`);
    return a;
}

export function zlabel(text: string): Axes3D { return axes3('zlabel').zlabel(text); }

export function zlim(): [number, number];
export function zlim(range: readonly [number | Date, number | Date] | 'auto'): Axes3D;
export function zlim(range?: readonly [number | Date, number | Date] | 'auto'): [number, number] | Axes3D {
    const a = axes3('zlim');
    return range === undefined ? a.zlim() : a.zlim(range);
}

/** view(azimuth, elevation) in degrees (MATLAB's default is view(-37.5, 30)); view() returns the angles. */
export function view(): [number, number];
export function view(az: number, el: number): Axes3D;
export function view(az?: number, el?: number): [number, number] | Axes3D {
    const a = axes3('view');
    return az === undefined || el === undefined ? a.view() as [number, number] : a.view(az, el) as Axes3D;
}

/** colormap(name) — see COLORMAP_NAMES, append '_r' to reverse — or a list of [r, g, b] colours. */
export function colormap(spec: ColormapName | readonly RGB[]): Axes3D { return axes3('colormap').colormap(spec) as Axes3D; }

/** caxis([lo, hi]) sets the colour limits, caxis('auto') uses the data range. */
export function caxis(range: readonly [number, number] | 'auto'): Axes3D { return axes3('caxis').caxis(range) as Axes3D; }

/** Shows or hides the colour bar of the current 3-D axes. */
export function colorbar(state?: HoldState): Axes3D { return axes3('colorbar').colorbar(state); }

/** shading('flat' | 'faceted' | 'interp') for the surfaces of the current axes. */
export function shading(mode: 'flat' | 'faceted' | 'interp'): Axes3D { return axes3('shading').shading(mode); }
