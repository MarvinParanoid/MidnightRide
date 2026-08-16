import * as THREE from 'three';
import { assets, neon } from './assets.js';
import { mulberry32, clamp, damp, MeshBuilder } from './geo.js';
import { BIOME, VIEW_DIST } from './constants.js';

const CAR_PAINT = [0x101218, 0x1a1c22, 0x0d1420, 0x201418, 0x141a18];

/**
 * Wheels, plate and reflectors merged into one geometry per kind, so all the
 * new detail costs three draw calls per car rather than a dozen.
 */
function carDetail(g, kind) {
  const half = g.len / 2;
  const axles = kind === 'truck' ? [-half + 1.6, half - 5.2, half - 3.4, half - 1.6]
    : [-half + 1.1, half - 1.1];
  const track = kind === 'truck' ? 1.12 : 0.82;
  const r = kind === 'truck' ? 0.46 : 0.34;

  const wheels = new MeshBuilder();
  for (const z of axles) {
    for (const dx of [-track, track]) {
      // a short faceted cylinder lying on its side reads as a tyre at night
      for (let i = 0; i < 8; i++) {
        const a0 = (i / 8) * Math.PI * 2;
        const a1 = ((i + 1) / 8) * Math.PI * 2;
        const y0 = r + Math.sin(a0) * r, z0 = z + Math.cos(a0) * r;
        const y1 = r + Math.sin(a1) * r, z1 = z + Math.cos(a1) * r;
        wheels.quad(
          { x: dx - 0.14, y: y0, z: z0 }, { x: dx + 0.14, y: y0, z: z0 },
          { x: dx + 0.14, y: y1, z: z1 }, { x: dx - 0.14, y: y1, z: z1 }
        );
      }
    }
  }

  const plate = new MeshBuilder();
  plate.box(0, 0.5, half + 0.03, 0.42, 0.11, 0.02, 0);

  const reflectors = new MeshBuilder();
  for (const dx of [-track * 0.9, track * 0.9]) {
    reflectors.box(dx, 0.42, half + 0.02, 0.16, 0.09, 0.02, 0);
  }

  return { wheels: wheels.build(), plate: plate.build(), reflectors: reflectors.build() };
}

/**
 * Where the lamps go on each kind.
 *
 * They used to be fixed numbers — 0.72 across, and a height measured from the
 * centre of the body. That is fine on a saloon and absurd on a lorry: a body
 * three metres tall put its headlights 1.9 m up and 1.4 m apart, halfway up the
 * front of a twelve-metre box. Lamps belong at a lamp's height and out near the
 * corners, and a lorry's are on the cab, which sticks out ahead of the trailer.
 */
const LAMPS = {
  sedan: { y: 0.62, x: 0.66, front: 0, marker: 0 },
  van: { y: 0.74, x: 0.78, front: 0, marker: 0 },
  truck: { y: 0.95, x: 1.02, front: 0.6, marker: 2.9 },
};

/** Shared geometry — every car on the road is one of these three. */
function carGeometries() {
  return {
    sedan: { body: new THREE.BoxGeometry(1.86, 0.62, 4.4), cabin: new THREE.BoxGeometry(1.66, 0.56, 2.2), cabinY: 0.56, cabinZ: 0.2, len: 4.4, half: 0.93 },
    van: { body: new THREE.BoxGeometry(2.0, 1.5, 5.4), cabin: new THREE.BoxGeometry(1.9, 0.5, 1.6), cabinY: 0.95, cabinZ: -1.6, len: 5.4, half: 1.0 },
    truck: { body: new THREE.BoxGeometry(2.5, 3.1, 12.5), cabin: new THREE.BoxGeometry(2.4, 1.6, 2.4), cabinY: 0.4, cabinZ: -5.6, len: 12.5, half: 1.25 },
  };
}

let GEOS = null;
let DETAIL = null;
const WHEEL_MAT = new THREE.MeshStandardMaterial({ color: 0x07080b, roughness: 0.92, metalness: 0.1 });
/* A plate lamp is a 5-watt bulb behind a piece of plastic. Anything near the
   bloom threshold turns it into a second headlight pointed at you. */
const PLATE_MAT = new THREE.MeshBasicMaterial({ color: neon(0xd6c9a6, 0.34), toneMapped: false });
const REFLECT_MAT = new THREE.MeshBasicMaterial({ color: neon(0xff2418, 0.85), toneMapped: false });

export class Traffic {
  /**
   * @param courtesy  whether a car moves over when you come level with it.
   *
   * This is the one thing the traffic does that is a game rule rather than a
   * fact about traffic, and it belongs to whoever is asking. Midnight Ride
   * wants it: nothing there may end a ride, so a car you are about to occupy
   * the same space as politely filters aside and you slip past. Midnight
   * Redline must not have it — you are aiming at a gap, and a gap that widens
   * itself the moment you commit is not a gap you threaded, it is a gap you
   * were given.
   *
   * A property set once at construction rather than a flag consulted all over:
   * the difference between the two games is stated in one place, in the line
   * that builds their world.
   */
  constructor(scene, road, { courtesy = true } = {}) {
    this.courtesy = courtesy;
    this.road = road;
    this.group = new THREE.Group();
    scene.add(this.group);
    GEOS ||= carGeometries();
    DETAIL ||= Object.fromEntries(Object.entries(GEOS).map(([k, g]) => [k, carDetail(g, k)]));
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
    /* A saloon is polished metal; a trailer is a painted box or a curtain, and
       giving it the same finish made a two-and-a-half metre flat wall act as a
       mirror — your headlight came back off it as a white rectangle that filled
       the road ahead. Finish belongs to the kind of vehicle. */
    const FINISH = {
      sedan: { roughness: 0.24, metalness: 0.85 },
      van: { roughness: 0.45, metalness: 0.5 },
      truck: { roughness: 0.72, metalness: 0.15 },
    }[kind];
    const paint = new THREE.MeshStandardMaterial({
      color: CAR_PAINT[(rnd() * CAR_PAINT.length) | 0],
      ...FINISH,
    });
    const body = new THREE.Mesh(g.body, paint);
    body.position.y = g.body.parameters.height / 2 + 0.32;
    const cabin = new THREE.Mesh(g.cabin, paint);
    cabin.position.set(0, body.position.y + g.cabinY, g.cabinZ);
    group.add(body, cabin);

    const halfLen = g.len / 2;
    const d = DETAIL[kind];
    const wheels = new THREE.Mesh(d.wheels, WHEEL_MAT);
    const plate = new THREE.Mesh(d.plate, PLATE_MAT);         // the plate lamp, always on
    const reflectors = new THREE.Mesh(d.reflectors, REFLECT_MAT); // catches your headlight
    wheels.name = 'wheels'; plate.name = 'plate'; reflectors.name = 'reflectors';
    group.add(wheels, plate, reflectors);

    /* Someone is in there: a dashboard, seen through the back window. It has to
       sit just *outside* the rear face of the cabin — anywhere inside and the
       opaque roof occludes it entirely, which measured as exactly zero pixels.
       Only the sedan has a rear window to see it through: the van's "cabin" is
       a roof pod and the truck's is 5 m up the road, facing away. */
    let cabinGlow = null;
    if (kind === 'sedan') {
      cabinGlow = a.glowSprite(0x4a7ad8, 0.7, 0.3);
      cabinGlow.name = 'cabinGlow';
      cabinGlow.position.set(
        0,
        body.position.y + g.cabinY,
        g.cabinZ + g.cabin.parameters.depth / 2 + 0.05
      );
      group.add(cabinGlow);
    }

    const glows = [];   // faded out at point-blank range so a close pass doesn't white out the screen

    const L = LAMPS[kind];

    /* tail lamps */
    const tailMat = new THREE.MeshBasicMaterial({ color: neon(0xff1428, 2.6), toneMapped: false });
    /* A dim strip joining them, which is what makes a vehicle read as one thing
       rather than as two lights.
       Measured at three hundred kilometres an hour: at eighty and a hundred and
       twenty metres two lorries with a gap between them are perfectly legible,
       and by a hundred and sixty they are not — not because the lights merge or
       the night is too dark, but because four red dots in a row have two kinds
       of space between them and no way to tell which is which. A lorry's own
       left-to-right spacing looks exactly like the gap you could ride through.
       Joining a vehicle's own lights closes that ambiguity by construction: the
       vehicle is a continuous mark, so every dark gap is a gap between two of
       them. Real cars have worn a bar across the tailgate for years, so it
       costs nothing in plausibility either.
       What it buys, measured: legibility out from a hundred and twenty metres
       to a hundred and sixty, which at three hundred kilometres an hour is one
       and nine tenths of a second of warning instead of one and a half. What it
       does not buy is two hundred and twenty — and brightening the strip with
       distance to try for it was tried and reverted, because at that size the
       vehicle is eleven pixels of bloom with no shape left to make continuous.
       A hundred and sixty metres is what this geometry gives; reading further
       than that would take a narrower field of view, not a brighter light. */
    const barMat = new THREE.MeshBasicMaterial({ color: neon(0xff1428, 0.5), toneMapped: false });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(L.x * 2, 0.07, 0.05), barMat);
    bar.position.set(0, L.y, halfLen - 0.005);
    group.add(bar);
    for (const dx of [-L.x, L.x]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.06), tailMat);
      t.position.set(dx, L.y, halfLen);
      group.add(t);
      const s = a.glowSprite(0xff1428, 1.5, 0.6);
      s.position.copy(t.position);
      group.add(s);
      glows.push(s);
    }

    /* head lamps — on the cab, which on a lorry is ahead of the trailer */
    for (const dx of [-L.x, L.x]) {
      const s = a.glowSprite(0xfff0d4, 2.6, 0.95);
      s.position.set(dx, L.y, -halfLen - L.front);
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
    cone.position.set(0, L.y, -halfLen - L.front);
    group.add(cone);

    /* Outline lamps: at night a row of little points along the top is most of
       what tells you the thing ahead is enormous. Red facing back, amber on the
       cab roof — the way a lorry is actually lit, and the way you read one. */
    if (L.marker > 0) {
      const back = new THREE.MeshBasicMaterial({ color: neon(0xff2418, 2.0), toneMapped: false });
      const front = new THREE.MeshBasicMaterial({ color: neon(0xffa02a, 2.2), toneMapped: false });
      for (let i = -2; i <= 2; i++) {
        const q = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.06), back);
        q.position.set(i * 0.5, L.marker, halfLen - 0.05);
        group.add(q);
      }
      for (const dx of [-0.85, -0.3, 0.3, 0.85]) {
        const q = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.09, 0.06), front);
        q.position.set(dx, body.position.y + g.cabinY + 0.85, g.cabinZ - 1.1);
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

    /* indicators, so a car pulling over says so first */
    const blinkers = { left: [], right: [] };
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.1, 0.05),
        new THREE.MeshBasicMaterial({ color: neon(0xffa01e, 2.4), toneMapped: false })
      );
      m.position.set(side * L.x * 1.25, L.y + 0.02, halfLen - 0.02);
      m.visible = false;
      group.add(m);
      blinkers[side < 0 ? 'left' : 'right'].push(m);
    }

    this.group.add(group);
    /* `half` is the body's own half-width. Anything that needs to know
       whether two things touched needs the real number, not a margin
       tuned for something else. */
    return { group, kind, len: g.len, half: g.half, glows, tailMat, barMat, blinkers, prevSpeed: 0 };
  }

  /**
   * Put a car on the road wherever a caller asks for one.
   *
   * `pinned` is the part the game never uses: a pinned car does not drive, does
   * not follow the one in front and does not move over for you. It exists so a
   * known arrangement can be put in front of the camera and measured — two
   * lorries a hundred and twenty metres out with a gap between them — which is
   * impossible while the traffic system owns every position. The first attempt
   * to measure how a gap reads at three hundred kilometres an hour photographed
   * an empty road, because the cars had been driven off before the shutter
   * opened.
   */
  place({ s, dir = 1, kind = 'sedan', lat = 1.75, speed = null, pinned = false }) {
    const car = this.obtain(kind);
    car.dir = dir;
    car.lat = dir > 0 ? lat : -lat;
    car.targetLat = car.lat;
    car.speed = speed !== null ? speed
      : kind === 'truck' ? 20 + this.rnd() * 5 : 24 + this.rnd() * 14;
    car.cruise = car.speed;
    car.s = s;
    car.passed = false;
    car.pinned = pinned;
    this.cars.push(car);
    return car;
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
    this.blinkT = (this.blinkT || 0) + dt;
    const want = this.targetCount(this.road.biomeAt(sBike), this.road.remotenessAt(sBike));

    /* Cars used to drive straight through each other: nothing looked ahead, so
       a fast one simply overlapped a slow one and kept going. Each now follows
       whatever is in front of it in its own lane and eases back up to its
       cruising speed when the road clears. */
    for (const car of this.cars) {
      if (car.pinned) continue;      // a pinned car is furniture, not traffic
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
      if (!car.pinned) car.s += car.dir * car.speed * dt;
      const rel = car.s - sBike;

      if (rel > VIEW_DIST + 40 || rel < -110) {
        this.release(car);
        this.cars.splice(i, 1);
        continue;
      }

      /* there is no crashing in this game — traffic just courteously moves over */
      if (this.courtesy && !car.pinned && car.dir > 0 && rel > 0 && rel < 42
          && Math.abs(car.lat - latBike) < 2.6) {
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

      /* brake lights, now that cars actually slow down for each other */
      const braking = car.prevSpeed - car.speed > 0.35 * dt * 60;
      car.prevSpeed = car.speed;
      car.tailMat.color.copy(neon(0xff1428, braking ? 6 : 2.6));
      car.barMat.color.copy(neon(0xff1428, braking ? 1.5 : 0.5));

      /* And indicators while they are moving across. The lamps live in the car's
         own frame, and an oncoming car's group is turned around — so the road-space
         direction has to be flipped back through car.dir or it signals the wrong way. */
      const moving = (car.targetLat - car.lat) * car.dir;
      const side = Math.abs(moving) > 0.25 ? (moving > 0 ? 'right' : 'left') : null;
      const lit = side && (this.blinkT % 0.66) < 0.36;
      for (const key of ['left', 'right']) {
        for (const m of car.blinkers[key]) m.visible = !!lit && side === key;
      }

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
