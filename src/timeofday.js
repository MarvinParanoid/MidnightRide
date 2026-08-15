import * as THREE from 'three';
import { lerp, clamp, smoothstep } from './geo.js';

/**
 * The ride is always at night — but *which* night depends on the clock on your
 * wall. Evening hours look like evening, 3am looks like 3am, and if you launch
 * at noon the world folds the daytime hours into the small hours instead of
 * refusing to be Midnight Ride.
 */
export function nightHourFromLocal(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  if (h >= 18) return h;            // 18:00 → 24:00
  if (h < 6) return h + 24;         // 00:00 → 06:00 becomes 24 → 30
  return 21 + ((h - 6) / 12) * 6;   // daylight is compressed into 21:00 → 03:00
}

const KEYS = [
  // t is "hours since 18:00", so 25 = 01:00, 30 = 06:00
  { t: 18.0, top: 0x0a1030, bot: 0x412454, glow: 0xe0663f, fog: 0x241a3a, dens: 0.0052, amb: 0.34, moon: 0.25, stars: 0.15, city: 0.55 },
  { t: 20.0, top: 0x05081c, bot: 0x171438, glow: 0xd4436b, fog: 0x121028, dens: 0.0060, amb: 0.24, moon: 0.45, stars: 0.55, city: 0.9 },
  { t: 22.0, top: 0x03040e, bot: 0x0a0c20, glow: 0x3a2f6e, fog: 0x080a18, dens: 0.0066, amb: 0.18, moon: 0.7, stars: 0.9, city: 1.0 },
  { t: 25.0, top: 0x01020a, bot: 0x050714, glow: 0x1b1f45, fog: 0x04050e, dens: 0.0072, amb: 0.13, moon: 0.85, stars: 1.0, city: 0.75 },
  { t: 28.0, top: 0x02040f, bot: 0x0a1026, glow: 0x27356c, fog: 0x070a18, dens: 0.0068, amb: 0.16, moon: 0.6, stars: 0.8, city: 0.5 },
  { t: 29.3, top: 0x08143a, bot: 0x2b3566, glow: 0xff9a5c, fog: 0x141a34, dens: 0.0056, amb: 0.30, moon: 0.3, stars: 0.25, city: 0.35 },
  { t: 30.0, top: 0x14265a, bot: 0x53587e, glow: 0xffb884, fog: 0x2a2f4a, dens: 0.0046, amb: 0.46, moon: 0.15, stars: 0.0, city: 0.25 },
];

const cTop = new THREE.Color();
const cBot = new THREE.Color();
const cGlow = new THREE.Color();
const cFog = new THREE.Color();
const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

export function palette(nightHour) {
  const t = clamp(nightHour, KEYS[0].t, KEYS[KEYS.length - 1].t);
  let i = 0;
  while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const k = clamp((t - a.t) / (b.t - a.t), 0, 1);
  const mix = (out, x, y) => out.copy(tmpA.setHex(x)).lerp(tmpB.setHex(y), k);

  return {
    top: mix(cTop, a.top, b.top),
    bottom: mix(cBot, a.bot, b.bot),
    glow: mix(cGlow, a.glow, b.glow),
    fog: mix(cFog, a.fog, b.fog),
    density: lerp(a.dens, b.dens, k),
    ambient: lerp(a.amb, b.amb, k),
    moon: lerp(a.moon, b.moon, k),
    stars: lerp(a.stars, b.stars, k),
    cityGlow: lerp(a.city, b.city, k),
  };
}

/** "Berlin" out of "Europe/Berlin" — a free sense of place, no network needed. */
export function placeName() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const leaf = tz.split('/').pop() || 'Nowhere';
    return leaf.replace(/_/g, ' ');
  } catch {
    return 'Nowhere';
  }
}

const CONDITIONS = [
  { name: 'Light Rain', rain: 0.45, fogMul: 1.05 },
  { name: 'Rain', rain: 0.85, fogMul: 1.18 },
  { name: 'Heavy Rain', rain: 1.0, fogMul: 1.3 },
  { name: 'Drizzle', rain: 0.25, fogMul: 1.0 },
  { name: 'Overcast', rain: 0.0, fogMul: 0.95 },
  { name: 'Clear', rain: 0.0, fogMul: 0.8 },
  { name: 'Mist', rain: 0.1, fogMul: 1.6 },
];

/**
 * Weather for tonight. Deterministic per calendar day, so the sky doesn't
 * reshuffle every reload — and shaped so it rains more often than not,
 * because wet asphalt is the whole point.
 */
export function weatherForToday(date = new Date()) {
  const day = Math.floor(date.getTime() / 86400000);
  let x = Math.sin(day * 12.9898) * 43758.5453;
  x = x - Math.floor(x);
  const weights = [0.24, 0.18, 0.08, 0.14, 0.16, 0.12, 0.08];
  let acc = 0, pick = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (x < acc) { pick = i; break; }
    pick = i;
  }
  let y = Math.sin(day * 78.233) * 24634.6345;
  y = y - Math.floor(y);
  return { ...CONDITIONS[pick], temp: Math.round(2 + y * 16), phase: x * 6.283 + y * 2.7 };
}

/**
 * Weather that arrives and leaves, instead of weather that was decided once.
 *
 * The condition above is still tonight's character — a Heavy Rain night is wet
 * about seven tenths of the way and a Clear one catches one shower in twenty
 * five kilometres, and it pours on the first where it spits on the last — but it is
 * now a description of the whole ride rather than a constant applied to every
 * metre of it. Showers pass; the road dries between them and the reflections go
 * with it, which is the only way the wet road reads as weather rather than as a
 * setting.
 *
 * Driven by distance, not by the clock. Two reasons. The road is what you are
 * moving through, so a front you ride into belongs to a place; and every test
 * in this project pins the clock and teleports to a fixed distance, so a
 * function of `s` is reproducible where a function of elapsed time is at the
 * mercy of how many frames a machine happened to render.
 */
export function rainAt(s, w) {
  /* Three waves that do not share a period, so the pattern does not repeat
     inside a ride. The longest is about six kilometres — three or four minutes
     at open-road speed, which is how long a shower takes to pass over you. */
  const x = s / 6000 + w.phase;
  const drift = 0.5 + 0.5 * (
    Math.sin(x * 6.283) * 0.55 +
    Math.sin(x * 2.31 + 1.7) * 0.3 +
    Math.sin(x * 0.79 + 4.1) * 0.15);

  /* How much of tonight is wet, and how hard it comes down when it is. A clear
     night still gets the occasional passing drizzle — that is the variety the
     whole thing is for — it just does not get a downpour.
     The ceiling matters as much as the floor. Scaling this straight up to the
     condition's own figure measured as 95% of a Rain night and 100% of a Heavy
     Rain one spent under water: on two thirds of nights the weather would never
     have turned at all, which is the thing being fixed. Even the wettest night
     gets its breaks now — a downpour that lets up for a mile and comes back is
     more weather than a downpour that never stops.
     The coefficient is calibrated against the measured result rather than set
     to the fraction wanted: three summed sines pile up around their midpoint,
     so a threshold placed at 0.70 does not give a road that is wet seven tenths
     of the time, it gives one that is wet nine tenths of it. */
  const wetFraction = 0.05 + w.rain * 0.48;
  /* A wide ramp, so a front takes a while to arrive and the shower swells
     rather than switching on at full strength. */
  const shower = smoothstep(1 - wetFraction - 0.16, 1 - wetFraction + 0.16, drift);
  return clamp(shower * Math.max(w.rain, 0.32), 0, 1);
}
