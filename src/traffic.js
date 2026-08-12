import * as THREE from 'three';
import { assets, neon } from './assets.js';
import { mulberry32, clamp, damp } from './geo.js';
import { BIOME, VIEW_DIST } from './constants.js';

const CAR_PAINT = [0x101218, 0x1a1c22, 0x0d1420, 0x201418, 0x141a18];

/** Shared geometry — every car on the road is one of these three. */
function carGeometries() {
  return {
    sedan: { body: new THREE.BoxGeometry(1.86, 0.62, 4.4), cabin: new THREE.BoxGeometry(1.66, 0.56, 2.2), cabinY: 0.56, cabinZ: 0.2, len: 4.4 },
    van: { body: new THREE.BoxGeometry(2.0, 1.5, 5.4), cabin: new THREE.BoxGeometry(1.9, 0.5, 1.6), cabinY: 0.95, cabinZ: -1.6, len: 5.4 },
    truck: { body: new THREE.BoxGeometry(2.5, 3.1, 12.5), cabin: new THREE.BoxGeometry(2.4, 1.6, 2.4), cabinY: 0.4, cabinZ: -5.6, len: 12.5 },
  };
}

let GEOS = null;

export class Traffic {
  constructor(scene, road) {
    this.road = road;
    this.group = new THREE.Group();
    scene.add(this.group);
    GEOS ||= carGeometries();
    this.rnd = mulberry32(4242);
    this.cars = [];
    this.pool = { sedan: [], van: [], truck: [] };
    this.onPass = null;
    this.a = assets();
  }

  /** Cars are pooled: at these distances they are only ever off-screen, never gone. */
  obtain(kind) {
    const car = this.pool[kind].pop();
    if (car) {
      car.group.visible = true;
      return car;
    }
    return this.makeCar(kind);
  }

  release(car) {
    car.group.visible = false;
    this.pool[car.kind].push(car);
  }

  makeCar(kind) {
    const a = this.a;
    const g = GEOS[kind];
    const rnd = this.rnd;
    const group = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({
      color: CAR_PAINT[(rnd() * CAR_PAINT.length) | 0],
      roughness: 0.24,
      metalness: 0.85,
    });
    const body = new THREE.Mesh(g.body, paint);
    body.position.y = g.body.parameters.height / 2 + 0.32;
    const cabin = new THREE.Mesh(g.cabin, paint);
    cabin.position.set(0, body.position.y + g.cabinY, g.cabinZ);
    group.add(body, cabin);

    const halfLen = g.len / 2;
    const glows = [];   // faded out at point-blank range so a close pass doesn't white out the screen

    /* tail lamps */
    const tailMat = new THREE.MeshBasicMaterial({ color: neon(0xff1428, 2.6), toneMapped: false });
    for (const dx of [-0.72, 0.72]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.06), tailMat);
      t.position.set(dx, body.position.y + 0.12, halfLen);
      group.add(t);
      const s = a.glowSprite(0xff1428, 1.5, 0.6);
      s.position.copy(t.position);
      group.add(s);
      glows.push(s);
    }

    /* head lamps */
    for (const dx of [-0.68, 0.68]) {
      const s = a.glowSprite(0xfff0d4, 2.6, 0.95);
      s.position.set(dx, body.position.y + 0.05, -halfLen);
      group.add(s);
      glows.push(s);
    }
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(3.4, 30, 12, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xfff0d4,
        transparent: true,
        opacity: 0.035,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
        toneMapped: false,
      })
    );
    cone.geometry.rotateX(Math.PI / 2);
    cone.geometry.translate(0, 0, -15);
    cone.position.set(0, body.position.y, -halfLen);
    group.add(cone);

    /* truck marker lights */
    if (kind === 'truck') {
      const m = new THREE.MeshBasicMaterial({ color: neon(0xffa02a, 2.2), toneMapped: false });
      for (let i = -2; i <= 2; i++) {
        const q = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.06), m);
        q.position.set(i * 0.5, 3.5, halfLen - 0.05);
        group.add(q);
      }
    }

    /* wet-road smear under the tail lamps */
    const smear = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 12),
      new THREE.MeshBasicMaterial({
        map: a.tex.streak,
        color: neon(0xff1428, 0.8),
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      })
    );
    smear.rotation.x = -Math.PI / 2;
    smear.position.set(0, 0.03, halfLen + 6);
    group.add(smear);

    /* contact shadow */
    const shade = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, g.len * 1.3),
      new THREE.MeshBasicMaterial({
        map: a.tex.glow,
        color: 0x000000,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        fog: false,
      })
    );
    shade.rotation.x = -Math.PI / 2;
    shade.position.y = 0.02;
    group.add(shade);

    glows.push(cone, smear);
    for (const o of glows) o.userData.baseOpacity = o.material.opacity;

    this.group.add(group);
    return { group, kind, len: g.len, glows };
  }

  spawn(sBike, dir) {
    const rnd = this.rnd;
    const kind = rnd() < 0.14 ? 'truck' : rnd() < 0.28 ? 'van' : 'sedan';
    const car = this.obtain(kind);
    car.dir = dir;
    const lane = rnd() < 0.5 ? 1.75 : 5.0;
    car.lat = dir > 0 ? lane : -lane;
    car.targetLat = car.lat;
    car.speed = kind === 'truck' ? 20 + rnd() * 5 : 24 + rnd() * 14;
    car.cruise = car.speed;      // what it goes back to once the road clears
    car.s = dir > 0
      ? sBike + 60 + rnd() * (VIEW_DIST - 120)
      : sBike + VIEW_DIST * (0.5 + rnd() * 0.5);
    car.passed = false;
    this.cars.push(car);
    return car;
  }

  /** How busy the road feels, by biome — and by how far from anywhere it is. */
  targetCount(biome, remote = 0) {
    let n;
    switch (biome) {
      case BIOME.CITY: n = 7; break;
      case BIOME.TUNNEL: n = 4; break;
      case BIOME.GAS: n = 3; break;
      case BIOME.FOREST: n = 2; break;
      case BIOME.BRIDGE: n = 3; break;
      case BIOME.COAST: n = 3; break;
      default: n = 4;
    }
    // deep in a long haul a single pair of tail lights becomes an event
    return Math.max(0, Math.round(n * (1 - remote * 0.82)));
  }

  update(dt, sBike, latBike, speedBike) {
    const want = this.targetCount(this.road.biomeAt(sBike), this.road.remotenessAt(sBike));

    /* Cars used to drive straight through each other: nothing looked ahead, so
       a fast one simply overlapped a slow one and kept going. Each now follows
       whatever is in front of it in its own lane and eases back up to its
       cruising speed when the road clears. */
    for (const car of this.cars) {
      let lead = null;
      for (const other of this.cars) {
        if (other === car || other.dir !== car.dir) continue;
        const gap = (other.s - car.s) * car.dir;
        if (gap <= 0 || gap > 70) continue;
        if (Math.abs(other.lat - car.lat) > 2.2) continue;
        if (!lead || gap < lead.gap) lead = { gap, speed: other.speed, len: other.len };
      }
      if (lead && lead.gap < (lead.len + car.len) / 2 + 10) {
        car.speed = damp(car.speed, Math.min(car.speed, lead.speed * 0.94), 2.2, dt);
      } else {
        car.speed = damp(car.speed, car.cruise, 0.5, dt);
      }
    }

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const car = this.cars[i];
      car.s += car.dir * car.speed * dt;
      const rel = car.s - sBike;

      if (rel > VIEW_DIST + 40 || rel < -110) {
        this.release(car);
        this.cars.splice(i, 1);
        continue;
      }

      /* there is no crashing in this game — traffic just courteously moves over */
      if (car.dir > 0 && rel > 0 && rel < 42 && Math.abs(car.lat - latBike) < 2.6) {
        car.targetLat = latBike > 0 ? 5.0 : 1.75;
        if (Math.abs(car.targetLat - latBike) < 2.6) car.targetLat = latBike > 3 ? 1.75 : 5.0;
      }
      car.lat += (car.targetLat - car.lat) * Math.min(1, dt * 1.4);

      const p = this.road.poseAt(car.s);
      car.group.position.set(
        p.x + Math.cos(p.h) * car.lat,
        p.y,
        p.z + Math.sin(p.h) * car.lat
      );
      car.group.rotation.y = -p.h + (car.dir > 0 ? 0 : Math.PI);

      const near = clamp((Math.abs(rel) - car.len * 0.5) / 12, 0, 1);
      for (const o of car.glows) o.material.opacity = o.userData.baseOpacity * near;

      if (!car.passed && car.dir < 0 && rel < 6) {
        car.passed = true;
        if (this.onPass) this.onPass(clamp((speedBike + car.speed) / 90, 0.2, 1.4), car.kind);
      }
    }

    if (this.cars.length < want && this.rnd() < 0.5) {
      this.spawn(sBike, this.rnd() < 0.45 ? 1 : -1);
    }
    // no rebase hook: every car is re-placed from its road distance each frame
  }
}
