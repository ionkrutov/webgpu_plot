// Shaders of the 3-D pipelines: lit triangles, screen-space thick lines and billboard markers.
// Orthographic projection; every pipeline shares one uniform block per Axes3D.

const COMMON = `
struct U {
    mvp:  mat4x4f,
    rotR: vec4f,   // view-space right / up / toward-camera axes in box coordinates
    rotU: vec4f,
    rotC: vec4f,
    misc: vec4f,   // x: depth bias, y: pixels per box unit, z: clip half-extent
    scr:  vec4f,   // x, y: viewport size in px
}
@group(0) @binding(0) var<uniform> u: U;

fn outside(p: vec3f) -> bool { return any(abs(p) > vec3f(u.misc.z)); }
`;

export const shader3dCode = COMMON + `
struct TOut {
    @builtin(position) pos: vec4f,
    @location(0) color: vec4f,
    @location(1) wpos: vec3f,
}
@vertex
fn vsTri(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) c: vec4f) -> TOut {
    var o: TOut;
    o.pos = u.mvp * vec4f(p, 1.0);
    o.wpos = p;
    var shade = 1.0;
    let nl = length(n);
    if (nl > 0.5) {
        let nv = vec3f(dot(n, u.rotR.xyz), dot(n, u.rotU.xyz), dot(n, u.rotC.xyz)) / nl;
        let l = normalize(vec3f(-0.35, 0.45, 0.82));
        shade = 0.45 + 0.55 * abs(dot(nv, l));
    }
    o.color = vec4f(c.rgb * shade, c.a);
    return o;
}
@fragment
fn fsTri(i: TOut) -> @location(0) vec4f {
    if (outside(i.wpos)) { discard; }
    return i.color;
}

struct LOut {
    @builtin(position) pos: vec4f,
    @location(0) color: vec4f,
    @location(1) wpos: vec3f,
    @location(2) s: f32,
    @location(3) dash: vec2f,
}
// Instance: p0, p1, color, prm = (arc length at p0, half width px, dash px, gap px)
@vertex
fn vsLine(@builtin(vertex_index) vi: u32,
          @location(0) p0: vec3f, @location(1) p1: vec3f,
          @location(2) color: vec4f, @location(3) prm: vec4f) -> LOut {
    var ts = array<f32, 6>(0.0, 1.0, 0.0, 0.0, 1.0, 1.0);
    var ss = array<f32, 6>(-1.0, -1.0, 1.0, 1.0, -1.0, 1.0);
    let t = ts[vi];
    let side = ss[vi];
    let c0 = u.mvp * vec4f(p0, 1.0);
    let c1 = u.mvp * vec4f(p1, 1.0);
    let half = u.scr.xy * 0.5;
    let dpx = (c1.xy - c0.xy) * half;
    let len = length(dpx);
    var dir = vec2f(1.0, 0.0);
    if (len > 1e-4) { dir = dpx / len; }
    let nrm = vec2f(-dir.y, dir.x);
    let hw = prm.y;
    let along = select(-hw, hw, t > 0.5);
    let off = nrm * side * hw + dir * along;
    let base = mix(c0, c1, t);
    var o: LOut;
    o.pos = vec4f(base.xy + off / half, base.z - u.misc.x, 1.0);
    o.color = color;
    o.wpos = mix(p0, p1, t);
    o.s = prm.x + t * distance(p0, p1) + along / u.misc.y;
    o.dash = vec2f(prm.z, prm.w);
    return o;
}
@fragment
fn fsLine(i: LOut) -> @location(0) vec4f {
    if (outside(i.wpos)) { discard; }
    if (i.dash.x > 0.0) {
        let on = i.dash.x / u.misc.y;
        let per = on + i.dash.y / u.misc.y;
        if (i.s - per * floor(i.s / per) > on) { discard; }
    }
    return i.color;
}

struct MOut {
    @builtin(position) pos: vec4f,
    @location(0) local: vec2f,
    @location(1) face: vec4f,
    @location(2) edge: vec4f,
    @location(3) prm: vec4f,
    @location(4) wpos: vec3f,
}
// Instance: position, face rgba, edge rgba, prm = (diameter px, shape, edge width px, 0)
@vertex
fn vsMarker(@builtin(vertex_index) vi: u32,
            @location(0) p: vec3f, @location(1) face: vec4f,
            @location(2) edge: vec4f, @location(3) prm: vec4f) -> MOut {
    var cs = array<vec2f, 6>(
        vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
        vec2f(-1.0, 1.0),  vec2f(1.0, -1.0), vec2f(1.0, 1.0));
    let corner = cs[vi];
    let c = u.mvp * vec4f(p, 1.0);
    let ext = prm.x * 0.5 + 1.5;
    var o: MOut;
    o.pos = vec4f(c.xy + corner * ext * 2.0 / u.scr.xy, c.z - u.misc.x, 1.0);
    o.local = corner * ext;
    o.face = face; o.edge = edge; o.prm = prm; o.wpos = p;
    return o;
}
@fragment
fn fsMarker(i: MOut) -> @location(0) vec4f {
    if (outside(i.wpos)) { discard; }
    let r = i.prm.x * 0.5;
    let q = abs(i.local);
    var d: f32;
    if (i.prm.y < 0.5) { d = length(i.local) - r; }
    else if (i.prm.y < 1.5) { d = max(q.x, q.y) - r; }
    else { d = (q.x + q.y) * 0.70710678 - r; }
    let outer = clamp(0.5 - d, 0.0, 1.0);
    let inner = clamp(0.5 - (d + i.prm.z), 0.0, 1.0);
    let ring = max(outer - inner, 0.0);
    let a = i.edge.a * ring + i.face.a * inner;
    if (a < 0.004) { discard; }
    let rgb = (i.edge.rgb * i.edge.a * ring + i.face.rgb * i.face.a * inner) / a;
    return vec4f(rgb, a);
}
`;
