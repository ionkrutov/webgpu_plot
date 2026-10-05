import { Figure } from "./figure.js";
import { loadFont } from "./font.js";
import type { FontSource } from "./font.js";
import { isData } from "./plot-args.js";
import { matlabStyle } from "./styles.js";
import type { FigureOptions, PlotSeries, PlotterOptions, ResolvedOptions } from "./styles.js";

type PointList = { x: number | string | Date; y: number | string | Date }[];

/**
 * Holds shared options (fonts, paddings, style) and creates figures.
 * For MATLAB-style scripting without an instance, see the functions exported from matlab.ts.
 */
export class Plotter {
    readonly opts: ResolvedOptions;
    private readonly fontSource: FontSource;

    /**
     * @param opts  Global styling and layout options (all optional).
     *   - fontSize / titleFontSize: px. Default 16 / fontSize × 1.4.
     *   - fontUrl / font:           custom TTF/OTF (URL or bytes). Default: bundled Roboto Regular.
     *   - grid:                     show grid lines (when `style` is not given). Default true.
     *   - padding*:                 px margins around the plot area, see PlotterOptions.
     *   - style:                    PlotStyle; default matlabStyle().
     */
    constructor(opts: PlotterOptions = {}) {
        const fs = opts.fontSize ?? 16;
        const style = opts.style ?? matlabStyle();
        if (opts.grid !== undefined && opts.style === undefined) style.grid.show = opts.grid;
        this.opts = {
            fontSize:              fs,
            titleFontSize:         opts.titleFontSize ?? Math.round(fs * 1.4),
            paddingLeft:           opts.paddingLeft ?? 20,
            paddingYLabelToYTicks: opts.paddingYLabelToYTicks ?? 10,
            paddingTop:            opts.paddingTop ?? 8,
            paddingTitleToPlot:    opts.paddingTitleToPlot ?? 8,
            paddingBottom:         opts.paddingBottom ?? 8,
            paddingXLabelToPlot:   opts.paddingXLabelToPlot ?? 6,
            paddingRight:          opts.paddingRight ?? 20,
            style,
        };
        this.fontSource = { url: opts.fontUrl, data: opts.font };
    }

    /** Preloads the font. Optional: figures load it on demand. */
    async init(): Promise<void> {
        await loadFont(this.fontSource);
    }

    /**
     * Creates a figure and appends it to `container` (element or CSS selector; default: document.body).
     * Returns immediately; GPU setup continues in the background (await `fig.ready` if needed).
     */
    figure(figOpts: FigureOptions = {}, container?: HTMLElement | string): Figure {
        return new Figure(this.opts, this.fontSource, figOpts, container);
    }

    /**
     * Creates a figure with one axes showing the given data.
     * @param data  Array of PlotSeries, or an array of { x, y } points.
     */
    plot(
        data: PointList | PlotSeries[],
        figOpts: FigureOptions = {},
        container?: HTMLElement | string,
    ): Figure {
        const fig = this.figure(figOpts, container);
        if (data.length === 0) return fig;
        const first = data[0]!;
        if (isData(first.y)) {
            fig.setData(data as PlotSeries[]);
        } else {
            const pts = data as PointList;
            fig.setData([{
                x: pts.map(p => p.x) as PlotSeries['x'],
                y: pts.map(p => p.y) as PlotSeries['y'],
            }]);
        }
        return fig;
    }
}
