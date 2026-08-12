import * as THREE from 'three';
import { assets, neon } from './assets.js';
import { clamp, damp, smoothstep, mulberry32, MeshBuilder } from './geo.js';
import { BIOME, VIEW_DIST, ROAD_HALF, SHOULDER } from './constants.js';

/**
 * The things that happen maybe once in half an hour.
 *
 * Everything here is deliberately rare. An aeroplane every few minutes is
 * scenery; an aeroplane every twenty minutes is something you look up at. The
 * intervals below are long on purpose — if you find yourself seeing one of
 * these twice in a short ride, they are too frequent, not too sparse.
 */

const CARRIAGES = 12;
const CARRIAGE_GAP = 25;

/* ── sound helpers: created once, level driven by proximity ── */

class TrainSound {
  constructor(core) {
    this.core = core;
    const src = core.noiseSource();
    this.lp = core.filter('lowpass', 200, 1.1);
    this.bp = core.filter('bandpass', 1150, 1.5);
    this.gLow = core.gain(0);
    this.gHi = core.gain(0);
    this.out = core.gain(1);
    src.connect(this.lp);
    this.lp.connect(this.gLow);
    this.gLow.connect(this.out);
    src.connect(this.bp);
    this.bp.connect(this.gHi);
    this.gHi.connect(this.out);
    this.out.connect(core.master);
  }

  set(level, closing) {
    const t = this.core.t;
    this.gLow.gain.setTargetAtTime(level * 0.55, t, 0.2);
    this.gHi.gain.setTargetAtTime(level * level * 0.1, t, 0.2);
    // a touch of doppler: brighter coming at you, duller once it is past
    this.lp.frequency.setTargetAtTime(170 + closing * 90, t, 0.3);
    this.bp.frequency.setTargetAtTime(1000 + closing * 380, t, 0.3);
  }
}

class RiderSound {
  constructor(core) {
    this.core = core;
    const ctx = core.ctx;
    this.oscs = [];
    this.g = core.gain(0);
    this.lp = core.filter('lowpass', 620, 2.4);
    this.g.connect(this.lp);
    this.lp.connect(core.master);
    for (const det of [0, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = det;
      o.frequency.value = 90;
      const vg = core.gain(0.4);
      o.connect(vg);
      vg.connect(this.g);
      o.start();
      this.oscs.push(o);
    }
  }

  set(level, hz) {
    const t = this.core.t;
    this.g.gain.setTargetAtTime(level * 0.09, t, 0.15);
    this.lp.frequency.setTargetAtTime(380 + level * 900, t, 0.2);
    for (const o of this.oscs) o.frequency.setTargetAtTime(hz, t, 0.08);
  }
}

export class Events {
  constructor(scene, road) {
    this.scene = scene;
    this.road = road;
    this.a = assets();
    this.rnd = mulberry32(8181);
    this.tmp = new THREE.Vector3();
    this.flash = 0;
    this.thunder = [];
    this.sounds = null;

    const r = this.rnd;
    this.plane = {
      group: null, t: -1, next: 200 + r() * 420,
      from: new THREE.Vector3(), to: new THREE.Vector3(),
    };
    this.train = { cars: null, active: false, head: 0, side: 1, speed: 40, next: 260 + r() * 420, life: 0 };
    this.rider = { obj: null, lean: null, active: false, s: 0, lat: 0, speed: 42, next: 180 + r() * 360, life: 0, phase: 0 };
    this.storm = { active: false, until: 0, strikeAt: 0, next: 150 + r() * 300, reflash: -1 };
    this.overlook = { obj: null };
    this.works = { obj: null, active: false, s: 0, side: 1, len: 0,
                   next: 200 + r() * 380, chase: 0 };
    this.broken = { obj: null, active: false, s: 0, next: 150 + r() * 320 };
    /* how many of the rare things this session actually showed anyone */
    this.seen = { train: 0, rider: 0, plane: 0, planeLow: 0, lightning: 0, works: 0, broken: 0 };
  }

  /* ── lazy construction: nothing exists until it first happens ── */

  buildPlane() {
    const g = new THREE.Group();
    const strobe = this.a.glowSprite(0xffffff, 40, 0);
    const nav = this.a.glowSprite(0xff3020, 26, 0);
    nav.position.x = 26;
    g.add(strobe, nav);
    this.scene.add(g);
    this.plane.group = g;
    this.plane.strobe = strobe;
    this.plane.nav = nav;
  }

  buildTrain() {
    const a = this.a;
    const shell = new THREE.MeshStandardMaterial({
      color: 0x0a0c12, roughness: 0.66, metalness: 0.45, envMapIntensity: 0.5,
    });
    const lit = new THREE.MeshBasicMaterial({ color: neon(0xffd49a, 1.0), toneMapped: false });
    const bodyGeo = new THREE.BoxGeometry(3.1, 3.3, 23);
    const skirtGeo = new THREE.BoxGeometry(3.4, 1.0, 23);

    /* Separate windows, not one long strip — a continuous bar of light reads as
       a neon tube rather than a train. All of them share one geometry, so a
       whole carriage side is still a single draw call. */
    const mb = new MeshBuilder();
    for (const dx of [-1.56, 1.56]) {
      for (let i = 0; i < 8; i++) {
        if (i === 4) continue;                       // a door, for rhythm
        mb.box(dx, 2.95, (i - 3.5) * 2.45, 0.12, 0.92, 1.35, 0);
      }
    }
    const winGeo = mb.build();

    this.train.cars = [];
    for (let i = 0; i < CARRIAGES; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, shell);
      body.position.y = 2.5;
      const skirt = new THREE.Mesh(skirtGeo, shell);
      skirt.position.y = 0.55;
      g.add(body, skirt, new THREE.Mesh(winGeo, lit));
      const bleed = a.glowSprite(0xffc07a, 8, 0.09);
      bleed.position.set(0, 2.7, 0);
      g.add(bleed);
      if (i === 0) {
        const head = a.glowSprite(0xfff0d0, 5, 0.9);
        head.position.set(0, 2.7, -11.8);
        g.add(head);
      }
      g.visible = false;
      this.scene.add(g);
      this.train.cars.push(g);
    }
  }

  buildRider() {
    const a = this.a;
    const root = new THREE.Group();
    const lean = new THREE.Group();
    root.add(lean);

    const dark = new THREE.MeshStandardMaterial({
      color: 0x0b0d13, roughness: 0.4, metalness: 0.7, envMapIntensity: 1.2,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.46, 1.8), dark);
    body.position.y = 0.68;
    const rider = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.42, 4, 8), dark);
    rider.position.set(0, 1.16, 0.2);
    rider.rotation.x = -0.5;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), dark);
    head.position.set(0, 1.45, -0.02);
    lean.add(body, rider, head);

    /* Wheels. Left off originally on the theory that nobody sees them at night
       — but your own headlight lights this rider up as you close on him, and a
       motorcycle hovering an inch off the road is the first thing you notice. */
    const tyre = new THREE.TorusGeometry(0.33, 0.085, 6, 16);
    tyre.rotateY(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(0.2, 0.2, 0.07, 8);
    rim.rotateZ(Math.PI / 2);
    const metal = new THREE.MeshStandardMaterial({
      color: 0x5a6472, roughness: 0.3, metalness: 1, envMapIntensity: 1.2,
    });
    this.rider.wheels = [];
    for (const z of [0.72, -0.74]) {
      const w = new THREE.Group();
      w.position.set(0, 0.33, z);
      w.add(new THREE.Mesh(tyre, dark), new THREE.Mesh(rim, metal));
      lean.add(w);
      this.rider.wheels.push(w);
    }

    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.07, 0.05),
      new THREE.MeshBasicMaterial({ color: neon(0xff1030, 2.4), toneMapped: false })
    );
    tail.position.set(0, 0.92, 0.9);
    lean.add(tail);
    const tailGlow = a.glowSprite(0xff1230, 1.5, 0.65);
    tailGlow.position.copy(tail.position);
    lean.add(tailGlow);
    const headGlow = a.glowSprite(0xffeccf, 1.6, 0.6);
    headGlow.position.set(0, 0.86, -0.86);
    lean.add(headGlow);
    this.rider.headGlow = headGlow;

    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(3.0, 26, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xfff1de, transparent: true, opacity: 0.022,
        blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.DoubleSide, fog: false, toneMapped: false,
      })
    );
    cone.geometry.rotateX(Math.PI / 2);
    cone.geometry.translate(0, 0, -13);
    cone.position.set(0, 0.86, -0.88);
    lean.add(cone);

    root.visible = false;
    this.scene.add(root);
    this.rider.obj = root;
    this.rider.lean = lean;
  }

  /**
   * Roadworks: a coned-off lane, an arrow board with lights chasing toward the
   * side that is still open, and a couple of beacons. Everything is built once
   * into a single group placed at the start of the works, so the cones follow
   * the road without thirty separate objects being repositioned every frame.
   */
  buildWorks() {
    const a = this.a;
    const g = new THREE.Group();
    const cone = new THREE.ConeGeometry(0.22, 0.62, 7);
    const orange = new THREE.MeshStandardMaterial({
      color: 0xd8500e, roughness: 0.75, metalness: 0.1, emissive: 0x3a1200, emissiveIntensity: 1,
    });
    const band = new THREE.MeshBasicMaterial({ color: neon(0xffffff, 1.4), toneMapped: false });
    const bandGeo = new THREE.CylinderGeometry(0.15, 0.19, 0.1, 7);

    this.works.cones = [];
    for (let i = 0; i < 26; i++) {
      const c = new THREE.Group();
      c.add(new THREE.Mesh(cone, orange));
      const b = new THREE.Mesh(bandGeo, band);
      b.position.y = 0.16;
      c.add(b);
      g.add(c);
      this.works.cones.push(c);
    }

    /* the arrow board */
    const board = new THREE.Group();
    board.add(new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 1.3, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.8, metalness: 0.2 })
    ));
    this.works.lamps = [];
    for (let i = 0; i < 5; i++) {
      const l = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.22, 0.08),
        new THREE.MeshBasicMaterial({ color: neon(0xffa81e, 3), toneMapped: false })
      );
      l.position.set(-0.8 + i * 0.4, 0, 0.12);
      board.add(l);
      const glow = a.glowSprite(0xffa81e, 1.5, 0);
      glow.position.copy(l.position);
      board.add(glow);
      this.works.lamps.push({ mesh: l, glow });
    }
    board.position.y = 1.5;
    g.add(board);
    this.works.board = board;

    this.works.beacons = [];
    for (let i = 0; i < 2; i++) {
      const bc = a.glowSprite(0xffb02a, 2.2, 0);
      g.add(bc);
      this.works.beacons.push(bc);
    }

    g.visible = false;
    this.scene.add(g);
    this.works.obj = g;
  }

  updateWorks(dt, st) {
    const w = this.works;
    if (!w.active) {
      w.next -= dt;
      const ok = st.biome === 'HIGHWAY' || st.biome === 'CITY';
      if (w.next > 0 || !ok || st.v < 8) return;
      if (!w.obj) this.buildWorks();
      w.active = true;
      w.side = 1;                       // always the outer lane on your side
      w.s = st.s + 260 + this.rnd() * 180;
      w.len = 120 + this.rnd() * 90;

      const origin = this.road.point(w.s, 0, 0, new THREE.Vector3());
      w.obj.position.copy(origin);
      const place = (obj, s, lat, y) => {
        this.road.point(s, lat, y, this.tmp);
        obj.position.copy(this.tmp).sub(origin);
        obj.rotation.y = -this.road.poseAt(s).h;
      };
      /* cones taper in over the first thirty metres, then hold the lane shut */
      w.cones.forEach((c, i) => {
        const f = i / (w.cones.length - 1);
        const along = w.s + f * w.len;
        const taper = Math.min(1, f * 4.5);
        place(c, along, w.side * (7.4 - taper * 3.4), 0.31);
      });
      place(w.board, w.s - 26, w.side * 6.6, 1.5);
      place(w.beacons[0], w.s - 26, w.side * 6.6, 2.6);
      place(w.beacons[1], w.s + w.len, w.side * 6.2, 1.4);
      w.obj.visible = true;
      this.seen.works++;
      return;
    }

    /* the lights chase toward the lane that is still open */
    w.chase += dt * 6;
    const idx = Math.floor(w.chase) % 7;
    w.lamps.forEach((l, i) => {
      const on = idx >= 4 ? true : i === (w.side > 0 ? 4 - idx : idx);
      l.mesh.visible = on;
      l.glow.material.opacity = on ? 0.9 : 0;
    });
    const flash = Math.sin(st.now * 7) > 0;
    w.beacons.forEach((b, i) => { b.material.opacity = (i === 0 ? flash : !flash) ? 0.8 : 0.05; });

    if (st.s > w.s + w.len + 140) {
      w.active = false;
      w.obj.visible = false;
      w.next = 260 + this.rnd() * 420;
    }
  }

  /** Which lane the autopilot must not use, if any. */
  get closedLane() {
    const w = this.works;
    return w.active ? { from: w.s - 90, to: w.s + w.len + 20, lat: w.side * 5.0 } : null;
  }

  /**
   * Somebody stopped on the hard shoulder with the hazards going. Nothing
   * happens and nothing is required of you — it is just a thing that is there,
   * the way it would be on a real road at two in the morning.
   */
  buildBroken() {
    const a = this.a;
    const g = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({
      color: 0x141820, roughness: 0.3, metalness: 0.8, envMapIntensity: 1.1,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.62, 4.4), paint);
    body.position.y = 0.63;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.56, 2.2), paint);
    cabin.position.set(0, 1.19, 0.2);
    g.add(body, cabin);

    /* boot open — the universal sign that this is not going anywhere */
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 1.2), paint);
    lid.position.set(0, 1.5, 1.9);
    lid.rotation.x = -0.9;
    g.add(lid);

    this.broken.lamps = [];
    for (const dx of [-0.72, 0.72]) {
      for (const [dz, hex] of [[-2.2, 0xffa81e], [2.2, 0xff7a1e]]) {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(0.2, 0.12, 0.06),
          new THREE.MeshBasicMaterial({ color: neon(hex, 2.6), toneMapped: false })
        );
        m.position.set(dx, 0.75, dz);
        g.add(m);
        const glow = a.glowSprite(hex, 1.1, 0);
        glow.position.copy(m.position);
        g.add(glow);
        this.broken.lamps.push({ mesh: m, glow });
      }
    }

    /* warning triangle a few metres back */
    const tri = new THREE.Mesh(
      new THREE.ConeGeometry(0.42, 0.66, 3),
      new THREE.MeshBasicMaterial({ color: neon(0xff3a2a, 1.8), toneMapped: false, side: THREE.DoubleSide })
    );
    tri.position.set(0, 0.33, 9);
    g.add(tri);
    this.broken.triangle = tri;

    g.visible = false;
    this.scene.add(g);
    this.broken.obj = g;
  }

  updateBroken(dt, st) {
    const bd = this.broken;
    if (!bd.active) {
      bd.next -= dt;
      if (bd.next > 0 || st.v < 8 || st.biome === 'TUNNEL' || st.biome === 'BRIDGE') return;
      if (!bd.obj) this.buildBroken();
      bd.active = true;
      bd.s = st.s + 220 + this.rnd() * 220;
      const side = this.rnd() < 0.75 ? 1 : -1;
      this.road.point(bd.s, side * (ROAD_HALF + SHOULDER - 0.7), 0, this.tmp);
      bd.obj.position.copy(this.tmp);
      bd.obj.rotation.y = -this.road.poseAt(bd.s).h + (side > 0 ? 0 : Math.PI);
      bd.obj.visible = true;
      this.seen.broken++;
      return;
    }
    const on = Math.sin(st.now * 4.4) > 0;          // hazards, all four together
    for (const l of bd.lamps) {
      l.mesh.visible = on;
      l.glow.material.opacity = on ? 0.75 : 0;
    }
    if (st.s > bd.s + 120) {
      bd.active = false;
      bd.obj.visible = false;
      bd.next = 220 + this.rnd() * 400;
    }
  }

  /* ── the events themselves ────────────────────────────────── */

  updatePlane(dt, st) {
    const p = this.plane;
    if (p.t < 0) {
      p.next -= dt;
      if (p.next > 0) return;
      if (!p.group) this.buildPlane();
      const pose = this.road.poseAt(st.s + 600);
      /* Once in a while it isn't a light crossing the sky at cruise — it is
         something enormous on approach, low enough to pass right over you. */
      p.low = this.rnd() < 0.3;
      if (p.low) {
        const h = this.rnd() < 0.5 ? 1 : -1;
        p.from.set(pose.x + h * 700, pose.y + 210, pose.z - 900);
        p.to.set(pose.x - h * 260, pose.y + 46, pose.z + 700);
      } else {
        p.from.set(pose.x - 900, pose.y + 320, pose.z - 500);
        p.to.set(pose.x + 900, pose.y + 380, pose.z + 700);
      }
      this.seen.plane++;
      if (p.low) this.seen.planeLow++;
      p.strobe.scale.setScalar(p.low ? 16 : 40);
      p.nav.scale.setScalar(p.low ? 11 : 26);
      p.nav.position.x = p.low ? 11 : 26;
      p.t = 0;
      return;
    }
    p.t += dt / (p.low ? 17 : 46);
    if (p.t > 1) {
      p.t = -1;
      p.next = 240 + this.rnd() * 480;
      p.strobe.material.opacity = 0;
      p.nav.material.opacity = 0;
      if (this.sounds) this.sounds.sky.set(0, 0);
      return;
    }
    p.group.position.lerpVectors(p.from, p.to, p.t);
    const fade = smoothstep(0, 0.08, p.t) * (1 - smoothstep(0.9, 1, p.t));
    p.strobe.material.opacity = (Math.sin(st.now * 7) > 0.85 ? 1 : 0.04) * fade;
    p.nav.material.opacity = 0.5 * fade * (Math.sin(st.now * 2.1) > 0 ? 1 : 0.3);

    if (p.low && this.sounds) {
      // the noise arrives late and leaves slowly, the way a low pass does
      const near = 1 - Math.abs(p.t - 0.62) / 0.38;
      this.sounds.sky.set(Math.pow(Math.max(0, near), 2.2) * 0.7, 0.9);
    }
  }

  updateTrain(dt, st) {
    const tr = this.train;

    if (!tr.active) {
      tr.next -= dt;
      const openCountry = st.biome === BIOME.HIGHWAY || st.biome === BIOME.FOREST;
      if (tr.next > 0 || !openCountry || st.remote < 0.2 || st.v < 12) return;
      if (!tr.cars) this.buildTrain();
      tr.active = true;
      this.seen.train++;
      tr.life = 0;
      tr.company = 0;
      tr.side = this.rnd() < 0.5 ? -1 : 1;
      /* Spawn distance and speed have to agree, or it just recedes for a
         minute and you never actually see it: either it comes up behind and
         overtakes you, or it is ahead and you slowly reel it in. */
      if (this.rnd() < 0.5) {
        tr.head = st.s - 220 - this.rnd() * 120;
        tr.speed = clamp(st.v * (1.1 + this.rnd() * 0.16), 26, 62);
      } else {
        tr.head = st.s + 260 + this.rnd() * 200;
        tr.speed = clamp(st.v * (0.76 + this.rnd() * 0.12), 22, 58);
      }
      for (const c of tr.cars) c.visible = true;
      return;
    }

    tr.life += dt;
    let rel = tr.head - st.s;

    /* once a carriage is level with you it settles into your pace, and for a
       while you are just two things moving through the dark together */
    if (tr.company === 0 && tr.life > 3 && Math.abs(rel - CARRIAGE_GAP * 3) < 90) {
      tr.company = 22 + this.rnd() * 40;
    }
    if (tr.company > 0) {
      tr.company -= dt;
      tr.speed = damp(tr.speed, st.v, 0.7, dt);
    }

    tr.head += tr.speed * dt;
    rel = tr.head - st.s;
    if (rel < -80 || rel > VIEW_DIST + 240 || tr.life > 220) {
      tr.active = false;
      tr.next = 300 + this.rnd() * 540;
      for (const c of tr.cars) c.visible = false;
      if (this.sounds) this.sounds.train.set(0, 0);
      return;
    }

    for (let i = 0; i < tr.cars.length; i++) {
      const s = tr.head - i * CARRIAGE_GAP;
      this.road.point(s, tr.side * 36, -2.4, this.tmp);
      const car = tr.cars[i];
      car.position.copy(this.tmp);
      car.rotation.y = -this.road.poseAt(s).h;
    }

    if (this.sounds) {
      // loudest when a carriage is level with you, not when the head is
      const nearest = clamp(Math.abs(rel - CARRIAGE_GAP * 4), 0, 400);
      const level = Math.pow(1 - nearest / 400, 2.2);
      this.sounds.train.set(level, clamp((tr.speed - st.v) / 20 + 0.5, 0, 1));
    }
  }

  updateRider(dt, st) {
    const rd = this.rider;

    if (!rd.active) {
      rd.next -= dt;
      if (rd.next > 0 || st.v < 14 || st.biome === BIOME.TUNNEL) return;
      if (!rd.obj) this.buildRider();
      rd.active = true;
      this.seen.rider++;
      rd.life = 0;
      rd.company = 0;
      rd.phase = this.rnd() * 6.28;
      rd.wantRel = -8 + this.rnd() * 24;      // where they end up sitting relative to you
      rd.flash = 0;
      rd.greeted = false;
      rd.latBase = 3.3;
      // same deal as the train: they either catch you, or you catch them
      if (this.rnd() < 0.5) {
        rd.s = st.s - 130 - this.rnd() * 90;
        rd.speed = clamp(st.v * (1.12 + this.rnd() * 0.18), 24, 64);
      } else {
        rd.s = st.s + 110 + this.rnd() * 150;
        rd.speed = clamp(st.v * (0.78 + this.rnd() * 0.12), 20, 60);
      }
      rd.lat = 1.8 + this.rnd() * 3;
      rd.obj.visible = true;
      return;
    }

    rd.life += dt;
    let rel = rd.s - st.s;

    /* They'll run with you for a bit before winding it on again — and while
       they do, they settle into the next lane rather than a dot on the
       horizon. Two headlights on an empty road is the whole point of them. */
    if (rd.company === 0 && rd.life > 3 && Math.abs(rel) < 90) {
      rd.company = 25 + this.rnd() * 50;
      /* Two riders meeting on an empty road at night flash their lamps at each
         other. It costs nothing and it is the only moment in the game where
         anything acknowledges you. */
      rd.greeted = false;
    }
    if (rd.company > 0 && !rd.greeted && Math.abs(rel) < 40) {
      rd.greeted = true;
      rd.flash = 0.7;
      if (st.onGreet) st.onGreet();
    }
    if (rd.flash > 0) {
      rd.flash -= dt;
      const on = Math.sin(rd.flash * 20) > -0.2;
      rd.headGlow.material.opacity = on ? 1 : 0.25;
      rd.headGlow.scale.setScalar(on ? 3.2 : 1.6);
    }
    if (rd.company > 0) {
      rd.company -= dt;
      const closing = clamp((rd.wantRel - rel) * 0.4, -9, 9);
      rd.speed = damp(rd.speed, st.v + closing, 1.8, dt);
    }

    rd.s += rd.speed * dt;
    rel = rd.s - st.s;
    if (rel < -220 || rel > 700 || rd.life > 260) {
      rd.active = false;
      rd.next = 220 + this.rnd() * 420;
      rd.obj.visible = false;
      if (this.sounds) this.sounds.rider.set(0, 90);
      return;
    }

    // drifts between the lanes the way a bored rider does; tucks alongside you
    // once you are travelling together
    const beside = st.lat < 3.3 ? 5.1 : 1.7;
    const base = rd.company > 0 ? beside : 3.3;
    rd.latBase = damp(rd.latBase, base, 0.7, dt);
    rd.lat = rd.latBase + Math.sin(st.now * 0.21 + rd.phase) * (rd.company > 0 ? 0.3 : 1.4);
    this.road.point(rd.s, rd.lat, 0, this.tmp);
    const pose = this.road.poseAt(rd.s);
    rd.obj.position.copy(this.tmp);
    rd.obj.rotation.set(pose.pitch, -pose.h, 0, 'YXZ');
    rd.lean.rotation.z = clamp(this.road.curvature(rd.s) * rd.speed * rd.speed * 0.02, -0.6, 0.6);
    for (const w of rd.wheels) w.rotation.x += (rd.speed / 0.33) * dt;

    if (this.sounds) {
      const level = Math.pow(1 - clamp(Math.abs(rel) / 220, 0, 1), 2.4);
      this.sounds.rider.set(level, 46 + (rd.speed / 62) * 90);
    }
  }

  buildOverlook() {
    const rnd = this.rnd;
    const n = 2600;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      /* Denser in the middle and taller there too, so it reads as a city with
         a centre rather than an evenly scattered field of dots. */
      const r = Math.pow(rnd(), 0.75);
      pos[i * 3] = (rnd() - 0.5) * 2600 * (0.25 + r);
      pos[i * 3 + 1] = Math.pow(rnd(), 2.4) * 110 * (1.15 - r);
      pos[i * 3 + 2] = (rnd() - 0.5) * 1300 * (0.3 + r);
      const warm = rnd();
      const c = warm > 0.88 ? [0.55, 0.78, 1.0] : warm > 0.6 ? [1.0, 0.86, 0.62] : [1.0, 0.68, 0.32];
      col.set(c, i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));

    const group = new THREE.Group();
    const pts = new THREE.Points(g, new THREE.PointsMaterial({
      size: 2.6, sizeAttenuation: false, vertexColors: true,
      transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, toneMapped: false,
    }));
    pts.frustumCulled = false;
    group.add(pts);

    // the dome of light over it — from this far out, this is what you see first
    const dome = this.a.glowSprite(0xff9a4a, 1500, 0.3);
    dome.position.set(0, 40, 0);
    dome.scale.set(2600, 620, 1);
    group.add(dome);

    group.visible = false;
    this.scene.add(group);
    this.overlook.obj = group;
    this.overlook.pts = pts;
    this.overlook.dome = dome;
    this.overlook.opacity = 0;
  }

  /**
   * The payoff at the end of a long haul: the next city, still kilometres off
   * and well below the road, laid out as a field of lights before you drop
   * into it. It fades out as you close in and the real thing takes over.
   */
  updateOverlook(dt, st) {
    const o = this.overlook;
    const dist = this.road.distanceTo(BIOME.CITY, st.s, 2800);
    const show = dist < 2600 && dist > 450 && st.remote > 0.18;
    if (show && !o.obj) this.buildOverlook();
    if (!o.obj) return;

    const want = show ? smoothstep(450, 1400, dist) * smoothstep(0.18, 0.5, st.remote) : 0;
    o.opacity = damp(o.opacity, want, 1.1, dt);
    o.pts.material.opacity = o.opacity * 0.55;
    o.dome.material.opacity = o.opacity * 0.1;
    o.obj.visible = o.opacity > 0.008;
    if (o.obj.visible && Number.isFinite(dist)) {
      // ahead and below: you come over a rise and the whole place is laid out
      this.road.point(st.s + dist + 250, 0, -60, this.tmp);
      o.obj.position.copy(this.tmp);
      o.obj.rotation.y = -this.road.poseAt(st.s + dist).h;
    }
  }

  updateStorm(dt, st) {
    const sm = this.storm;
    if (st.rain < 0.35) {
      sm.active = false;
      return;
    }
    if (!sm.active) {
      sm.next -= dt;
      if (sm.next <= 0) {
        sm.active = true;
        sm.until = st.now + 45 + this.rnd() * 70;
        sm.strikeAt = st.now + this.rnd() * 8;
      }
      return;
    }
    if (st.now > sm.until) {
      sm.active = false;
      sm.next = 180 + this.rnd() * 360;
      return;
    }
    if (st.now >= sm.strikeAt) {
      this.strike(st.now);
      sm.strikeAt = st.now + 7 + this.rnd() * 16;
    }
    if (sm.reflash > 0 && st.now >= sm.reflash) {
      sm.reflash = -1;
      this.flash = Math.max(this.flash, 0.55);
    }
  }

  strike(now) {
    this.seen.lightning++;
    this.flash = 1;
    this.storm.reflash = now + 0.07 + this.rnd() * 0.1;   // real lightning flickers
    this.thunder.push(now + 1.4 + this.rnd() * 5.5);
  }

  /** @returns the lightning flash level for this frame, 0..1 */
  update(dt, st) {
    if (st.audio && !this.sounds) {
      this.sounds = {
        train: new TrainSound(st.audio),
        sky: new TrainSound(st.audio),      // the same rumble, for a low pass
        rider: new RiderSound(st.audio),
      };
    }

    this.updatePlane(dt, st);
    this.updateTrain(dt, st);
    this.updateRider(dt, st);
    this.updateOverlook(dt, st);
    this.updateWorks(dt, st);
    this.updateBroken(dt, st);
    this.updateStorm(dt, st);

    this.flash = Math.max(0, this.flash - dt * 3.2);
    while (this.thunder.length && this.thunder[0] <= st.now) {
      this.thunder.shift();
      if (st.audio) st.audio.thunder();
    }
    return this.flash;
  }

  /** Long rides shift the world back to the origin; anything holding world
      coordinates has to come along. */
  rebase(offset) {
    if (this.works.obj) this.works.obj.position.sub(offset);
    if (this.broken.obj) this.broken.obj.position.sub(offset);
    if (this.plane.group) {
      this.plane.group.position.sub(offset);
      this.plane.from.sub(offset);
      this.plane.to.sub(offset);
    }
    // the train and the rider are re-placed from road distances every frame
  }
}
