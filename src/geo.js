import * as THREE from 'three';

/**
 * Tiny retained-mode mesh builder. Everything in the world is generated into a
 * handful of these (one per material) so that a whole 120 m chunk of road,
 * lamps, guardrails and buildings ends up as ~6 draw calls.
 */
export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.idx = [];
  }

  get empty() {
    return this.idx.length === 0;
  }

  /** Quad in CCW winding: p0 p1 p2 p3 (arrays or Vector3-likes). */
  quad(p0, p1, p2, p3, u0 = 0, v0 = 0, u1 = 1, v1 = 1) {
    const n = this.pos.length / 3;
    for (const p of [p0, p1, p2, p3]) this.pos.push(p.x, p.y, p.z);
    this.uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    this.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    return this;
  }

  /**
   * Ribbon along a list of cross-sections: [{ l: Vector3, r: Vector3 }, ...].
   * `vScale` controls how fast the V coordinate advances per metre.
   */
  ribbon(sections, vScale = 0.05) {
    let v = 0;
    for (let i = 0; i < sections.length - 1; i++) {
      const a = sections[i];
      const b = sections[i + 1];
      const dv = a.l.distanceTo(b.l) * vScale;
      this.quad(a.l, a.r, b.r, b.l, 0, v, 1, v + dv);
      v += dv;
    }
    return this;
  }

  /** Axis-aligned box, optionally yawed around its own centre. */
  box(cx, cy, cz, sx, sy, sz, rotY = 0) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const P = (x, y, z) => new THREE.Vector3(cx + x * c + z * s, cy + y, cz - x * s + z * c);
    const a = P(-hx, -hy, -hz), b = P(hx, -hy, -hz), d = P(hx, -hy, hz), e = P(-hx, -hy, hz);
    const f = P(-hx, hy, -hz), g = P(hx, hy, -hz), h = P(hx, hy, hz), i = P(-hx, hy, hz);
    this.quad(f, g, h, i);          // top
    this.quad(e, d, b, a);          // bottom
    this.quad(a, b, g, f, 0, 0, sx, sy); // -z
    this.quad(d, e, i, h, 0, 0, sx, sy); // +z
    this.quad(e, a, f, i, 0, 0, sz, sy); // -x
    this.quad(b, d, h, g, 0, 0, sz, sy); // +x
    return this;
  }

  /** Vertical cylinder (no caps unless asked — poles never need them). */
  cylinder(cx, cy, cz, radius, height, segments = 6, caps = false) {
    const top = [], bot = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const x = cx + Math.cos(a) * radius, z = cz + Math.sin(a) * radius;
      bot.push(new THREE.Vector3(x, cy, z));
      top.push(new THREE.Vector3(x, cy + height, z));
    }
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.quad(bot[i], bot[j], top[j], top[i], 0, 0, 1, height * 0.2);
    }
    if (caps) {
      const cTop = new THREE.Vector3(cx, cy + height, cz);
      for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments;
        this.quad(top[i], top[j], cTop, cTop);
      }
    }
    return this;
  }

  /** Cone with apex up — trees, mostly. */
  cone(cx, cy, cz, radius, height, segments = 6) {
    const apex = new THREE.Vector3(cx, cy + height, cz);
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const p0 = new THREE.Vector3(cx + Math.cos(a0) * radius, cy, cz + Math.sin(a0) * radius);
      const p1 = new THREE.Vector3(cx + Math.cos(a1) * radius, cy, cz + Math.sin(a1) * radius);
      this.quad(p0, p1, apex, apex);
    }
    return this;
  }

  /** Horizontal quad lying on the road, centred at p, aligned to `right`. */
  decal(p, right, forward, width, length, yOff = 0) {
    const w = right.clone().multiplyScalar(width / 2);
    const f = forward.clone().multiplyScalar(length / 2);
    const up = new THREE.Vector3(0, yOff, 0);
    const a = p.clone().sub(w).sub(f).add(up);
    const b = p.clone().add(w).sub(f).add(up);
    const c = p.clone().add(w).add(f).add(up);
    const d = p.clone().sub(w).add(f).add(up);
    return this.quad(a, b, c, d, 0, 0, 1, 1);
  }

  build(computeNormals = true) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    if (computeNormals) g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Deterministic PRNG — every chunk regenerates identically. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential smoothing. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
