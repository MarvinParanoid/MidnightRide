import './style.css';
import * as THREE from 'three';

import { Road } from './road.js';
import { ROAD_HALF, SHOULDER, BIOME } from './constants.js';
import { Bike } from './bike.js';
import { Traffic } from './traffic.js';
import { Rain } from './rain.js';
import { Sky } from './sky.js';
import { Events } from './events.js';
import { createComposer } from './postfx.js';
import { Input } from './input.js';
import { Hud, formatClock } from './hud.js';
import { palette, nightHourFromLocal, placeName, weatherForToday } from './timeofday.js';
import { AudioCore } from './audio/core.js';
import { EngineSound } from './audio/engine.js';
import { Music } from './audio/music.js';
import { clamp, damp } from './geo.js';
import { assets } from './assets.js';

/* ── renderer ──────────────────────────────────────────────── */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.info.autoReset = false;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x06070f, 0.0066);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.4, 5200);
camera.position.set(0, 3, 8);

const { composer, bloom, grade } = createComposer(renderer, scene, camera);

/* ── world ─────────────────────────────────────────────────── */
const road = new Road(scene);
const bike = new Bike(scene);
const traffic = new Traffic(scene, road);
const rain = new Rain(scene);
const sky = new Sky(scene);
sky.attachEnvironment(renderer, scene);
const hud = new Hud();
const input = new Input();
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
};

const CAM_MODES = ['CHASE', 'CLOSE', 'CINEMATIC', 'FIRST PERSON'];
const weather = weatherForToday();
const place = placeName();
hud.setIntro(`${place} · ${weather.temp}°C · ${weather.name}`);

const camPos = new THREE.Vector3(0, 3, 10);
const camLook = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const prevCamPos = new THREE.Vector3();
const camVel = new THREE.Vector3();
const headingVec = new THREE.Vector3(0, 0, -1);
const camLookPose = {};

/* ── controls ──────────────────────────────────────────────── */
input.on('KeyC', () => {
  state.camMode = (state.camMode + 1) % CAM_MODES.length;
  hud.toast(CAM_MODES[state.camMode]);
});
input.on('KeyF', () => {
  state.photo = !state.photo;
  hud.photo(state.photo);
});
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

/* ── start ─────────────────────────────────────────────────── */
let running = false;
async function begin() {
  if (running) return;
  running = true;
  hud.dismiss();
  audio = new AudioCore();
  engine = new EngineSound(audio);
  music = new Music(audio);
  music.onBeat = () => { state.beat = 1; };
  traffic.onPass = (i) => engine && engine.whoosh(i);
  await audio.start();
  hud.toast(`${place.toUpperCase()} · ${weather.name.toUpperCase()}`);
}
document.addEventListener('pointerdown', begin, { once: true });
document.addEventListener('keydown', (e) => {
  if (!running && (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyW')) begin();
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

/* ── simulation ────────────────────────────────────────────── */
const V_REF = 88;      // where the engine runs out of pull, m/s

function drive(dt) {
  const boost = input.boost ? 1.32 : 1;
  state.throttle = damp(state.throttle, input.throttle, 7, dt);
  state.brake = damp(state.brake, clamp(input.brake, 0, 1), 12, dt);
  state.steer = damp(state.steer, input.steer, 6.5, dt);

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
  state.lat = clamp(state.lat, -12.5, 12.5);

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

  const targetFov = fov + (input.boost ? 5 : 0);
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

/* ── main loop ─────────────────────────────────────────────── */
let last = performance.now() / 1000;
let clockTick = 0;
let clockStr = formatClock();
let fps = 0;

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  let dt = Math.min(0.05, now - last);
  last = now;
  fps = fps ? fps * 0.94 + (1 / Math.max(dt, 1e-4)) * 0.06 : 1 / Math.max(dt, 1e-4);
  renderer.info.reset();   // autoReset is off, so stats cover the whole frame
  if (!running) dt = Math.min(dt, 1 / 60);

  if (running) drive(dt);

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

  const { rainAmount, biome } = updateWorld(dt, now);

  /* place the bike */
  road.point(state.s, state.lat, 0, tmpA);
  const p = road.poseAt(state.s);
  bike.setPose(tmpA, p.h, p.pitch);
  const offRoad = Math.abs(state.lat) > ROAD_HALF + SHOULDER;
  bike.update(dt, {
    speed: state.v,
    steer: state.steer,
    throttle: state.throttle,
    brake: state.brake,
    rpm: engine ? engine.rpm : 1200,
    rain: rainAmount,
    wobble: offRoad ? Math.sin(now * 42) * state.v : 0,
  });

  updateCamera(dt);

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
    music.tick(clamp(kmh / 230, 0, 1), dt);
  }

  /* post */
  state.beat = Math.max(0, state.beat - dt * 3.4);
  const speed01 = clamp(state.v / 62, 0, 1.1);
  bloom.strength = 0.82 + state.beat * 0.22 + rainAmount * 0.16 + speed01 * 0.12;
  grade.uniforms.uTime.value = now;
  grade.uniforms.uSpeed.value = Math.pow(speed01, 1.6);
  grade.uniforms.uWet.value = rainAmount * clamp(state.v / 40, 0, 1) * 0.55;
  grade.uniforms.uGrain.value = state.photo ? 0.006 : 0.014;

  composer.render();

  /* hud */
  clockTick -= dt;
  if (clockTick <= 0) {
    clockTick = 1;
    clockStr = formatClock(new Date(Date.now() + state.timeOffset * 3600e3));
  }
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
  road.update(s);
  road.point(s - cam.back, state.lat, cam.h, camPos);
  road.point(s + cam.ahead, state.lat, 1.35, camLook);
  prevCamPos.copy(camPos);
  camVel.set(0, 0, 0);
}

/* a handle for poking at the ride from the console */
window.__mr = {
  THREE, renderer, scene, camera, road, bike, traffic, events, state, teleport,
  get fps() { return fps; },
  get audio() { return audio; },
  get engine() { return engine; },
  get music() { return music; },
};
