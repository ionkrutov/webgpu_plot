import type { MarkerStyle, RGBA } from "./styles.js";

export const SHAPE_IDS: Record<string, number> = {
    'o': 0, '+': 1, '*': 2, '.': 3, 'x': 4, '_': 5, '|': 6,
    'square': 7, 'diamond': 8,
    '^': 9, 'v': 10, '>': 11, '<': 12,
    'pentagram': 13, 'hexagram': 14,
};

export interface ResolvedMarker {
    /** Outer radius in CSS px. */
    outerR: number;
    /** Inner radius in CSS px; negative marks a hollow (unfilled) marker. */
    innerR: number;
    face: [number, number, number, number];
    edge: [number, number, number, number];
    shapeId: number;
}

/** Resolves inherited colours/alpha and the hollow-marker radius encoding used by the marker shaders. */
export function resolveMarker(mk: MarkerStyle, color: RGBA): ResolvedMarker {
    const [r, g, b] = color;
    const alpha = color[3] ?? 1;
    const fc = mk.faceColor, ec = mk.edgeColor;
    const outerR = mk.size / 2;
    const ring = Math.max(0, outerR - mk.edgeWidth);
    return {
        outerR,
        innerR: fc === null ? -ring : ring,
        face: fc ? [fc[0], fc[1], fc[2], fc[3] ?? 1] : [r, g, b, 0],
        edge: ec ? [ec[0], ec[1], ec[2], ec[3] ?? 1] : [r, g, b, alpha],
        shapeId: SHAPE_IDS[mk.shape] ?? 0,
    };
}

/**
 * Appends one marker quad (6 vertices × 15 floats) in the layout the marker render pipeline expects.
 * Mirrors markerComputeShaderCode; used for legend samples that bypass the compute path.
 */
export function pushMarkerQuad(
    out: number[], cx: number, cy: number,
    w: number, h: number, scale: number, m: ResolvedMarker
): void {
    const hw = w / 2, hh = h / 2;
    const qr = m.outerR + (m.outerR - Math.abs(m.innerR));
    const qx0 = (cx - qr) / hw - 1, qx1 = (cx + qr) / hw - 1;
    const qy0 = 1 - (cy - qr) / hh, qy1 = 1 - (cy + qr) / hh;
    const Q = qr * scale;
    const lx = [-Q, -Q, Q, -Q, Q, Q];
    const ly = [-Q, Q, Q, -Q, Q, -Q];
    const px = [qx0, qx0, qx1, qx0, qx1, qx1];
    const py = [qy0, qy1, qy1, qy0, qy1, qy0];
    for (let v = 0; v < 6; v++) {
        out.push(px[v]!, py[v]!, lx[v]!, ly[v]!, m.outerR * scale, m.innerR * scale, ...m.face, ...m.edge, m.shapeId);
    }
}
