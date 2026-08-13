import './style.css';
import * as THREE from 'three';

import { Road } from './road.js';
import { ROAD_HALF, SHOULDER, BIOME } from './constants.js';
import { Bike } from './bike.js';
import { Traffic } from './traffic.js';
import { Rain } from './rain.js';
import { Sky } from './sky.js';
import { Events } from './events.js';
import { createComposer, applyBloomScale } from './postfx.js';
import { Input, isTouchDevice } from './input.js';
import { Autopilot } from './autopilot.js';
import { detectQuality, QualityGuard, TIERS } from './quality.js';
import { PhotoMode } from './photo.js';
import { StreamMode, StreamPacer } from './stream.js';
import { Hud, formatClock } from './hud.js';
import { palette, nightHourFromLocal, placeName, weatherForToday } from './timeofday.js';
import { AudioCore } from './audio/core.js';
import { EngineSound } from './audio/engine.js';
import { Music } from './audio/music.js';
import { clamp, damp, smoothstep } from './geo.js';
import { assets } from './assets.js';
import { telemetry } from './telemetry.js';

/* ── renderer ──────────────────────────────────────────────── */
const canvas = document.getElementById('scene');
const quality = detectQuality();
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.info.autoReset = false;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x06070f, 0.0066);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.4, 5200);
camera.position.set(0, 3, 8);

const { composer, bloom, grade } = createComposer(renderer, scene, camera, quality);

/* ── world ─────────────────────────────────────────────────── */
const road = new Road(scene);
const bike = new Bike(scene);
const traffic = new Traffic(scene, road);
const rain = new Rain(scene, 5000);
rain.setDensity(quality.rain);
const sky = new Sky(scene);
sky.attachEnvironment(renderer, scene, quality.envEvery);
const hud = new Hud();
const input = new Input();
if (isTouchDevice) hud.setTouch(() => setAuto(!state.auto));
const a = assets();

const events = new Events(scene, road);

/* ── audio (created on the first click) ────────────────────── */
let audio = null;
let engine = null;
let music = null;

/* ── ride state ────────────────────────────────────────────── */
const state = {
  s: 0,               // distance along the road, metres
  lat: 1.9,           // lateral offset from the centreline
  v: 0,               // m/s
  throttle: 0,
  brake: 0,
  steer: 0,
  odo: 0,
  timeOffset: 0,      // hours added by the T key
  rainOverride: null,
  camMode: 0,
  photo: false,
  enclosure: 0,
  remote: 0,          // 0 in town, 1 deep in a long empty haul
  beat: 0,
  rain: 0,
  auto: false,        // autopilot has the controls
  lastInput: 0,
  autoCamT: 0,
};

const CAM_MODES = ['CHASE', 'CLOSE', 'CINEMATIC', 'FIRST PERSON'];
const weather = weatherForToday();
const place = placeName();
hud.setIntro(`${place} · ${weather.temp}°C · ${weather.name}`);

const photo = new PhotoMode({ camera, renderer, scene, composer, canvas });

/* ?stream=1 turns the game into a channel: autopilot only, gentler pace,
   the interface replaced by a station ident. */
const stream = new StreamMode();
const pacer = new StreamPacer();
if (stream.active) {
  hud.root.classList.add('off');
  state.auto = true;      // it really is on; keep the flag honest for telemetry
}

/* The only thing this game remembers about you: how far you have ridden.
   No levels, no unlocks — just a note that you have been here before. */
const ODO_KEY = 'midnightride.km';
let lifetimeKm = 0;
try {
  lifetimeKm = Number(localStorage.getItem(ODO_KEY)) || 0;
} catch { /* private mode, never mind */ }
hud.setReturning(lifetimeKm);
telemetry.set({
  returning: lifetimeKm > 1,
  device: isTouchDevice ? 'touch' : 'desktop',
  quality: quality.name,
});

function saveOdo() {
  try {
    localStorage.setItem(ODO_KEY, String(lifetimeKm + state.odo / 1000));
  } catch { /* ignore */ }
}
addEventListener('pagehide', saveOdo);
addEventListener('visibilitychange', () => { if (document.hidden) saveOdo(); });

const camPos = new THREE.Vector3(0, 3, 10);
const camLook = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const prevCamPos = new THREE.Vector3();
const camVel = new THREE.Vector3();
const headingVec = new THREE.Vector3(0, 0, -1);
const camLookPose = {};
const lampPos = new THREE.Vector3();

/** 1 when the beam should be at full strength, ~0 when the camera is staring
    down the barrel of the headlight from a few metres away. */
function beamFade(bikePos, heading) {
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  lampPos.set(bikePos.x + fx * 0.72, bikePos.y + 0.88, bikePos.z + fz * 0.72);
  const d = camera.position.distanceTo(lampPos);
  const ahead = ((camera.position.x - lampPos.x) * fx + (camera.position.z - lampPos.z) * fz) / Math.max(d, 1e-3);
  const inFront = clamp((ahead - 0.05) / 0.45, 0, 1);
  const near = 1 - smoothstep(6, 26, d);
  return 1 - inFront * near * 0.95;
}

/* ── autopilot ─────────────────────────────────────────────── */
const auto = new Autopilot();
const IDLE_BEFORE_AUTO = 25;      // seconds of hands off before it takes over

function setAuto(on) {
  if (state.auto === on) return;
  state.auto = on;
  if (on) {
    auto.reset(state);
    state.autoCamT = 30;
  }
  hud.setAuto(on);
  hud.toast(on ? 'AUTOPILOT' : 'MANUAL');
  state.lastInput = clock;
}

/**
 * One place decides who is driving. Any input from the rider takes the controls
 * back immediately; leave them alone for a while and it takes them again, which
 * turns the game into something you can just leave running.
 */
function controls(dt, now) {
  if (stream.active) {
    pacer.update(dt);
    state.autoCamT -= dt;
    if (state.autoCamT <= 0) {
      state.autoCamT = pacer.camHold;               // shorter holds while pressing on
      state.camMode = (state.camMode + 1) % CAM_MODES.length;
    }
    const out = auto.update(dt, state, road, traffic, { rain: state.rain, pace: pacer.scale, closedLane: events.closedLane });
    bike.signal = auto.signal;
    if (auto.wantFlash) { auto.wantFlash = false; bike.flash(1); }
    return out;
  }
  if (input.active) {
    state.lastInput = now;
    if (state.auto) setAuto(false);
  } else if (!state.auto && (running || attract) && now - state.lastInput > IDLE_BEFORE_AUTO) {
    setAuto(true);
  }

  if (state.auto) {
    // hands off, so the camera wanders too — this is the mode you leave running
    state.autoCamT -= dt;
    if (state.autoCamT <= 0) {
      state.autoCamT = 30 + Math.random() * 30;
      state.camMode = (state.camMode + 1) % CAM_MODES.length;
    }
    const out = auto.update(dt, state, road, traffic, { rain: state.rain, closedLane: events.closedLane });
    bike.signal = auto.signal;
    if (auto.wantFlash) { auto.wantFlash = false; bike.flash(1); }
    return out;
  }
  bike.signal = null;
  return { throttle: input.throttle, brake: clamp(input.brake, 0, 1), steer: input.steer, boost: input.boost };
}

/* ── controls ──────────────────────────────────────────────── */
input.on('KeyE', () => setAuto(!state.auto));
input.on('KeyL', () => {
  bike.highBeam = !bike.highBeam;
  hud.toast(bike.highBeam ? 'MAIN BEAM' : 'DIPPED');
});
input.on('KeyC', () => {
  state.camMode = (state.camMode + 1) % CAM_MODES.length;
  state.autoCamT = 45;          // don't yank a camera you just chose
  hud.toast(CAM_MODES[state.camMode]);
});
input.on('KeyF', () => {
  if (photo.active) {
    photo.exit();
    state.photo = false;
    hud.photo(false);
    hud.photoBar(false);
  } else {
    road.point(state.s, state.lat, 0, tmpA);
    photo.enter(tmpA, road.poseAt(state.s).h);
    telemetry.data.photo++;
    state.photo = true;
    hud.photo(true);
    hud.photoBar(true, photo.readout);
  }
});
input.on('KeyH', () => {
  if (!photo.active) return;
  photo.hideUi = !photo.hideUi;
  hud.photoBar(!photo.hideUi, photo.readout);
});
input.on('BracketLeft', () => photo.active && photo.nudge('focus', -1));
input.on('BracketRight', () => photo.active && photo.nudge('focus', 1));
input.on('Minus', () => photo.active && photo.nudge('aperture', -1));
input.on('Equal', () => photo.active && photo.nudge('aperture', 1));
input.on('Enter', () => { if (photo.active) photo.wantShot = true; });
input.on('KeyR', () => {
  const steps = [null, 0, 0.45, 1];
  const i = steps.indexOf(state.rainOverride);
  state.rainOverride = steps[(i + 1) % steps.length];
  hud.toast(state.rainOverride === null ? `WEATHER: ${weather.name}` : state.rainOverride === 0 ? 'RAIN OFF' : `RAIN ${Math.round(state.rainOverride * 100)}%`);
});
input.on('KeyM', () => {
  if (music) hud.toast(music.toggle() ? 'MUSIC ON' : 'MUSIC OFF');
});
input.on('KeyT', () => {
  state.timeOffset = (state.timeOffset + 1) % 24;
  hud.toast(`TIME +${state.timeOffset}h`);
});

/* ── attract ───────────────────────────────────────────────────
   Before anyone touches anything the world is already riding, on the long
   lens, behind the title. It costs nothing — the loop was rendering that
   frame anyway — and it means the first thing you see is the game itself
   rather than a colour.                                                     */
let attract = true;
state.auto = true;                 // silently: no toast, nobody is watching yet
state.camMode = 2;                 // cinematic, from the verge
state.autoCamT = 1e9;              // and it stays there: no cycling under the title
hud.setAuto(true);
hud.revealWorld(700);

/* ── start ─────────────────────────────────────────────────── */
let running = false;
async function begin() {
  if (running) return;
  running = true;
  attract = false;
  telemetry.started();
  hud.dismiss();
  state.odo = 0;                 // the attract lap isn't yours; don't bank it
  state.camMode = 0;             // hand back the riding camera
  state.autoCamT = 45;
  if (!isTouchDevice && !stream.active) setAuto(false);   // desktop starts in your hands
  audio = new AudioCore();
  engine = new EngineSound(audio);
  music = new Music(audio);
  music.onBeat = () => { state.beat = 1; };
  traffic.onPass = (i) => engine && engine.whoosh(i);
  await audio.start();
  hud.toast(`${place.toUpperCase()} · ${weather.name.toUpperCase()}`);
  state.lastInput = clock;   // the idle clock starts now
  // a phone should start by showing you the ride, not asking you to drive it
  if (isTouchDevice) setAuto(true);
}
document.addEventListener('pointerdown', begin, { once: true });
document.addEventListener('keydown', (e) => {
  if (!running && (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyW')) begin();
});

/**
 * Applying a tier is three knobs: how many pixels we draw, how big the bloom
 * buffers are, and how much rain is in the air. Everything else stays put, so
 * a change is invisible apart from the frame rate recovering.
 */
const viewSize = new THREE.Vector2();
function applyTier(tier) {
  renderer.setPixelRatio(Math.min(devicePixelRatio, tier.pixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  // in drawing-buffer pixels, or the post chain silently halves on HiDPI
  renderer.getDrawingBufferSize(viewSize);
  composer.setSize(viewSize.x, viewSize.y);
  applyBloomScale(bloom, viewSize, tier.bloomScale);
  rain.setDensity(tier.rain);
  sky.envEvery = tier.envEvery;
}
const guard = new QualityGuard(quality.index, applyTier);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  applyTier(TIERS[guard.index]);     // composer.setSize resets the bloom buffers
});

/* ── simulation ────────────────────────────────────────────── */
const V_REF = 88;      // where the engine runs out of pull, m/s

function drive(dt, c) {
  const boost = c.boost ? 1.32 : 1;
  state.throttle = damp(state.throttle, c.throttle, 7, dt);
  state.brake = damp(state.brake, clamp(c.brake, 0, 1), 12, dt);
  state.steer = damp(state.steer, c.steer, 6.5, dt);

  const v = state.v;
  const offRoad = Math.abs(state.lat) > ROAD_HALF + SHOULDER;

  const power = 12.2 * boost * clamp(1 - v / (V_REF * boost), 0, 1) * state.throttle;
  const drag = 0.00092 * v * v + 0.42 + (offRoad ? 3.4 : 0);
  const braking = state.brake * 15 + (state.throttle < 0.05 ? 1.3 : 0);

  state.v = Math.max(0, v + (power - drag - (v > 0.2 ? braking : 0)) * dt);

  /* steering: quick at walking pace, deliberate at speed */
  const authority = clamp(1.8 + state.v * 0.11, 1.8, 8.2);
  state.lat += state.steer * authority * dt;

  /* the corner throws you toward the outside line */
  const k = road.curvature(state.s);
  state.lat -= k * state.v * state.v * 0.16 * dt;
  /* Traffic is solid enough to squeeze past, not solid enough to crash into.
     Riding straight through a car looked worse than any collision would, so
     coming level with one pushes you aside instead — a motorcycle filtering
     past, which is what a bike would do anyway. No damage, no fail state. */
  for (const car of traffic.cars) {
    const ds = car.s - state.s;
    if (Math.abs(ds) > car.len / 2 + 2.2) continue;
    const dl = state.lat - car.lat;
    if (Math.abs(dl) > 2.1) continue;
    state.lat += (2.1 - Math.abs(dl)) * Math.sign(dl || 1) * 3.2 * dt;
  }

  /* You can put a wheel on the verge, but not drive out across the field: the
     bike rides at road height and the ground beside it is a metre lower, so
     far off the tarmac it visibly floats. The drag out here does the rest. */
  state.lat = clamp(state.lat, -9.6, 9.6);

  const ds = state.v * dt;
  state.s += ds;
  state.odo += ds;
}

/* ── camera rigs ───────────────────────────────────────────────
   The rig is smoothed in *road space* — how far back, how far to the side,
   how high — and only then projected onto the centreline. Smoothing world
   positions instead would leave the camera trailing by v/λ metres, which at
   150 km/h is half a bus. This way the lag is deliberate, not accidental,
   and the camera swings through corners along the road rather than cutting
   across them.                                                              */
const cam = { back: 8, lat: 1.9, h: 2.4, ahead: 22 };
let prevV = 0;
let accelSm = 0;

function updateCamera(dt) {
  const v = state.v;
  const mode = state.camMode;
  let back, height, latMul, ahead, fov, lambda;

  if (mode === 0) {          // chase
    back = 6.4 + v * 0.028; height = 2.35; latMul = 0.8; ahead = 20 + v * 0.34; fov = 60 + v * 0.44; lambda = 4.5;
  } else if (mode === 1) {   // close
    back = 4.2; height = 1.75; latMul = 0.92; ahead = 16 + v * 0.3; fov = 57 + v * 0.5; lambda = 7;
  } else if (mode === 2) {   // cinematic: long lens from the verge
    back = 13; height = 1.0; latMul = 1; ahead = 34; fov = 38; lambda = 2.2;
  } else {                   // first person
    back = -0.15; height = 1.42; latMul = 1; ahead = 34 + v * 0.3; fov = 72 + v * 0.34; lambda = 14;
  }

  /* the rig breathes with acceleration: falls back under power, closes in under brakes */
  const accel = (v - prevV) / Math.max(dt, 1e-3);
  prevV = v;
  accelSm = damp(accelSm, clamp(accel, -14, 12), 2.6, dt);
  const sideOffset = mode === 2 ? Math.sin(state.s * 0.0037) * 7 : 0;

  cam.back = damp(cam.back, back + accelSm * 0.16, lambda, dt);
  cam.lat = damp(cam.lat, state.lat * latMul + sideOffset, lambda, dt);
  cam.h = damp(cam.h, height, lambda * 0.8, dt);
  cam.ahead = damp(cam.ahead, ahead, lambda, dt);

  road.point(state.s - cam.back, cam.lat, cam.h, camPos);
  road.point(state.s + cam.ahead, state.lat * 0.6, mode === 3 ? 1.15 : 1.35, camLook);

  camera.position.copy(camPos);
  camera.lookAt(camLook);
  camera.rotateZ(bike.leanAngle * (mode === 3 ? 0.55 : 0.16));

  /* Speed you can feel in your hands. Barely-there jitter that grows with
     velocity and revs, and turns into a proper shudder off the tarmac —
     enough that 200 km/h reads differently from 100 without a number. */
  const offRoad = Math.abs(state.lat) > ROAD_HALF + SHOULDER;
  const revs = engine ? engine.rpm / 9800 : 0;
  const shake = Math.pow(clamp(v / 64, 0, 1), 1.7) * 0.014
    + (offRoad ? 0.045 : 0)
    + Math.pow(revs, 4) * 0.006;
  if (shake > 0.0002) {
    camera.position.x += Math.sin(clock * 61.7) * shake;
    camera.position.y += Math.sin(clock * 47.3 + 1.7) * shake * 0.8;
    camera.rotateZ(Math.sin(clock * 23.1) * shake * 0.05);
  }

  // the lens reacts to what your right hand is doing, not just to speed
  const targetFov = fov + clamp(accelSm, -8, 8) * 0.55 + (state.throttle > 0.9 && input.boost ? 5 : 0);
  camera.fov = damp(camera.fov, targetFov, 3.5, dt);
  camera.updateProjectionMatrix();

  camVel.copy(camPos).sub(prevCamPos).divideScalar(Math.max(dt, 0.001));
  prevCamPos.copy(camPos);
}

/* ── atmosphere ────────────────────────────────────────────── */
let lastBiome = null;

function updateWorld(dt, now) {
  const biome = road.biomeAt(state.s);
  if (biome !== lastBiome) {
    if (lastBiome !== null) hud.toast(biome);
    lastBiome = biome;
  }

  state.enclosure = damp(state.enclosure, biome === BIOME.TUNNEL ? 1 : 0, 4, dt);

  const nightHour = nightHourFromLocal(new Date(Date.now() + state.timeOffset * 3600e3));
  const pal = palette(nightHour);

  /* Out on a long haul the sky loses its orange lid and the stars come back.
     Then, a kilometre or two before the next city, the glow returns ahead of
     you — you see the place before you reach it. */
  const remote = road.remotenessAt(state.s);
  state.remote = damp(state.remote, remote, 2, dt);
  const cityIn = road.distanceTo(BIOME.CITY, state.s, 2600);
  const approach = 1 - clamp(cityIn / 2600, 0, 1);
  pal.cityGlow *= clamp(0.3 + 0.7 * Math.max(1 - state.remote, approach), 0.3, 1.0);
  pal.stars = Math.min(1, pal.stars * (1 + state.remote * 0.5));

  const rainAmount = state.rainOverride ?? weather.rain;
  state.rain = rainAmount;
  scene.fog.color.copy(pal.fog);
  scene.fog.density = pal.density * weather.fogMul * (1 - state.enclosure * 0.45)
    * (1 + rainAmount * 0.18) * (1 - state.remote * 0.22);
  renderer.setClearColor(pal.fog, 1);

  a.asphalt.roughness = 0.5 - rainAmount * 0.26;
  a.asphalt.metalness = 0.28 + rainAmount * 0.3;
  a.asphalt.envMapIntensity = 0.7 + rainAmount * 1.5;

  road.poseAt(state.s + 40, camLookPose);
  headingVec.set(Math.sin(camLookPose.h), 0, -Math.cos(camLookPose.h));
  sky.update(pal, camera.position, headingVec);
  sky.refreshEnvironment(dt);

  const flash = events.update(dt, {
    s: state.s, v: state.v, lat: state.lat, now, biome, remote, rain: rainAmount, audio,
    onGreet: () => bike.flash(2),
  });
  if (flash > 0.01) {
    const f = flash * (0.4 + Math.random() * 0.6);
    sky.ambient.intensity += f * 1.6;
    sky.uniforms.glowStrength.value += f * 2.4;
  }

  rain.update(dt, camera.position, camVel, rainAmount, state.enclosure, now);
  traffic.update(dt, state.s, state.lat, state.v);

  return { pal, rainAmount, biome };
}

/* ── recording ─────────────────────────────────────────────────
   Capturing a clip from a browser is normally hopeless: the renderer runs at
   whatever speed the machine manages, and a screenshot takes far longer than a
   frame, so you get a stuttering mess. Here the simulation runs on a fixed
   timestep instead of the wall clock, and the loop stops after every frame
   until the capture tool asks for the next one. The machine can take a second
   per frame; the clip still comes out at an exact, smooth 30 fps.            */
const record = {
  active: false,
  dt: 1 / 30,
  /* Film grain re-randomises every pixel every frame, which is exactly the
     thing inter-frame compression cannot cope with — leaving it on multiplies
     the size of a GIF several times over. Off by default while recording. */
  grain: 0,
  resolve: null,
  begin(opts = {}) {
    this.active = true;
    this.dt = 1 / (opts.fps || 30);
    this.grain = opts.grain ?? 0;
    if (opts.auto !== undefined) setAuto(opts.auto);
    if (opts.camMode !== undefined) state.camMode = opts.camMode;
    if (opts.hud === false) hud.photo(true);
    if (opts.hints === false) document.body.classList.add('nohints');
    state.autoCamT = opts.camCycle === false ? 1e9 : state.autoCamT;
    return true;
  },
  /** Advance exactly one frame and resolve once it has been rendered. */
  next() {
    return new Promise((r) => {
      this.resolve = r;
      setTimeout(frame, 0);
    });
  },
  finish() {
    const r = this.resolve;
    this.resolve = null;
    if (r) r();
  },
  end() {
    this.active = false;
    hud.photo(state.photo);
    document.body.classList.remove('nohints');
    requestAnimationFrame(frame);
  },
};

/* ── main loop ─────────────────────────────────────────────── */
let last = performance.now() / 1000;
let clock = 0;                 // simulation time; the wall clock in normal play
let clockTick = 0;
let odoTick = 15;
let clockStr = formatClock();
let fps = 0;
let rideTime = 0;
let autoTime = 0;

function frame() {
  const wall = performance.now() / 1000;
  let dt = record.active ? record.dt : Math.min(0.05, wall - last);
  last = wall;
  fps = fps ? fps * 0.94 + (1 / Math.max(dt, 1e-4)) * 0.06 : 1 / Math.max(dt, 1e-4);
  renderer.info.reset();   // autoReset is off, so stats cover the whole frame
  if (!running) dt = Math.min(dt, 1 / 60);

  /* photo mode stops the world: rain hangs in the air, traffic holds still,
     and only the camera moves */
  const simDt = photo.active ? 0 : dt;
  clock += simDt;
  const now = clock;

  if ((running || attract) && !photo.active) drive(dt, controls(dt, now));

  road.update(state.s);

  /* keep world coordinates small on very long rides */
  const bikePose = road.poseAt(state.s);
  if (Math.abs(bikePose.x) > 6000 || Math.abs(bikePose.z) > 6000) {
    const off = new THREE.Vector3(bikePose.x, 0, bikePose.z);
    road.rebase(off);
    camPos.sub(off);
    camLook.sub(off);
    prevCamPos.sub(off);
    events.rebase(off);
  }

  const { rainAmount, biome } = updateWorld(simDt, now);

  /* place the bike */
  road.point(state.s, state.lat, 0, tmpA);
  const p = road.poseAt(state.s);
  bike.setPose(tmpA, p.h, p.pitch);
  const offRoad = Math.abs(state.lat) > ROAD_HALF + SHOULDER;
  bike.setFirstPerson(state.camMode === 3 && !photo.active);
  bike.update(simDt, {
    speed: state.v,
    steer: state.steer,
    throttle: state.throttle,
    brake: state.brake,
    rpm: engine ? engine.rpm : 1200,
    rain: rainAmount,
    wobble: offRoad ? Math.sin(now * 42) * state.v : 0,
    beamFade: beamFade(tmpA, p.h),
  });

  if (photo.active) photo.update(dt, tmpA);
  else updateCamera(dt);

  /* audio */
  if (audio) {
    const kmh = state.v * 3.6;
    engine.update(dt, {
      kmh,
      throttle: state.throttle,
      brake: state.brake,
      rain: rainAmount,
      enclosure: state.enclosure,
      offRoad,
      musicEnergy: music.enabled ? music.energy : 0,
    });
    audio.setEnclosure(state.enclosure);
    music.setContext({ biome, remote: state.remote, rain: rainAmount });
    /* Normalised against the speeds people actually ride at, not the top speed.
       Measured over a drive: p10 80 km/h, median 101, p90 133. Dividing by 230
       squeezed all of that into 0.35–0.58, where every layer gate was already
       wide open and the music stopped answering the throttle. */
    music.tick(clamp((kmh - 50) / 110, 0, 1), dt);
  }

  /* post */
  state.beat = Math.max(0, state.beat - dt * 3.4);
  const speed01 = clamp(state.v / 62, 0, 1.1);
  bloom.strength = 0.82 + state.beat * 0.22 + rainAmount * 0.16 + speed01 * 0.12;
  grade.uniforms.uTime.value = now;
  grade.uniforms.uSpeed.value = Math.pow(speed01, 1.6);
  grade.uniforms.uWet.value = rainAmount * clamp(state.v / 40, 0, 1) * 0.55;
  grade.uniforms.uGrain.value = (state.photo ? 0.006 : 0.014) * (record.active ? record.grain : 1);

  composer.render();

  /* the drawing buffer is only intact for the rest of this task */
  if (photo.wantShot && photo.maybeCapture(place)) { hud.flashShot(); telemetry.data.shots++; }

  /* let the frame rate decide the quality, but not while a recording or a
     photo pose is holding the loop to a different rhythm */
  guard.update(dt, fps, record.active || photo.active);

  /* bookkeeping for the single end-of-session beacon */
  if (!telemetry.data.ok) telemetry.set({ ok: true });
  telemetry.data.maxKmh = Math.max(telemetry.data.maxKmh, state.v * 3.6);
  telemetry.data.km = state.odo / 1000;
  telemetry.data.fps = fps;
  telemetry.data.seen = events.seen;
  telemetry.data.quality = guard.name;
  telemetry.data.qStart = guard.startName;
  telemetry.data.qChanges = guard.changes;
  if (running) {
    rideTime += dt;
    if (state.auto) autoTime += dt;
    telemetry.data.autoShare = autoTime / Math.max(rideTime, 0.001);
    if (!telemetry.data.cams.includes(state.camMode)) telemetry.data.cams.push(state.camMode);
  }
  if (photo.active && !photo.hideUi) hud.photoBar(true, photo.readout);

  /* hud */
  odoTick -= dt;
  if (odoTick <= 0) {
    odoTick = 15;
    saveOdo();
  }
  clockTick -= dt;
  if (clockTick <= 0) {
    clockTick = 1;
    clockStr = formatClock(new Date(Date.now() + state.timeOffset * 3600e3));
  }
  stream.update({
    kmh: state.v * 3.6,
    clock12: StreamMode.clock12(nightHourFromLocal(new Date(Date.now() + state.timeOffset * 3600e3))),
    place, temp: weather.temp,
    weather: state.rainOverride === null ? weather.name : state.rainOverride > 0 ? 'Rain' : 'Clear',
    biome,
    totalKm: lifetimeKm + state.odo / 1000,
    bpm: music ? music.bpm : 84,
    station: music ? music.stationName : '88.3 NIGHT FM',
    style: music ? music.stationStyle : 'generated live',
  });

  hud.update(dt, {
    kmh: state.v * 3.6,
    rpm: engine ? engine.rpm : 1150,
    gear: engine ? engine.gear : 1,
    clock: clockStr,
    place,
    temp: weather.temp,
    weather: state.rainOverride === null ? weather.name : state.rainOverride > 0 ? 'Rain' : 'Clear',
    biome,
    odo: state.odo,
    bpm: music ? music.bpm : 84,
  });

  if (record.active) record.finish();
  else requestAnimationFrame(frame);
}

/* prime a few chunks before the first frame so the road is already there */
road.update(0);
frame();

/** Jump somewhere down the road and snap the camera there with it. */
function teleport(s, v = state.v) {
  state.s = s;
  state.v = v;
  prevV = v;
  accelSm = 0;
  road.seek(s);          // may be a jump backwards, out of the retained window
  road.update(s);
  road.point(s - cam.back, state.lat, cam.h, camPos);
  road.point(s + cam.ahead, state.lat, 1.35, camLook);
  prevCamPos.copy(camPos);
  camVel.set(0, 0, 0);
}

/* a handle for poking at the ride from the console */
window.__mr = {
  THREE, renderer, scene, camera, road, bike, traffic, events, input, state,
  teleport, setAuto, record, photo, composer, guard,
  get fps() { return fps; },
  get audio() { return audio; },
  get engine() { return engine; },
  get music() { return music; },
};
