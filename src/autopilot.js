import { clamp, damp } from './geo.js';
import { BIOME } from './constants.js';

const LANES = [1.75, 5.0];

/** Cruising speed for each kind of road, m/s. */
const CRUISE = {
  [BIOME.CITY]: 33,
  [BIOME.TUNNEL]: 37,
  [BIOME.HIGHWAY]: 52,
  [BIOME.FOREST]: 44,
  [BIOME.BRIDGE]: 45,
  [BIOME.GAS]: 36,
};

/**
 * Rides for you. Not a challenge to beat — the point is to be able to put the
 * phone down, or leave it running on a second monitor, and still have something
 * worth looking at.
 *
 * It reads the road the way a rider does: looks ahead for the next corner and
 * arrives at a speed the corner allows, holds a lane, pulls out for slower
 * traffic, and drifts its speed around a little so it never feels like a rail.
 */
export class Autopilot {
  constructor() {
    this.lane = 0;
    this.targetLat = LANES[0];
    this.laneTimer = 20;
    this.mood = 0;
    this.t = 0;
  }

  reset(state) {
    // adopt whatever lane the rider left us in, so engaging isn't a jolt
    this.lane = state.lat > (LANES[0] + LANES[1]) / 2 ? 1 : 0;
    this.targetLat = state.lat;
    this.laneTimer = 12 + Math.random() * 30;
    this.t = 0;
  }

  /** The fastest this corner will take, looking a couple of seconds ahead. */
  cornerLimit(road, s, v) {
    const look = clamp(v * 3.2, 60, 240);
    let k = 0;
    for (let d = 0; d <= look; d += 20) k = Math.max(k, Math.abs(road.curvature(s + d)));
    return Math.sqrt(4.6 / Math.max(k, 1e-5));
  }

  /** Nearest car ahead in a given lane, or null. */
  carAhead(traffic, s, lat, range = 110) {
    let best = null;
    for (const car of traffic.cars) {
      if (car.dir < 0) continue;
      const gap = car.s - s;
      if (gap < -8 || gap > range) continue;
      if (Math.abs(car.lat - lat) > 2.2) continue;
      if (!best || gap < best.gap) best = { gap, speed: car.speed };
    }
    return best;
  }

  laneIsClear(traffic, s, lat) {
    for (const car of traffic.cars) {
      if (car.dir < 0) continue;
      const gap = car.s - s;
      if (gap > -35 && gap < 90 && Math.abs(car.lat - lat) < 2.4) return false;
    }
    return true;
  }

  update(dt, state, road, traffic, opts) {
    this.t += dt;
    const v = state.v;
    const s = state.s;

    /* ── how fast ─────────────────────────────────────────── */
    const biome = road.biomeAt(s);
    let target = CRUISE[biome] ?? 45;
    target *= 1 + road.remotenessAt(s) * 0.14;      // nobody about, press on
    target *= 1 - (opts.rain || 0) * 0.13;
    target = Math.min(target, this.cornerLimit(road, s, v));
    // a slow wander so it never sits at exactly one number
    target *= 0.95 + 0.05 * Math.sin(this.t * 0.07) + 0.03 * Math.sin(this.t * 0.021);

    /* ── which lane ───────────────────────────────────────── */
    this.laneTimer -= dt;
    const ahead = this.carAhead(traffic, s, this.targetLat);
    const other = 1 - this.lane;

    if (ahead && ahead.gap < 60 && ahead.speed < v - 1.2) {
      if (this.laneIsClear(traffic, s, LANES[other])) {
        this.lane = other;
        this.laneTimer = 14 + Math.random() * 20;
      }
    } else if (this.laneTimer <= 0) {
      this.laneTimer = 25 + Math.random() * 45;
      if (this.laneIsClear(traffic, s, LANES[other]) && Math.random() < 0.5) this.lane = other;
    }

    this.targetLat = damp(this.targetLat, LANES[this.lane], 0.9, dt);
    const wander = Math.sin(this.t * 0.13) * 0.22;

    /* ── steering ─────────────────────────────────────────────
       drive() moves us by `steer * authority` and the corner pushes us out by
       `k * v² * 0.16`, so solve for the steer that produces the lateral speed
       we actually want. Anything less exact drifts wide on every bend.        */
    const authority = clamp(1.8 + v * 0.11, 1.8, 8.2);
    const drift = road.curvature(s) * v * v * 0.16;
    const err = this.targetLat + wander - state.lat;
    const wantLatVel = clamp(err * 1.15, -3.4, 3.4);
    const steer = clamp((wantLatVel + drift) / authority, -1, 1);

    /* ── throttle and brake ───────────────────────────────── */
    let throttle = 0;
    let brake = 0;
    const dv = target - v;
    if (dv > 0) throttle = clamp(dv * 0.32, 0, 1);
    else brake = clamp(-dv * 0.09, 0, 1);

    // don't drive into the back of anything
    if (ahead && ahead.gap < 34 && ahead.speed < v) {
      brake = Math.max(brake, clamp((34 - ahead.gap) / 22, 0, 1) * 0.8);
      throttle = 0;
    }

    return { throttle, brake, steer, boost: false };
  }
}
