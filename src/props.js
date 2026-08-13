import * as THREE from 'three';
import { MeshBuilder } from './geo.js';
import { assets, neon, NEON_PALETTE } from './assets.js';
import { BIOME, ROAD_HALF, SHOULDER, DS, N, CHUNK_LEN, coastSide } from './constants.js';

/* An object yawed to follow the road at heading h uses rotation.y = -h:
   its local +X is then the road's right vector and -Z is forward. */

/**
 * Light lying on the road, with one extra rule: it fades as the view flattens
 * out. A flat additive quad seen almost edge-on compresses its whole falloff
 * into a couple of pixels, so every pool near the horizon turns into a hard
 * bright bar across the picture. Fading by the angle between the eye and the
 * surface removes the bar and leaves the pool looking the same from above.
 */
const DECAL_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vEye;
  varying vec3 vUp;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vEye = -mv.xyz;
    vUp = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
    gl_Position = projectionMatrix * mv;
  }
`;
const DECAL_FRAG = /* glsl */ `
  uniform vec3 color;
  uniform float radial;        // 1 for a pool, 0 for a band down the road
  varying vec2 vUv;
  varying vec3 vEye;
  varying vec3 vUp;
  void main() {
    /* Not a full fade to nothing: that kills the wet sheen everywhere, since
       a chase camera sees almost the whole road at a shallow angle. Keep a
       floor so the reflection survives, and take enough off the flattest
       fragments that they stop stacking into a bar. */
    float graze = abs(dot(normalize(vEye), vUp));
    float fade = 0.15 + 0.85 * pow(graze, 0.4);

    /* The falloff is computed, not sampled.
       It used to come from a texture, and a flat quad seen at a grazing angle
       has such a lopsided UV derivative that the GPU drops to a coarse mip —
       where a radial gradient has averaged out to a flat grey. The quad then
       stopped fading at its own border and drew its outline: a soft grey
       square sitting on the verge next to a lamp. Arithmetic has no mips. */
    vec2 e = (vUv - 0.5) * 2.0;
    float d = mix(abs(e.x), length(e), radial);
    float shape = pow(max(0.0, 1.0 - d), mix(2.2, 2.6, radial));

    gl_FragColor = vec4(color * shape * fade, 1.0);
  }
`;

function decalMat(hex, intensity, radial) {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: neon(hex, intensity) }, radial: { value: radial } },
    vertexShader: DECAL_VERT,
    fragmentShader: DECAL_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
}

const emissiveCache = new Map();
/* The map has to be part of the key. Keying on "has a map" alone means a pool
   and a smear of the same colour and strength silently share one material, and
   whichever was built first decides how both of them fade. */
function emissiveMat(hex, intensity, map = null, mapKey = '') {
  const key = `${hex}|${intensity}|${mapKey}`;
  let m = emissiveCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color: neon(hex, intensity),
      map,
      transparent: !!map,
      blending: map ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: !map,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    emissiveCache.set(key, m);
  }
  return m;
}

const decalCache = new Map();
/* The shape has to be part of the key, or a pool and a band of the same colour
   and strength silently share one material and whichever was built first
   decides the shape of both. */
function decalCached(hex, intensity, radial, mapKey) {
  const key = `${hex}|${intensity}|${mapKey}`;
  let m = decalCache.get(key);
  if (!m) {
    m = decalMat(hex, intensity, radial);
    decalCache.set(key, m);
  }
  return m;
}

const lineMat = new THREE.LineBasicMaterial({
  color: neon(0x88aacc, 0.7),
  transparent: true,
  opacity: 0.5,
  fog: false,
  toneMapped: false,
});

export class ChunkCtx {
  constructor(origin, road, rnd, biome, prev, next, sStart) {
    this.origin = origin;
    this.road = road;
    this.rnd = rnd;
    this.biome = biome;
    this.prev = prev;
    this.next = next;
    this.s0 = sStart;
    this.s1 = sStart + CHUNK_LEN;
    this.remote = 0;          // set by the road: 0 near town, 1 out in the dark
    this.a = assets();
    this.builders = new Map();
    this.loose = [];
    this.ownMaterials = [];
  }

  get(key, material) {
    let e = this.builders.get(key);
    if (!e) {
      e = { mb: new MeshBuilder(), material };
      this.builders.set(key, e);
    }
    return e.mb;
  }

  /** Unlit, bloom-feeding surface in a given colour. */
  emit(hex, intensity = 1.6) {
    return this.get(`e${hex}_${intensity}`, emissiveMat(hex, intensity));
  }

  /** A light band smeared down the wet road — fades away from its centreline. */
  smear(hex, intensity = 1) {
    return this.get(`s${hex}_${intensity}`, decalCached(hex, intensity, 0, 'band'));
  }

  /** Sign characters, additive, in a given colour. */
  glyph(hex, intensity = 3.2) {
    return this.get(`g${hex}_${intensity}`,
      emissiveMat(hex, intensity, this.a.tex.glyphs, 'glyphs'));
  }

  /** A soft pool of reflected light — fades in every direction. */
  pool(hex, intensity = 1) {
    return this.get(`p${hex}_${intensity}`, decalCached(hex, intensity, 1, 'glow'));
  }

  pose(s) {
    return this.road.poseAt(s);
  }

  /** Local-space point at distance `s`, lateral offset and height. */
  at(s, lat = 0, y = 0) {
    const p = this.road.poseAt(s);
    return new THREE.Vector3(
      p.x + Math.cos(p.h) * lat - this.origin.x,
      p.y + y - this.origin.y,
      p.z + Math.sin(p.h) * lat - this.origin.z
    );
  }

  right(s) {
    const p = this.road.poseAt(s);
    return new THREE.Vector3(Math.cos(p.h), 0, Math.sin(p.h));
  }

  forward(s) {
    const p = this.road.poseAt(s);
    return new THREE.Vector3(Math.sin(p.h), 0, -Math.cos(p.h));
  }

  yaw(s) {
    return -this.road.poseAt(s).h;
  }

  add(obj) {
    this.loose.push(obj);
    return obj;
  }

  /** A halo sprite at a local position. */
  halo(p, hex, scale, opacity = 0.55) {
    const s = this.a.glowSprite(neon(hex, 1), scale, opacity);
    s.position.copy(p);
    return this.add(s);
  }

  finish() {
    const g = new THREE.Group();
    for (const { mb, material } of this.builders.values()) {
      if (mb.empty) continue;
      const mesh = new THREE.Mesh(mb.build(), material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = true;
      g.add(mesh);
    }
    for (const o of this.loose) {
      // chunk props never move relative to their chunk: bake the matrix once
      o.updateMatrix();
      o.matrixAutoUpdate = false;
      g.add(o);
    }
    return g;
  }
}

/* ────────────────────────────────────────────────────────────
   Shared pieces
   ──────────────────────────────────────────────────────────── */

const LAMP_WARM = 0xffb257;

function streetLamp(ctx, s, side) {
  const a = ctx.a;
  const lat = side * (ROAD_HALF + SHOULDER + 0.5);
  const yaw = ctx.yaw(s);
  const base = ctx.at(s, lat, 0);
  const metal = ctx.get('metal', a.metal);

  metal.cylinder(base.x, base.y, base.z, 0.13, 8.4, 6);
  const armY = base.y + 8.2;
  const armC = ctx.at(s, lat - side * 1.3, 0);
  metal.box(armC.x, armY, armC.z, 2.8, 0.16, 0.16, yaw);

  const headP = ctx.at(s, lat - side * 2.5, 0);
  ctx.emit(LAMP_WARM, 2.4).box(headP.x, armY - 0.16, headP.z, 1.5, 0.16, 0.55, yaw);

  ctx.halo(new THREE.Vector3(headP.x, armY - 0.2, headP.z), LAMP_WARM, 7.5, 0.42);

  // pool of light on the wet tarmac, stretched down the road
  const p = ctx.at(s, lat - side * 3.0, 0.02);
  ctx.pool(LAMP_WARM, 0.62).decal(p, ctx.right(s), ctx.forward(s), 14, 24, 0.02);
}

function guardrail(ctx, side) {
  const a = ctx.a;
  const metal = ctx.get('metal', a.metal);
  const lat = side * (ROAD_HALF + SHOULDER + 0.25);
  const sections = [];
  for (let i = 0; i <= N; i++) {
    const s = ctx.s0 + i * DS;
    sections.push({ l: ctx.at(s, lat, 0.95), r: ctx.at(s, lat, 0.45) });
    if (i % 2 === 0) {
      const p = ctx.at(s, lat, 0);
      metal.box(p.x, p.y + 0.25, p.z, 0.1, 0.5, 0.1, 0);
    }
  }
  metal.ribbon(sections, 0.08);

  // retroreflectors: the thing that actually sells speed at night
  for (let i = 0; i <= N; i += 2) {
    const s = ctx.s0 + i * DS;
    const p = ctx.at(s, lat - side * 0.06, 0.78);
    const hex = side > 0 ? 0xff9a2e : 0xdfe8ff;
    ctx.emit(hex, 1.7).box(p.x, p.y, p.z, 0.06, 0.16, 0.16, ctx.yaw(s));
  }
}

function curb(ctx, side) {
  const a = ctx.a;
  const lat = side * (ROAD_HALF + SHOULDER);
  const sections = [];
  const top = [];
  for (let i = 0; i <= N; i++) {
    const s = ctx.s0 + i * DS;
    sections.push({ l: ctx.at(s, lat, 0.22), r: ctx.at(s, lat, -0.1) });
    top.push({ l: ctx.at(s, lat, 0.22), r: ctx.at(s, lat + side * 3.6, 0.22) });
  }
  const c = ctx.get('concrete', a.concrete);
  c.ribbon(sections, 0.1);
  c.ribbon(top, 0.1);
}

/* ────────────────────────────────────────────────────────────
   Biomes
   ──────────────────────────────────────────────────────────── */

function city(ctx) {
  const a = ctx.a;
  const rnd = ctx.rnd;

  for (let i = 0; i < N; i += 8) {
    const s = ctx.s0 + i * DS;
    streetLamp(ctx, s, ((ctx.s0 / CHUNK_LEN + i) | 0) % 2 === 0 ? 1 : -1);
  }
  curb(ctx, 1);
  curb(ctx, -1);

  const dark = ctx.get('dark', a.dark);
  const win = ctx.get('windows', a.windows);

  for (let side of [-1, 1]) {
    let d = rnd() * 14;
    while (d < CHUNK_LEN) {
      const w = 9 + rnd() * 15;
      const depth = 10 + rnd() * 18;
      const h = 9 + Math.pow(rnd(), 1.7) * 62;
      const s = ctx.s0 + d + w / 2;
      const lat = side * (ROAD_HALF + SHOULDER + 5 + rnd() * 16 + depth / 2);
      const yaw = ctx.yaw(s) + (rnd() - 0.5) * 0.12;
      const c = ctx.at(s, lat, 0);

      /* box() takes sizes in the yawed frame: X runs across the road, Z along
         it. `w` is the frontage and `depth` is how far back the building goes,
         so they go in as (depth, height, w) — passing them the other way round
         gave buildings a lateral half-extent of up to 12 m while the placement
         had only reserved 5, which put them out in the carriageway. */
      dark.box(c.x, c.y + h / 2 - 1, c.z, depth, h, w, yaw);

      // lit window field on the road-facing wall, spanning the frontage
      const face = ctx.at(s, lat - side * (depth / 2 + 0.06), 0);
      const along = ctx.forward(s).multiplyScalar(w / 2 - 0.4);
      const y0 = face.y + 0.6, y1 = face.y + h - 1.6;
      win.quad(
        new THREE.Vector3(face.x - along.x, y0, face.z - along.z),
        new THREE.Vector3(face.x + along.x, y0, face.z + along.z),
        new THREE.Vector3(face.x + along.x, y1, face.z + along.z),
        new THREE.Vector3(face.x - along.x, y1, face.z - along.z),
        0, 0, Math.max(1, w / 5) | 0, Math.max(1, h / 3.2) | 0
      );

      // aircraft warning beacon on the tall ones
      if (h > 48) {
        ctx.halo(new THREE.Vector3(c.x, c.y + h - 0.6, c.z), 0xff2a2a, 3.2, 0.5);
      }

      // street-level neon, and its reflection on the wet road below
      if (rnd() < 0.5) {
        const hex = NEON_PALETTE[(rnd() * NEON_PALETTE.length) | 0];
        const ny = 3 + rnd() * (Math.min(h, 26) - 3);
        const np = ctx.at(s + (rnd() - 0.5) * 6, lat - side * (depth / 2 + 0.35), 0);
        const vertical = rnd() < 0.55;
        /* A row or column of characters rather than a blank glowing bar. The
           bar read as exactly what it was — an untextured rectangle — and a
           wall carrying nothing but blank rectangles is the same reason the
           buildings themselves read as flat panels. */
        const n = 2 + ((rnd() * 3) | 0);
        const cell = vertical ? 1.05 + rnd() * 0.6 : 0.95 + rnd() * 0.5;
        const gap = cell * 0.12;
        const span = n * cell + (n - 1) * gap;
        const along = ctx.forward(s);
        const glyph = ctx.glyph(hex);
        for (let k = 0; k < n; k++) {
          // pick a character from the atlas — 4 x 4 cells
          const gi = (rnd() * 16) | 0;
          const u0 = (gi % 4) / 4, v0 = 1 - ((gi / 4 | 0) + 1) / 4;
          const off = -span / 2 + cell / 2 + k * (cell + gap);
          const cx = np.x + (vertical ? 0 : along.x * off);
          const cz = np.z + (vertical ? 0 : along.z * off);
          const cy = np.y + ny + (vertical ? -off : 0);
          const ax = along.x * (cell / 2), az = along.z * (cell / 2);
          const hy = cell / 2;
          glyph.quad(
            new THREE.Vector3(cx - ax, cy - hy, cz - az),
            new THREE.Vector3(cx + ax, cy - hy, cz + az),
            new THREE.Vector3(cx + ax, cy + hy, cz + az),
            new THREE.Vector3(cx - ax, cy + hy, cz - az),
            u0, v0, u0 + 0.25, v0 + 0.25
          );
        }
        const sw = vertical ? cell : span;
        const sh = vertical ? span : cell;
        ctx.halo(new THREE.Vector3(np.x, np.y + ny, np.z), hex, Math.max(sw, sh) * 2.0, 0.36);
        /* Only some of them reach the road. Every sign casting a pool meant
           half a dozen overlapping on the same stretch, and additive blending
           piled them into a saturated slab with a hard rim — which reads as a
           painted rectangle, not as a reflection. */
        if (rnd() < 0.45) {
          const rp = ctx.at(s, side * (ROAD_HALF - 1.5 - rnd() * 3), 0.02);
          ctx.pool(hex, 0.4).decal(rp, ctx.right(s), ctx.forward(s), 8, 22, 0.02);
        }
      }
      d += w + 2 + rnd() * 10;
    }
  }
}

function highway(ctx) {
  const rnd = ctx.rnd;
  const remote = ctx.remote;
  guardrail(ctx, 1);
  guardrail(ctx, -1);

  /* out in the middle of a long haul the lighting all but stops, and the
     reflector posts become the only thing showing you where the road goes */
  const ci = (ctx.s0 / CHUNK_LEN) | 0;
  if (remote < 0.55) {
    if (ci % 2 === 0) streetLamp(ctx, ctx.s0 + 4 * DS, 1);
    if (ci % 3 === 0) streetLamp(ctx, ctx.s0 + 14 * DS, -1);
  } else if (ci % 9 === 0) {
    streetLamp(ctx, ctx.s0 + 9 * DS, rnd() < 0.5 ? 1 : -1);
  }

  /* someone's light, a very long way off the road */
  if (remote > 0.4 && rnd() < 0.3) {
    const s = ctx.s0 + rnd() * CHUNK_LEN;
    const side = rnd() < 0.5 ? -1 : 1;
    const far = ctx.at(s, side * (130 + rnd() * 280), 4 + rnd() * 34);
    const warm = rnd() < 0.28;
    ctx.halo(far, warm ? 0xff3a2a : 0xffb060, 3 + rnd() * 3.5, 0.5);
  }

  // overhead gantry with a lit sign
  if (rnd() < 0.22 * (1 - remote)) {
    const s = ctx.s0 + (6 + rnd() * 12) * DS;
    const yaw = ctx.yaw(s);
    const metal = ctx.get('metal', ctx.a.metal);
    for (const side of [-1, 1]) {
      const p = ctx.at(s, side * (ROAD_HALF + SHOULDER + 0.4), 0);
      metal.cylinder(p.x, p.y, p.z, 0.18, 7.4, 6);
    }
    const c = ctx.at(s, 0, 7.2);
    metal.box(c.x, c.y, c.z, (ROAD_HALF + SHOULDER) * 2 + 1, 0.4, 0.4, yaw);
    const sign = ctx.at(s, -2.6, 5.6);
    ctx.emit(0x1e7a3a, 1.5).box(sign.x, sign.y, sign.z, 5.2, 1.9, 0.16, yaw);
    ctx.halo(new THREE.Vector3(sign.x, sign.y, sign.z), 0x2fe07a, 5, 0.22);
  }

  // roadside distance markers
  for (let i = 4; i < N; i += 10) {
    const s = ctx.s0 + i * DS;
    const p = ctx.at(s, ROAD_HALF + SHOULDER + 1.2, 0);
    ctx.get('metal', ctx.a.metal).box(p.x, p.y + 0.5, p.z, 0.12, 1.0, 0.12, ctx.yaw(s));
    ctx.emit(0xdfe8ff, 2.4).box(p.x, p.y + 1.0, p.z, 0.16, 0.16, 0.14, ctx.yaw(s));
  }
}

function forest(ctx) {
  const rnd = ctx.rnd;
  guardrail(ctx, 1);
  guardrail(ctx, -1);

  const fol = ctx.get('foliage', ctx.a.foliage);
  const dark = ctx.get('dark', ctx.a.dark);
  for (let i = 0; i < 54; i++) {
    const s = ctx.s0 + rnd() * CHUNK_LEN;
    const side = rnd() < 0.5 ? -1 : 1;
    const lat = side * (ROAD_HALF + SHOULDER + 3 + Math.pow(rnd(), 0.6) * 62);
    const p = ctx.at(s, lat, -0.3);
    const h = 6 + rnd() * 13;
    const r = 1.1 + rnd() * 1.9;
    dark.cylinder(p.x, p.y, p.z, 0.22, h * 0.35, 4);
    fol.cone(p.x, p.y + h * 0.28, p.z, r, h * 0.5, 5);
    fol.cone(p.x, p.y + h * 0.55, p.z, r * 0.72, h * 0.45, 5);
  }
  if (rnd() < 0.3 * (1 - ctx.remote)) streetLamp(ctx, ctx.s0 + 10 * DS, rnd() < 0.5 ? 1 : -1);
}

function tunnel(ctx) {
  const a = ctx.a;
  const c = ctx.get('concrete', a.concrete);
  const wallLat = ROAD_HALF + SHOULDER + 0.2;
  const H = 6.4;

  const wallL = [], wallR = [], ceilA = [], ceilB = [];
  for (let i = 0; i <= N; i++) {
    const s = ctx.s0 + i * DS;
    wallL.push({ l: ctx.at(s, -wallLat, H - 1.1), r: ctx.at(s, -wallLat, -0.2) });
    wallR.push({ l: ctx.at(s, wallLat, -0.2), r: ctx.at(s, wallLat, H - 1.1) });
    ceilA.push({ l: ctx.at(s, -wallLat, H - 1.1), r: ctx.at(s, -wallLat * 0.45, H) });
    ceilB.push({ l: ctx.at(s, -wallLat * 0.45, H), r: ctx.at(s, wallLat, H - 1.1) });
  }
  c.ribbon(wallL, 0.08).ribbon(wallR, 0.08).ribbon(ceilA, 0.08).ribbon(ceilB, 0.08);

  // ceiling strip lights + their reflections directly below
  for (let d = 0; d < CHUNK_LEN; d += 12) {
    const s = ctx.s0 + d;
    const p = ctx.at(s, 0, H - 0.55);
    ctx.emit(0xdff0ff, 2.2).box(p.x, p.y, p.z, 0.6, 0.14, 3.0, ctx.yaw(s));
    ctx.halo(p.clone(), 0xcfe6ff, 3.6, 0.2);
    const road = ctx.at(s, 0, 0.02);
    ctx.pool(0xbfe0ff, 0.4).decal(road, ctx.right(s), ctx.forward(s), 10, 20, 0.02);
  }

  // sodium bands running along both walls — the classic tunnel smear
  for (const side of [-1, 1]) {
    const band = [];
    for (let i = 0; i <= N; i++) {
      const s = ctx.s0 + i * DS;
      /* Well above eye level. At camera height a thin horizontal strip
         projects to a dead-flat line straight across the picture, which reads
         as a rendering fault rather than as a light on a wall. */
      band.push({ l: ctx.at(s, side * (wallLat - 0.05), 3.9), r: ctx.at(s, side * (wallLat - 0.05), 3.62) });
    }
    ctx.emit(0xff7a2a, 0.8).ribbon(band, 0.1);
    const smear = [];
    for (let i = 0; i <= N; i++) {
      const s = ctx.s0 + i * DS;
      smear.push({ l: ctx.at(s, side * (ROAD_HALF - 0.2), 0.02), r: ctx.at(s, side * (ROAD_HALF - 3.2), 0.02) });
    }
    ctx.smear(0xff7a2a, 0.42).ribbon(smear, 0.1);
  }

  // portals
  for (const [other, s] of [[ctx.prev, ctx.s0], [ctx.next, ctx.s1]]) {
    if (other === BIOME.TUNNEL) continue;
    const yaw = ctx.yaw(s);
    const p = ctx.at(s, 0, 0);
    c.box(p.x, p.y + H + 1.4, p.z, wallLat * 2 + 4, 3.4, 1.6, yaw);
    for (const side of [-1, 1]) {
      const q = ctx.at(s, side * (wallLat + 1.4), 0);
      c.box(q.x, q.y + H / 2, q.z, 2.8, H + 3, 1.6, yaw);
    }
  }
}

function gasStation(ctx) {
  const a = ctx.a;
  const yaw = ctx.yaw(ctx.s0 + 12 * DS);
  const sMid = ctx.s0 + 12 * DS;
  const c = ctx.get('concrete', a.concrete);
  const metal = ctx.get('metal', a.metal);
  const dark = ctx.get('dark', a.dark);

  guardrail(ctx, -1);

  // apron
  const apron = [];
  for (let i = 0; i <= N; i++) {
    const s = ctx.s0 + i * DS;
    const t = Math.min(1, Math.min(i, N - i) / 5);
    apron.push({ l: ctx.at(s, ROAD_HALF + SHOULDER - 0.1, 0.0), r: ctx.at(s, ROAD_HALF + SHOULDER + t * 22, -0.04) });
  }
  ctx.get('shoulder', a.shoulder).ribbon(apron, 0.06);

  // canopy
  const cp = ctx.at(sMid, ROAD_HALF + 16, 0);
  c.box(cp.x, cp.y + 6.0, cp.z, 20, 0.9, 15, yaw);
  ctx.emit(0xdfeaff, 0.7).box(cp.x, cp.y + 5.52, cp.z, 18.4, 0.08, 13.4, yaw);
  for (const dx of [-7.5, 7.5]) {
    for (const dz of [-5, 5]) {
      const q = ctx.at(sMid + dz, ROAD_HALF + 16 + dx, 0);
      metal.cylinder(q.x, q.y, q.z, 0.24, 5.6, 6);
    }
  }
  ctx.halo(new THREE.Vector3(cp.x, cp.y + 4.4, cp.z), 0xdff0ff, 24, 0.07);
  ctx.pool(0xdff0ff, 0.34).decal(ctx.at(sMid, ROAD_HALF + 10, 0.03), ctx.right(sMid), ctx.forward(sMid), 30, 40, 0.03);

  // pumps
  for (const dz of [-3.4, 3.4]) {
    const q = ctx.at(sMid + dz, ROAD_HALF + 16, 0);
    dark.box(q.x, q.y + 0.9, q.z, 1.1, 1.8, 2.6, yaw);
    ctx.emit(0x2bffb0, 2.0).box(q.x, q.y + 1.5, q.z, 0.62, 0.4, 0.06, yaw + Math.PI / 2);
  }

  // shop
  const sp = ctx.at(sMid - 16, ROAD_HALF + 26, 0);
  c.box(sp.x, sp.y + 2.1, sp.z, 14, 4.2, 9, yaw);
  const face = ctx.at(sMid - 16, ROAD_HALF + 21.4, 0);
  ctx.emit(0xfff2d0, 0.55).box(face.x, face.y + 2.0, face.z, 12, 2.6, 0.1, yaw);
  ctx.halo(new THREE.Vector3(face.x, face.y + 2.0, face.z), 0xffe6b0, 10, 0.12);

  // roadside price totem
  const tp = ctx.at(sMid + 20, ROAD_HALF + 5.5, 0);
  metal.cylinder(tp.x, tp.y, tp.z, 0.2, 7, 6);
  ctx.emit(0xff2f6d, 1.9).box(tp.x, tp.y + 7.4, tp.z, 0.3, 2.6, 3.4, yaw);
  ctx.halo(new THREE.Vector3(tp.x, tp.y + 7.4, tp.z), 0xff2f6d, 7, 0.3);
  ctx.pool(0xff2f6d, 0.62).decal(ctx.at(sMid + 20, ROAD_HALF - 2, 0.02), ctx.right(sMid), ctx.forward(sMid), 10, 32, 0.02);
}

function bridge(ctx) {
  const a = ctx.a;
  const c = ctx.get('concrete', a.concrete);

  // water, far below
  const w = ctx.at(ctx.s0 + CHUNK_LEN / 2, 0, -19);
  const yaw = ctx.yaw(ctx.s0 + CHUNK_LEN / 2);
  ctx.get('water', a.water).box(w.x, w.y, w.z, 700, 0.5, CHUNK_LEN + 40, yaw);

  // deck underside + parapets
  const deck = [], parL = [], parR = [];
  for (let i = 0; i <= N; i++) {
    const s = ctx.s0 + i * DS;
    deck.push({ l: ctx.at(s, ROAD_HALF + SHOULDER + 0.6, -1.2), r: ctx.at(s, -ROAD_HALF - SHOULDER - 0.6, -1.2) });
    parL.push({ l: ctx.at(s, -ROAD_HALF - SHOULDER - 0.3, 1.15), r: ctx.at(s, -ROAD_HALF - SHOULDER - 0.3, -1.2) });
    parR.push({ l: ctx.at(s, ROAD_HALF + SHOULDER + 0.3, -1.2), r: ctx.at(s, ROAD_HALF + SHOULDER + 0.3, 1.15) });
  }
  c.ribbon(deck, 0.05).ribbon(parL, 0.08).ribbon(parR, 0.08);

  // rail lighting
  for (const side of [-1, 1]) {
    const band = [];
    for (let i = 0; i <= N; i++) {
      const s = ctx.s0 + i * DS;
      const lat = side * (ROAD_HALF + SHOULDER + 0.25);
      band.push({ l: ctx.at(s, lat, 1.2), r: ctx.at(s, lat, 1.05) });
    }
    ctx.emit(0x24d6ff, 1.4).ribbon(band, 0.1);
    const smear = [];
    for (let i = 0; i <= N; i++) {
      const s = ctx.s0 + i * DS;
      smear.push({ l: ctx.at(s, side * (ROAD_HALF - 0.4), 0.02), r: ctx.at(s, side * (ROAD_HALF - 3.6), 0.02) });
    }
    ctx.smear(0x24d6ff, 0.4).ribbon(smear, 0.1);
  }

  // pylon + cables, once per bridge run
  if (ctx.prev !== BIOME.BRIDGE) {
    const s = ctx.s0 + 6 * DS;
    const py = ctx.yaw(s);
    const H = 46;
    const tops = [];
    for (const side of [-1, 1]) {
      const p = ctx.at(s, side * (ROAD_HALF + SHOULDER + 2.4), -2);
      c.box(p.x, p.y + H / 2, p.z, 2.6, H, 3.2, py);
      ctx.halo(new THREE.Vector3(p.x, p.y + H, p.z), 0xff2a2a, 4, 0.6);
      tops.push(new THREE.Vector3(p.x, p.y + H - 2, p.z));
    }
    const pts = [];
    for (let i = 0; i < 14; i++) {
      const t = (i / 13 - 0.5) * 2;
      const ds = t * 70;
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -1 : 1;
        pts.push(tops[k]);
        pts.push(ctx.at(s + ds, side * (ROAD_HALF + SHOULDER + 0.5), 1.2));
      }
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    ctx.add(new THREE.LineSegments(g, lineMat));
  }
}

/**
 * The sea on one side, a metre or two below the road. Water is nearly a mirror
 * and the environment map is the sky, so it picks up the moon and the horizon
 * glow for free; the rest is a parapet, a smeared moon path, and — rarely —
 * a lighthouse a long way out.
 */
function coast(ctx) {
  const a = ctx.a;
  const rnd = ctx.rnd;
  /* The road builder uses the same rule to decide where to stop the ground. */
  const side = coastSide((ctx.s0 / CHUNK_LEN) | 0);
  const drop = -5.5;

  guardrail(ctx, -side);

  /* parapet along the seaward edge */
  const c = ctx.get('concrete', a.concrete);
  const wall = [];
  const verge = [];
  for (let i = 0; i <= N; i++) {
    const s = ctx.s0 + i * DS;
    const lat = side * (ROAD_HALF + SHOULDER + 0.3);
    wall.push({ l: ctx.at(s, lat, 0.95), r: ctx.at(s, lat, -0.3) });
    verge.push({ l: ctx.at(s, lat, 0.95), r: ctx.at(s, lat + side * 0.5, 0.95) });
  }
  c.ribbon(wall, 0.1).ribbon(verge, 0.1);

  /* the sea itself, and the rocks it breaks on */
  const w = ctx.at(ctx.s0 + CHUNK_LEN / 2, side * 210, drop);
  ctx.get('water', a.water).box(w.x, w.y, w.z, 400, 0.4, CHUNK_LEN + 60, ctx.yaw(ctx.s0 + CHUNK_LEN / 2));
  const dark = ctx.get('dark', a.dark);
  for (let i = 0; i < 14; i++) {
    const s = ctx.s0 + rnd() * CHUNK_LEN;
    const p = ctx.at(s, side * (12 + rnd() * 26), drop + rnd() * 1.6);
    dark.box(p.x, p.y, p.z, 2 + rnd() * 5, 1.5 + rnd() * 2.5, 2 + rnd() * 5, rnd() * 3);
  }

  /* moonlight lying on the water */
  const mp = ctx.at(ctx.s0 + CHUNK_LEN / 2, side * 90, drop + 0.25);
  ctx.pool(0x9fb6ff, 0.5).decal(mp, ctx.right(ctx.s0), ctx.forward(ctx.s0), 150, CHUNK_LEN + 40, 0);

  if (rnd() < 0.55) streetLamp(ctx, ctx.s0 + ((rnd() * N) | 0) * DS, -side);

  /* something out at sea, blinking */
  if (rnd() < 0.16) {
    const p = ctx.at(ctx.s0 + rnd() * CHUNK_LEN, side * (260 + rnd() * 320), drop + 14);
    ctx.get('concrete', a.concrete).cylinder(p.x, p.y - 14, p.z, 1.6, 16, 6);
    ctx.halo(p, 0xffd08a, 7, 0.7);
  }
  if (rnd() < 0.3) {
    const p = ctx.at(ctx.s0 + rnd() * CHUNK_LEN, side * (70 + rnd() * 120), drop + 1.2);
    ctx.halo(p, rnd() < 0.5 ? 0x2bff9a : 0xff3a2a, 2.2, 0.6);   // a buoy
  }
}

export function decorateChunk(ctx) {
  switch (ctx.biome) {
    case BIOME.CITY: city(ctx); break;
    case BIOME.TUNNEL: tunnel(ctx); break;
    case BIOME.FOREST: forest(ctx); break;
    case BIOME.GAS: gasStation(ctx); break;
    case BIOME.BRIDGE: bridge(ctx); break;
    case BIOME.COAST: coast(ctx); break;
    default: highway(ctx); break;
  }
}
