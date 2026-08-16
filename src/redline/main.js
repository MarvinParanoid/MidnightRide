import '../style.css';
import './redline.css';
import * as THREE from 'three';

import { Road } from '../road.js';
import { ROAD_HALF, SHOULDER } from '../constants.js';
import { Bike } from '../bike.js';
import { Traffic } from '../traffic.js';
import { Rain } from '../rain.js';
import { Sky } from '../sky.js';
import { createComposer } from '../postfx.js';
import { Input } from '../input.js';
import { detectQuality } from '../quality.js';
import { palette, nightHourFromLocal, weatherForToday, rainAt } from '../timeofday.js';
import { WORLD_SEED } from '../seed.js';
import { AudioCore } from '../audio/core.js';
import { EngineSound } from '../audio/engine.js';
import { Music } from '../audio/music.js';
import { clamp, damp } from '../geo.js';
import { proximity } from '../proximity.js';
import { assets } from '../assets.js';
import { Scoring } from './scoring.js';
import { Run } from './run.js';
import { Board } from './board.js';

/**
 * Midnight Redline: the same night, ridden as if it owed you something.
 *
 * A second game on the same world. It shares everything about how the world
 * works — the road, the traffic, the weather, the light, the sound — and
 * disagrees with Midnight Ride about one thing only: what it means when a car
 * is close. There, coming level with one nudges you politely aside and there is
 * no way to fail. Here it ends the run, and coming *almost* level with one is
 * the entire point.
 *
 * This is a separate loop rather than a flag inside the other one. A flag would
 * have meant `if (arcade)` scattered through a thousand lines and two games each
 * carrying the other's weight; a separate loop costs a couple of hundred lines
 * and carries none. It has no photo mode, no broadcast mode, no autopilot and no
 * telemetry, because none of those are what this game is.
 *
 * What it does have is deliberately small, because the question it exists to
 * answer is small: is threading a gap at speed worth doing twice.
 */

/* ── the world, exactly as the other game builds it ─────────── */
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
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.7, 5200);

const { composer, grade } = createComposer(renderer, scene, camera, quality);

scene.add(assets().glowField.mesh);
const road = new Road(scene);
const bike = new Bike(scene);
const traffic = new Traffic(scene, road);
const rain = new Rain(scene, 5000);
rain.setDensity(quality.rain);
const sky = new Sky(scene);
sky.attachEnvironment(renderer, scene, quality.envEvery);

const input = new Input();
const weather = weatherForToday();
const board = new Board(WORLD_SEED);

/* ── the ride ───────────────────────────────────────────────── */
const state = { s: 0, lat: 1.9, v: 0, steer: 0, throttle: 0, brake: 0 };
const scoring = new Scoring();
let run = new Run();

/* Arcade, not the simulation next door. The other game's physics are tuned for
   a machine you sit on for an hour; this one is tuned for a machine you have
   four seconds to point at a gap. It accelerates on its own — the throttle is
   the floor of your speed, not the whole of it — and the brake is the one
   control that really matters. */
const TOP = 96;                    // metres per second, about 345 km/h
const PUSH = 7.5;                  // how hard it pulls away on its own
function drive(dt) {
  const wants = input.throttle > 0.05 ? TOP : TOP * 0.62;
  state.v = damp(state.v, wants, PUSH / Math.max(8, state.v) * 1.4, dt);
  if (input.brake > 0.05) state.v = damp(state.v, 12, 1.9 * input.brake, dt);
  state.v = clamp(state.v, 6, TOP);

  /* Steering that bites less the faster you go, so top speed is a commitment. */
  const authority = 10.5 / (1 + state.v / 46);
  state.steer = damp(state.steer, input.steer, 9, dt);
  state.lat += state.steer * authority * dt;
  state.lat -= road.curvature(state.s) * state.v * state.v * 0.16 * dt;
  state.lat = clamp(state.lat, -ROAD_HALF - SHOULDER, ROAD_HALF + SHOULDER);
  state.s += state.v * dt;
}

/* ── the loop ───────────────────────────────────────────────── */
const camPos = new THREE.Vector3(0, 3, 10);
const camLook = new THREE.Vector3();
const camVel = new THREE.Vector3(0, 0, 0);
const heading = new THREE.Vector3(0, 0, -1);
const here = new THREE.Vector3();
const nearby = {};
const cam = { back: 7.2, lat: 1.9, ahead: 26 };

let audio = null;
let engine = null;
let music = null;
let started = false;
let last = performance.now() / 1000;
let clock = 0;

function begin() {
  if (started) return;
  started = true;
  document.body.classList.add('riding');
  audio = new AudioCore();
  engine = new EngineSound(audio);
  music = new Music(audio);
  music.enabled = true;
}

function restart() {
  run = new Run();
  scoring.reset();
  state.s += 240;                  // a clean stretch, rather than the wreck you left
  state.v = TOP * 0.5;
  state.lat = 1.9;
  road.seek(state.s);
  road.update(state.s);
  board.begin();
}

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now() / 1000;
  const dt = Math.min(0.05, now - last);
  last = now;
  clock += dt;

  const live = started && !run.frozen;
  if (live) drive(dt);

  road.update(state.s);
  const pal = palette(nightHourFromLocal());
  const rainAmount = rainAt(state.s, weather);
  scene.fog.color.copy(pal.fog);
  scene.fog.density = pal.density * weather.fogMul;
  renderer.setClearColor(pal.fog, 1);
  const a = assets();
  a.asphalt.setPuddles(clamp(rainAmount * 1.3, 0, 1));
  a.asphalt.roughness = 0.5 - rainAmount * 0.26;
  a.asphalt.metalness = 0.28 + rainAmount * 0.3;

  /* the bike, and the world under it */
  road.point(state.s, state.lat, 0, here);
  const p = road.poseAt(state.s);
  bike.setPose(here, p.h, p.pitch);
  bike.update(live ? dt : 0, {
    speed: state.v, steer: state.steer, throttle: input.throttle,
    brake: input.brake, rpm: engine ? engine.rpm : 1200,
    rain: rainAmount, wobble: 0, beamFade: 1,
  });
  if (live) traffic.update(dt, state.s, state.lat, state.v);

  /* the one disagreement with the other game */
  proximity(traffic.cars, state.s, state.lat, state.v, nearby);
  if (live) {
    for (const e of scoring.update(dt, state.v, nearby)) {
      if (e.kind === 'pass') board.pass(e);
      if (e.kind === 'combo-lost') board.comboLost();
    }
    if (nearby.contact && run.crash()) {
      scoring.crash();
      board.crash(run.summary(scoring));
      if (music) music.enabled = false;
    }
  }
  run.update(dt, state.v, state.s);
  if (run.state === 'riding') pressed = false;
  if (run.canRestart && pressed) {
    if (music) music.enabled = true;
    restart();
  }

  /* the camera: one angle, close, and it does not wander */
  cam.back = damp(cam.back, 6.6 + state.v * 0.035, 5, dt);
  cam.lat = damp(cam.lat, state.lat * 0.85, 6, dt);
  road.point(state.s - cam.back, cam.lat, 2.15, camPos);
  road.point(state.s + cam.ahead, state.lat * 0.6, 1.35, camLook);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  camera.fov = 58 + Math.min(1, state.v / TOP) * 8;
  camera.updateProjectionMatrix();
  heading.set(camLook.x - camPos.x, 0, camLook.z - camPos.z).normalize();

  sky.update(pal, camera.position, heading);
  sky.refreshEnvironment(dt);
  rain.update(dt, camera.position, camVel, rainAmount, 0, clock);

  /* the meter is the soundtrack: it is why you do not want to slow down */
  if (audio) {
    engine.update(dt, {
      kmh: state.v * 3.6, throttle: input.throttle, brake: input.brake,
      rain: rainAmount, enclosure: 0, offRoad: false,
      musicEnergy: music.enabled ? music.energy : 0,
    });
    music.setContext({ biome: road.biomeAt(state.s), remote: 0, rain: rainAmount });
    music.tick(scoring.meter, dt);
  }

  grade.uniforms.uTime.value = clock;
  grade.uniforms.uSpeed.value = Math.pow(clamp(state.v / 62, 0, 1.1), 1.6);
  grade.uniforms.uWet.value = rainAmount * 0.4;

  assets().glowField.update(scene);
  board.update(dt, { score: scoring.score, combo: scoring.combo, meter: scoring.meter,
    kmh: state.v * 3.6, clearance: nearby.clearance });
  composer.render();
  renderer.info.reset();
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(renderer.getDrawingBufferSize(new THREE.Vector2()).x,
    renderer.getDrawingBufferSize(new THREE.Vector2()).y);
});
/* One press does both jobs: it starts the first run, and it answers the card.
   Deliberately any key — hunting for the right one is time between wanting to
   go again and going again, which is the one thing this game may not spend. */
let pressed = false;
const press = () => { pressed = true; begin(); };
addEventListener('keydown', press);
addEventListener('pointerdown', press);

state.v = TOP * 0.5;
road.update(0);
frame();

/* a handle for poking at it from the console, as the other game has */
window.__rl = { THREE, renderer, scene, camera, road, bike, traffic, state, scoring,
  get run() { return run; }, board, restart };
