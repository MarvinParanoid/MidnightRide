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

const { composer, grade, bloom } = createComposer(renderer, scene, camera, quality);

scene.add(assets().glowField.mesh);
const road = new Road(scene);
const bike = new Bike(scene);
const traffic = new Traffic(scene, road, { courtesy: false, emptyHauls: 0 });
const rain = new Rain(scene, 5000);
rain.setDensity(quality.rain);
const sky = new Sky(scene);
sky.attachEnvironment(renderer, scene, quality.envEvery);

const input = new Input();
const weather = weatherForToday();
const board = new Board(WORLD_SEED);

/* ── the ride ───────────────────────────────────────────────── */
const state = { s: 0, lat: 1.9, v: 0, latV: 0, steer: 0, throttle: 0, brake: 0 };
const scoring = new Scoring();
let run = new Run();

/* Arcade, not the simulation next door. The other game's physics are tuned for
   a machine you sit on for an hour; this one is tuned for a machine you have
   four seconds to point at a gap. It accelerates on its own — the throttle is
   the floor of your speed, not the whole of it — and the brake is the one
   control that really matters. */
const TOP = 96;                    // metres per second, about 345 km/h
const PUSH = 7.5;                  // how hard it pulls away on its own

/**
 * Arcade, but not weightless.
 *
 * The first version set the lateral speed straight from the steering key, which
 * is the difference between riding a motorcycle and dragging a cursor: it went
 * exactly where it was told, the instant it was told, and reported back as "too
 * arcadey" within one session. A machine has to take a moment to agree with you
 * and a moment to stop agreeing.
 *
 * So the sideways movement is a velocity with mass. It builds towards what the
 * bars ask for and it carries on for a beat after they stop asking, which is
 * what makes threading a gap a thing you commit to a fraction of a second early
 * rather than a thing you do when you arrive.
 *
 * And it is slower to change its mind the faster you go, so speed is a decision
 * with a cost rather than a free multiplier — while the brake sharpens the
 * turn-in, because weight going onto the front wheel is what a bike does. That
 * gives braking a second job beyond buying time: it is also how you make the
 * tightest line. Which is the whole question the game is asking.
 */
function drive(dt) {
  const wants = input.throttle > 0.05 ? TOP : TOP * 0.62;
  state.v = damp(state.v, wants, PUSH / Math.max(8, state.v) * 1.4, dt);
  if (input.brake > 0.05) state.v = damp(state.v, 12, 1.9 * input.brake, dt);
  state.v = clamp(state.v, 6, TOP);

  const fast = Math.min(1, state.v / TOP);
  const reach = 9.2 - fast * 3.6;                 // how far sideways it will go
  const grip = 3.4 + input.brake * 2.6 - fast * 1.1;   // how fast it agrees to
  state.steer = damp(state.steer, input.steer, 12, dt);
  state.latV = damp(state.latV, state.steer * reach, grip, dt);
  state.lat += state.latV * dt;

  /* The corner throws you towards the outside — but not by the square of the
     speed, which is right for the other game's hundred and ninety and reads at
     three hundred as the bike wandering off on its own rather than as a corner.
     Held to something a rider can hold a line against. */
  const push = road.curvature(state.s) * state.v * state.v * 0.16;
  state.lat -= clamp(push, -2.6, 2.6) * dt;
  const edge = ROAD_HALF + SHOULDER;
  if (state.lat > edge || state.lat < -edge) state.latV *= 0.3;   // the verge bites
  state.lat = clamp(state.lat, -edge, edge);
  state.s += state.v * dt;
}


/**
 * What a near miss does to you.
 *
 * The scoring counts it; this is the part that is felt. Everything here already
 * existed in the engine and was being used for atmosphere — the whoosh of air
 * from a passing lorry, the bloom, the chromatic split in the grade, the
 * percussion in the generated track. Pointed at a single instant and scaled by
 * how close it was, the same parts become a punch.
 *
 * Five things at once, because one of them alone reads as an effect and all of
 * them together read as an event: the camera flinches away from the car, the
 * air goes past your ear on the correct side, the lights bloom for a frame, the
 * colour tears, and the track puts a hit exactly there. The last is the one
 * that matters most — the traffic becomes an instrument, and a good run does
 * not merely score well, it plays better.
 */
const hit = { kick: 0, side: 1, punch: 0, glow: 0, slow: 0 };
function impact(e) {
  const force = e.worth / 8;                 // CLOSE is an eighth of NO WAY
  hit.kick = Math.max(hit.kick, 0.3 + force * 1.5);
  hit.side = e.side;
  /* Two stages, because one is a blink. The punch is gone in a tenth of a
     second and is what you feel; the glow hangs about for the best part of a
     second and is what tells you it happened. A single decay curve gave neither
     — too short to register as an event, too long to feel like a hit. */
  hit.punch = Math.max(hit.punch, 0.35 + force * 0.9);
  hit.glow = Math.max(hit.glow, 0.2 + force * 0.8);

  if (engine) engine.whoosh(0.45 + force * 0.9);
  if (music && audio) {
    /* A snare for the close ones, a hat for the rest — chosen by how near it
       was, not by where in the bar it fell. Landing it on the beat instead
       would be truer to the idea that the traffic is an instrument, and it
       needs the sequencer to hand out the next beat time, which it does not
       yet. Off-grid is the honest version of this until it does. */
    if (force > 0.45) music.snare(audio.t);
    else music.hat(audio.t, 0.5 + force, force > 0.2);
    /* And shove the energy up by hand rather than waiting for it to drift.
       The track chases the meter with a second and a half of lag and the layer
       gates smooth it further, so a magnificent pass used to produce no audible
       consequence at the moment it happened — which is the whole promise of
       the thing: what you did should be what you hear. */
    music.energy = Math.min(1, music.energy + force * 0.28);
  }

  /* And for the two tightest bands, the world takes a breath. A tenth of a
     second at just under half speed is the strongest single device this genre
     has: it says "that mattered" without a word of interface, and it costs
     nothing but a multiplier on the timestep. */
  if (e.worth >= 4) hit.slow = 1;
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

async function begin() {
  if (started) return;
  started = true;
  document.body.classList.add('riding');
  audio = new AudioCore();
  /* A taller box, because this machine goes half as fast again as the one next
     door and the stock six run out at two hundred and twenty. */
  engine = new EngineSound(audio, { gears: [0, 46, 76, 110, 150, 196, 250, 310, 350] });
  music = new Music(audio);
  music.enabled = true;
  scoring.prime(state.v);
  /* Without this there is no sound at all — not quiet, none. The context comes
     up suspended and the master gain comes up at zero, and `start()` is what
     undoes both. Leaving it out is a silent failure in the most literal sense:
     everything else runs, the meter climbs, the engine object dutifully updates
     its filters, and not one sample reaches the speakers. */
  await audio.start();
}

/**
 * Somewhere down the road with nothing standing in it.
 *
 * Two hundred and forty metres on from the wreck, and then as much further as
 * it takes to find air. Measured before this existed: three restarts in forty
 * landed within forty centimetres of a car and the worst of them a metre and a
 * half *inside* one — an instant second death, one attempt in thirteen, in a
 * game whose whole promise is that pressing anything puts you straight back on
 * the road. Nothing feels more like being cheated than dying before the run
 * has begun.
 */
function clearSpot(from) {
  for (let tries = 0; tries < 14; tries++) {
    const at = from + tries * 55;
    let closest = Infinity;
    for (const car of traffic.cars) {
      if (Math.abs(car.s - at) > 55) continue;
      closest = Math.min(closest, Math.abs(1.9 - car.lat) - ((car.half || 0.95) + 0.45));
    }
    if (closest > 1.4) return at;
  }
  return from + 14 * 55;           // the road is packed; take what we can get
}

function restart() {
  run = new Run();
  scoring.reset();
  state.s = clearSpot(state.s + 240);
  state.v = TOP * 0.5;
  state.lat = 1.9;
  state.latV = 0;
  scoring.prime(state.v);
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

  /* The world's own clock, which is not quite the wall's. */
  hit.slow = Math.max(0, hit.slow - dt * 7.5);
  const simDt = dt * (1 - hit.slow * 0.55);

  const live = started && !run.frozen;
  if (live) drive(simDt);

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
  bike.update(live ? simDt : 0, {
    speed: state.v, steer: state.steer, throttle: input.throttle,
    brake: input.brake, rpm: engine ? engine.rpm : 1200,
    rain: rainAmount, wobble: 0, beamFade: 1,
  });
  if (live) traffic.update(simDt, state.s, state.lat, state.v);

  /* the one disagreement with the other game */
  proximity(traffic.cars, state.s, state.lat, state.v, nearby);
  if (live) {
    for (const e of scoring.update(simDt, state.v, nearby)) {
      if (e.kind === 'brush') impact(e);
      if (e.kind === 'pass') board.pass(e);
      if (e.kind === 'combo-lost') board.comboLost();
    }
    /* No margin at all: the metal has to actually meet. */
    if (nearby.contact && run.crash()) {
      scoring.crash();
      board.crash(run.summary(scoring));
      if (music) music.enabled = false;
    }
  }
  run.update(simDt, state.v, state.s);
  if (run.state === 'riding') pressed = false;
  if (run.canRestart && pressed) {
    if (music) music.enabled = true;
    restart();
  }

  /* the camera: one angle, close, and it does not wander — except when
     something has just gone past close enough to shove it */
  hit.kick = Math.max(0, hit.kick - dt * 4.2);
  hit.punch = Math.max(0, hit.punch - dt * 9);       // gone in a tenth of a second
  hit.glow = Math.max(0, hit.glow - dt * 1.3);       // and a second of afterglow
  cam.back = damp(cam.back, 6.6 + state.v * 0.035, 5, dt);
  cam.lat = damp(cam.lat, state.lat * 0.85 - hit.side * hit.kick * 0.5, 6, dt);
  road.point(state.s - cam.back, cam.lat, 2.15 + hit.kick * 0.12, camPos);
  road.point(state.s + cam.ahead, state.lat * 0.6, 1.35, camLook);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  camera.rotateZ(-hit.side * hit.kick * 0.045);      // it rocks away from the car
  camera.fov = 58 + Math.min(1, state.v / TOP) * 8 + hit.kick * 2.4;
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
    /* One station, and the fastest one there is.
       The dial picks by biome for the other game, where drifting between four
       moods over an hour is the point. Here the soundtrack is the scoreboard and
       it may not wander off into ambient halfway through a run: INTERSTATE is
       the one with tight drums and the highest tempo, and it stays. */
    music.setContext({ biome: 'TUNNEL', remote: 0, rain: rainAmount });
    music.tick(scoring.meter, dt);
  }

  grade.uniforms.uTime.value = clock;
  /* Speed has to be visible, not merely printed. The other game's curve is
     drawn for a hundred and ninety and reads at three hundred as barely more
     than at two hundred; this one keeps climbing where the speedometer does. */
  grade.uniforms.uSpeed.value = Math.pow(clamp(state.v / TOP, 0, 1), 1.25) * 1.35;
  grade.uniforms.uWet.value = rainAmount * 0.4;
  /* The colour tears for a moment, and the lights swell. Both are the existing
     look pushed briefly past where it normally sits, rather than a new effect —
     which is why it reads as the world reacting rather than as a filter. */
  /* Heat. The tear and the swell are the punch; the rest is the state of the
     run, and it is the part that was missing — a combo of eight looked exactly
     like a combo of one, so nothing about the world said you were doing well.
     Now the colour opens up, the corners lift and the lights grow as it goes,
     and a run that is going somewhere looks like one. */
  const heat = Math.min(1, scoring.combo / 12) * scoring.meter;
  grade.uniforms.uAberration.value = 1 + hit.punch * 6 + heat * 1.2;
  grade.uniforms.uVignette.value = 1 - heat * 0.45;
  grade.uniforms.uGrain.value = 0.055 + hit.punch * 0.05;
  bloom.strength = 0.95 + scoring.meter * 0.3 + heat * 0.45 + hit.punch * 0.8 + hit.glow * 0.35;

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
  get run() { return run; }, board, restart,
  get music() { return music; }, get engine() { return engine; },
  /* Is anything actually going to come out of the speakers? Asked from the
     outside, because the failure this answers was invisible from the inside:
     every object updated correctly and the master gain was zero. */
  /* What the last near miss did to the frame, for checking that it did it. */
  probeNear: () => ({ clearance: nearby.clearance, along: nearby.along, contact: nearby.contact }),
  probe: () => ({ aberration: grade.uniforms.uAberration.value, bloom: bloom.strength,
    vignette: grade.uniforms.uVignette.value, speed: grade.uniforms.uSpeed.value,
    kick: hit.kick, punch: hit.punch, glow: hit.glow, slow: hit.slow }),
  /* recompute the colour from the current combo without waiting for a frame */
  probeHeat: () => {
    const heat = Math.min(1, scoring.combo / 12) * scoring.meter;
    grade.uniforms.uAberration.value = 1 + hit.punch * 6 + heat * 1.2;
    grade.uniforms.uVignette.value = 1 - heat * 0.45;
    bloom.strength = 0.95 + scoring.meter * 0.3 + heat * 0.45 + hit.punch * 0.8 + hit.glow * 0.35;
  },
  audioProbe: () => (audio ? {
    context: audio.ctx.state,
    master: +audio.master.gain.value.toFixed(3),
    music: music ? { on: music.enabled, energy: +music.energy.toFixed(2), bpm: Math.round(music.bpm) } : null,
  } : 'no audio yet') };
