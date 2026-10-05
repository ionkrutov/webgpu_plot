/// <reference types="opentype.js" />
import * as opentype from "opentype.js";
import earcut from "earcut";


// ---------------------------------------------------------------------------
// Converts an opentype.js Path into line-list vertex data (clip space).
// ---------------------------------------------------------------------------

export function subdivideQ(
    verts: number[],
    x0: number, y0: number,
    x1: number, y1: number,
    x2: number, y2: number,
    r: number, g: number, b: number,
    scaleX: number, scaleY: number,
    tolerance: number,
    depth: number
): void {
    const mx = 0.25*x0 + 0.5*x1 + 0.25*x2;
    const my = 0.25*y0 + 0.5*y1 + 0.25*y2;
    const cx = 0.5*(x0 + x2);
    const cy = 0.5*(y0 + y2);
    const dx = (mx - cx) * scaleX;
    const dy = (my - cy) * scaleY;
    const err = Math.sqrt(dx*dx + dy*dy);
    if (err < tolerance || depth >= 10) {
        verts.push(x0, y0, r, g, b,  x2, y2, r, g, b);
        return;
    }
    const lx1 = 0.5*(x0 + x1), ly1 = 0.5*(y0 + y1);
    const rx1 = 0.5*(x1 + x2), ry1 = 0.5*(y1 + y2);
    const midX = 0.5*(lx1 + rx1), midY = 0.5*(ly1 + ry1);
    subdivideQ(verts, x0, y0, lx1, ly1, midX, midY, r, g, b, scaleX, scaleY, tolerance, depth + 1);
    subdivideQ(verts, midX, midY, rx1, ry1, x2, y2, r, g, b, scaleX, scaleY, tolerance, depth + 1);
}

export function subdivideC(
    verts: number[],
    x0: number, y0: number,
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number,
    r: number, g: number, b: number,
    scaleX: number, scaleY: number,
    tolerance: number,
    depth: number
): void {
    const chordX = x3 - x0, chordY = y3 - y0;
    const chordLen2 = chordX*chordX + chordY*chordY + 1e-10;
    const d1 = Math.abs((x1 - x0)*chordY - (y1 - y0)*chordX) / Math.sqrt(chordLen2);
    const d2 = Math.abs((x2 - x0)*chordY - (y2 - y0)*chordX) / Math.sqrt(chordLen2);
    const err = Math.max(d1, d2) * Math.max(Math.abs(scaleX), Math.abs(scaleY));
    if (err < tolerance || depth >= 12) {
        verts.push(x0, y0, r, g, b,  x3, y3, r, g, b);
        return;
    }
    const ax = 0.5*(x0+x1), ay = 0.5*(y0+y1);
    const bx = 0.5*(x1+x2), by = 0.5*(y1+y2);
    const cx_ = 0.5*(x2+x3), cy_ = 0.5*(y2+y3);
    const dx_ = 0.5*(ax+bx), dy_ = 0.5*(ay+by);
    const ex = 0.5*(bx+cx_), ey = 0.5*(by+cy_);
    const mx = 0.5*(dx_+ex), my = 0.5*(dy_+ey);
    subdivideC(verts, x0, y0, ax, ay, dx_, dy_, mx, my, r, g, b, scaleX, scaleY, tolerance, depth + 1);
    subdivideC(verts, mx, my, ex, ey, cx_, cy_, x3, y3, r, g, b, scaleX, scaleY, tolerance, depth + 1);
}

export function glyphToLineSegments(
    path: opentype.Path,
    r: number, g: number, b: number,
    canvasWidth: number,
    canvasHeight: number,
    tolerance = 0.35
): number[] {
    const verts: number[] = [];
    let cx = 0, cy = 0;
    let startX = 0, startY = 0;
    const scaleX = canvasWidth  / 2.0;
    const scaleY = canvasHeight / 2.0;
    for (const cmd of path.commands) {
        if (cmd.type === 'M') {
            cx = cmd.x; cy = cmd.y;
            startX = cx; startY = cy;
        } else if (cmd.type === 'L') {
            verts.push(cx, cy, r, g, b,  cmd.x, cmd.y, r, g, b);
            cx = cmd.x; cy = cmd.y;
        } else if (cmd.type === 'Q') {
            subdivideQ(verts, cx, cy, cmd.x1, cmd.y1, cmd.x, cmd.y,
                       r, g, b, scaleX, scaleY, tolerance, 0);
            cx = cmd.x; cy = cmd.y;
        } else if (cmd.type === 'C') {
            subdivideC(verts, cx, cy, cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y,
                       r, g, b, scaleX, scaleY, tolerance, 0);
            cx = cmd.x; cy = cmd.y;
        } else if (cmd.type === 'Z') {
            verts.push(cx, cy, r, g, b,  startX, startY, r, g, b);
            cx = startX; cy = startY;
        }
    }
    return verts;
}

export function textWidthClip(text: string, font: opentype.Font, fontSize: number, canvasWidth: number): number {
    const scale = fontSize / font.unitsPerEm * (2.0 / canvasWidth);
    let w = 0;
    for (const char of text) {
        w += (font.charToGlyph(char).advanceWidth ?? 0) * scale;
    }
    return w;
}

export function flattenQ(
    pts: number[],
    x0: number, y0: number,
    x1: number, y1: number,
    x2: number, y2: number,
    scaleX: number, scaleY: number,
    tolerance: number, depth: number
): void {
    const mx = 0.25*x0 + 0.5*x1 + 0.25*x2;
    const my = 0.25*y0 + 0.5*y1 + 0.25*y2;
    const cx = 0.5*(x0+x2), cy = 0.5*(y0+y2);
    const dx = (mx-cx)*scaleX, dy = (my-cy)*scaleY;
    if (Math.sqrt(dx*dx + dy*dy) < tolerance || depth >= 10) {
        pts.push(x2, y2); return;
    }
    const lx1 = 0.5*(x0+x1), ly1 = 0.5*(y0+y1);
    const rx1 = 0.5*(x1+x2), ry1 = 0.5*(y1+y2);
    const midX = 0.5*(lx1+rx1), midY = 0.5*(ly1+ry1);
    flattenQ(pts, x0, y0, lx1, ly1, midX, midY, scaleX, scaleY, tolerance, depth+1);
    flattenQ(pts, midX, midY, rx1, ry1, x2, y2, scaleX, scaleY, tolerance, depth+1);
}

export function flattenC(
    pts: number[],
    x0: number, y0: number,
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number,
    scaleX: number, scaleY: number,
    tolerance: number, depth: number
): void {
    const chordX = x3-x0, chordY = y3-y0;
    const chordLen2 = chordX*chordX + chordY*chordY + 1e-10;
    const d1 = Math.abs((x1-x0)*chordY - (y1-y0)*chordX) / Math.sqrt(chordLen2);
    const d2 = Math.abs((x2-x0)*chordY - (y2-y0)*chordX) / Math.sqrt(chordLen2);
    if (Math.max(d1, d2) * Math.max(Math.abs(scaleX), Math.abs(scaleY)) < tolerance || depth >= 12) {
        pts.push(x3, y3); return;
    }
    const ax = 0.5*(x0+x1), ay = 0.5*(y0+y1);
    const bx = 0.5*(x1+x2), by = 0.5*(y1+y2);
    const cx_ = 0.5*(x2+x3), cy_ = 0.5*(y2+y3);
    const dx_ = 0.5*(ax+bx), dy_ = 0.5*(ay+by);
    const ex = 0.5*(bx+cx_), ey = 0.5*(by+cy_);
    const mx = 0.5*(dx_+ex), my = 0.5*(dy_+ey);
    flattenC(pts, x0, y0, ax, ay, dx_, dy_, mx, my, scaleX, scaleY, tolerance, depth+1);
    flattenC(pts, mx, my, ex, ey, cx_, cy_, x3, y3, scaleX, scaleY, tolerance, depth+1);
}

export function signedArea2D(pts: number[]): number {
    let area = 0;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += pts[i*2]! * pts[j*2+1]! - pts[j*2]! * pts[i*2+1]!;
    }
    return area / 2;
}

export function glyphToTriangles(path: opentype.Path, tolerance = 0.05): number[] {
    const scaleX = 1.0, scaleY = 1.0;
    const contours: number[][] = [];
    let current: number[] = [];
    let cx = 0, cy = 0;
    for (const cmd of path.commands) {
        if (cmd.type === 'M') {
            cx = cmd.x; cy = cmd.y;
            current = [cx, cy];
        } else if (cmd.type === 'L') {
            current.push(cmd.x, cmd.y);
            cx = cmd.x; cy = cmd.y;
        } else if (cmd.type === 'Q') {
            flattenQ(current, cx, cy, cmd.x1, cmd.y1, cmd.x, cmd.y, scaleX, scaleY, tolerance, 0);
            cx = cmd.x; cy = cmd.y;
        } else if (cmd.type === 'C') {
            flattenC(current, cx, cy, cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y, scaleX, scaleY, tolerance, 0);
            cx = cmd.x; cy = cmd.y;
        } else if (cmd.type === 'Z') {
            if (current.length >= 6) contours.push(current);
            current = [];
        }
    }
    if (current.length >= 6) contours.push(current);
    if (contours.length === 0) return [];

    const outers: number[][] = [];
    const holes:  number[][] = [];
    for (const c of contours) {
        (signedArea2D(c) >= 0 ? outers : holes).push(c);
    }
    const outerList = outers.length > 0 ? outers : contours;
    const holeList  = outers.length > 0 ? holes  : [];

    const triXY: number[] = [];
    for (const outer of outerList) {
        const holeIndices: number[] = [];
        let flat = [...outer];
        for (const h of holeList) {
            holeIndices.push(flat.length / 2);
            flat = flat.concat(h);
        }
        const indices = earcut(flat, holeIndices.length > 0 ? holeIndices : undefined, 2);
        for (const idx of indices) {
            triXY.push(flat[idx*2]!, flat[idx*2+1]!);
        }
    }
    return triXY;
}

export function textToTriVerts(
    text: string,
    font: opentype.Font,
    penClipX: number,
    baselineClipY: number,
    fontSize: number,
    canvasWidth: number,
    canvasHeight: number,
    r: number, g: number, b: number
): number[] {
    const sfX = 2.0 / canvasWidth;
    const sfY = 2.0 / canvasHeight;
    const scale = fontSize / font.unitsPerEm;
    const verts: number[] = [];
    for (const char of text) {
        const glyph = font.charToGlyph(char);
        const path = glyph.getPath(0, 0, fontSize);
        const triXY = glyphToTriangles(path);
        for (let i = 0; i < triXY.length; i += 2) {
            const px = triXY[i]!;
            const py = triXY[i+1]!;
            verts.push(
                 px * sfX + penClipX,
                -py * sfY + baselineClipY,
                r, g, b
            );
        }
        penClipX += (glyph.advanceWidth ?? 0) * scale * sfX;
    }
    return verts;
}


// ---------------------------------------------------------------------------
// Cached text meshes (pixel space, baseline origin, Y down — opentype convention)
// ---------------------------------------------------------------------------

export interface TextMesh {
    /** Interleaved x,y triangle-list vertices in pixels. */
    xy: Float32Array;
    /** Advance width in pixels. */
    width: number;
}

const MESH_CACHE_LIMIT = 4000;
const meshCache  = new WeakMap<opentype.Font, Map<string, TextMesh>>();
const glyphCache = new WeakMap<opentype.Font, Map<string, number[]>>();

function cacheFor<V>(store: WeakMap<opentype.Font, Map<string, V>>, font: opentype.Font): Map<string, V> {
    let m = store.get(font);
    if (!m) { m = new Map(); store.set(font, m); }
    return m;
}

export function textWidthPx(text: string, font: opentype.Font, fontSize: number): number {
    const scale = fontSize / font.unitsPerEm;
    let w = 0;
    for (const ch of text) w += (font.charToGlyph(ch).advanceWidth ?? 0) * scale;
    return w;
}

export function textMesh(text: string, font: opentype.Font, fontSize: number): TextMesh {
    const meshes = cacheFor(meshCache, font);
    const key = fontSize + '|' + text;
    const hit = meshes.get(key);
    if (hit) return hit;

    const glyphs = cacheFor(glyphCache, font);
    const scale = fontSize / font.unitsPerEm;
    const out: number[] = [];
    let pen = 0;
    let prev: opentype.Glyph | null = null;
    for (const ch of text) {
        const glyph = font.charToGlyph(ch);
        if (prev) pen += font.getKerningValue(prev, glyph) * scale;
        prev = glyph;
        const gKey = fontSize + '|' + ch;
        let tris = glyphs.get(gKey);
        if (!tris) { tris = glyphToTriangles(glyph.getPath(0, 0, fontSize)); glyphs.set(gKey, tris); }
        for (let i = 0; i < tris.length; i += 2) out.push(tris[i]! + pen, tris[i + 1]!);
        pen += (glyph.advanceWidth ?? 0) * scale;
    }
    const mesh: TextMesh = { xy: Float32Array.from(out), width: pen };
    if (meshes.size >= MESH_CACHE_LIMIT) meshes.clear();
    meshes.set(key, mesh);
    return mesh;
}

/** Appends clip-space vertices (x,y,r,g,b) for text whose baseline-left is at (penXpx, baselineYpx) from the top-left. */
export function pushText(
    out: number[], mesh: TextMesh,
    penXpx: number, baselineYpx: number,
    w: number, h: number,
    r: number, g: number, b: number
): void {
    const sx = 2 / w, sy = 2 / h, xy = mesh.xy;
    for (let i = 0; i < xy.length; i += 2) {
        out.push((penXpx + xy[i]!) * sx - 1, 1 - (baselineYpx + xy[i + 1]!) * sy, r, g, b);
    }
}

/** Same as pushText but rotated 90° CCW (reads bottom-to-top), centred on (centerYpx) along the baseline. */
export function pushTextRotated(
    out: number[], mesh: TextMesh,
    baselineXpx: number, centerYpx: number,
    w: number, h: number,
    r: number, g: number, b: number
): void {
    const sx = 2 / w, sy = 2 / h, xy = mesh.xy, half = mesh.width / 2;
    for (let i = 0; i < xy.length; i += 2) {
        const screenX = baselineXpx + xy[i + 1]!;
        const screenY = centerYpx - (xy[i]! - half);
        out.push(screenX * sx - 1, 1 - screenY * sy, r, g, b);
    }
}
