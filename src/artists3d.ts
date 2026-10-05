import type { LineStyle, MarkerShape, RGB } from "./styles.js";

/** Receives change notifications from artists. */
export interface ArtistOwner { _artistChanged(): void }

/** Something drawn by an Axes3D. Change a property, then call invalidate() to redraw. */
export abstract class Artist3D {
    visible = true;
    /** @internal */ owner: ArtistOwner | null = null;
    invalidate(): void { this.owner?._artistChanged(); }
}

export class Line3D extends Artist3D {
    color: RGB = [0, 0.447, 0.741];
    lineStyle: LineStyle = '-';
    lineWidth = 1;
    marker: MarkerShape = 'none';
    markerSize = 6;
    markerFaceColor: RGB | 'none' | 'auto' = 'none';
    displayName = '';
    constructor(public x: Float64Array, public y: Float64Array, public z: Float64Array) { super(); }
}

export class Scatter3D extends Artist3D {
    /** Marker diameter in px: one value or one per point. */
    size: number | Float64Array = 6;
    /** One RGB colour, or one value per point mapped through the axes' colormap. */
    color: RGB | Float64Array = [0, 0.447, 0.741];
    filled = false;
    marker: MarkerShape = 'o';
    constructor(public x: Float64Array, public y: Float64Array, public z: Float64Array) { super(); }
}

export type FaceColor = 'flat' | 'interp' | 'none' | 'background' | RGB;
export type EdgeColor = 'flat' | 'none' | RGB;

/** A grid surface; point (i, j) is stored at i * cols + j. */
export class Surface3D extends Artist3D {
    faceColor: FaceColor = 'flat';
    edgeColor: EdgeColor = [0, 0, 0];
    lineWidth = 1;
    constructor(
        public x: Float64Array, public y: Float64Array, public z: Float64Array, public c: Float64Array,
        public readonly rows: number, public readonly cols: number,
    ) { super(); }
}

/** Contour lines: `segments[k]` holds x0, y0, z0, x1, y1, z1, ... for level `levels[k]`. */
export class Contour3D extends Artist3D {
    lineWidth = 1;
    constructor(public levels: number[], public segments: number[][]) { super(); }
}
