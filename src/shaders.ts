// ---------------------------------------------------------------------------
// WebGPU shaders
// ---------------------------------------------------------------------------

export const blitShaderCode = `
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

export const shaderCode = `
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
export const seriesLineShaderCode = `
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
export const computeShaderCode = `
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

    // Cull: both endpoints on same side of view, or either endpoint is a NaN/Inf gap marker (|v| > 1e37)
    let degenerate = (xa < p.xMin && xb < p.xMin) || (xa > p.xMax && xb > p.xMax) ||
                     (ya < p.yMin && yb < p.yMin) || (ya > p.yMax && yb > p.yMax) ||
                     abs(xa) > 1e37 || abs(ya) > 1e37 || abs(xb) > 1e37 || abs(yb) > 1e37;
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
export const markerComputeShaderCode = `
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

    // Bounding quad: extend by edge-band half-width so the full edge ring is rasterised.
    // The edge band spans [outerS-ew, outerS+ew]; without padding the outer half is clipped.
    let ewCss = mp.outerR - abs(mp.innerR);   // edge half-width in CSS pixels
    let qr    = mp.outerR + ewCss;            // bounding-box half-size in CSS pixels
    let qx0 = (cx - qr) / hw - 1.0;
    let qx1 = (cx + qr) / hw - 1.0;
    let qy0 = 1.0 - (cy - qr) / hh;
    let qy1 = 1.0 - (cy + qr) / hh;

    let fr = mp.faceR; let fg = mp.faceG; let fb = mp.faceB; let fa = mp.faceA;
    let er = mp.edgeR; let eg = mp.edgeG; let eb = mp.edgeB;
    let sid = f32(mp.shapeId);

    // Per-vertex offset from marker centre in SSAA pixels (used as SDF input in fragment shader)
    let QR = qr * mp.ssaa;
    var lx = array<f32, 6>(-QR, -QR, QR,  -QR, QR, QR);
    var ly = array<f32, 6>(-QR,  QR, QR,  -QR, QR, -QR);

    // Quad corners: TL, BL, BR,  TL, BR, TR
    var px = array<f32, 6>(qx0, qx0, qx1,  qx0, qx1, qx1);
    var py = array<f32, 6>(qy0, qy1, qy1,  qy0, qy1, qy0);

    for (var v = 0u; v < VERTS; v++) {
        let vb = base + v * FPV;
        out[vb]      = px[v]; out[vb+1u]  = py[v];    // clip pos
        out[vb+2u]   = lx[v]; out[vb+3u]  = ly[v];    // local offset from centre (ssaa px)
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
export const markerShaderCode = `
struct VSIn {
    @location(0) clipPos:  vec2f,
    @location(1) localPos: vec2f,   // offset from marker centre in SSAA pixels
    @location(2) radii:    vec2f,   // (outerR, innerR) SSAA pixels; innerR<0 → hollow
    @location(3) faceCol:  vec4f,   // rgba
    @location(4) edgeCol:  vec4f,   // rgba
    @location(5) shapeId:  f32,     // bitcast from u32
}
struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) localPos:  vec2f,
    @location(1) radii:     vec2f,
    @location(2) faceCol:   vec4f,
    @location(3) edgeCol:   vec4f,
    @location(4) shapeId:   f32,
}
@vertex fn vsMarker(v: VSIn) -> VSOut {
    var o: VSOut;
    o.pos      = vec4f(v.clipPos, 0.0, 1.0);
    o.localPos = v.localPos;
    o.radii    = v.radii;
    o.faceCol  = v.faceCol;
    o.edgeCol  = v.edgeCol;
    o.shapeId  = v.shapeId;
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

// Equilateral triangle, apex at +Y, circumradius = r.
// Centroid is at origin: apex y=+r, base midpoint y=-r/2, centroid=(r-r/2-r/2)/3=0.
fn sdfTriangle(p: vec2f, r: f32) -> f32 {
    let px = abs(p.x);
    return max(px * 0.866025 + p.y * 0.5, -p.y) - r * 0.5;
}

// Oriented isoceles triangle helpers.
// localPos Y is screen-down (CSS pixel space), so we flip Y to match the
// math-coordinate sdfTriangle (apex at +Y).
fn sdfTriangleUp(p: vec2f, r: f32)    -> f32 { return sdfTriangle(vec2f(p.x, -p.y), r); }
fn sdfTriangleDown(p: vec2f, r: f32)  -> f32 { return sdfTriangle(p, r); }
fn sdfTriangleRight(p: vec2f, r: f32) -> f32 { return sdfTriangle(vec2f(-p.y, p.x), r); }
fn sdfTriangleLeft(p: vec2f, r: f32)  -> f32 { return sdfTriangle(vec2f(p.y, -p.x), r); }

// n-pointed star (IQ formula). R = outer circumradius, m = pointiness (2.0 = sharp classic star).
// One tip points screen-up (-Y in localPos space).
fn sdfStar(p: vec2f, n: f32, R: f32, m: f32) -> f32 {
    let an  = 3.14159265 / n;
    let en  = 3.14159265 / m;
    let acs = vec2f(cos(an), sin(an));
    let ecs = vec2f(cos(en), sin(en));
    // atan2(p.x, -p.y): angle from screen-up direction (Y-down space)
    let a2  = 2.0 * an;
    var raw = atan2(p.x, -p.y) % a2;
    if (raw < 0.0) { raw += a2; }   // true modulo (WGSL % can be negative)
    let bn  = raw - an;
    var pp  = length(p) * vec2f(cos(bn), abs(sin(bn)));
    pp      = pp - R * acs;
    pp      = pp + ecs * clamp(-dot(pp, ecs), 0.0, R * acs.y / ecs.y);
    return length(pp) * sign(pp.x);
}

// Stroke helper: given a shape SDF, return edge colour if within edge band,
// face colour if interior, else discard.
// Edge band spans [-ew, 0]: exactly ew pixels inward from the shape boundary,
// so edgeWidth=1 produces a 1px border (matches series lineWidth semantics).
fn resolveStrokedShape(
    d:      f32,
    ew:     f32,    // edge width in pixels (full, not half)
    hollow: bool,
    face:   vec4f,
    edge:   vec4f
) -> vec4f {
    if (d > 0.0) { discard; }     // outside shape boundary
    if (d > -ew) { return edge; } // edge band (inward from boundary)
    if (hollow) { discard; }      // hollow interior
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

// 5-pointed star (IQ). R = outer circumradius, rf = inner/outer radius ratio.
// rf = 0.382 gives the golden-ratio classic star. Tip points screen-up.
fn sdfStar5(p: vec2f, R: f32, rf: f32) -> f32 {
    // Flip y: localPos y is screen-down, formula expects y-up (tip at +y)
    var q = vec2f(p.x, -p.y);
    let k1 = vec2f( 0.809016994375, -0.587785252192);
    let k2 = vec2f(-0.809016994375, -0.587785252192);
    q.x = abs(q.x);
    q -= 2.0 * max(dot(k1, q), 0.0) * k1;
    q -= 2.0 * max(dot(k2, q), 0.0) * k2;
    q.x = abs(q.x);
    q.y -= R;
    let ba = rf * vec2f(-k1.y, k1.x) - vec2f(0.0, 1.0);
    let h  = clamp(dot(q, ba) / dot(ba, ba), 0.0, R);
    return length(q - ba * h) * sign(q.y * ba.x - q.x * ba.y);
}

// 6-pointed star. Tip points screen-up. rf = inner/outer radius ratio (0.5 = classic).
// 6-star is symmetric in both axes → fold to first quadrant with abs(x) AND abs(y),
// then one 60°-sector fold.
fn sdfStar6(p: vec2f, R: f32, rf: f32) -> f32 {
    var q = vec2f(abs(p.x), abs(p.y));   // fold to first quadrant (handles top+bottom tips)
    let k = vec2f(0.866025403784, -0.5); // fold normal for 60° sector
    q -= 2.0 * max(dot(k, q), 0.0) * k;
    q.x = abs(q.x);                      // fold back after reflection can flip x
    q.y -= R;
    let ba = rf * vec2f(-k.y, k.x) - vec2f(0.0, 1.0);
    let h  = clamp(dot(q, ba) / dot(ba, ba), 0.0, R);
    return length(q - ba * h) * sign(q.y * ba.x - q.x * ba.y);
}

@fragment fn fsMarker(in: VSOut) -> @location(0) vec4f {
    let outerR  = in.radii.x;           // SSAA pixels
    let innerR  = in.radii.y;           // negative → hollow
    let hollow  = innerR < 0.0;
    let ew      = outerR - abs(innerR); // edge half-width
    let p       = in.localPos;          // offset from marker centre in SSAA pixels
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
            d = sdfTriangleUp(p, outerR);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 10u: {  // v downward triangle
            d = sdfTriangleDown(p, outerR);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 11u: {  // > right-pointing triangle
            d = sdfTriangleRight(p, outerR);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 12u: {  // < left-pointing triangle
            d = sdfTriangleLeft(p, outerR);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 13u: {  // pentagram (5-pointed star)
            d = sdfStar5(p, outerR, 0.382);
            return resolveStrokedShape(d, ew, hollow, in.faceCol, in.edgeCol);
        }
        case 14u: {  // hexagram (6-pointed star)
            d = sdfStar6(p, outerR, 0.45);
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
export const dashedComputeShaderCode = `
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

        // NaN/Inf gap marker: skip this segment
        if (abs(xa) > 1e37 || abs(ya) > 1e37 || abs(xb) > 1e37 || abs(yb) > 1e37) { continue; }

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

