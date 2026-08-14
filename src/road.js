import * as THREE from 'three';
import { MeshBuilder, mulberry32, smoothstep } from './geo.js';
import { assets } from './assets.js';
import { decorateChunk, ChunkCtx } from './props.js';
import { DS, N, CHUNK_LEN, ROAD_HALF, SHOULDER, AHEAD, BEHIND, BIOME, coastSide } from './constants.js';

export * from './constants.js';

/** Curvature as a pure function of distance — the road is the same every run. */
function curvatureAt(s) {
  return (
    0.00150 * Math.sin(s * 0.00061) +
    0.00085 * Math.sin(s * 0.00243 + 1.7) +
    0.00048 * Math.sin(s * 0.00701 + 4.1) +
    0.00016 * Math.sin(s * 0.01900 + 2.3)
  );
}

function elevationAt(s) {
  return (
    3.4 * Math.sin(s * 0.00110) +
    1.7 * Math.sin(s * 0.00313 + 2.1) +
    0.7 * Math.sin(s * 0.00810 + 0.6)
  );
}

/**
 * Which biome a chunk belongs to, and how far from anywhere it is.
 *
 * Beside the biome each chunk carries a "remoteness" from 0 to 1. Ordinary
 * runs are 0. Every so often the sequencer commits to a *long haul* — ten to
 * twenty kilometres with no city at all — and ramps remoteness up to 1 through
 * the middle of it. Lamps thin out, traffic dries up, the sky goes properly
 * dark, and one lone petrol station sits somewhere near the midpoint. Then it
 * delivers you back into a city, which after all that reads as an event.
 */
class BiomeSequencer {
  constructor(seed = 1337) {
    this.rnd = mulberry32(seed);
    this.seq = [];
    this.remote = [];
    this.sinceHaul = 0;
    this.push(BIOME.CITY, 6);
  }

  push(biome, len, remote = 0) {
    for (let i = 0; i < len; i++) {
      this.seq.push(biome);
      this.remote.push(remote);
    }
    this.sinceHaul += len;
  }

  longHaul() {
    const total = 88 + ((this.rnd() * 72) | 0);      // 10.5 – 19 km of nothing
    const plan = [];
    while (plan.length < total) {
      const r = this.rnd();
      const [biome, len] =
        r < 0.52 ? [BIOME.HIGHWAY, 10 + ((this.rnd() * 16) | 0)]
          : r < 0.72 ? [BIOME.FOREST, 8 + ((this.rnd() * 14) | 0)]
          : r < 0.84 ? [BIOME.COAST, 7 + ((this.rnd() * 9) | 0)]
            : r < 0.93 ? [BIOME.BRIDGE, 2 + ((this.rnd() * 2) | 0)]
              : [BIOME.TUNNEL, 2 + ((this.rnd() * 2) | 0)];
      for (let i = 0; i < len && plan.length < total; i++) plan.push(biome);
    }
    plan[(total * (0.35 + this.rnd() * 0.3)) | 0] = BIOME.GAS;

    const ramp = Math.max(6, Math.min(20, (total * 0.22) | 0));
    for (let i = 0; i < total; i++) {
      this.seq.push(plan[i]);
      this.remote.push(Math.min(smoothstep(0, ramp, i), smoothstep(0, ramp, total - 1 - i)));
    }
    this.sinceHaul = 0;
    this.push(BIOME.CITY, 7 + ((this.rnd() * 7) | 0));   // the payoff
  }

  extend() {
    const last = this.seq[this.seq.length - 1];
    const r = this.rnd();
    if (last === BIOME.CITY && this.sinceHaul > 150 && r < 0.5) return this.longHaul();
    this.push(...this.next(last, r));
  }

  next(last, r) {
    switch (last) {
      case BIOME.CITY:
        return r < 0.34
          ? [BIOME.TUNNEL, 2 + ((this.rnd() * 3) | 0)]
          : r < 0.72
            ? [BIOME.HIGHWAY, 6 + ((this.rnd() * 7) | 0)]
            : [BIOME.BRIDGE, 2 + ((this.rnd() * 2) | 0)];
      case BIOME.TUNNEL:
        return r < 0.5
          ? [BIOME.HIGHWAY, 5 + ((this.rnd() * 6) | 0)]
          : [BIOME.CITY, 5 + ((this.rnd() * 6) | 0)];
      case BIOME.HIGHWAY:
        return r < 0.15
          ? [BIOME.GAS, 1]
          : r < 0.38
            ? [BIOME.FOREST, 5 + ((this.rnd() * 7) | 0)]
            : r < 0.54
              ? [BIOME.COAST, 6 + ((this.rnd() * 7) | 0)]
              : r < 0.68
                ? [BIOME.BRIDGE, 2 + ((this.rnd() * 2) | 0)]
                : r < 0.86
                  ? [BIOME.CITY, 5 + ((this.rnd() * 6) | 0)]
                  : [BIOME.TUNNEL, 2 + ((this.rnd() * 3) | 0)];
      case BIOME.GAS:
        return [BIOME.HIGHWAY, 5 + ((this.rnd() * 8) | 0)];
      case BIOME.FOREST:
        return r < 0.24
          ? [BIOME.BRIDGE, 2]
          : r < 0.44
            ? [BIOME.TUNNEL, 2 + ((this.rnd() * 2) | 0)]
            : r < 0.6
              ? [BIOME.COAST, 6 + ((this.rnd() * 6) | 0)]
              : [BIOME.HIGHWAY, 5 + ((this.rnd() * 6) | 0)];

      case BIOME.COAST:
        return r < 0.5
          ? [BIOME.HIGHWAY, 6 + ((this.rnd() * 7) | 0)]
          : r < 0.8
            ? [BIOME.FOREST, 5 + ((this.rnd() * 6) | 0)]
            : [BIOME.CITY, 5 + ((this.rnd() * 5) | 0)];
      case BIOME.BRIDGE:
      default:
        return r < 0.5
          ? [BIOME.HIGHWAY, 6 + ((this.rnd() * 6) | 0)]
          : [BIOME.CITY, 5 + ((this.rnd() * 7) | 0)];
    }
  }

  at(i) {
    const idx = Math.max(0, i);
    while (this.seq.length <= idx) this.extend();
    return this.seq[idx];
  }

  remotenessAt(i) {
    this.at(i);
    return this.remote[Math.max(0, i)];
  }
}

export class Road {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.a = assets();
    this.biomes = new BiomeSequencer();

    this.first = 0;                  // absolute index of samples[0]
    this.samples = [{ x: 0, y: elevationAt(0), z: 0, h: 0 }];
    this.chunks = new Map();
    this.chunkCache = new Map();     // chunkIndex -> biome (for HUD / audio)
  }

  /* ── centreline ─────────────────────────────────────────── */

  ensure(idx) {
    let last = this.first + this.samples.length - 1;
    while (last < idx) {
      const p = this.samples[this.samples.length - 1];
      const s = last * DS;
      const h = p.h + curvatureAt(s) * DS;
      this.samples.push({
        x: p.x + Math.sin(h) * DS,
        y: elevationAt((last + 1) * DS),
        z: p.z - Math.cos(h) * DS,
        h,
      });
      last++;
    }
  }

  sample(idx) {
    this.ensure(idx);
    const i = idx - this.first;
    return this.samples[Math.max(0, Math.min(this.samples.length - 1, i))];
  }

  /**
   * Jump the centreline to an arbitrary distance, forwards or backwards.
   *
   * Samples behind the rider are thrown away as you ride, so asking for one
   * again — which only happens if something moves you backwards — used to clamp
   * to the oldest surviving sample. Every pose then collapsed onto the same
   * point and the camera ended up inside a degenerate world with no error to
   * show for it. This rebuilds instead: heading is re-integrated from zero
   * (cheap, and the only quantity with history), position restarts at the
   * origin, which is fine because the world is rebased on long rides anyway.
   */
  seek(s) {
    const idx = Math.floor(s / DS);
    const last = this.first + this.samples.length - 1;
    if (idx >= this.first && idx <= last + 4000) return false;

    let h = 0;
    for (let i = 0; i < idx; i++) h += curvatureAt(i * DS) * DS;
    this.first = idx;
    this.samples = [{ x: 0, y: elevationAt(idx * DS), z: 0, h }];
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
    return true;
  }

  /** Interpolated centreline pose at distance `s` (metres). */
  poseAt(s, out = {}) {
    const f = s / DS;
    const i0 = Math.floor(f);
    const t = f - i0;
    const a = this.sample(i0);
    const b = this.sample(i0 + 1);
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    out.h = a.h + (b.h - a.h) * t;
    out.pitch = Math.atan2(b.y - a.y, DS);
    return out;
  }

  curvature(s) {
    return curvatureAt(s);
  }

  biomeAt(s) {
    return this.biomes.at(Math.floor(s / CHUNK_LEN));
  }

  /** 0 = ordinary road, 1 = deep in a long haul with nothing around. */
  remotenessAt(s) {
    return this.biomes.remotenessAt(Math.floor(s / CHUNK_LEN));
  }

  /** Metres until the next chunk of `biome`, or Infinity if none within range. */
  distanceTo(biome, s, maxAhead = 3000) {
    const c0 = Math.floor(s / CHUNK_LEN);
    for (let c = c0; c <= c0 + Math.ceil(maxAhead / CHUNK_LEN); c++) {
      if (this.biomes.at(c) === biome) return Math.max(0, c * CHUNK_LEN - s);
    }
    return Infinity;
  }

  static right(h, out = new THREE.Vector3()) {
    return out.set(Math.cos(h), 0, Math.sin(h));
  }

  static forward(h, out = new THREE.Vector3()) {
    return out.set(Math.sin(h), 0, -Math.cos(h));
  }

  /** World position offset laterally from the centreline. */
  point(s, lateral, y = 0, out = new THREE.Vector3()) {
    const p = this.poseAt(s);
    return out.set(
      p.x + Math.cos(p.h) * lateral,
      p.y + y,
      p.z + Math.sin(p.h) * lateral
    );
  }

  /* ── chunk lifecycle ────────────────────────────────────── */

  update(s) {
    const c0 = Math.floor(s / CHUNK_LEN);
    for (let c = c0 - BEHIND; c <= c0 + AHEAD; c++) {
      if (c >= 0 && !this.chunks.has(c)) this.chunks.set(c, this.buildChunk(c));
    }
    for (const [c, chunk] of this.chunks) {
      if (c < c0 - BEHIND || c > c0 + AHEAD) {
        this.disposeChunk(chunk);
        this.chunks.delete(c);
      }
    }
    // trim centreline samples that nothing references any more
    const keepFrom = (c0 - BEHIND - 1) * N;
    if (keepFrom > this.first + N) {
      const drop = keepFrom - this.first;
      this.samples.splice(0, drop);
      this.first += drop;
    }
  }

  disposeChunk(chunk) {
    this.group.remove(chunk.group);
    chunk.group.traverse((o) => {
      if (o.isMesh && o.geometry) o.geometry.dispose();
    });
    for (const m of chunk.ownMaterials) m.dispose();
  }

  buildChunk(ci) {
    const a = this.a;
    const sStart = ci * CHUNK_LEN;
    const biome = this.biomes.at(ci);
    const prev = this.biomes.at(ci - 1);
    const next = this.biomes.at(ci + 1);
    const rnd = mulberry32(ci * 9176 + 17);
    const origin = new THREE.Vector3().copy(this.poseAt(sStart));

    const ctx = new ChunkCtx(origin, this, rnd, biome, prev, next, sStart);
    ctx.remote = this.biomes.remotenessAt(ci);

    /* ── cross-sections for the carriageway ─────────────── */
    const secAsphalt = [];
    const secShoulderL = [];
    const secShoulderR = [];
    const secGroundL = [];
    const secGroundR = [];
    const tunnel = biome === BIOME.TUNNEL;
    const bridge = biome === BIOME.BRIDGE;
    // on the coast the ground stops at the parapet: past it there is only sea
    const sea = biome === BIOME.COAST ? coastSide(ci) : 0;

    for (let i = 0; i <= N; i++) {
      const s = sStart + i * DS;
      const p = this.poseAt(s);
      const c = Math.cos(p.h), sn = Math.sin(p.h);
      const at = (lat, dy = 0) =>
        new THREE.Vector3(p.x + c * lat - origin.x, p.y + dy - origin.y, p.z + sn * lat - origin.z);

      secAsphalt.push({ l: at(-ROAD_HALF), r: at(ROAD_HALF) });
      secShoulderL.push({ l: at(-ROAD_HALF - SHOULDER, -0.05), r: at(-ROAD_HALF) });
      secShoulderR.push({ l: at(ROAD_HALF), r: at(ROAD_HALF + SHOULDER, -0.05) });
      if (!tunnel && !bridge) {
        if (sea >= 0) secGroundL.push({ l: at(-90, -0.9 - (i % 3) * 0.35), r: at(-ROAD_HALF - SHOULDER, -0.05) });
        if (sea <= 0) secGroundR.push({ l: at(ROAD_HALF + SHOULDER, -0.05), r: at(90, -0.9 - ((i + 1) % 3) * 0.35) });
      }
    }

    ctx.get('asphalt', a.asphalt).ribbon(secAsphalt, 0.06);
    ctx.get('shoulder', a.shoulder).ribbon(secShoulderL, 0.1).ribbon(secShoulderR, 0.1);
    const ground = ctx.get('ground', a.ground);
    if (secGroundL.length) ground.ribbon(secGroundL, 0.02);
    if (secGroundR.length) ground.ribbon(secGroundR, 0.02);

    /* ── paint ───────────────────────────────────────────── */
    const white = ctx.get('paintWhite', a.paintWhite);
    const yellow = ctx.get('paintYellow', a.paintYellow);
    /* Fifteen millimetres was not enough clearance. A perspective depth buffer
       resolves about z^2 / (near * 2^bits) at distance z, so with a near plane
       of 0.4 m the finest step it can tell apart is already millimetres at
       fifty metres and centimetres beyond a couple of hundred — and where the
       step is smaller than that, the road and the paint on it win alternate
       pixels. That reads as the paint breaking into black dashes along a band
       at a fixed distance, which is exactly the arc that shows up under street
       lamps. Multisampling hides it, which is why it only appeared on the
       profile that has none. */
    /* Back to a small lift now that the depth offset does the real work: four
       centimetres of paint standing off the tarmac is visible from the saddle. */
    const paintY = 0.018;
    this.solidLine(white, sStart, sStart + CHUNK_LEN, -ROAD_HALF + 0.35, 0.14, paintY, origin);
    this.solidLine(white, sStart, sStart + CHUNK_LEN, ROAD_HALF - 0.35, 0.14, paintY, origin);
    this.solidLine(yellow, sStart, sStart + CHUNK_LEN, -0.2, 0.12, paintY, origin);
    this.solidLine(yellow, sStart, sStart + CHUNK_LEN, 0.2, 0.12, paintY, origin);
    for (let d = 0; d < CHUNK_LEN; d += 12) {
      for (const lat of [-3.3, 3.3]) {
        this.solidLine(white, sStart + d, sStart + d + 4.5, lat, 0.13, paintY, origin);
      }
    }

    /* ── biome decoration ────────────────────────────────── */
    decorateChunk(ctx);

    const group = ctx.finish();
    group.position.copy(origin);
    this.group.add(group);

    return { group, ownMaterials: ctx.ownMaterials, biome };
  }

  /** A painted stripe following the centreline between two distances. */
  solidLine(mb, s0, s1, lateral, width, y, origin) {
    const sections = [];
    const steps = Math.max(2, Math.ceil((s1 - s0) / DS));
    for (let i = 0; i <= steps; i++) {
      const s = s0 + ((s1 - s0) * i) / steps;
      const p = this.poseAt(s);
      const c = Math.cos(p.h), sn = Math.sin(p.h);
      const mk = (lat) =>
        new THREE.Vector3(p.x + c * lat - origin.x, p.y + y - origin.y, p.z + sn * lat - origin.z);
      sections.push({ l: mk(lateral - width / 2), r: mk(lateral + width / 2) });
    }
    mb.ribbon(sections, 0.5);
  }

  /** Shift the entire world so floats stay small on very long rides. */
  rebase(offset) {
    for (const s of this.samples) {
      s.x -= offset.x;
      s.y -= offset.y;
      s.z -= offset.z;
    }
    for (const { group } of this.chunks.values()) group.position.sub(offset);
  }
}

export { MeshBuilder };
