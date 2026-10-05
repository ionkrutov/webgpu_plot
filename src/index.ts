// Public entry point of the library.

export { Plotter } from "./plotter.js";
export { Figure } from "./figure.js";
export type { ExportFormat } from "./figure.js";
export { Axes } from "./axes.js";
export type { HoldState, LegendLocation, ViewSnapshot } from "./axes.js";
export { Line } from "./line.js";

export { GridStyle, BackgroundStyle, MarkerStyle, PlotStyle, matlabStyle } from "./styles.js";
export type {
    MarkerShape, LineStyle, RGB, RGBA, AxisData, NumericArray,
    PlotterOptions, FigureOptions, PlotSeries,
} from "./styles.js";
export type { LineProps } from "./plot-args.js";
export { COLOR_ORDER, parseFormat, parseColor } from "./format.js";
export { enumerateAdapters } from "./gpu-utils.js";
export type { AdapterOption } from "./gpu-utils.js";

// MATLAB-style functions: plot, subplot, hold, title, xlabel, ylabel, legend, xlim, ylim, ...
export * from "./matlab.js";
