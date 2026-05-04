// ---------------------------------------------------------------------------
// Style classes — visual appearance of the plot (defaults mimic ggplot2 theme_gray)
// ---------------------------------------------------------------------------

/** Configures grid line appearance. */
export class GridStyle {
    /** Show grid lines. Default: true */
    show: boolean = true;
    /** Grid line color [r, g, b], each in [0, 1]. Default: white [1, 1, 1] (ggplot2 style) */
    color: [number, number, number] = [1, 1, 1];
    /** Grid line width in CSS pixels. Default: 1 */
    lineWidth: number = 1;
}

/** Configures plot background colors. */
export class BackgroundStyle {
    /** Plot panel fill color [r, g, b]. Default: ggplot2 grey92 ≈ [0.922, 0.922, 0.922] */
    panelColor: [number, number, number] = [0.922, 0.922, 0.922];
    /** Canvas/figure background color [r, g, b]. Default: white [1, 1, 1] */
    figureColor: [number, number, number] = [1, 1, 1];
}

// ---------------------------------------------------------------------------
// MarkerStyle — per-series marker appearance
// ---------------------------------------------------------------------------

/** Supported marker shapes. */
export type MarkerShape =
    | 'o'           // circle (default)
    | '+' | '*' | '.' | 'x' | '_' | '|'
    | 'square' | 'diamond'
    | '^' | 'v' | '>' | '<'
    | 'pentagram' | 'hexagram'
    | 'none';

/**
 * Visual style for data-point markers on a series.
 *
 * Defaults mimic MATLAB: circular marker, no fill, edge color inherits the
 * series line color, edge width 1 px.
 *
 * Usage:
 *   const m = new MarkerStyle();
 *   m.shape           = 'o';      // circle (default)
 *   m.size            = 8;        // diameter in CSS pixels
 *   m.edgeColor       = [0, 0, 1]; // blue border
 *   m.faceColor       = [1, 1, 1]; // white fill
 *   m.edgeWidth       = 1.5;
 */
export class MarkerStyle {
    /** Marker shape. Default: 'o' (circle). */
    shape: MarkerShape = 'o';
    /** Marker diameter in CSS pixels. Default: 6 */
    size: number = 10;
    /**
     * Fill color [r, g, b] for the marker interior.
     * Default: null — no fill (hollow marker, MATLAB default).
     * Set to a color to fill the interior, e.g. [1, 1, 1] for white.
     */
    faceColor: [number, number, number, number?] | null = null;
    /**
     * Edge (border) color [r, g, b] or [r, g, b, a].
     * Default: null — inherits the series line color and alpha.
     */
    edgeColor: [number, number, number, number?] | null = null;
    /** Edge (border) line width in CSS pixels. Default: 1 */
    edgeWidth: number = 1;
}

/** Visual style for the entire plot. Defaults mimic ggplot2 theme_gray. */
export class PlotStyle {
    /** Grid line appearance. */
    grid: GridStyle = new GridStyle();
    /** Background colors. */
    background: BackgroundStyle = new BackgroundStyle();
    /** Color for axis lines, ticks, and tick labels [r, g, b]. Default: ggplot2 grey30 */
    axisColor: [number, number, number] = [0.302, 0.302, 0.302];
    /**
     * Direction of axis ticks relative to the plot panel.
     * - 'in'   — ticks point inward into the panel (default)
     * - 'out'  — ticks point outward beyond the axes border (MATLAB style)
     * - 'both' — ticks extend both inward and outward
     */
    tickDirection: 'in' | 'out' | 'both' = 'in';
    /**
     * Aspect ratio constraint for the plot panel.
     * - 'auto'  — panel fills all available space (default)
     * - 'equal' — one data unit on X equals one data unit on Y in screen pixels;
     *             the panel is centered and the excess dimension is cropped.
     */
    aspectRatio: 'auto' | 'equal' = 'auto';
}

/**
 * MATLAB-style theme preset.
 * White panel, white figure, black axes/labels, light-gray dashed grid.
 *
 * Usage:
 *   const p = new Plotter({ style: matlabStyle() });
 */
export function matlabStyle(): PlotStyle {
    const s = new PlotStyle();
    s.background.panelColor  = [1, 1, 1];
    s.background.figureColor = [1, 1, 1];
    s.axisColor              = [0, 0, 0];
    s.grid.show      = true;
    s.grid.color     = [0.75, 0.75, 0.75];  // ≈ MATLAB default grid grey
    s.grid.lineWidth = 2;
    s.tickDirection  = 'in';
    return s;
}

// ---------------------------------------------------------------------------
// PlotterOptions — configures the Plotter instance
// ---------------------------------------------------------------------------

export interface PlotterOptions {
    /** Base font size in pixels (used for tick labels and axis labels). Default: 14 */
    fontSize?: number;
    /** Title font size in pixels. Default: fontSize * 1.4 */
    titleFontSize?: number;
    /** Font family URL/path to load via opentype.js. */
    fontUrl?: string;
    /** Show grid lines. Default: true */
    grid?: boolean;

    // --- Padding dimensions (all in pixels) ---

    /** Distance from the left edge of the canvas to the left edge of the y-axis label. Default: 4 */
    paddingLeft?: number;
    /** Distance from the right edge of the y-axis label to the left side of the y-tick value text. Default: 6 */
    paddingYLabelToYTicks?: number;
    /** Distance from the top edge of the canvas to the top of the title text. Default: 8 */
    paddingTop?: number;
    /** Distance from the bottom of the title to the top edge of the plot area. Default: 8 */
    paddingTitleToPlot?: number;
    /** Distance from the bottom edge of the canvas to the bottom of the x-axis label. Default: 4 */
    paddingBottom?: number;
    /** Distance from the top of the x-axis label to the bottom edge of the plot area. Default: 6 */
    paddingXLabelToPlot?: number;
    /** Distance from the right edge of the plot area to the right edge of the canvas. Default: 12 */
    paddingRight?: number;
    /** Visual style for grid lines and background. Defaults match ggplot2 theme_gray. */
    style?: PlotStyle;
}

// ---------------------------------------------------------------------------
// FigureOptions — per-figure settings (title, axis labels, data)
// ---------------------------------------------------------------------------

export interface FigureOptions {
    /** Title shown above the plot. Default: '' */
    title?: string;
    /** X-axis label. Default: '' */
    xlabel?: string;
    /** Y-axis label. Default: '' */
    ylabel?: string;
}

// ---------------------------------------------------------------------------
// PlotSeries — one data series
// ---------------------------------------------------------------------------

export interface PlotSeries {
    x: number[] | string[] | Date[];
    y: number[] | string[] | Date[];
    /** RGB or RGBA colour, each in [0, 1]. 4th element is alpha (default 1.0). */
    color?: [number, number, number, number?];
    /** Line style. Default: '-' (solid). Use 'none' to draw markers only (scatter plot). */
    lineStyle?: '-' | '--' | ':' | '-.' | 'none';
    /** Line width in CSS pixels. Default: 1.5 */
    lineWidth?: number;
    /**
     * Marker style. When provided, a marker is drawn at each data point.
     * Set to `new MarkerStyle()` for a default circle marker.
     * Default: undefined (no markers).
     */
    marker?: MarkerStyle;
}
