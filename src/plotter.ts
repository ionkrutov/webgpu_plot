/// <reference types="@webgpu/types" />
/// <reference types="opentype.js" />
import * as opentype from "opentype.js";
import earcut from "earcut";

// ---------------------------------------------------------------------------
// Converts an opentype.js Path into line-list vertex data (clip space).
// ---------------------------------------------------------------------------

function subdivideQ(
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

function subdivideC(
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

function glyphToLineSegments(
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

function textWidthClip(text: string, font: opentype.Font, fontSize: number, canvasWidth: number): number {
    const scale = fontSize / font.unitsPerEm * (2.0 / canvasWidth);
    let w = 0;
    for (const char of text) {
        w += (font.charToGlyph(char).advanceWidth ?? 0) * scale;
    }
    return w;
}

function flattenQ(
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

function flattenC(
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

function signedArea2D(pts: number[]): number {
    let area = 0;
    const n = pts.length / 2;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += pts[i*2]! * pts[j*2+1]! - pts[j*2]! * pts[i*2+1]!;
    }
    return area / 2;
}

function glyphToTriangles(path: opentype.Path, tolerance = 0.35): number[] {
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

function textToTriVerts(
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
// Nice-number tick algorithm (Heckbert 1990)
// ---------------------------------------------------------------------------

function niceNum(range: number, round: boolean): number {
    const exp = Math.floor(Math.log10(range));
    const f   = range / Math.pow(10, exp);
    let nf: number;
    if (round) {
        if      (f < 1.5) nf = 1;
        else if (f < 3.0) nf = 2;
        else if (f < 7.0) nf = 5;
        else              nf = 10;
    } else {
        if      (f <= 1)  nf = 1;
        else if (f <= 2)  nf = 2;
        else if (f <= 5)  nf = 5;
        else              nf = 10;
    }
    return nf * Math.pow(10, exp);
}

function niceTicks(min: number, max: number, targetCount = 5): number[] {
    const range   = niceNum(max - min, false);
    const step    = niceNum(range / targetCount, true);
    const tickMin = Math.floor(min / step) * step;
    const tickMax = Math.ceil (max / step) * step;
    const ticks: number[] = [];
    for (let v = tickMin; v <= tickMax + step * 1e-6; v += step) {
        ticks.push(Math.round(v / step) * step);
    }
    return ticks;
}

function formatTick(v: number): string {
    if (Number.isInteger(v)) return String(v);
    return parseFloat(v.toPrecision(4)).toString();
}

function getInteriorTicks(min: number, max: number, minCount = 4): number[] {
    for (let target = 5; target <= 24; target++) {
        const t = niceTicks(min, max, target).filter(v => v > min && v < max);
        if (t.length >= minCount) return t;
    }
    return niceTicks(min, max, 5).filter(v => v > min && v < max);
}

/** Returns the tick step that getInteriorTicks would use for the given range. */
function getTickStep(min: number, max: number): number {
    const ticks = getInteriorTicks(min, max);
    if (ticks.length >= 2) return ticks[1]! - ticks[0]!;
    const range = niceNum(max - min, false);
    return niceNum(range / 5, true);
}

/** Generates interior ticks for [min, max] using a fixed step. */
function ticksFromStep(min: number, max: number, step: number): number[] {
    const tickMin = Math.floor(min / step) * step;
    const tickMax = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let v = tickMin; v <= tickMax + step * 1e-6; v += step) {
        const rv = Math.round(v / step) * step;
        if (rv > min && rv < max) ticks.push(rv);
    }
    return ticks;
}

/** Integer tick positions for categorical (string) axes. */
function categoricalTicks(viewMin: number, viewMax: number): number[] {
    const ticks: number[] = [];
    const start = Math.ceil(viewMin + 1e-9);
    const end   = Math.floor(viewMax - 1e-9);
    for (let i = start; i <= end; i++) ticks.push(i);
    return ticks;
}

/** Returns the best tick step in ms for a datetime range width `spanMs`. */
function getDateTickStep(spanMs: number): number {
    const SEC = 1e3, MIN = 60*SEC, HOUR = 60*MIN, DAY = 24*HOUR;
    const MONTH = 30.44*DAY, YEAR = 365.25*DAY;
    const candidates = [
        SEC, 2*SEC, 5*SEC, 10*SEC, 15*SEC, 30*SEC,
        MIN, 2*MIN, 5*MIN, 10*MIN, 15*MIN, 30*MIN,
        HOUR, 2*HOUR, 3*HOUR, 6*HOUR, 12*HOUR,
        DAY, 2*DAY, 7*DAY, 14*DAY,
        MONTH, 2*MONTH, 3*MONTH, 6*MONTH,
        YEAR, 2*YEAR, 5*YEAR, 10*YEAR, 20*YEAR, 50*YEAR,
    ];
    for (const step of candidates) {
        const count = spanMs / step;
        if (count >= 3 && count <= 10) return step;
    }
    return DAY;
}

/** Datetime ticks inside [minMs, maxMs] for a fixed step, stable across panning. */
function dateTicksFromStep(minMs: number, maxMs: number, step: number): number[] {
    const ticks: number[] = [];
    const start = Math.ceil(minMs / step) * step;
    for (let v = start; v <= maxMs - step * 1e-9; v += step) {
        if (v > minMs) ticks.push(v);
    }
    return ticks;
}

const _PAD2 = (n: number) => n.toString().padStart(2, '0');
const _MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Formats a timestamp (ms) for display. Precision is derived from the tick step so
 * that adjacent ticks always have distinct labels (e.g. step=14d → "3/15", not "Feb 2026"). */
function formatDateTick(ms: number, step: number): string {
    const d = new Date(ms);
    const SEC = 1e3, MIN = 60*SEC, HOUR = 60*MIN, DAY = 24*HOUR;
    const MONTH = 30.44*DAY, YEAR = 365.25*DAY;
    if (step < MIN)     return `${_PAD2(d.getHours())}:${_PAD2(d.getMinutes())}:${_PAD2(d.getSeconds())}`;
    if (step < HOUR)    return `${_PAD2(d.getHours())}:${_PAD2(d.getMinutes())}`;
    if (step < DAY)     return `${d.getMonth()+1}/${d.getDate()} ${_PAD2(d.getHours())}h`;
    if (step < MONTH)   return `${d.getMonth()+1}/${d.getDate()}`;
    if (step < YEAR)    return `${_MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
    return String(d.getFullYear());
}

// ---------------------------------------------------------------------------
// Dash-pattern rendering helper
// ---------------------------------------------------------------------------

/** Pixel-length patterns for each line style: [on, off, ...] */
const DASH_PATTERNS: Record<string, number[]> = {
    '-':  [],
    '--': [8, 8],
    ':':  [2, 4],
    '-.': [8, 4, 4, 6],
};

/**
 * Builds triangle-list vertices (quads) for a data series, pushing them into `out`.
 * Each "on" dash segment is rendered as a rectangle oriented along the line.
 * lineWidth is in CSS pixels.
 * viewX/Y bounds are used to skip segments fully outside the visible area.
 * When xSorted=true, binary search limits the iteration to the visible X window.
 * For solid lines, stride decimation caps output at ~50k segments (fast zoom-out).
 */
// function buildDashedLineVerts(
//     xData: number[],
//     yData: number[],
//     dataToClipX: (x: number) => number,
//     dataToClipY: (y: number) => number,
//     pattern: number[],
//     lineWidth: number,
//     r: number, g: number, b: number,
//     w: number, h: number,
//     viewXMin: number, viewXMax: number,
//     viewYMin: number, viewYMax: number,
//     out: number[],
//     xSorted: boolean
// ): void {
//     const n = xData.length;
//     if (n < 2) return;

//     // Binary-search for the visible X range when data is sorted ascending
//     let startI = 0, endI = n - 1;
//     if (xSorted) {
//         let lo = 0, hi = n;
//         while (lo < hi) { const mid = (lo + hi) >> 1; if (xData[mid]! < viewXMin) lo = mid + 1; else hi = mid; }
//         startI = Math.max(0, lo - 1);
//         lo = 0; hi = n;
//         while (lo < hi) { const mid = (lo + hi) >> 1; if (xData[mid]! <= viewXMax) lo = mid + 1; else hi = mid; }
//         endI = Math.min(n - 1, lo);
//     }

//     const hw = w / 2, hh = h / 2;
//     const cpX = (cx: number) => (cx + 1) * hw;
//     const cpY = (cy: number) => (1 - cy) * hh;
//     const pcX = (px: number) => px / hw - 1;
//     const pcY = (py: number) => 1 - py / hh;
//     const halfW = lineWidth / 2;

//     const verts = out;

//     // Emit one quad (2 triangles = 6 verts) for a dash/segment
//     const emitQuad = (ax: number, ay: number, ex: number, ey: number,
//                       nx: number, ny: number): void => {
//         const p0x = pcX(ax - nx), p0y = pcY(ay - ny);
//         const p1x = pcX(ax + nx), p1y = pcY(ay + ny);
//         const p2x = pcX(ex + nx), p2y = pcY(ey + ny);
//         const p3x = pcX(ex - nx), p3y = pcY(ey - ny);
//         verts.push(p0x, p0y, r, g, b,  p1x, p1y, r, g, b,  p2x, p2y, r, g, b);
//         verts.push(p0x, p0y, r, g, b,  p2x, p2y, r, g, b,  p3x, p3y, r, g, b);
//     };

//     if (pattern.length === 0) {
//         // Solid — stride decimation: cap visible segments to limit JS work
//         const MAX_SEGS = 50_000;
//         const visibleSegs = endI - startI;
//         const stride = Math.max(1, Math.ceil(visibleSegs / MAX_SEGS));
//         for (let i = startI; i < endI; i += stride) {
//             const ib = Math.min(i + stride, endI);
//             const xa = xData[i]!, xb = xData[ib]!;
//             const ya = yData[i]!, yb = yData[ib]!;
//             // Skip culling check for unsorted data only (sorted range already correct)
//             if (!xSorted) {
//                 if ((xa < viewXMin && xb < viewXMin) || (xa > viewXMax && xb > viewXMax)) continue;
//                 if ((ya < viewYMin && yb < viewYMin) || (ya > viewYMax && yb > viewYMax)) continue;
//             }
//             const ax = cpX(dataToClipX(xa));
//             const ay = cpY(dataToClipY(ya));
//             const bx = cpX(dataToClipX(xb));
//             const by = cpY(dataToClipY(yb));
//             const dx = bx - ax, dy = by - ay;
//             const segLen = Math.sqrt(dx * dx + dy * dy);
//             if (segLen < 1e-6) continue;
//             const ux = dx / segLen, uy = dy / segLen;
//             emitQuad(ax, ay, bx, by, -uy * halfW, ux * halfW);
//         }
//         return;
//     }

//     // Dashed/dotted — stride decimation (same cap as solid) + walk polyline in pixel space
//     const MAX_DASHED_SEGS = 50_000;
//     const totalDashedSegs = endI - startI;
//     const dStride = Math.max(1, Math.ceil(totalDashedSegs / MAX_DASHED_SEGS));

//     let patIdx = 0;
//     let remaining = pattern[0]!;
//     let dashOn = true;

//     for (let i = startI; i < endI; i += dStride) {
//         const ib = Math.min(i + dStride, endI);
//         const xa = xData[i]!, xb = xData[ib]!;
//         const ya = yData[i]!, yb = yData[ib]!;
//         if (!xSorted) {
//             // Cull: both endpoints outside view on the same side
//             if ((xa < viewXMin && xb < viewXMin) || (xa > viewXMax && xb > viewXMax)) continue;
//             if ((ya < viewYMin && yb < viewYMin) || (ya > viewYMax && yb > viewYMax)) continue;
//         }
//         const pax = cpX(dataToClipX(xa));
//         const pay = cpY(dataToClipY(ya));
//         const pbx = cpX(dataToClipX(xb));
//         const pby = cpY(dataToClipY(yb));
//         const ddx = pbx - pax, ddy = pby - pay;
//         const segLen = Math.sqrt(ddx * ddx + ddy * ddy);
//         if (segLen < 1e-6) continue;
//         const ux = ddx / segLen, uy = ddy / segLen;
//         const nx = -uy * halfW, ny = ux * halfW;

//         // Clip segment to padded canvas bounds (Liang-Barsky) to prevent extremely
//         // long dash walks when zoomed in and segment endpoints are far off-screen.
//         const PAD = halfW + 2;
//         const xmin = -PAD, xmax = w + PAD, ymin = -PAD, ymax = h + PAD;
//         let t0c = 0.0, t1c = 1.0;
//         const cps = [-ddx, ddx, -ddy, ddy];
//         const cqs = [pax - xmin, xmax - pax, pay - ymin, ymax - pay];
//         let clipped = false;
//         for (let k = 0; k < 4; k++) {
//             const pk = cps[k]!, qk = cqs[k]!;
//             if (Math.abs(pk) < 1e-10) {
//                 if (qk < 0) { clipped = true; break; }
//             } else {
//                 const r = qk / pk;
//                 if (pk < 0) { if (r > t1c) { clipped = true; break; } if (r > t0c) t0c = r; }
//                 else        { if (r < t0c) { clipped = true; break; } if (r < t1c) t1c = r; }
//             }
//         }
//         if (clipped || t0c >= t1c) continue;

//         // Advance dash phase from segment start to clip entry point so dashes
//         // remain visually continuous even when the segment start is off-screen.
//         let advDist = t0c * segLen;
//         while (advDist > 1e-10) {
//             const step = Math.min(remaining, advDist);
//             advDist -= step;
//             remaining -= step;
//             if (remaining < 1e-6) {
//                 patIdx = (patIdx + 1) % pattern.length;
//                 remaining = pattern[patIdx]!;
//                 dashOn = !dashOn;
//             }
//         }

//         // Walk only the clipped (on-screen) portion of the segment
//         let ax = pax + ux * (t0c * segLen);
//         let ay = pay + uy * (t0c * segLen);
//         const endT = t1c * segLen;
//         let t = t0c * segLen;
//         while (t < endT - 1e-6) {
//             const step = Math.min(remaining, endT - t);
//             const ex = ax + ux * step;
//             const ey = ay + uy * step;
//             if (dashOn) emitQuad(ax, ay, ex, ey, nx, ny);
//             ax = ex; ay = ey;
//             t += step;
//             remaining -= step;
//             if (remaining < 1e-6) {
//                 patIdx = (patIdx + 1) % pattern.length;
//                 remaining = pattern[patIdx]!;
//                 dashOn = !dashOn;
//             }
//         }
//     }
// }

// ---------------------------------------------------------------------------
// WebGPU shaders
// ---------------------------------------------------------------------------

const blitShaderCode = `
struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
}
@vertex
fn vsMain(@builtin(vertex_index) i: u32) -> VSOut {
    var pos = array<vec2f, 6>(
        vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
        vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0),
    );
    var uv = array<vec2f, 6>(
        vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
        vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
    );
    var out: VSOut;
    out.pos = vec4f(pos[i], 0.0, 1.0);
    out.uv  = uv[i];
    return out;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment
fn fsMain(in: VSOut) -> @location(0) vec4f {
    return textureSample(tex, samp, in.uv);
}
`;

const shaderCode = `
struct DataStruct {
    @builtin(position) pos: vec4f,
    @location(0) colors: vec3f,
}
@vertex
fn vertexMain(@location(0) coords: vec2f, @location(1) colors: vec3f) -> DataStruct {
    var outData: DataStruct;
    outData.pos = vec4f(coords, 0.0, 1.0);
    outData.colors = colors;
    return outData;
}
@fragment
fn fragmentMain(fragData: DataStruct) -> @location(0) vec4f {
    return vec4f(fragData.colors, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Render shader for series lines: supports per-vertex alpha (RGBA).
// Used by seriesLinePipeline (triangle-list, alpha blending).
// ---------------------------------------------------------------------------
const seriesLineShaderCode = `
struct SeriesVOut {
    @builtin(position) pos: vec4f,
    @location(0) color: vec4f,
}
@vertex fn vsSeriesLine(@location(0) coords: vec2f, @location(1) color: vec4f) -> SeriesVOut {
    var o: SeriesVOut;
    o.pos   = vec4f(coords, 0.0, 1.0);
    o.color = color;
    return o;
}
@fragment fn fsSeriesLine(v: SeriesVOut) -> @location(0) vec4f {
    return v.color;
}
`;

// ---------------------------------------------------------------------------
// Compute shader: GPU-side line quad generation.
// One thread per decimated segment → outputs 2 triangles (6 verts × 6 floats).
// Raw x/y data is uploaded once; only the 80-byte uniform changes on pan/zoom.
// ---------------------------------------------------------------------------
const computeShaderCode = `
struct SeriesParams {
    xMin:      f32, xMax:      f32, yMin:      f32, yMax:      f32,  // 0
    plotX0:    f32, plotX1:    f32, plotY0:    f32, plotY1:    f32,  // 16
    canvasW:   f32, canvasH:   f32, lineHalfW: f32, r:         f32,  // 32
    g:         f32, b:         f32, a:         f32, _pad1:     f32,  // 48
    startI:    u32, stride:    u32, numSegs:   u32, _pad2:     u32,  // 64
}                                                                     // = 80 bytes

@group(0) @binding(0) var<uniform>            p:   SeriesParams;
@group(0) @binding(1) var<storage, read>      pts: array<f32>;       // x0,y0,x1,y1,...
@group(0) @binding(2) var<storage, read_write> out: array<f32>;       // 6 verts*6 floats / seg

@compute @workgroup_size(64)
fn csMain(@builtin(global_invocation_id) gid: vec3u) {
    let si   = gid.x;
    let base = si * 36u;
    if (si >= p.numSegs) { return; }

    let nPts = arrayLength(&pts) / 2u;
    let iA   = p.startI + si * p.stride;
    let iB   = min(iA + p.stride, nPts - 1u);
    if (iA >= nPts) { return; }

    let xa = pts[iA * 2u];  let ya = pts[iA * 2u + 1u];
    let xb = pts[iB * 2u];  let yb = pts[iB * 2u + 1u];

    // Cull: both endpoints on same side of view
    let degenerate = (xa < p.xMin && xb < p.xMin) || (xa > p.xMax && xb > p.xMax) ||
                     (ya < p.yMin && yb < p.yMin) || (ya > p.yMax && yb > p.yMax);
    if (degenerate) {
        for (var v = 0u; v < 6u; v++) {
            out[base + v*6u] = 0.0; out[base + v*6u+1u] = 0.0;
            out[base + v*6u+2u] = 0.0; out[base + v*6u+3u] = 0.0; out[base + v*6u+4u] = 0.0; out[base + v*6u+5u] = 0.0;
        }
        return;
    }

    let hw = p.canvasW * 0.5;  let hh = p.canvasH * 0.5;
    let xr = p.xMax - p.xMin;  let yr = p.yMax - p.yMin;

    // Data → clip → pixel space
    let ax  = (p.plotX0 + (xa - p.xMin) / xr * (p.plotX1 - p.plotX0) + 1.0) * hw;
    let ay  = (1.0 - (p.plotY0 + (ya - p.yMin) / yr * (p.plotY1 - p.plotY0))) * hh;
    let bx  = (p.plotX0 + (xb - p.xMin) / xr * (p.plotX1 - p.plotX0) + 1.0) * hw;
    let by_ = (1.0 - (p.plotY0 + (yb - p.yMin) / yr * (p.plotY1 - p.plotY0))) * hh;

    let dx = bx - ax;  let dy = by_ - ay;
    let segLen = sqrt(dx*dx + dy*dy);
    if (segLen < 1e-6) {
        for (var v = 0u; v < 6u; v++) {
            out[base + v*6u] = 0.0; out[base + v*6u+1u] = 0.0;
            out[base + v*6u+2u] = 0.0; out[base + v*6u+3u] = 0.0; out[base + v*6u+4u] = 0.0; out[base + v*6u+5u] = 0.0;
        }
        return;
    }

    let ux = dx / segLen;  let uy = dy / segLen;
    let nx = -uy * p.lineHalfW;  let ny = ux * p.lineHalfW;

    // Pixel → clip space (4 corners of the quad)
    let p0x = (ax - nx) / hw - 1.0;  let p0y = 1.0 - (ay - ny) / hh;
    let p1x = (ax + nx) / hw - 1.0;  let p1y = 1.0 - (ay + ny) / hh;
    let p2x = (bx + nx) / hw - 1.0;  let p2y = 1.0 - (by_ + ny) / hh;
    let p3x = (bx - nx) / hw - 1.0;  let p3y = 1.0 - (by_ - ny) / hh;

    let r = p.r;  let g = p.g;  let b = p.b;  let a = p.a;

    // Triangle 1: p0, p1, p2
    out[base]     = p0x; out[base+1u]  = p0y; out[base+2u]  = r; out[base+3u]  = g; out[base+4u]  = b; out[base+5u]  = a;
    out[base+6u]  = p1x; out[base+7u]  = p1y; out[base+8u]  = r; out[base+9u]  = g; out[base+10u] = b; out[base+11u] = a;
    out[base+12u] = p2x; out[base+13u] = p2y; out[base+14u] = r; out[base+15u] = g; out[base+16u] = b; out[base+17u] = a;
    // Triangle 2: p0, p2, p3
    out[base+18u] = p0x; out[base+19u] = p0y; out[base+20u] = r; out[base+21u] = g; out[base+22u] = b; out[base+23u] = a;
    out[base+24u] = p2x; out[base+25u] = p2y; out[base+26u] = r; out[base+27u] = g; out[base+28u] = b; out[base+29u] = a;
    out[base+30u] = p3x; out[base+31u] = p3y; out[base+32u] = r; out[base+33u] = g; out[base+34u] = b; out[base+35u] = a;
}
`;

// ---------------------------------------------------------------------------
// Compute shader: GPU-side marker quad generation (SDF circle approach).
//
// One thread per visible (decimated) data point.
// Outputs a bounding quad (6 verts × 14 floats) per marker.
// The companion render shader (markerShaderCode) does the SDF circle test in
// the fragment stage — no polygon approximation needed.
//
// Vertex layout written to out[] (15 floats per vertex, stride 60 bytes):
//   [0..1]   clipX, clipY         — clip-space position of quad corner
//   [2..3]   centerSsaaX/Y        — marker centre in SSAA framebuffer pixels
//   [4..5]   outerR, innerR       — radii in SSAA pixels (innerR<0 → hollow)
//   [6..9]   faceR,faceG,faceB,faceA  — fill colour + alpha (0 = transparent)
//   [10..13] edgeR,edgeG,edgeB,edgeA  — edge colour + alpha
//   [14]     shapeId              — bitcast u32 → f32 marker shape identifier
//
// MarkerParams uniform (112 bytes):
//   f[0..3]  xMin,xMax,yMin,yMax
//   f[4..7]  plotX0,plotX1,plotY0,plotY1
//   f[8..11] canvasW_css, canvasH_css, ssaaScale, outerR_css
//   f[12..15] innerR_css, faceR,faceG,faceB
//   f[16..19] faceA, edgeR,edgeG,edgeB
//   u[20..23] startI, stride, numPoints, edgeA_as_f32_at_byte92  (edgeA stored as f)
//   u[24]    shapeId   u[25..27] _pad
// ---------------------------------------------------------------------------
const markerComputeShaderCode = `
struct MarkerParams {
    xMin:      f32, xMax:      f32, yMin:     f32, yMax:     f32,   //  0
    plotX0:    f32, plotX1:    f32, plotY0:   f32, plotY1:   f32,   // 16
    canvasW:   f32, canvasH:   f32, ssaa:     f32, outerR:   f32,   // 32
    innerR:    f32, faceR:     f32, faceG:    f32, faceB:    f32,   // 48
    faceA:     f32, edgeR:     f32, edgeG:    f32, edgeB:    f32,   // 64
    startI:    u32, stride:    u32, numPts:   u32, edgeA:    f32,   // 80
    shapeId:   u32, _p0:       u32, _p1:      u32, _p2:      u32,   // 96
}                                                                    // = 112 bytes

@group(0) @binding(0) var<uniform>             mp:  MarkerParams;
@group(0) @binding(1) var<storage, read>       pts: array<f32>;    // x0,y0,x1,y1,...
@group(0) @binding(2) var<storage, read_write> out: array<f32>;    // 6 verts * 15 floats / marker

const VERTS: u32 = 6u;
const FPV:   u32 = 15u;   // floats per vertex
const FPM:   u32 = 90u;   // floats per marker = VERTS * FPV

@compute @workgroup_size(64)
fn csMarker(@builtin(global_invocation_id) gid: vec3u) {
    let wi = gid.x;
    if (wi >= mp.numPts) { return; }

    let nPts  = arrayLength(&pts) / 2u;
    let dataI = mp.startI + wi * mp.stride;
    if (dataI >= nPts) { return; }

    let base = wi * FPM;

    let xd = pts[dataI * 2u];
    let yd = pts[dataI * 2u + 1u];

    // Cull: point outside data view → write degenerate (zero) quad
    if (xd < mp.xMin || xd > mp.xMax || yd < mp.yMin || yd > mp.yMax) {
        for (var i = 0u; i < FPM; i++) { out[base + i] = 0.0; }
        return;
    }

    let hw = mp.canvasW * 0.5;
    let hh = mp.canvasH * 0.5;
    let xr = mp.xMax - mp.xMin;
    let yr = mp.yMax - mp.yMin;

    // Data → CSS pixel space (origin: top-left, Y down)
    let cx = (mp.plotX0 + (xd - mp.xMin) / xr * (mp.plotX1 - mp.plotX0) + 1.0) * hw;
    let cy = (1.0 - (mp.plotY0 + (yd - mp.yMin) / yr * (mp.plotY1 - mp.plotY0))) * hh;

    // Centre and radii in SSAA framebuffer pixels
    let cxS    = cx * mp.ssaa;
    let cyS    = cy * mp.ssaa;
    let outerS = mp.outerR * mp.ssaa;
    let innerS = mp.innerR * mp.ssaa;   // negative means hollow

    // Bounding quad corners in clip space
    let qx0 = (cx - mp.outerR) / hw - 1.0;
    let qx1 = (cx + mp.outerR) / hw - 1.0;
    let qy0 = 1.0 - (cy - mp.outerR) / hh;
    let qy1 = 1.0 - (cy + mp.outerR) / hh;

    let fr = mp.faceR; let fg = mp.faceG; let fb = mp.faceB; let fa = mp.faceA;
    let er = mp.edgeR; let eg = mp.edgeG; let eb = mp.edgeB;
    let sid = f32(mp.shapeId);

    // Quad corners: TL, BL, BR,  TL, BR, TR
    var px = array<f32, 6>(qx0, qx0, qx1,  qx0, qx1, qx1);
    var py = array<f32, 6>(qy0, qy1, qy1,  qy0, qy1, qy0);

    for (var v = 0u; v < VERTS; v++) {
        let vb = base + v * FPV;
        out[vb]      = px[v]; out[vb+1u]  = py[v];    // clip pos
        out[vb+2u]   = cxS;   out[vb+3u]  = cyS;      // centre (ssaa px)
        out[vb+4u]   = outerS; out[vb+5u] = innerS;   // radii (ssaa px)
        out[vb+6u]   = fr;    out[vb+7u]  = fg;        // face rgba
        out[vb+8u]   = fb;    out[vb+9u]  = fa;
        out[vb+10u]  = er;    out[vb+11u] = eg;        // edge rgba
        out[vb+12u]  = eb;    out[vb+13u] = mp.edgeA;
        out[vb+14u]  = sid;                            // shape id
    }
}
`;

// ---------------------------------------------------------------------------
// Render shader: SDF marker shapes (triangle-list, alpha blending).
// The fragment shader dispatches to per-shape SDF functions based on shapeId.
// All shapes respect the same outerR / innerR hollow encoding as the circle.
// Shape IDs: 0=circle 1=plus 2=asterisk 3=point 4=cross 5=hline 6=vline
//            7=square 8=diamond 9=up-tri 10=down-tri 11=right-tri 12=left-tri
//            13=pentagram 14=hexagram
// ---------------------------------------------------------------------------
const markerShaderCode = `
struct VSIn {
    @location(0) clipPos:  vec2f,
    @location(1) center:   vec2f,   // SSAA fb pixels
    @location(2) radii:    vec2f,   // (outerR, innerR) SSAA pixels; innerR<0 → hollow
    @location(3) faceCol:  vec4f,   // rgba
    @location(4) edgeCol:  vec4f,   // rgba
    @location(5) shapeId:  f32,     // bitcast from u32
}
struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) center:    vec2f,
    @location(1) radii:     vec2f,
    @location(2) faceCol:   vec4f,
    @location(3) edgeCol:   vec4f,
    @location(4) shapeId:   f32,
}
@vertex fn vsMarker(v: VSIn) -> VSOut {
    var o: VSOut;
    o.pos     = vec4f(v.clipPos, 0.0, 1.0);
    o.center  = v.center;
    o.radii   = v.radii;
    o.faceCol = v.faceCol;
    o.edgeCol = v.edgeCol;
    o.shapeId = v.shapeId;
    return o;
}

// ---- SDF helpers (all return signed distance, negative = inside) ----

// Circle
fn sdfCircle(p: vec2f, r: f32) -> f32 { return length(p) - r; }

// Axis-aligned box (half-extents b)
fn sdfBox(p: vec2f, b: vec2f) -> f32 {
    let d = abs(p) - b;
    return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

// Thin line segment from a to b, half-width w
fn sdfSegThick(p: vec2f, a: vec2f, b: vec2f, w: f32) -> f32 {
    let ab = b - a;
    let t  = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
    return length(p - (a + t * ab)) - w;
}

// Diamond: rotated square
fn sdfDiamond(p: vec2f, r: f32) -> f32 {
    return (abs(p.x) + abs(p.y)) - r;
}

// Equilateral triangle: apex at top (+Y), base at bottom.
fn sdfTriangle(p: vec2f, r: f32) -> f32 {
    // r = circumradius
    let px = abs(p.x);
    // Inradius = r/2
    return max(px * 0.866025 + p.y * 0.5, -p.y) - r * 0.5;
}

// Oriented isoceles triangle helpers
fn sdfTriangleUp(p: vec2f, r: f32)    -> f32 { return sdfTriangle(p, r); }
fn sdfTriangleDown(p: vec2f, r: f32)  -> f32 { return sdfTriangle(vec2f(p.x, -p.y), r); }
fn sdfTriangleRight(p: vec2f, r: f32) -> f32 { return sdfTriangle(vec2f(-p.y, p.x), r); }
fn sdfTriangleLeft(p: vec2f, r: f32)  -> f32 { return sdfTriangle(vec2f(p.y, -p.x), r); }

// Regular n-gon star (polygon approach): n points, outer radius R, inner radius q*R
fn sdfStar(p: vec2f, n: f32, R: f32, q: f32) -> f32 {
    let an = 3.14159265 / n;
    let en = 3.14159265 / max(3.0 * q, 1.0);   // external angle
    let acs = vec2f(cos(an), sin(an));
    let ecs = vec2f(cos(en), sin(en));
    let bn  = (atan2(p.y, p.x) % (2.0 * an)) - an;
    var pp  = length(p) * vec2f(cos(bn), abs(sin(bn)));
    pp      = pp - R * acs;
    pp      = pp + ecs * clamp(-dot(pp, ecs), 0.0, R * acs.y / ecs.y);
    return length(pp) * sign(pp.x);
}

// Stroke helper: given a shape SDF, return edge colour if within edge band,
// face colour if interior, else discard.
fn resolveStrokedShape(
    d:      f32,
    ew:     f32,    // edge half-width in pixels
    hollow: bool,
    face:   vec4f,
    edge:   vec4f
) -> vec4f {
    if (d > ew) { discard; }       // outside
    if (d > -ew) { return edge; }  // edge band
    if (hollow) { discard; }       // hollow interior
    return face;
}

// Cross (+) with arm half-width ew
fn sdfPlus(p: vec2f, r: f32, ew: f32) -> f32 {
    let h = sdfBox(p, vec2f(ew, r));
    let v = sdfBox(p, vec2f(r, ew));
    return min(h, v);
}

// X cross: rotated plus
fn sdfX(p: vec2f, r: f32, ew: f32) -> f32 {
    let r2 = 0.70710678;
    let q  = vec2f(r2 * p.x - r2 * p.y, r2 * p.x + r2 * p.y);
    return sdfPlus(q, r, ew);
}

@fragment fn fsMarker(in: VSOut) -> @location(0) vec4f {
    let outerR  = in.radii.x;           // SSAA pixels
    let innerR  = in.radii.y;           // negative → hollow
    let hollow  = innerR < 0.0;
    let ew      = outerR - abs(innerR); // edge half-width
    let p       = in.pos.xy - in.center;
    let sid     = u32(in.shapeId + 0.5);

    var d: f32;
    switch (sid) {
        case 1u: {  // + plus
            d = sdfPlus(p, outerR, ew);
            if (d > 0.0) { discard; } return in.edgeCol;
        }
        case 2u: {  // * asterisk = plus + X combined
            let dp = sdfPlus(p, outerR, ew);
            let dx = sdfX(p, outerR, ew);
            d = min(dp, dx);
            if (d > 0.0) { discard; } return in.edgeCol;
        }
        case 3u: {  // . point = small filled circle (25% of outerR)
            d = sdfCircle(p, outerR * 0.35);
            if (d > 0.0) { discard; } return in.edgeCol;
        }
        case 4u: {  // x cross
            d = sdfX(p, outerR, ew);
            if (d > 0.0) { discard; } return in.edgeCol;
        }
        case 5u: {  // _ horizontal line
            d = sdfBox(p, vec2f(outerR, ew));
            if (d > 0.0) { discard; } return in.edgeCol;
        }
        case 6u: {  // | vertical line
            d = sdfBox(p, vec2f(ew, outerR));
            if (d > 0.0) { discard; } return in.edgeCol;
        }
        case 7u: {  // square
            d = sdfBox(p, vec2f(outerR, outerR));
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 8u: {  // diamond
            d = sdfDiamond(p, outerR);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 9u: {  // ^ upward triangle
            d = sdfTriangleUp(p, outerR * 2.0);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 10u: {  // v downward triangle
            d = sdfTriangleDown(p, outerR * 2.0);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 11u: {  // > right-pointing triangle
            d = sdfTriangleRight(p, outerR * 2.0);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 12u: {  // < left-pointing triangle
            d = sdfTriangleLeft(p, outerR * 2.0);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 13u: {  // pentagram (5-pointed star)
            d = sdfStar(p, 5.0, outerR, 0.4);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 14u: {  // hexagram (6-pointed star)
            d = sdfStar(p, 6.0, outerR, 0.5);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        default: {  // 0 = circle
            d = sdfCircle(p, outerR);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
    }
}
`;

// ---------------------------------------------------------------------------
// Compute shader: GPU-side dashed/dotted line quad generation.
//
// Uses a SINGLE thread that processes all segments sequentially, maintaining
// dash phase state across segment boundaries — exactly matching the behaviour
// of the previous JS buildDashedLineVerts() implementation.
//
// Dispatched as dispatchWorkgroups(1) with workgroup_size(1).
// Writes the indirect draw-args directly to drawArgs[0..3] at the end.
//
// DashedParams uniform (128 bytes) — same layout as before.
// ---------------------------------------------------------------------------
const dashedComputeShaderCode = `
struct DashedParams {
    xMin:    f32, xMax:    f32, yMin:    f32, yMax:    f32,  //  0
    plotX0:  f32, plotX1:  f32, plotY0:  f32, plotY1:  f32,  // 16
    canvasW: f32, canvasH: f32, halfW:   f32, r:       f32,  // 32
    g:       f32, b:       f32, a:       f32, _p1:     f32,  // 48
    startI:  u32, stride:  u32, numSegs: u32, maxQuads:u32,  // 64
    patLen:  u32, _p2:     u32, _p3:     u32, _p4:     u32,  // 80
    pattern: array<f32, 8>,                                   // 96
}                                                             // = 128 bytes

@group(0) @binding(0) var<uniform>             dp:       DashedParams;
@group(0) @binding(1) var<storage, read>       pts:      array<f32>;           // x0,y0,x1,y1,...
@group(0) @binding(2) var<storage, read_write> out:      array<f32>;           // 30 floats per quad
@group(0) @binding(3) var<storage, read_write> drawArgs: array<u32>;           // [vtxCount,1,0,0]

@compute @workgroup_size(1)
fn csDashed() {
    let nPts = arrayLength(&pts) / 2u;
    let hw = dp.canvasW * 0.5;
    let hh = dp.canvasH * 0.5;
    let xr = dp.xMax - dp.xMin;
    let yr = dp.yMax - dp.yMin;
    // Guard against degenerate view (prevents division by zero)
    if (xr < 1e-30 || yr < 1e-30) { drawArgs[0] = 0u; drawArgs[1] = 1u; drawArgs[2] = 0u; drawArgs[3] = 0u; return; }

    let PAD  = dp.halfW + 2.0;
    let bxMn = -PAD;          let bxMx = dp.canvasW + PAD;
    let byMn = -PAD;          let byMx = dp.canvasH + PAD;

    // Dash phase state — preserved across ALL segments (key fix vs. per-segment restart)
    var patIdx:    u32  = 0u;
    var remaining: f32  = dp.pattern[0];
    var dashOn:    bool = true;
    var slot:      u32  = 0u;

    for (var si = 0u; si < dp.numSegs; si++) {
        let iA = dp.startI + si * dp.stride;
        let iB = min(iA + dp.stride, nPts - 1u);
        if (iA >= nPts || iA >= iB) { continue; }

        let xa = pts[iA * 2u]; let ya = pts[iA * 2u + 1u];
        let xb = pts[iB * 2u]; let yb = pts[iB * 2u + 1u];

        // Data → CSS pixel space (same formula as solid-line compute shader)
        let pax = (dp.plotX0 + (xa - dp.xMin) / xr * (dp.plotX1 - dp.plotX0) + 1.0) * hw;
        let pay = (1.0 - (dp.plotY0 + (ya - dp.yMin) / yr * (dp.plotY1 - dp.plotY0))) * hh;
        let pbx = (dp.plotX0 + (xb - dp.xMin) / xr * (dp.plotX1 - dp.plotX0) + 1.0) * hw;
        let pby = (1.0 - (dp.plotY0 + (yb - dp.yMin) / yr * (dp.plotY1 - dp.plotY0))) * hh;

        let ddx = pbx - pax; let ddy = pby - pay;
        let segLen = sqrt(ddx * ddx + ddy * ddy);
        if (segLen < 1e-4) { continue; }

        let ux = ddx / segLen; let uy = ddy / segLen;
        let nrx = -uy * dp.halfW; let nry = ux * dp.halfW;

        // Liang-Barsky clip to canvas bounds (+padding for line half-width)
        var t0 = 0.0; var t1 = 1.0;
        var culled = false;
        if (abs(ddx) > 1e-10) {
            let ra = (bxMn - pax) / ddx; let rb = (bxMx - pax) / ddx;
            t0 = max(t0, min(ra, rb)); t1 = min(t1, max(ra, rb));
        } else { culled = culled || (pax < bxMn || pax > bxMx); }
        if (abs(ddy) > 1e-10) {
            let ra = (byMn - pay) / ddy; let rb = (byMx - pay) / ddy;
            t0 = max(t0, min(ra, rb)); t1 = min(t1, max(ra, rb));
        } else { culled = culled || (pay < byMn || pay > byMx); }
        if (culled || t0 >= t1) { continue; }

        // Advance dash phase from segment start to clip entry (pre-visible portion)
        // This keeps phase consistent even when part of the segment is off-screen.
        var adv = t0 * segLen;
        var advI = 0u;
        while (adv > 1e-4 && advI < 8192u) {
            advI += 1u;
            let step = min(remaining, adv);
            adv -= step; remaining -= step;
            if (remaining < 1e-4) {
                patIdx = (patIdx + 1u) % dp.patLen;
                remaining = dp.pattern[patIdx];
                dashOn = !dashOn;
            }
        }

        // Walk the visible (clipped) portion, emitting a quad per "on" dash
        var ax = pax + ux * (t0 * segLen);
        var ay = pay + uy * (t0 * segLen);
        let visLen = (t1 - t0) * segLen;
        var dist = 0.0; var iterV = 0u;
        while (dist < visLen - 1e-4 && iterV < 16384u) {
            iterV += 1u;
            let step = min(remaining, visLen - dist);
            let ex = ax + ux * step; let ey = ay + uy * step;
            if (dashOn && slot < dp.maxQuads) {
                let ob = slot * 36u; slot += 1u;
                let r = dp.r; let g = dp.g; let b = dp.b; let a = dp.a;
                let p0x = (ax - nrx) / hw - 1.0; let p0y = 1.0 - (ay - nry) / hh;
                let p1x = (ax + nrx) / hw - 1.0; let p1y = 1.0 - (ay + nry) / hh;
                let p2x = (ex + nrx) / hw - 1.0; let p2y = 1.0 - (ey + nry) / hh;
                let p3x = (ex - nrx) / hw - 1.0; let p3y = 1.0 - (ey - nry) / hh;
                out[ob]     = p0x; out[ob+1u]  = p0y; out[ob+2u]  = r; out[ob+3u]  = g; out[ob+4u]  = b; out[ob+5u]  = a;
                out[ob+6u]  = p1x; out[ob+7u]  = p1y; out[ob+8u]  = r; out[ob+9u]  = g; out[ob+10u] = b; out[ob+11u] = a;
                out[ob+12u] = p2x; out[ob+13u] = p2y; out[ob+14u] = r; out[ob+15u] = g; out[ob+16u] = b; out[ob+17u] = a;
                out[ob+18u] = p0x; out[ob+19u] = p0y; out[ob+20u] = r; out[ob+21u] = g; out[ob+22u] = b; out[ob+23u] = a;
                out[ob+24u] = p2x; out[ob+25u] = p2y; out[ob+26u] = r; out[ob+27u] = g; out[ob+28u] = b; out[ob+29u] = a;
                out[ob+30u] = p3x; out[ob+31u] = p3y; out[ob+32u] = r; out[ob+33u] = g; out[ob+34u] = b; out[ob+35u] = a;
            }
            ax = ex; ay = ey; dist += step; remaining -= step;
            if (remaining < 1e-4) {
                patIdx = (patIdx + 1u) % dp.patLen;
                remaining = dp.pattern[patIdx];
                dashOn = !dashOn;
            }
        }
        // Phase for post-clip portion (t1..1) is intentionally NOT advanced here,
        // matching the reference JS implementation.
    }

    // Write indirect draw args: vertexCount = slot * 6, instanceCount = 1
    drawArgs[0] = slot * 6u;
    drawArgs[1] = 1u;
    drawArgs[2] = 0u;
    drawArgs[3] = 0u;
}
`;

// ---------------------------------------------------------------------------
// GPU adapter enumeration
// ---------------------------------------------------------------------------

export interface AdapterOption {
    label: string;
    powerPreference: GPUPowerPreference | undefined;
}

export async function enumerateAdapters(): Promise<AdapterOption[]> {
    const prefs: Array<GPUPowerPreference | undefined> = ['high-performance', 'low-power', undefined];
    const seen = new Set<string>();
    const options: AdapterOption[] = [];
    for (const pref of prefs) {
        const a = await navigator.gpu.requestAdapter(
            pref !== undefined ? { powerPreference: pref } : undefined
        );
        if (!a) continue;
        const info = a.info;
        const key = `${info.vendor}|${info.architecture}|${info.device}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const parts: string[] = [];
        if (info.description) parts.push(info.description);
        else if (info.vendor)  parts.push(info.vendor);
        if (info.architecture) parts.push(`(${info.architecture})`);
        const fallback = pref === 'high-performance' ? 'High-performance GPU'
                       : pref === 'low-power'        ? 'Low-power GPU'
                       :                               'Default GPU';
        options.push({ label: parts.length > 0 ? parts.join(' ') : fallback, powerPreference: pref });
    }
    return options;
}

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
    size: number = 6;
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

// ---------------------------------------------------------------------------
// Figure — manages one plot window DOM element + GPU rendering
// ---------------------------------------------------------------------------

/** Normalized series: strings→index, Date→ms. Always numeric x/y. */
interface InternalSeries {
    x: number[];
    y: number[];
    xSorted: boolean;   // true when x is non-decreasing (enables binary-search range culling)
    color?: [number, number, number, number?];
    lineStyle?: '-' | '--' | ':' | '-.' | 'none';
    lineWidth?: number;
    marker?: MarkerStyle;
}

export class Figure {
    // DOM
    readonly windowEl: HTMLDivElement;
    readonly canvas: HTMLCanvasElement;
    private readonly zoomRectEl: HTMLDivElement;
    private readonly titleLabelEl: HTMLSpanElement;
    private readonly gpuSelectEl: HTMLSelectElement;
    private readonly btnZoomRegion: HTMLButtonElement;
    private readonly btnInspect: HTMLButtonElement;
    private readonly tooltipEl: HTMLDivElement;
    private readonly crosshairVEl: HTMLDivElement;
    private readonly crosshairHEl: HTMLDivElement;

    // Config
    private readonly opts: Required<PlotterOptions>;
    private figureOpts: Required<FigureOptions>;
    private seriesList: PlotSeries[] = [];
    private internalSeries: InternalSeries[] = [];
    private xLabels: string[] | null = null;
    private yLabels: string[] | null = null;
    private xIsDate = false;
    private yIsDate = false;

    // GPU
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private canvasFormat!: GPUTextureFormat;
    private linePipeline!: GPURenderPipeline;
    private textPipeline!: GPURenderPipeline;
    private titlePipeline!: GPURenderPipeline;
    private seriesLinePipeline!: GPURenderPipeline;  // series lines/dashed: triangle-list + alpha blend
    private blitPipeline!: GPURenderPipeline;
    private blitSampler!: GPUSampler;
    private computePipeline!: GPUComputePipeline;
    private adapterOptions: AdapterOption[] = [];

    // Per-series GPU buffers for compute path (solid lines only).
    // Allocated once in uploadSeriesGpuBuffers(); reused across frames.
    //   seriesRawBufs[i]   — raw x/y float32 pairs, STORAGE (uploaded once, shared with marker compute)
    //   seriesOutBufs[i]   — quad verts output, STORAGE | VERTEX (MAX_SEGS * 36 * 4 bytes)
    //   seriesParamBufs[i] — 80-byte SeriesParams uniform, updated per frame via writeBuffer
    //   seriesOutCounts[i] — vertex count to draw this frame (numDispatched * 6)
    private readonly MAX_COMPUTE_SEGS = 50_000;
    private seriesRawBufs:   GPUBuffer[] = [];
    private seriesOutBufs:   (GPUBuffer | null)[] = [];
    private seriesParamBufs: (GPUBuffer | null)[] = [];
    private seriesOutCounts: number[]    = [];

    // Per-series GPU buffers for marker compute path.
    //   markerOutBufs[i]   — SDF quad verts, STORAGE | VERTEX (MAX_MARKERS * 6 * 15 * 4 bytes)
    //   markerParamBufs[i] — 112-byte MarkerParams uniform, updated per frame
    //   markerOutCounts[i] — vertex count to draw (numMarkers * 6)
    // Only allocated for series that have a marker; null otherwise.
    private readonly MAX_MARKER_COUNT = 50_000;
    private markerComputePipeline!: GPUComputePipeline;
    private markerRenderPipeline!:  GPURenderPipeline;
    private markerOutBufs:   (GPUBuffer | null)[] = [];
    private markerParamBufs: (GPUBuffer | null)[] = [];
    private markerOutCounts: number[]              = [];

    // Per-series GPU buffers for dashed-line compute path.
    //   dashedOutBufs[i]      — output quads, STORAGE | VERTEX (MAX_DASHED_OUT_QUADS * 36 * 4 bytes)
    //   dashedParamBufs[i]    — 128-byte DashedParams uniform, updated per frame
    //   dashedDrawArgsBufs[i] — 16-byte indirect draw args, written by compute shader
    //   dashedNumSegs[i]      — number of segments dispatched this frame
    // Only allocated for series that have a non-empty dash pattern; null otherwise.
    private readonly MAX_DASHED_OUT_QUADS = 200_000;
    private dashedComputePipeline!:  GPUComputePipeline;
    private dashedOutBufs:      (GPUBuffer | null)[] = [];
    private dashedParamBufs:    (GPUBuffer | null)[] = [];
    private dashedDrawArgsBufs: (GPUBuffer | null)[] = [];
    private dashedNumSegs:      number[]              = [];

    // Font
    private font!: opentype.Font;

    // View state
    private viewXMin = 0; private viewXMax = 1;
    private viewYMin = 0; private viewYMax = 1;
    private defaultViewXMin = 0; private defaultViewXMax = 1;
    private defaultViewYMin = 0; private defaultViewYMax = 1;
    // Minimum spacing between adjacent data points in data-space coordinates.
    // Used as the hard zoom-in limit so you can never zoom between two points.
    private minDataSpanX = 0;
    private minDataSpanY = 0;

    // Interaction state
    private plotMode: 'pan' | 'zoomRegion' | 'inspect' = 'pan';
    private isDragging = false;
    private dragStartX = 0; private dragStartY = 0;
    private dragViewXMin = 0; private dragViewXMax = 0;
    private dragViewYMin = 0; private dragViewYMax = 0;
    private zbDragging = false;
    private zbStartClientX = 0; private zbStartClientY = 0;

    // Cached plot rect in clip space (updated on render)
    private plotRectX0 = -0.75; private plotRectY0 = -0.78;
    private plotRectX1 =  0.90; private plotRectY1 =  0.78;

    // Cached tick steps — only recomputed when the view span (zoom) changes, not on pan
    private xTickStep = 1; private yTickStep = 1;
    private lastXSpan = -1; private lastYSpan = -1;

    private readonly ssaaScale = 2;
    private rafPending = false;

    constructor(opts: Required<PlotterOptions>, figOpts: Required<FigureOptions>) {
        this.opts = opts;
        this.figureOpts = figOpts;

        // ---- Build DOM ----
        this.windowEl = document.createElement('div');
        this.windowEl.className = 'plot_window';

        // Header
        const header = document.createElement('div');
        header.className = 'plot_header';

        this.titleLabelEl = document.createElement('span');
        this.titleLabelEl.className = 'plot_title_label';
        this.titleLabelEl.textContent = figOpts.title;

        const toolbar = document.createElement('div');
        toolbar.className = 'plot_toolbar';

        const mkBtn = (id: string, title: string, inner: string): HTMLButtonElement => {
            const b = document.createElement('button');
            b.className = 'plot-btn';
            b.id = id;
            b.title = title;
            b.innerHTML = inner;
            return b;
        };

        const btnZoomIn  = mkBtn('', 'Zoom In',    '+');
        const btnZoomOut = mkBtn('', 'Zoom Out',   '&#8722;');
        this.btnZoomRegion = mkBtn('', 'Zoom Region',
            `<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="1" y="1" width="12" height="12" stroke-dasharray="3 2"/>
                <line x1="11" y1="11" x2="17" y2="17"/>
                <line x1="14" y1="17" x2="17" y2="17"/><line x1="17" y1="14" x2="17" y2="17"/>
            </svg>`);
        const btnHome    = mkBtn('', 'Reset View', '&#8962;');
        this.btnInspect  = mkBtn('', 'Inspect Values',
            `<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="9" cy="9" r="4"/>
                <line x1="9" y1="1" x2="9" y2="5"/><line x1="9" y1="13" x2="9" y2="17"/>
                <line x1="1" y1="9" x2="5" y2="9"/><line x1="13" y1="9" x2="17" y2="9"/>
            </svg>`);

        this.gpuSelectEl = document.createElement('select');
        this.gpuSelectEl.title = 'GPU Adapter';
        this.gpuSelectEl.style.cssText = 'height:30px;border:1px solid #bbb;border-radius:5px;background:#fff;font-size:12px;padding:0 6px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.18);max-width:200px;';

        // Save-as dropdown
        const saveWrapper = document.createElement('div');
        saveWrapper.style.cssText = 'position:relative;display:inline-flex;';

        const btnSave = mkBtn('', 'Save as Image',
            `<svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="9" y1="2" x2="9" y2="12"/>
                <polyline points="5,8 9,13 13,8"/>
                <line x1="2" y1="16" x2="16" y2="16"/>
            </svg>`);

        const saveMenu = document.createElement('div');
        saveMenu.style.cssText = 'display:none;position:absolute;top:calc(100% + 3px);right:0;z-index:200;background:#fff;border:1px solid #bbb;border-radius:5px;box-shadow:0 3px 10px rgba(0,0,0,0.25);overflow:hidden;white-space:nowrap;';

        (['PNG', 'JPEG', 'PDF'] as const).forEach(fmt => {
            const item = document.createElement('button');
            item.textContent = fmt;
            item.style.cssText = 'display:block;width:100%;padding:7px 18px;background:none;border:none;border-bottom:1px solid #eee;text-align:left;cursor:pointer;font-size:13px;font-family:sans-serif;color:#333;';
            item.addEventListener('mouseover', () => { item.style.background = '#f0f4ff'; });
            item.addEventListener('mouseout',  () => { item.style.background = '';        });
            item.addEventListener('click', e => {
                e.stopPropagation();
                saveMenu.style.display = 'none';
                void this.saveAs(fmt.toLowerCase() as 'png' | 'jpeg' | 'pdf');
            });
            saveMenu.appendChild(item);
        });
        (saveMenu.lastElementChild as HTMLElement).style.borderBottom = 'none';

        saveWrapper.append(btnSave, saveMenu);

        btnSave.addEventListener('click', e => {
            e.stopPropagation();
            saveMenu.style.display = saveMenu.style.display === 'none' ? 'block' : 'none';
        });
        window.addEventListener('click', () => { saveMenu.style.display = 'none'; });

        toolbar.append(btnZoomIn, btnZoomOut, this.btnZoomRegion, btnHome, this.btnInspect, saveWrapper, this.gpuSelectEl);
        header.append(this.titleLabelEl, toolbar);

        // Canvas container
        const canvasContainer = document.createElement('div');
        canvasContainer.className = 'canvas_container';

        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'display:block;width:100%;height:100%;';

        this.zoomRectEl = document.createElement('div');
        this.zoomRectEl.className = 'zoom_rect';

        this.crosshairVEl = document.createElement('div');
        this.crosshairVEl.style.cssText = 'position:absolute;pointer-events:none;top:0;bottom:0;width:1px;background:rgba(0,0,0,0.4);display:none;transform:translateX(-0.5px);';
        this.crosshairHEl = document.createElement('div');
        this.crosshairHEl.style.cssText = 'position:absolute;pointer-events:none;left:0;right:0;height:1px;background:rgba(0,0,0,0.4);display:none;transform:translateY(-0.5px);';
        this.tooltipEl = document.createElement('div');
        this.tooltipEl.style.cssText = 'position:absolute;pointer-events:none;background:rgba(20,20,20,0.85);color:#fff;font-size:12px;font-family:monospace;padding:5px 9px;border-radius:5px;white-space:pre;display:none;z-index:10;line-height:1.6;box-shadow:0 2px 8px rgba(0,0,0,0.3);';

        canvasContainer.append(this.canvas, this.zoomRectEl, this.crosshairVEl, this.crosshairHEl, this.tooltipEl);
        this.windowEl.append(header, canvasContainer);

        // ---- Toolbar events ----
        btnZoomIn.addEventListener('click', () => {
            const cx = (this.viewXMin + this.viewXMax) / 2;
            const cy = (this.viewYMin + this.viewYMax) / 2;
            this.zoomAround(cx, cy, 1 / 1.5);
            this.scheduleRender();
        });
        btnZoomOut.addEventListener('click', () => {
            const cx = (this.viewXMin + this.viewXMax) / 2;
            const cy = (this.viewYMin + this.viewYMax) / 2;
            this.zoomAround(cx, cy, 1.5);
            this.scheduleRender();
        });
        this.btnZoomRegion.addEventListener('click', () => {
            this.setMode(this.plotMode === 'zoomRegion' ? 'pan' : 'zoomRegion');
        });
        btnHome.addEventListener('click', () => {
            this.viewXMin = this.defaultViewXMin; this.viewXMax = this.defaultViewXMax;
            this.viewYMin = this.defaultViewYMin; this.viewYMax = this.defaultViewYMax;
            this.scheduleRender();
        });
        this.btnInspect.addEventListener('click', () => {
            this.setMode(this.plotMode === 'inspect' ? 'pan' : 'inspect');
        });
        this.gpuSelectEl.addEventListener('change', async () => {
            const idx = parseInt(this.gpuSelectEl.value, 10);
            const opt = this.adapterOptions[idx];
            if (!opt) return;
            await this.initGPUResources(opt.powerPreference);
            this.render();
        });

        // ---- Mouse / wheel events ----
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
            const data = this.clientToData(e.clientX, e.clientY);
            this.zoomAround(data.x, data.y, factor);
            this.scheduleRender();
        }, { passive: false });

        this.canvas.addEventListener('mousedown', (e) => {
            e.preventDefault();
            if (this.plotMode === 'zoomRegion') {
                this.zbDragging = true;
                this.zbStartClientX = e.clientX;
                this.zbStartClientY = e.clientY;
                const cr = this.canvas.getBoundingClientRect();
                const x = e.clientX - cr.left;
                const y = e.clientY - cr.top;
                this.zoomRectEl.style.left = x + 'px';
                this.zoomRectEl.style.top  = y + 'px';
                this.zoomRectEl.style.width  = '0px';
                this.zoomRectEl.style.height = '0px';
                this.zoomRectEl.style.display = 'block';
            } else if (this.plotMode === 'pan') {
                this.isDragging = true;
                this.dragStartX = e.clientX;
                this.dragStartY = e.clientY;
                this.dragViewXMin = this.viewXMin; this.dragViewXMax = this.viewXMax;
                this.dragViewYMin = this.viewYMin; this.dragViewYMax = this.viewYMax;
                this.canvas.style.cursor = 'grabbing';
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (this.zbDragging) {
                const cr = this.canvas.getBoundingClientRect();
                const x0 = this.zbStartClientX - cr.left;
                const y0 = this.zbStartClientY - cr.top;
                const x1 = e.clientX - cr.left;
                const y1 = e.clientY - cr.top;
                this.zoomRectEl.style.left   = Math.min(x0, x1) + 'px';
                this.zoomRectEl.style.top    = Math.min(y0, y1) + 'px';
                this.zoomRectEl.style.width  = Math.abs(x1 - x0) + 'px';
                this.zoomRectEl.style.height = Math.abs(y1 - y0) + 'px';
                return;
            }
            if (this.plotMode === 'inspect') {
                this.updateInspector(e.clientX, e.clientY);
                return;
            }
            if (!this.isDragging) return;
            const rect = this.canvas.getBoundingClientRect();
            const dxClip =  (e.clientX - this.dragStartX) / rect.width  * 2;
            const dyClip = -(e.clientY - this.dragStartY) / rect.height * 2;
            const dxData = dxClip / (this.plotRectX1 - this.plotRectX0) * (this.dragViewXMax - this.dragViewXMin);
            const dyData = dyClip / (this.plotRectY1 - this.plotRectY0) * (this.dragViewYMax - this.dragViewYMin);
            this.viewXMin = this.dragViewXMin - dxData;
            this.viewXMax = this.dragViewXMax - dxData;
            this.viewYMin = this.dragViewYMin - dyData;
            this.viewYMax = this.dragViewYMax - dyData;
            this.scheduleRender();
        });

        window.addEventListener('mouseup', (e) => {
            if (this.zbDragging) {
                this.zbDragging = false;
                this.zoomRectEl.style.display = 'none';
                const x0 = this.zbStartClientX, y0 = this.zbStartClientY;
                const x1 = e.clientX,           y1 = e.clientY;
                if (Math.abs(x1 - x0) > 5 && Math.abs(y1 - y0) > 5) {
                    const topLeft     = this.clientToData(Math.min(x0, x1), Math.min(y0, y1));
                    const bottomRight = this.clientToData(Math.max(x0, x1), Math.max(y0, y1));
                    this.viewXMin = topLeft.x;     this.viewXMax = bottomRight.x;
                    this.viewYMin = bottomRight.y; this.viewYMax = topLeft.y;
                    this.scheduleRender();
                }
                return;
            }
            if (this.isDragging) {
                this.isDragging = false;
                this.canvas.style.cursor = 'grab';
            }
        });

        this.canvas.addEventListener('mouseleave', () => {
            this.crosshairVEl.style.display = 'none';
            this.crosshairHEl.style.display = 'none';
            this.tooltipEl.style.display = 'none';
        });

        this.canvas.style.cursor = 'grab';

        // Resize observer
        const ro = new ResizeObserver(() => this.render());
        ro.observe(canvasContainer);
    }

    // ---- GPU initialisation ----

    async init(font: opentype.Font): Promise<void> {
        this.font = font;

        if (!navigator.gpu) throw new Error("WebGPU not supported");

        const contextOrNull = this.canvas.getContext("webgpu");
        if (!contextOrNull) throw new Error("Could not obtain WebGPU context");
        this.context = contextOrNull;
        this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();

        this.adapterOptions = await enumerateAdapters();
        for (let i = 0; i < this.adapterOptions.length; i++) {
            const el = document.createElement('option');
            el.value = String(i);
            el.textContent = this.adapterOptions[i]!.label;
            this.gpuSelectEl.appendChild(el);
        }
        if (this.adapterOptions.length === 0) {
            const el = document.createElement('option');
            el.value = '0'; el.textContent = 'Default GPU';
            this.gpuSelectEl.appendChild(el);
        }
        this.gpuSelectEl.disabled = this.adapterOptions.length <= 1;

        if (this.adapterOptions.length === 0) throw new Error("No GPUAdapter found");
        await this.initGPUResources(this.adapterOptions[0]!.powerPreference);
    }

    private async initGPUResources(powerPreference: GPUPowerPreference | undefined): Promise<void> {
        const oldDevice: GPUDevice | undefined = this.device;

        const adapter = await navigator.gpu.requestAdapter(
            powerPreference !== undefined ? { powerPreference } : undefined
        );
        if (!adapter) throw new Error("No GPUAdapter found");
        // Запрашиваем максимальный поддерживаемый размер буфера
        this.device = await adapter.requestDevice({
            requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize }
        });
        if (!this.device) throw new Error("Failed to create a GPUDevice");

        if (oldDevice) {
            this.destroySeriesGpuBuffers();
            await oldDevice.queue.onSubmittedWorkDone();
            this.context.unconfigure();
            const oldLost = oldDevice.lost;
            oldDevice.destroy();
            await oldLost;
        }

        this.context.configure({ device: this.device, format: this.canvasFormat });

        const shaderModule = this.device.createShaderModule({ code: shaderCode });
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 20,
            attributes: [
                { format: "float32x2", offset: 0,  shaderLocation: 0 },
                { format: "float32x3", offset: 8,  shaderLocation: 1 },
            ]
        };
        const makePipeline = (topology: GPUPrimitiveTopology): GPURenderPipeline =>
            this.device.createRenderPipeline({
                layout: "auto",
                vertex:   { module: shaderModule, entryPoint: "vertexMain",   buffers: [vertexBufferLayout] },
                fragment: { module: shaderModule, entryPoint: "fragmentMain", targets: [{ format: this.canvasFormat }] },
                primitive: { topology }
            });

        this.linePipeline  = makePipeline("line-list");
        this.textPipeline  = makePipeline("triangle-list");
        this.titlePipeline = makePipeline("triangle-list");

        // Render pipeline for series lines/dashed: RGBA vertex color, alpha blending
        const seriesLineModule = this.device.createShaderModule({ code: seriesLineShaderCode });
        const seriesLineVertLayout: GPUVertexBufferLayout = {
            arrayStride: 24,  // 6 floats × 4 bytes
            attributes: [
                { format: 'float32x2', offset:  0, shaderLocation: 0 },  // coords
                { format: 'float32x4', offset:  8, shaderLocation: 1 },  // color rgba
            ]
        };
        this.seriesLinePipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex:   { module: seriesLineModule, entryPoint: 'vsSeriesLine', buffers: [seriesLineVertLayout] },
            fragment: {
                module: seriesLineModule, entryPoint: 'fsSeriesLine',
                targets: [{
                    format: this.canvasFormat,
                    blend: {
                        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                        alpha: { operation: 'add', srcFactor: 'one',       dstFactor: 'zero' },
                    }
                }]
            },
            primitive: { topology: 'triangle-list' }
        });

        const blitShaderModule = this.device.createShaderModule({ code: blitShaderCode });
        this.blitPipeline = this.device.createRenderPipeline({
            layout: "auto",
            vertex:   { module: blitShaderModule, entryPoint: "vsMain" },
            fragment: { module: blitShaderModule, entryPoint: "fsMain", targets: [{ format: this.canvasFormat }] },
            primitive: { topology: "triangle-list" }
        });
        this.blitSampler = this.device.createSampler({ magFilter: "linear", minFilter: "linear" });

        // Compute pipeline for GPU-side solid-line quad generation
        const computeModule = this.device.createShaderModule({ code: computeShaderCode });
        this.computePipeline = this.device.createComputePipeline({
            layout: "auto",
            compute: { module: computeModule, entryPoint: "csMain" }
        });

        // Compute pipeline for GPU-side marker quad generation (SDF circles)
        const markerComputeModule = this.device.createShaderModule({ code: markerComputeShaderCode });
        this.markerComputePipeline = this.device.createComputePipeline({
            layout: "auto",
            compute: { module: markerComputeModule, entryPoint: "csMarker" }
        });

        // Render pipeline for SDF marker shapes (triangle-list, alpha blending)
        const markerModule = this.device.createShaderModule({ code: markerShaderCode });
        const markerVertexLayout: GPUVertexBufferLayout = {
            arrayStride: 15 * 4,  // 15 floats × 4 bytes
            attributes: [
                { shaderLocation: 0, offset:  0, format: 'float32x2' },  // clipPos
                { shaderLocation: 1, offset:  8, format: 'float32x2' },  // center (ssaa px)
                { shaderLocation: 2, offset: 16, format: 'float32x2' },  // radii
                { shaderLocation: 3, offset: 24, format: 'float32x4' },  // faceColor rgba
                { shaderLocation: 4, offset: 40, format: 'float32x4' },  // edgeColor rgba
                { shaderLocation: 5, offset: 56, format: 'float32'   },  // shapeId
            ]
        };
        this.markerRenderPipeline = this.device.createRenderPipeline({
            layout: 'auto',
            vertex:   { module: markerModule, entryPoint: 'vsMarker', buffers: [markerVertexLayout] },
            fragment: {
                module: markerModule, entryPoint: 'fsMarker',
                targets: [{
                    format: this.canvasFormat,
                    blend: {
                        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                        alpha: { operation: 'add', srcFactor: 'one',       dstFactor: 'zero' },
                    }
                }]
            },
            primitive: { topology: 'triangle-list' }
        });

        // Dashed-line compute pipeline (single-threaded sequential, writes drawArgs directly)
        const dashedComputeModule = this.device.createShaderModule({ code: dashedComputeShaderCode });
        this.dashedComputePipeline = this.device.createComputePipeline({
            layout: 'auto',
            compute: { module: dashedComputeModule, entryPoint: 'csDashed' },
        });

        // Re-upload series data onto the new device (e.g. after adapter switch)
        if (this.internalSeries.length > 0) {
            this.uploadSeriesGpuBuffers();
        }
    }

    // ---- Data / view management ----

    setData(seriesList: PlotSeries[]): void {
        this.seriesList = seriesList;

        // Detect axis types from the first non-empty value in each axis
        const xSample = seriesList.flatMap(s => s.x as (number | string | Date)[]);
        const ySample = seriesList.flatMap(s => s.y as (number | string | Date)[]);
        const xIsString = xSample.length > 0 && typeof xSample[0] === 'string';
        const xIsDate   = xSample.length > 0 && xSample[0] instanceof Date;
        const yIsString = ySample.length > 0 && typeof ySample[0] === 'string';
        const yIsDate   = ySample.length > 0 && ySample[0] instanceof Date;

        this.xIsDate = xIsDate;
        this.yIsDate = yIsDate;

        // Build sorted category label arrays (union across all series)
        this.xLabels = xIsString ? [...new Set(xSample as string[])].sort() : null;
        this.yLabels = yIsString ? [...new Set(ySample as string[])].sort() : null;

        const xMap = this.xLabels ? new Map(this.xLabels.map((l, i) => [l, i])) : null;
        const yMap = this.yLabels ? new Map(this.yLabels.map((l, i) => [l, i])) : null;

        // Normalize each series to numeric x/y
        this.internalSeries = seriesList.map(s => {
            let xn: number[] = xIsString ? (s.x as string[]).map(v => xMap!.get(v) ?? 0)
                             : xIsDate   ? (s.x as Date[]).map(d => d.getTime())
                             : s.x as number[];
            let yn: number[] = yIsString ? (s.y as string[]).map(v => yMap!.get(v) ?? 0)
                             : yIsDate   ? (s.y as Date[]).map(d => d.getTime())
                             : s.y as number[];

            // Sort by x when x has an intrinsic ordering (string/date)
            if ((xIsString || xIsDate) && xn.length > 1) {
                const idx = Array.from({length: xn.length}, (_, i) => i).sort((a, b) => xn[a]! - xn[b]!);
                xn = idx.map(i => xn[i]!);
                yn = idx.map(i => yn[i]!);
            }

            return {
                x: xn, y: yn,
                xSorted: xIsString || xIsDate || (() => {
                    for (let i = 1; i < xn.length; i++) {
                        if (xn[i]! < xn[i - 1]!) return false;
                    }
                    return true;
                })(),
                ...(s.color     !== undefined && { color:     s.color }),
                ...(s.lineStyle !== undefined && { lineStyle: s.lineStyle }),
                ...(s.lineWidth !== undefined && { lineWidth: s.lineWidth }),
                ...(s.marker    !== undefined && { marker:    s.marker }),
            };
        });

        this.resetDefaultView();

        // Upload raw data to GPU if device is already initialised
        if (this.device) {
            this.uploadSeriesGpuBuffers();
        }
    }

    private destroySeriesGpuBuffers(): void {
        for (const b of this.seriesRawBufs)      b.destroy();
        for (const b of this.seriesOutBufs)      b?.destroy();
        for (const b of this.seriesParamBufs)    b?.destroy();
        for (const b of this.markerOutBufs)      b?.destroy();
        for (const b of this.markerParamBufs)    b?.destroy();
        for (const b of this.dashedOutBufs)      b?.destroy();
        for (const b of this.dashedParamBufs)    b?.destroy();
        for (const b of this.dashedDrawArgsBufs) b?.destroy();
        this.seriesRawBufs      = [];
        this.seriesOutBufs      = [];
        this.seriesParamBufs    = [];
        this.seriesOutCounts    = [];
        this.markerOutBufs      = [];
        this.markerParamBufs    = [];
        this.markerOutCounts    = [];
        this.dashedOutBufs      = [];
        this.dashedParamBufs    = [];
        this.dashedDrawArgsBufs = [];
        this.dashedNumSegs      = [];
    }

    /** Creates (or recreates) per-series GPU buffers.
     *  Raw x/y data is uploaded here and never touched again until setData() is called.
     *  Output buffers are fixed size (MAX_COMPUTE_SEGS segments). */
    private uploadSeriesGpuBuffers(): void {
        this.destroySeriesGpuBuffers();
        const MAX = this.MAX_COMPUTE_SEGS;
        for (const series of this.internalSeries) {
            const n = series.x.length;

            // Raw interleaved x,y buffer (STORAGE | COPY_DST)
            const rawData = new Float32Array(n * 2);
            for (let i = 0; i < n; i++) { rawData[i * 2] = series.x[i]!; rawData[i * 2 + 1] = series.y[i]!; }
            const rawBuf = this.device.createBuffer({
                size: Math.max(rawData.byteLength, 8),
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
            if (rawData.byteLength > 0) this.device.queue.writeBuffer(rawBuf, 0, rawData);

            // Output vertex buffer and params uniform — skipped for markers-only series
            const markersOnly = series.lineStyle === 'none';
            if (!markersOnly) {
                const outBuf = this.device.createBuffer({
                    size: MAX * 36 * 4,  // MAX_SEGS * 6 verts * 6 floats * 4 bytes
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
                });
                const paramBuf = this.device.createBuffer({
                    size: 80,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                this.seriesOutBufs.push(outBuf);
                this.seriesParamBufs.push(paramBuf);
            } else {
                this.seriesOutBufs.push(null);
                this.seriesParamBufs.push(null);
            }

            this.seriesRawBufs.push(rawBuf);
            this.seriesOutCounts.push(0);

            // Marker GPU buffers — only when series has a marker style
            if (series.marker && series.marker.shape !== 'none') {
                const MAX_M = this.MAX_MARKER_COUNT;
                const mOutBuf = this.device.createBuffer({
                    // 6 verts × 15 floats × 4 bytes per marker
                    size: MAX_M * 6 * 15 * 4,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
                });
                const mParamBuf = this.device.createBuffer({
                    size: 112,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                this.markerOutBufs.push(mOutBuf);
                this.markerParamBufs.push(mParamBuf);
            } else {
                this.markerOutBufs.push(null);
                this.markerParamBufs.push(null);
            }
            this.markerOutCounts.push(0);

            // Dashed-line GPU buffers — only for series with a non-empty dash pattern
            const pattern = DASH_PATTERNS[series.lineStyle ?? '-'] ?? [];
            if (pattern.length > 0) {
                const dOutBuf = this.device.createBuffer({
                    label: 'dashed out',
                    size: this.MAX_DASHED_OUT_QUADS * 36 * 4,   // quads * 6 verts * 6 floats * 4 bytes
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
                });
                const dParamBuf = this.device.createBuffer({
                    label: 'dashed param',
                    size: 128,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                const dDrawArgsBuf = this.device.createBuffer({
                    label: 'dashed draw args',
                    size: 16,
                    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
                });
                this.dashedOutBufs.push(dOutBuf);
                this.dashedParamBufs.push(dParamBuf);
                this.dashedDrawArgsBufs.push(dDrawArgsBuf);
            } else {
                this.dashedOutBufs.push(null);
                this.dashedParamBufs.push(null);
                this.dashedDrawArgsBufs.push(null);
            }
            this.dashedNumSegs.push(0);
        }
    }

    private resetDefaultView(): void {
        // Compute minimum adjacent-point spacing to serve as the data-resolution zoom-in limit.
        let minDX = Infinity, minDY = Infinity;
        for (const s of this.internalSeries) {
            const n = s.x.length;
            for (let i = 1; i < n; i++) {
                const dx = Math.abs(s.x[i]! - s.x[i - 1]!);
                const dy = Math.abs(s.y[i]! - s.y[i - 1]!);
                if (dx > 1e-300 && dx < minDX) minDX = dx;
                if (dy > 1e-300 && dy < minDY) minDY = dy;
            }
        }
        this.minDataSpanX = isFinite(minDX) ? minDX : 1e-9;
        this.minDataSpanY = isFinite(minDY) ? minDY : 1e-9;

        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (const s of this.internalSeries) {
            for (let i = 0; i < s.x.length; i++) {
                if (s.x[i]! < xMin) xMin = s.x[i]!;
                if (s.x[i]! > xMax) xMax = s.x[i]!;
                if (s.y[i]! < yMin) yMin = s.y[i]!;
                if (s.y[i]! > yMax) yMax = s.y[i]!;
            }
        }
        if (!isFinite(xMin)) { xMin = 0; xMax = 1; yMin = 0; yMax = 1; }

        if (this.xLabels) {
            this.defaultViewXMin = -0.5;
            this.defaultViewXMax = this.xLabels.length - 0.5;
        } else if (this.xIsDate) {
            const margin = (xMax - xMin) * 0.05 || 3_600_000;
            this.defaultViewXMin = xMin - margin;
            this.defaultViewXMax = xMax + margin;
        } else {
            const xTicks = niceTicks(xMin, xMax, 5);
            this.defaultViewXMin = xTicks[0]!;
            this.defaultViewXMax = xTicks[xTicks.length - 1]!;
        }

        if (this.yLabels) {
            this.defaultViewYMin = -0.5;
            this.defaultViewYMax = this.yLabels.length - 0.5;
        } else if (this.yIsDate) {
            const margin = (yMax - yMin) * 0.05 || 3_600_000;
            this.defaultViewYMin = yMin - margin;
            this.defaultViewYMax = yMax + margin;
        } else {
            const yTicks = niceTicks(yMin, yMax, 5);
            this.defaultViewYMin = yTicks[0]!;
            this.defaultViewYMax = yTicks[yTicks.length - 1]!;
        }

        this.viewXMin = this.defaultViewXMin; this.viewXMax = this.defaultViewXMax;
        this.viewYMin = this.defaultViewYMin; this.viewYMax = this.defaultViewYMax;
    }

    private zoomAround(dataX: number, dataY: number, factor: number): void {
        const xRange = this.viewXMax - this.viewXMin;
        const yRange = this.viewYMax - this.viewYMin;
        const tx = (dataX - this.viewXMin) / xRange;
        const ty = (dataY - this.viewYMin) / yRange;

        // --- Zoom limits ---
        // Minimum view span = distance between two adjacent data points (zoom-in hard stop).
        // Maximum view span = data span × plot size in pixels:
        //   allows zooming out until the entire dataset occupies ~1 CSS pixel on screen.
        const minSpanX = this.minDataSpanX || 1e-9;
        const minSpanY = this.minDataSpanY || 1e-9;
        const plotWidthPx  = (this.plotRectX1 - this.plotRectX0) / 2 * this.canvas.clientWidth;
        const plotHeightPx = (this.plotRectY1 - this.plotRectY0) / 2 * this.canvas.clientHeight;
        const dataSpanX = this.defaultViewXMax - this.defaultViewXMin;
        const dataSpanY = this.defaultViewYMax - this.defaultViewYMin;
        const maxSpanX = dataSpanX * Math.max(plotWidthPx, 1);
        const maxSpanY = dataSpanY * Math.max(plotHeightPx, 1);

        let newXMin = dataX - tx * xRange * factor;
        let newXMax = newXMin + xRange * factor;
        let newYMin = dataY - ty * yRange * factor;
        let newYMax = newYMin + yRange * factor;

        // Clamp X span to [minSpanX, maxSpanX]
        if (newXMax - newXMin < minSpanX) {
            const mid = (newXMin + newXMax) / 2;
            newXMin = mid - minSpanX / 2;
            newXMax = mid + minSpanX / 2;
        } else if (maxSpanX > 0 && newXMax - newXMin > maxSpanX) {
            const mid = (newXMin + newXMax) / 2;
            newXMin = mid - maxSpanX / 2;
            newXMax = mid + maxSpanX / 2;
        }
        // Clamp Y span to [minSpanY, maxSpanY]
        if (newYMax - newYMin < minSpanY) {
            const mid = (newYMin + newYMax) / 2;
            newYMin = mid - minSpanY / 2;
            newYMax = mid + minSpanY / 2;
        } else if (maxSpanY > 0 && newYMax - newYMin > maxSpanY) {
            const mid = (newYMin + newYMax) / 2;
            newYMin = mid - maxSpanY / 2;
            newYMax = mid + maxSpanY / 2;
        }

        this.viewXMin = newXMin;
        this.viewXMax = newXMax;
        this.viewYMin = newYMin;
        this.viewYMax = newYMax;
    }

    private clientToData(clientX: number, clientY: number): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        const clipX = (clientX - rect.left) / rect.width  *  2 - 1;
        const clipY = 1 - (clientY - rect.top)  / rect.height * 2;
        const tx = (clipX - this.plotRectX0) / (this.plotRectX1 - this.plotRectX0);
        const ty = (clipY - this.plotRectY0) / (this.plotRectY1 - this.plotRectY0);
        return {
            x: this.viewXMin + tx * (this.viewXMax - this.viewXMin),
            y: this.viewYMin + ty * (this.viewYMax - this.viewYMin),
        };
    }

    private setMode(mode: 'pan' | 'zoomRegion' | 'inspect'): void {
        this.plotMode = mode;
        this.btnZoomRegion.classList.remove('active');
        this.btnInspect.classList.remove('active');
        this.crosshairVEl.style.display = 'none';
        this.crosshairHEl.style.display = 'none';
        this.tooltipEl.style.display = 'none';
        if (mode === 'zoomRegion') {
            this.canvas.style.cursor = 'crosshair';
            this.btnZoomRegion.classList.add('active');
        } else if (mode === 'inspect') {
            this.canvas.style.cursor = 'crosshair';
            this.btnInspect.classList.add('active');
        } else {
            this.canvas.style.cursor = 'grab';
        }
    }

    private formatXInspect(v: number): string {
        if (this.xLabels) return this.xLabels[Math.round(v)] ?? String(Math.round(v));
        if (this.xIsDate) return new Date(v).toLocaleString();
        return parseFloat(v.toPrecision(6)).toString();
    }

    private formatYInspect(v: number): string {
        if (this.yLabels) return this.yLabels[Math.round(v)] ?? String(Math.round(v));
        if (this.yIsDate) return new Date(v).toLocaleString();
        return parseFloat(v.toPrecision(6)).toString();
    }

    private updateInspector(mouseClientX: number, mouseClientY: number): void {
        const rect = this.canvas.getBoundingClientRect();
        const w = rect.width, h = rect.height;
        const mousePxX = mouseClientX - rect.left;
        const mousePxY = mouseClientY - rect.top;

        const plotPxX0 = (this.plotRectX0 + 1) / 2 * w;
        const plotPxX1 = (this.plotRectX1 + 1) / 2 * w;
        const plotPxY0 = (1 - this.plotRectY1) / 2 * h;  // top of plot in CSS px
        const plotPxY1 = (1 - this.plotRectY0) / 2 * h;  // bottom of plot in CSS px

        const hide = () => {
            this.crosshairVEl.style.display = 'none';
            this.crosshairHEl.style.display = 'none';
            this.tooltipEl.style.display = 'none';
        };

        if (mousePxX < plotPxX0 || mousePxX > plotPxX1 ||
            mousePxY < plotPxY0 || mousePxY > plotPxY1) { hide(); return; }

        const mouseDataX = this.viewXMin + (mousePxX - plotPxX0) / (plotPxX1 - plotPxX0) * (this.viewXMax - this.viewXMin);

        const dtoPxX = (x: number) =>
            plotPxX0 + (x - this.viewXMin) / (this.viewXMax - this.viewXMin) * (plotPxX1 - plotPxX0);
        const dtoPxY = (y: number) => {
            const t = (y - this.viewYMin) / (this.viewYMax - this.viewYMin);
            return (1 - (this.plotRectY0 + t * (this.plotRectY1 - this.plotRectY0))) / 2 * h;
        };

        let bestDist2 = 30 * 30;  // 30 px snap radius
        let bestSeries = -1, bestPt = -1;

        for (let si = 0; si < this.internalSeries.length; si++) {
            const s = this.internalSeries[si]!;
            if (s.x.length === 0) continue;
            // Binary search to find the index with x closest to mouseDataX
            let lo = 0, hi = s.x.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (s.x[mid]! < mouseDataX) lo = mid + 1;
                else hi = mid;
            }
            // Scan a window around that index (covers dense & sparse data alike)
            const W = 200;
            for (let i = Math.max(0, lo - W); i <= Math.min(s.x.length - 1, lo + W); i++) {
                const dx = dtoPxX(s.x[i]!) - mousePxX;
                const dy = dtoPxY(s.y[i]!) - mousePxY;
                const d2 = dx*dx + dy*dy;
                if (d2 < bestDist2) { bestDist2 = d2; bestSeries = si; bestPt = i; }
            }
        }

        if (bestSeries < 0) { hide(); return; }

        const dataX = this.internalSeries[bestSeries]!.x[bestPt]!;
        const dataY = this.internalSeries[bestSeries]!.y[bestPt]!;
        const ptPxX = dtoPxX(dataX);
        const ptPxY = dtoPxY(dataY);

        this.crosshairVEl.style.display = 'block';
        this.crosshairVEl.style.left = ptPxX + 'px';
        this.crosshairHEl.style.display = 'block';
        this.crosshairHEl.style.top  = ptPxY + 'px';

        const label = this.internalSeries.length > 1
            ? `x: ${this.formatXInspect(dataX)}\ny: ${this.formatYInspect(dataY)}\nseries: ${bestSeries + 1}`
            : `x: ${this.formatXInspect(dataX)}\ny: ${this.formatYInspect(dataY)}`;
        this.tooltipEl.textContent = label;
        this.tooltipEl.style.display = 'block';

        // Position tooltip near the mouse — flip if too close to an edge
        let tipX = mousePxX + 14;
        let tipY = mousePxY - this.tooltipEl.offsetHeight - 6;
        if (tipX + this.tooltipEl.offsetWidth > w - 4) tipX = mousePxX - this.tooltipEl.offsetWidth - 14;
        if (tipY < 4) tipY = mousePxY + 14;
        if (tipX < 4) tipX = 4;
        this.tooltipEl.style.left = tipX + 'px';
        this.tooltipEl.style.top  = tipY + 'px';
    }

    // ---- Compute plot rectangle from padding options (in clip space) ----
    private computePlotRect(
        w: number, h: number,
        yTickMaxWidthPx: number
    ): { x0: number; y0: number; x1: number; y1: number } {
        const o = this.opts;
        const fs = o.fontSize;
        const titleFs = o.titleFontSize;

        // All lengths converted from pixels to clip-space units
        const pxX = 2.0 / w;  // 1 pixel in clip-space X
        const pxY = 2.0 / h;  // 1 pixel in clip-space Y

        // Estimated rendered heights/widths in pixels (cap-height ≈ 0.75 * fontSize)
        const capH = fs * 0.75;
        const titleCapH = titleFs * 0.75;

        // Y-axis label width (rotated, so it occupies width = capH pixels)
        const yLabelWidth = capH;  // rotated text occupies one cap-height in X

        // Left boundary:
        //   paddingLeft  →  y-label  →  paddingYLabelToYTicks  →  y-tick values  →  gap  →  plot edge
        // For 'out'/'both' ticks the tick itself (8px) is outside the plot border and
        // must be included in the gap between the label text and the plot edge.
        const tickDir = o.style.tickDirection;
        const tickOutPx = (tickDir === 'out' || tickDir === 'both') ? 8 : 0;  // outward tick length
        const tickToPlotGapPx = tickOutPx + 4;  // tick + 4px label gap
        const leftPx = o.paddingLeft + yLabelWidth + o.paddingYLabelToYTicks + yTickMaxWidthPx + tickToPlotGapPx;

        // Right boundary= paddingRight from right edge
        const rightPx = w - o.paddingRight;

        // Top boundary = paddingTop + titleCapH + paddingTitleToPlot
        const topPx = o.paddingTop + titleCapH + o.paddingTitleToPlot;

        // Bottom boundary = paddingBottom + xLabelCapH + paddingXLabelToPlot + xTickLabelCapH + tick space
        const xTickLabelHeightPx = capH;
        const tickLenPx = 8;
        const tickDir2 = o.style.tickDirection;
        const xTickOutPx = (tickDir2 === 'out' || tickDir2 === 'both') ? tickLenPx : 0;
        const bottomPx = h - (o.paddingBottom + capH + o.paddingXLabelToPlot + xTickLabelHeightPx + xTickOutPx + 4);

        // Convert from pixel coordinates (origin top-left) to clip space (origin center, Y-up)
        const x0 = leftPx  * pxX - 1;
        const x1 = rightPx * pxX - 1;
        const y1 = 1 - topPx    * pxY;  // top of plot in clip space
        const y0 = 1 - bottomPx * pxY;  // bottom of plot in clip space (must be < y1 but > -1)

        return { x0, y0, x1, y1 };
    }

    // ---- Save as image / PDF ----

    private async saveAs(format: 'png' | 'jpeg' | 'pdf'): Promise<void> {
        this.render();  // ensure latest frame is on canvas
        const w = this.canvas.width;
        const h = this.canvas.height;
        const offscreen = document.createElement('canvas');
        offscreen.width  = w;
        offscreen.height = h;
        offscreen.getContext('2d')!.drawImage(this.canvas, 0, 0);

        let blob: Blob;
        let filename: string;

        if (format === 'png') {
            blob = await new Promise<Blob>(res => offscreen.toBlob(b => res(b!), 'image/png'));
            filename = 'plot.png';
        } else if (format === 'jpeg') {
            blob = await new Promise<Blob>(res => offscreen.toBlob(b => res(b!), 'image/jpeg', 0.92));
            filename = 'plot.jpg';
        } else {
            // PDF: embed JPEG in a minimal hand-crafted PDF
            const jpegBlob = await new Promise<Blob>(res => offscreen.toBlob(b => res(b!), 'image/jpeg', 0.92));
            const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
            blob = this.buildSimplePdf(jpegBytes, w, h);
            filename = 'plot.pdf';
        }

        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    /** Builds a minimal single-page PDF that embeds the supplied JPEG bytes. */
    private buildSimplePdf(jpegBytes: Uint8Array, imgW: number, imgH: number): Blob {
        const enc = new TextEncoder();
        const e = (s: string) => enc.encode(s);

        const contStr   = `q ${imgW} 0 0 ${imgH} 0 0 cm /Im0 Do Q\n`;
        const contBytes = e(contStr);

        const parts: Uint8Array[] = [];
        const xref: number[] = [0]; // xref[0] is always the free object
        let pos = 0;

        const add = (...chunks: Uint8Array[]): void => {
            for (const c of chunks) { parts.push(c); pos += c.byteLength; }
        };

        add(e('%PDF-1.4\n'));

        xref.push(pos);
        add(e('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));

        xref.push(pos);
        add(e('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'));

        xref.push(pos);
        add(e(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${imgW} ${imgH}]` +
              ` /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`));

        // Image XObject (JPEG, DCTDecode filter)
        xref.push(pos);
        add(
            e(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH}` +
              ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.byteLength} >>\nstream\n`),
            jpegBytes,
            e('\nendstream\nendobj\n')
        );

        // Content stream (places the image on the page)
        xref.push(pos);
        add(
            e(`5 0 obj\n<< /Length ${contBytes.byteLength} >>\nstream\n`),
            contBytes,
            e('endstream\nendobj\n')
        );

        // Cross-reference table
        const xrefPos  = pos;
        const xrefSect = xref.map((o, i) =>
            i === 0 ? '0000000000 65535 f \n' : `${String(o).padStart(10, '0')} 00000 n \n`
        ).join('');
        add(e(`xref\n0 ${xref.length}\n${xrefSect}` +
              `trailer\n<< /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`));

        // Assemble all chunks into a single Uint8Array
        const total = parts.reduce((s, p) => s + p.byteLength, 0);
        const pdf   = new Uint8Array(total);
        let offset  = 0;
        for (const p of parts) { pdf.set(p, offset); offset += p.byteLength; }
        return new Blob([pdf], { type: 'application/pdf' });
    }

    // ---- Main render ----

    /** Schedules a render on the next animation frame, deduplicating multiple calls per frame. */
    scheduleRender(): void {
        if (this.rafPending) return;
        this.rafPending = true;
        requestAnimationFrame(() => { this.rafPending = false; this.render(); });
    }

    render(): void {
        if (!this.device) return;
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (w === 0 || h === 0) return;
        this.canvas.width  = w;
        this.canvas.height = h;

        const ssaaTexture = this.device.createTexture({
            size: [w * this.ssaaScale, h * this.ssaaScale],
            format: this.canvasFormat,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });

        const pixelX = 2.0 / w;
        const pixelY = 2.0 / h;
        const o = this.opts;
        const font = this.font;
        const fs = o.fontSize;
        const titleFs = o.titleFontSize;

        // ---- Ticks ----
        const xSpan = this.viewXMax - this.viewXMin;
        const ySpan = this.viewYMax - this.viewYMin;
        // Use relative tolerance to detect real zoom vs floating-point drift during pan
        const xSpanChanged = this.lastXSpan < 0 || Math.abs(xSpan - this.lastXSpan) / this.lastXSpan > 1e-9;
        const ySpanChanged = this.lastYSpan < 0 || Math.abs(ySpan - this.lastYSpan) / this.lastYSpan > 1e-9;
        let xTicks: number[];
        let yTicks: number[];
        if (this.xLabels) {
            xTicks = categoricalTicks(this.viewXMin, this.viewXMax);
        } else if (this.xIsDate) {
            if (xSpanChanged) { this.xTickStep = getDateTickStep(xSpan); this.lastXSpan = xSpan; }
            xTicks = dateTicksFromStep(this.viewXMin, this.viewXMax, this.xTickStep);
        } else {
            if (xSpanChanged) { this.xTickStep = getTickStep(this.viewXMin, this.viewXMax); this.lastXSpan = xSpan; }
            xTicks = ticksFromStep(this.viewXMin, this.viewXMax, this.xTickStep);
        }
        if (this.yLabels) {
            yTicks = categoricalTicks(this.viewYMin, this.viewYMax);
        } else if (this.yIsDate) {
            if (ySpanChanged) { this.yTickStep = getDateTickStep(ySpan); this.lastYSpan = ySpan; }
            yTicks = dateTicksFromStep(this.viewYMin, this.viewYMax, this.yTickStep);
        } else {
            if (ySpanChanged) { this.yTickStep = getTickStep(this.viewYMin, this.viewYMax); this.lastYSpan = ySpan; }
            yTicks = ticksFromStep(this.viewYMin, this.viewYMax, this.yTickStep);
        }
        const fmtX = (v: number) => this.xLabels ? (this.xLabels[Math.round(v)] ?? '') : this.xIsDate ? formatDateTick(v, this.xTickStep) : formatTick(v);
        const fmtY = (v: number) => this.yLabels ? (this.yLabels[Math.round(v)] ?? '') : this.yIsDate ? formatDateTick(v, this.yTickStep) : formatTick(v);

        // Measure actual max y-tick label width in pixels (clip-space width × w/2)
        const yTickMaxWidthPx = yTicks.reduce((max, tick) => {
            const wClip = textWidthClip(fmtY(tick), font, fs, w);
            return Math.max(max, wClip * w / 2);
        }, fs * 0.6);  // fallback minimum

        // Compute plot rectangle using real tick label widths
        let pr = this.computePlotRect(w, h, yTickMaxWidthPx);

        // Equal aspect ratio: shrink the larger dimension so that
        // 1 data unit on X == 1 data unit on Y in screen pixels.
        if (this.opts.style.aspectRatio === 'equal') {
            const xSpanAR = this.viewXMax - this.viewXMin;
            const ySpanAR = this.viewYMax - this.viewYMin;
            if (xSpanAR > 0 && ySpanAR > 0) {
                const plotWpx = (pr.x1 - pr.x0) * w / 2;  // plot panel width  in px
                const plotHpx = (pr.y1 - pr.y0) * h / 2;  // plot panel height in px
                const pxPerUnitX = plotWpx / xSpanAR;
                const pxPerUnitY = plotHpx / ySpanAR;
                if (pxPerUnitX > pxPerUnitY) {
                    // Panel is too wide → shrink width, keep height
                    const newWpx  = pxPerUnitY * xSpanAR;
                    const cx      = (pr.x0 + pr.x1) / 2;
                    pr = { ...pr, x0: cx - newWpx / w, x1: cx + newWpx / w };
                } else {
                    // Panel is too tall → shrink height, keep width
                    const newHpx  = pxPerUnitX * ySpanAR;
                    const cy      = (pr.y0 + pr.y1) / 2;
                    pr = { ...pr, y0: cy - newHpx / h, y1: cy + newHpx / h };
                }
            }
        }

        this.plotRectX0 = pr.x0; this.plotRectY0 = pr.y0;
        this.plotRectX1 = pr.x1; this.plotRectY1 = pr.y1;
        const { x0: rectX0, y0: rectY0, x1: rectX1, y1: rectY1 } = pr;

        const style = this.opts.style;
        const [cr, cg, cb] = style.axisColor;  // axes/tick color

        const verts: number[] = [];
        const textVerts: number[] = [];
        const titleVerts: number[] = [];

        // ---- Panel background (filled rectangle, ggplot2 grey92 by default) ----
        const [bgR, bgG, bgB] = style.background.panelColor;
        const bgVerts: number[] = [
            rectX0, rectY0, bgR, bgG, bgB,
            rectX1, rectY0, bgR, bgG, bgB,
            rectX1, rectY1, bgR, bgG, bgB,
            rectX0, rectY0, bgR, bgG, bgB,
            rectX1, rectY1, bgR, bgG, bgB,
            rectX0, rectY1, bgR, bgG, bgB,
        ];

        // ---- Plot border (2px thick) ----
        const lineWidth = 2;
        for (let i = 0; i < lineWidth; i++) {
            const bx0 = rectX0 + pixelX * i, by0 = rectY0 + pixelY * i;
            const bx1 = rectX1 - pixelX * i, by1 = rectY1 - pixelY * i;
            const ex = pixelX * 0.5;
            verts.push(bx0 - ex, by0, cr, cg, cb,  bx1 + ex, by0, cr, cg, cb);
            verts.push(bx0 - ex, by1, cr, cg, cb,  bx1 + ex, by1, cr, cg, cb);
            verts.push(bx0, by0, cr, cg, cb,  bx0, by1, cr, cg, cb);
            verts.push(bx1, by0, cr, cg, cb,  bx1, by1, cr, cg, cb);
        }

        // ---- Ticks ----
        const dataToClipX = (x: number) =>
            rectX0 + (x - this.viewXMin) / (this.viewXMax - this.viewXMin) * (rectX1 - rectX0);
        const dataToClipY = (y: number) =>
            rectY0 + (y - this.viewYMin) / (this.viewYMax - this.viewYMin) * (rectY1 - rectY0);

        const tickLenX = pixelX * 8;
        const tickLenY = pixelY * 8;
        const tickDir = style.tickDirection;
        // Inward/outward extents for each tick line endpoint relative to the border
        const xTickIn  = (tickDir === 'in'   || tickDir === 'both') ?  tickLenY : 0;  // into panel (Y+)
        const xTickOut = (tickDir === 'out'  || tickDir === 'both') ? -tickLenY : 0;  // outside panel (Y-)
        const yTickIn  = (tickDir === 'in'   || tickDir === 'both') ?  tickLenX : 0;  // into panel (X+)
        const yTickOut = (tickDir === 'out'  || tickDir === 'both') ? -tickLenX : 0;  // outside panel (X-)
        // Label offset: labels always sit beyond the outer end of the tick
        const xLabelOffsetPx = (tickDir === 'in' ? 4 : 8 + 4);  // px below the border
        const yLabelOffsetPx = (tickDir === 'in' ? 4 : 8 + 4);  // px left of the border

        // ---- Grid lines first (so tick marks render on top) ----
        if (style.grid.show) {
            const [gridR, gridG, gridB] = style.grid.color;
            for (const tick of xTicks) {
                const tx = dataToClipX(tick);
                verts.push(tx, rectY0, gridR, gridG, gridB,  tx, rectY1, gridR, gridG, gridB);
            }
            for (const tick of yTicks) {
                const ty = dataToClipY(tick);
                verts.push(rectX0, ty, gridR, gridG, gridB,  rectX1, ty, gridR, gridG, gridB);
            }
        }

        // ---- Tick marks (drawn after grid so they appear on top) ----
        for (const tick of xTicks) {
            const tx = dataToClipX(tick);
            verts.push(tx, rectY0 + xTickOut, cr, cg, cb,  tx, rectY0 + xTickIn, cr, cg, cb);
            const label = fmtX(tick);
            const lw = textWidthClip(label, font, fs, w);
            textVerts.push(...textToTriVerts(
                label, font,
                tx - lw / 2,
                rectY0 - pixelY * (fs * 0.75 + xLabelOffsetPx),
                fs, w, h, cr, cg, cb
            ));
        }

        for (const tick of yTicks) {
            const ty = dataToClipY(tick);
            verts.push(rectX0 + yTickOut, ty, cr, cg, cb,  rectX0 + yTickIn, ty, cr, cg, cb);
            const label = fmtY(tick);
            const lw = textWidthClip(label, font, fs, w);
            textVerts.push(...textToTriVerts(
                label, font,
                rectX0 - lw - pixelX * yLabelOffsetPx,
                ty - pixelY * fs * 0.35,
                fs, w, h, cr, cg, cb
            ));
        }

        // ---- Data series ----
        // Solid lines  → GPU compute path (no JS iteration, only binary-search + 80-byte write).
        // Dashed lines → GPU compute path (dashed compute shader + finalize shader + drawIndirect).

        const MAX = this.MAX_COMPUTE_SEGS;
        const MAX_DASHED = 5_000;   // max decimated segments per dashed series

        for (let si = 0; si < this.internalSeries.length; si++) {
            const series = this.internalSeries[si]!;
            const pattern = DASH_PATTERNS[series.lineStyle ?? '-'] ?? [];
            const isSolid = pattern.length === 0;
            const [dr, dg, db] = series.color ?? [0, 0.447, 0.741];  // MATLAB default blue
            const seriesAlpha = series.color?.[3] ?? 1.0;

            if (!isSolid) {
                // GPU compute path for dashed lines
                const dParamBuf = this.dashedParamBufs[si];
                if (!dParamBuf) { this.dashedNumSegs[si] = 0; continue; }

                const n = series.x.length;
                if (n < 2) { this.dashedNumSegs[si] = 0; continue; }

                // Binary search for visible X range
                let startI = 0, endI = n - 1;
                if (series.xSorted) {
                    let lo = 0, hi = n;
                    while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! < this.viewXMin) lo = mid + 1; else hi = mid; }
                    startI = Math.max(0, lo - 1);
                    lo = 0; hi = n;
                    while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! <= this.viewXMax) lo = mid + 1; else hi = mid; }
                    endI = Math.min(n - 1, lo);
                }
                const visibleSegs = endI - startI;
                const stride  = Math.max(1, Math.ceil(visibleSegs / MAX_DASHED));
                const numSegs = Math.ceil(visibleSegs / stride);
                this.dashedNumSegs[si] = numSegs;

                // Pad pattern array to 8 elements
                // Pattern values are in CSS pixels — no SSAA scaling needed
                const patPadded = new Float32Array(8);
                for (let k = 0; k < pattern.length; k++) patPadded[k] = pattern[k]!;

                // Fill 128-byte DashedParams uniform
                const dAB = new ArrayBuffer(128);
                const df  = new Float32Array(dAB);
                const du  = new Uint32Array(dAB);
                df[0]  = this.viewXMin; df[1]  = this.viewXMax; df[2]  = this.viewYMin; df[3]  = this.viewYMax;
                df[4]  = rectX0;        df[5]  = rectX1;        df[6]  = rectY0;        df[7]  = rectY1;
                df[8]  = w;             df[9]  = h;
                df[10] = (series.lineWidth ?? 1) / 2;   df[11] = dr!;
                df[12] = dg!;           df[13] = db!;   df[14] = seriesAlpha;
                // df[15] = _p1
                du[16] = startI;        du[17] = stride;        du[18] = numSegs;
                du[19] = this.MAX_DASHED_OUT_QUADS;
                du[20] = pattern.length;
                // du[21..23] = _pad
                df.set(patPadded, 24);  // pattern[8] at byte offset 96
                this.device.queue.writeBuffer(dParamBuf, 0, dAB);

                this.seriesOutCounts[si] = 0;
                continue;
            }

            // --- Compute path for solid lines ---
            const n = series.x.length;
            if (n < 2 || !this.seriesParamBufs[si]) { this.seriesOutCounts[si] = 0; continue; }

            // Binary search for visible X range (O(log N))
            let startI = 0, endI = n - 1;
            if (series.xSorted) {
                let lo = 0, hi = n;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! < this.viewXMin) lo = mid + 1; else hi = mid; }
                startI = Math.max(0, lo - 1);
                lo = 0; hi = n;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! <= this.viewXMax) lo = mid + 1; else hi = mid; }
                endI = Math.min(n - 1, lo);
            }
            const visibleSegs = endI - startI;
            const stride   = Math.max(1, Math.ceil(visibleSegs / MAX));
            const numSegs  = Math.ceil(visibleSegs / stride);
            this.seriesOutCounts[si] = numSegs * 6;

            // Fill 80-byte SeriesParams uniform
            const paramAB = new ArrayBuffer(80);
            const pf = new Float32Array(paramAB);
            const pu = new Uint32Array(paramAB);
            pf[0] = this.viewXMin; pf[1] = this.viewXMax; pf[2] = this.viewYMin; pf[3] = this.viewYMax;
            pf[4] = rectX0;        pf[5] = rectX1;        pf[6] = rectY0;        pf[7] = rectY1;
            pf[8] = w;             pf[9] = h;             pf[10] = (series.lineWidth ?? 1) / 2;  pf[11] = dr!;
            pf[12] = dg!;          pf[13] = db!;          pf[14] = seriesAlpha;
            // pf[15] = _pad1 (zero)
            pu[16] = startI;       pu[17] = stride;       pu[18] = numSegs;
            this.device.queue.writeBuffer(this.seriesParamBufs[si]!, 0, paramAB);
        }

        // ---- Marker params: binary-search visible range + write MarkerParams uniform ----
        for (let si = 0; si < this.internalSeries.length; si++) {
            const series  = this.internalSeries[si]!;
            const mkStyle = series.marker;
            if (!mkStyle || mkStyle.shape === 'none' || !this.markerParamBufs[si]) {
                this.markerOutCounts[si] = 0;
                continue;
            }
            const n = series.x.length;
            if (n === 0) { this.markerOutCounts[si] = 0; continue; }

            const [dr, dg, db] = series.color ?? [0, 0.447, 0.741];
            const seriesAlpha = series.color?.[3] ?? 1.0;

            // Resolve colours and alphas (null = inherit series color/alpha)
            const [fr, fg, fb] = mkStyle.faceColor ?? [dr!, dg!, db!];
            const faceA = mkStyle.faceColor === null ? 0.0 : (mkStyle.faceColor[3] ?? 1.0);
            const [er, eg, eb] = mkStyle.edgeColor ?? [dr!, dg!, db!];
            const edgeA = mkStyle.edgeColor === null ? seriesAlpha : (mkStyle.edgeColor[3] ?? 1.0);

            // Outer radius and inner radius in CSS pixels
            const outerR = mkStyle.size / 2;
            const ew     = mkStyle.edgeWidth;
            // innerR < 0 means no fill (hollow marker)
            // For hollow markers (faceColor === null): innerR is stored as -(outerR - edgeWidth).
            // Negative innerR signals "hollow" to the shader; its absolute value is the ring inner boundary.
            const innerR = mkStyle.faceColor === null ? -Math.max(0, outerR - ew) : Math.max(0, outerR - ew);

            // Binary search for visible X range
            let startI = 0, endI = n - 1;
            if (series.xSorted) {
                let lo = 0, hi = n;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! < this.viewXMin) lo = mid + 1; else hi = mid; }
                startI = Math.max(0, lo - 1);
                lo = 0; hi = n;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (series.x[mid]! <= this.viewXMax) lo = mid + 1; else hi = mid; }
                endI = Math.min(n - 1, lo);
            }
            const visiblePts = endI - startI + 1;
            const MAX_M  = this.MAX_MARKER_COUNT;
            const stride = Math.max(1, Math.ceil(visiblePts / MAX_M));
            const numPts = Math.ceil(visiblePts / stride);
            this.markerOutCounts[si] = numPts * 6;

            // Shape ID lookup
            const SHAPE_IDS: Record<string, number> = {
                'o': 0, '+': 1, '*': 2, '.': 3, 'x': 4, '_': 5, '|': 6,
                'square': 7, 'diamond': 8,
                '^': 9, 'v': 10, '>': 11, '<': 12,
                'pentagram': 13, 'hexagram': 14,
            };
            const shapeId = SHAPE_IDS[mkStyle.shape] ?? 0;

            // Fill 112-byte MarkerParams uniform
            const mAB = new ArrayBuffer(112);
            const mf  = new Float32Array(mAB);
            const mu  = new Uint32Array(mAB);
            mf[0]  = this.viewXMin; mf[1]  = this.viewXMax; mf[2]  = this.viewYMin; mf[3]  = this.viewYMax;
            mf[4]  = rectX0;       mf[5]  = rectX1;        mf[6]  = rectY0;        mf[7]  = rectY1;
            mf[8]  = w;            mf[9]  = h;             mf[10] = this.ssaaScale; mf[11] = outerR;
            mf[12] = innerR;       mf[13] = fr!;           mf[14] = fg!;           mf[15] = fb!;
            mf[16] = faceA;        mf[17] = er!;           mf[18] = eg!;           mf[19] = eb!;
            mu[20] = startI;       mu[21] = stride;        mu[22] = numPts;        mf[23] = edgeA;
            mu[24] = shapeId;      // mu[25..27] = _pad
            this.device.queue.writeBuffer(this.markerParamBufs[si]!, 0, mAB);
        }

        // ---- Title ----
        const titleText = this.figureOpts.title;
        if (titleText) {
            const titleW = textWidthClip(titleText, font, titleFs, w);
            const titleX = (rectX0 + rectX1) / 2 - titleW / 2;
            // Top of canvas in clip space = 1.0; title baseline is below paddingTop + titleCapH
            const titleBaselineClip = 1 - (o.paddingTop + titleFs * 0.75) * pixelY;
            // Use title baseline clip Y directly
            const titleY = 1 - o.paddingTop * pixelY;  // top of title cap
            titleVerts.push(...textToTriVerts(
                titleText, font,
                titleX,
                titleY - titleFs * 0.75 * pixelY,
                titleFs, w, h, cr, cg, cb
            ));
            void titleBaselineClip;
        }

        // ---- X Axis label ----
        const xAxisLabel = this.figureOpts.xlabel;
        if (xAxisLabel) {
            const lw = textWidthClip(xAxisLabel, font, fs, w);
            const lx = (rectX0 + rectX1) / 2 - lw / 2;
            // baseline sits paddingBottom pixels above canvas bottom
            const baselinePxFromTop = h - o.paddingBottom;
            const ly = 1 - baselinePxFromTop * pixelY;
            textVerts.push(...textToTriVerts(xAxisLabel, font, lx, ly, fs, w, h, cr, cg, cb));
        }

        // ---- Y Axis label (rotated 90° CCW) ----
        const yAxisLabel = this.figureOpts.ylabel;
        if (yAxisLabel) {
            const scalePx = fs / font.unitsPerEm;
            const sfX = 2.0 / w;
            const sfY = 2.0 / h;

            const pxVerts: number[] = [];
            let penPx = 0;
            for (const char of yAxisLabel) {
                const glyph = font.charToGlyph(char);
                const path  = glyph.getPath(0, 0, fs);
                const triXY = glyphToTriangles(path);
                for (let i = 0; i < triXY.length; i += 2) {
                    pxVerts.push(triXY[i]! + penPx, triXY[i+1]!, cr, cg, cb);
                }
                penPx += (glyph.advanceWidth ?? 0) * scalePx;
            }
            const labelWPx = penPx;
            for (let i = 0; i < pxVerts.length; i += 5) pxVerts[i]! - labelWPx / 2;

            // Center of the y-axis label: vertically centered on the plot
            const yLabelCenterClipY = (rectY0 + rectY1) / 2;
            // X position: paddingLeft + capH/2 from left in clip space
            const yLabelCenterClipX = -1 + (o.paddingLeft + fs * 0.75 / 2) * pixelX;

            for (let i = 0; i < pxVerts.length; i += 5) {
                const px = pxVerts[i]! - labelWPx / 2;
                const py = pxVerts[i+1]!;
                textVerts.push(
                     py * sfX + yLabelCenterClipX,
                     px * sfY + yLabelCenterClipY,
                    cr, cg, cb
                );
            }
        }

        // ---- Upload to GPU ----
        const mkBuf = (data: Float32Array, label: string): GPUBuffer => {
            const buf = this.device.createBuffer({
                label,
                size: Math.max(data.byteLength, 4),
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
            });
            if (data.byteLength > 0) this.device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
            return buf;
        };

        const bgBuf       = mkBuf(new Float32Array(bgVerts),       "Panel BG verts");
        const vertexBuf   = mkBuf(new Float32Array(verts),        "Line verts");
        const textBuf     = mkBuf(new Float32Array(textVerts),     "Text verts");
        const titleBuf    = mkBuf(new Float32Array(titleVerts),    "Title verts");

        // Scissor rect for data clipping
        const W = w * this.ssaaScale, H = h * this.ssaaScale;
        const sci_x = Math.ceil ((rectX0 + 1) / 2 * W);
        const sci_y = Math.ceil ((1 - rectY1) / 2 * H);
        const sci_w = Math.floor((rectX1 + 1) / 2 * W) - sci_x;
        const sci_h = Math.floor((1 - rectY0) / 2 * H) - sci_y;

        const encoder = this.device.createCommandEncoder();

        // ---- Compute passes: one per solid series (before render pass) ----
        for (let si = 0; si < this.internalSeries.length; si++) {
            const numSegs = (this.seriesOutCounts[si] ?? 0) / 6;
            if (numSegs <= 0 || !this.seriesParamBufs[si]) continue;
            const pattern = DASH_PATTERNS[this.internalSeries[si]!.lineStyle ?? '-'] ?? [];
            if (pattern.length !== 0) continue;  // skip dashed series

            const bindGroup = this.device.createBindGroup({
                layout: this.computePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.seriesParamBufs[si]! } },
                    { binding: 1, resource: { buffer: this.seriesRawBufs[si]!   } },
                    { binding: 2, resource: { buffer: this.seriesOutBufs[si]!   } },
                ]
            });
            const computePass = encoder.beginComputePass();
            computePass.setPipeline(this.computePipeline);
            computePass.setBindGroup(0, bindGroup);
            computePass.dispatchWorkgroups(Math.ceil(numSegs / 64));
            computePass.end();
        }

        // ---- Compute passes: one per series with markers ----
        for (let si = 0; si < this.internalSeries.length; si++) {
            const numPts = (this.markerOutCounts[si] ?? 0) / 6;
            if (numPts <= 0 || !this.markerParamBufs[si] || !this.markerOutBufs[si]) continue;

            const bindGroup = this.device.createBindGroup({
                layout: this.markerComputePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.markerParamBufs[si]! } },
                    { binding: 1, resource: { buffer: this.seriesRawBufs[si]!   } },
                    { binding: 2, resource: { buffer: this.markerOutBufs[si]!   } },
                ]
            });
            const mPass = encoder.beginComputePass();
            mPass.setPipeline(this.markerComputePipeline);
            mPass.setBindGroup(0, bindGroup);
            mPass.dispatchWorkgroups(Math.ceil(numPts / 64));
            mPass.end();
        }

        // ---- Compute passes: one per dashed series ----
        for (let si = 0; si < this.internalSeries.length; si++) {
            const numSegs = this.dashedNumSegs[si] ?? 0;
            const dParamBuf    = this.dashedParamBufs[si];
            const dOutBuf      = this.dashedOutBufs[si];
            const dDrawArgsBuf = this.dashedDrawArgsBufs[si];
            if (numSegs <= 0 || !dParamBuf || !dOutBuf || !dDrawArgsBuf) continue;

            // Dispatch dashed compute shader (1 thread, sequential, writes drawArgs)
            const dBindGroup = this.device.createBindGroup({
                layout: this.dashedComputePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: dParamBuf    } },
                    { binding: 1, resource: { buffer: this.seriesRawBufs[si]! } },
                    { binding: 2, resource: { buffer: dOutBuf      } },
                    { binding: 3, resource: { buffer: dDrawArgsBuf } },
                ]
            });
            const dPass = encoder.beginComputePass();
            dPass.setPipeline(this.dashedComputePipeline);
            dPass.setBindGroup(0, dBindGroup);
            dPass.dispatchWorkgroups(1);   // single-threaded: 1 workgroup × 1 thread
            dPass.end();
        }

        // Pass 1: render into SSAA texture
        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: ssaaTexture.createView(),
                loadOp: "clear",
                clearValue: { r: style.background.figureColor[0], g: style.background.figureColor[1], b: style.background.figureColor[2], a: 1 },
                storeOp: "store"
            }]
        });

        renderPass.setPipeline(this.textPipeline);
        renderPass.setVertexBuffer(0, bgBuf);
        renderPass.draw(bgVerts.length / 5);

        renderPass.setPipeline(this.linePipeline);
        renderPass.setVertexBuffer(0, vertexBuf);
        renderPass.draw(verts.length / 5);

        // Draw data series within scissor rect
        renderPass.setScissorRect(sci_x, sci_y, sci_w, sci_h);
        renderPass.setPipeline(this.seriesLinePipeline);  // triangle-list, alpha blending

        // Solid series — draw from GPU compute output buffers
        for (let si = 0; si < this.internalSeries.length; si++) {
            const vertCount = this.seriesOutCounts[si] ?? 0;
            if (vertCount <= 0 || !this.seriesOutBufs[si]) continue;
            const pattern = DASH_PATTERNS[this.internalSeries[si]!.lineStyle ?? '-'] ?? [];
            if (pattern.length !== 0) continue;
            renderPass.setVertexBuffer(0, this.seriesOutBufs[si]!);
            renderPass.draw(vertCount);
        }

        // Dashed series — draw from GPU compute output buffer via drawIndirect
        for (let si = 0; si < this.internalSeries.length; si++) {
            const dOutBuf      = this.dashedOutBufs[si];
            const dDrawArgsBuf = this.dashedDrawArgsBufs[si];
            if (!dOutBuf || !dDrawArgsBuf) continue;
            renderPass.setVertexBuffer(0, dOutBuf);
            renderPass.drawIndirect(dDrawArgsBuf, 0);
        }

        // Markers — draw SDF quads from GPU compute output buffers
        renderPass.setPipeline(this.markerRenderPipeline);
        for (let si = 0; si < this.internalSeries.length; si++) {
            const vertCount = this.markerOutCounts[si] ?? 0;
            if (vertCount <= 0 || !this.markerOutBufs[si]) continue;
            renderPass.setVertexBuffer(0, this.markerOutBufs[si]!);
            renderPass.draw(vertCount);
        }

        renderPass.setScissorRect(0, 0, W, H);

        if (textVerts.length > 0) {
            renderPass.setPipeline(this.textPipeline);
            renderPass.setVertexBuffer(0, textBuf);
            renderPass.draw(textVerts.length / 5);
        }

        if (titleVerts.length > 0) {
            renderPass.setPipeline(this.titlePipeline);
            renderPass.setVertexBuffer(0, titleBuf);
            renderPass.draw(titleVerts.length / 5);
        }

        renderPass.end();

        // Pass 2: blit SSAA → canvas
        const blitBindGroup = this.device.createBindGroup({
            layout: this.blitPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.blitSampler },
                { binding: 1, resource: ssaaTexture.createView() },
            ]
        });
        const blitPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                loadOp: "clear",
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                storeOp: "store"
            }]
        });
        blitPass.setPipeline(this.blitPipeline);
        blitPass.setBindGroup(0, blitBindGroup);
        blitPass.draw(6);
        blitPass.end();

        this.device.queue.submit([encoder.finish()]);

        ssaaTexture.destroy();
        bgBuf.destroy(); vertexBuf.destroy(); textBuf.destroy(); titleBuf.destroy();
    }
}

// ---------------------------------------------------------------------------
// Plotter — top-level factory for figures
// ---------------------------------------------------------------------------

export class Plotter {
    private readonly opts: Required<PlotterOptions>;
    private font?: opentype.Font;
    private initialized = false;

    /**
     * @param opts  Global styling and layout options.
     *   - fontSize:            Base font size in px (tick labels, axis labels). Default 14.
     *   - titleFontSize:       Title font size in px. Default fontSize * 1.4.
     *   - fontUrl:             URL/path to a TTF/OTF font. Default bundled Roboto.
     *   - grid:                Show grid lines. Default true.
     *   - paddingLeft:         px from left canvas edge to left edge of y-axis label. Default 4.
     *   - paddingYLabelToYTicks: px from right edge of y-axis label to left side of y-tick value text. Default 6.
     *   - paddingTop:          px from top canvas edge to top of title text. Default 8.
     *   - paddingTitleToPlot:  px from bottom of title to top of plot area. Default 8.
     *   - paddingBottom:       px from bottom canvas edge to bottom of x-axis label. Default 4.
     *   - paddingXLabelToPlot: px from top of x-axis label to bottom of plot area. Default 6.
     *   - paddingRight:        px from right edge of plot area to right canvas edge. Default 12.
     */
    constructor(opts: PlotterOptions = {}) {
        const fs = opts.fontSize ?? 16;
        // Resolve style; respect legacy boolean `grid` option when style is not provided
        const style = opts.style ?? matlabStyle();
        // style.aspectRatio = 'equal'
        if (opts.grid !== undefined && opts.style === undefined) {
            style.grid.show = opts.grid;
        }
        this.opts = {
            fontSize:             fs,
            titleFontSize:        opts.titleFontSize        ?? Math.round(fs * 1.4),
            fontUrl:              opts.fontUrl              ?? "fonts/helvetica/roboto-13281/RobotoRegular-3m4L.ttf",
            grid:                 style.grid.show,
            paddingLeft:          opts.paddingLeft          ?? 20,
            paddingYLabelToYTicks:opts.paddingYLabelToYTicks ?? 10,
            paddingTop:           opts.paddingTop           ?? 8,
            paddingTitleToPlot:   opts.paddingTitleToPlot   ?? 8,
            paddingBottom:        opts.paddingBottom        ?? 8,
            paddingXLabelToPlot:  opts.paddingXLabelToPlot  ?? 6,
            paddingRight:         opts.paddingRight         ?? 20,
            style,
        };
    }

    /** Loads the font. Must be called (and awaited) before figure() / plot(). */
    async init(): Promise<void> {
        if (this.initialized) return;
        if (!navigator.gpu) throw new Error("WebGPU not supported");
        this.font = await opentype.load(this.opts.fontUrl);
        this.initialized = true;
    }

    /**
     * Creates a new plot window and appends it to the given container (default: document.body).
     * Returns the Figure instance (call render() on it, or use plot() which does it automatically).
     */
    async figure(figOpts: FigureOptions = {}, container?: HTMLElement): Promise<Figure> {
        if (!this.initialized) await this.init();
        const fullFigOpts: Required<FigureOptions> = {
            title:  figOpts.title  ?? '',
            xlabel: figOpts.xlabel ?? '',
            ylabel: figOpts.ylabel ?? '',
        };
        const fig = new Figure(this.opts, fullFigOpts);
        await fig.init(this.font!);
        (container ?? document.body).appendChild(fig.windowEl);
        return fig;
    }

    /**
     * Convenience method: creates a figure, sets data, and renders.
     * @param data   Array of { x, y } points (or PlotSeries for multi-series).
     * @param figOpts  Figure options (title, xlabel, ylabel).
     * @param container  DOM element to append the window to. Default: document.body.
     */
    async plot(
        data: { x: number | string | Date; y: number | string | Date }[] | PlotSeries[],
        figOpts: FigureOptions = {},
        container?: HTMLElement
    ): Promise<Figure> {
        const fig = await this.figure(figOpts, container);

        // Normalise input to PlotSeries[]
        let series: PlotSeries[];
        if (data.length === 0) {
            series = [];
        } else if ('color' in data[0]! || Array.isArray((data[0] as PlotSeries).x)) {
            series = data as PlotSeries[];
        } else {
            const pts = data as { x: number | string | Date; y: number | string | Date }[];
            series = [{ x: pts.map(p => p.x) as PlotSeries['x'], y: pts.map(p => p.y) as PlotSeries['y'] }];
        }

        fig.setData(series);
        fig.render();
        return fig;
    }
}
