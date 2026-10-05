import { MarkerStyle } from "./styles.js";
import type { AxisData, LineStyle, MarkerShape, RGBA } from "./styles.js";
import type { Axes } from "./axes.js";
import { markerShapeOf } from "./plot-args.js";

export interface LineInit {
    color: RGBA;
    lineStyle: LineStyle;
    lineWidth: number;
    marker: MarkerStyle | null;
    displayName: string;
}

/**
 * Handle to one plotted series (MATLAB's Line object). Property setters trigger a redraw.
 * Created by Axes.plot(); do not construct directly.
 */
export class Line {
    /** @internal numeric x (dates → ms, categories → index) */
    xs: Float64Array;
    /** @internal */
    ys: Float64Array;
    /** @internal true when xs is non-decreasing (enables O(log n) range culling) */
    sorted: boolean;
    /** @internal bumped whenever xs/ys change; GPU buffers are re-uploaded lazily */
    dataVersion = 0;

    private _color: RGBA;
    private _lineStyle: LineStyle;
    private _lineWidth: number;
    private _marker: MarkerStyle | null;
    private _displayName: string;
    private _visible = true;
    private deleted = false;

    /** @internal */
    constructor(readonly axes: Axes, xs: Float64Array, ys: Float64Array, sorted: boolean, init: LineInit) {
        this.xs = xs; this.ys = ys; this.sorted = sorted;
        this._color = init.color;
        this._lineStyle = init.lineStyle;
        this._lineWidth = init.lineWidth;
        this._marker = init.marker;
        this._displayName = init.displayName;
    }

    get color(): RGBA { return this._color; }
    set color(v: RGBA) { this._color = v; this.touch(); }

    get lineStyle(): LineStyle { return this._lineStyle; }
    set lineStyle(v: LineStyle) { this._lineStyle = v; this.touch(); }

    get lineWidth(): number { return this._lineWidth; }
    set lineWidth(v: number) { this._lineWidth = v; this.touch(); }

    get visible(): boolean { return this._visible; }
    set visible(v: boolean) { this._visible = v; this.touch(); }

    get displayName(): string { return this._displayName; }
    set displayName(v: string) { this._displayName = v; this.touch(); }

    /** Marker style object, or null when the line has no markers. */
    get marker(): MarkerStyle | null { return this._marker; }
    set marker(v: MarkerStyle | MarkerShape | null) {
        this._marker = v === null || v === 'none' ? null
                     : typeof v === 'string' ? Object.assign(new MarkerStyle(), { shape: markerShapeOf(v) })
                     : v;
        this.touch();
    }

    get markerSize(): number { return this._marker?.size ?? 0; }
    set markerSize(v: number) { this.ensureMarker().size = v; this.touch(); }

    get markerFaceColor(): RGBA | null { return this._marker?.faceColor ?? null; }
    set markerFaceColor(v: RGBA | null) { this.ensureMarker().faceColor = v; this.touch(); }

    get markerEdgeColor(): RGBA | null { return this._marker?.edgeColor ?? null; }
    set markerEdgeColor(v: RGBA | null) { this.ensureMarker().edgeColor = v; this.touch(); }

    /** Numeric x values (Date → ms since epoch, category → index). */
    get xData(): Float64Array { return this.xs; }
    get yData(): Float64Array { return this.ys; }
    get length(): number { return this.xs.length; }

    /** Replaces the data of this line and recomputes automatic axis limits. */
    setData(x: AxisData | null, y: AxisData): void {
        if (this.deleted) throw new Error('Line has been deleted');
        this.axes._replaceData(this, x, y);
    }

    /** Removes the line from its axes. */
    delete(): void {
        if (this.deleted) return;
        this.deleted = true;
        this.axes._removeLine(this);
    }

    private ensureMarker(): MarkerStyle {
        return this._marker ??= new MarkerStyle();
    }

    private touch(): void { if (!this.deleted) this.axes._lineStyleChanged(); }
}
