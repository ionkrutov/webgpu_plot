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
import { Figure } from "./figure.js";
import { Plotter } from "./plotter.js";
import type { Line } from "./line.js";
import type { AxisData, FigureOptions, PlotterOptions } from "./styles.js";

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
export function plot(...args: unknown[]): Line[] { return gca().plot(...args); }
export function scatter(x: AxisData, y: AxisData, ...rest: unknown[]): Line[] { return gca().scatter(x, y, ...rest); }

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
