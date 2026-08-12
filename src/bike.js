import * as THREE from 'three';
import { assets, neon } from './assets.js';
import { damp, clamp, lerp } from './geo.js';

const BEAM_FRAG = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  uniform float len;
  varying vec3 vPos;
  void main() {
    float t = clamp(1.0 + vPos.z / len, 0.0, 1.0);   // 1 at the lamp, 0 at the far end
    float a = pow(t, 1.9) * opacity;
    gl_FragColor = vec4(color, a);
  }
`;
const BEAM_VERT = /* glsl */ `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

function beam(length, radius, opacity, color) {
  const g = new THREE.ConeGeometry(radius, length, 18, 1, true);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, -length / 2);
  const m = new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(color) },
      opacity: { value: opacity },
      len: { value: length },
    },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
  return new THREE.Mesh(g, m);
}

export class Bike {
  constructor(scene) {
    const a = assets();
    this.root = new THREE.Group();      // yaw + pitch, sits on the road
    this.lean = new THREE.Group();      // roll
    this.root.add(this.lean);
    scene.add(this.root);

    const paint = new THREE.MeshStandardMaterial({ color: 0x14161d, roughness: 0.24, metalness: 0.85, envMapIntensity: 1.6 });
    const black = new THREE.MeshStandardMaterial({ color: 0x08090c, roughness: 0.6, metalness: 0.5 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0x6a7382, roughness: 0.16, metalness: 1.0 });
    const rider = new THREE.MeshStandardMaterial({ color: 0x0b0c11, roughness: 0.72, metalness: 0.18 });
    const visor = new THREE.MeshBasicMaterial({ color: neon(0x2b4a6a, 1.4), toneMapped: false });

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      this.lean.add(m);
      return m;
    };

    /* ── wheels ─────────────────────────────────────────── */
    const tyre = new THREE.TorusGeometry(0.33, 0.085, 8, 22);
    tyre.rotateY(Math.PI / 2);
    const rim = new THREE.CylinderGeometry(0.235, 0.235, 0.075, 12);
    rim.rotateZ(Math.PI / 2);
    const disc = new THREE.CylinderGeometry(0.16, 0.16, 0.02, 10);
    disc.rotateZ(Math.PI / 2);

    this.rearWheel = new THREE.Group();
    this.rearWheel.position.set(0, 0.33, 0.72);
    this.lean.add(this.rearWheel);
    this.rearWheel.add(new THREE.Mesh(tyre, black), new THREE.Mesh(rim, chrome));

    this.steerPivot = new THREE.Group();
    this.steerPivot.position.set(0, 0.33, -0.74);
    this.lean.add(this.steerPivot);
    this.frontWheel = new THREE.Group();
    this.steerPivot.add(this.frontWheel);
    this.frontWheel.add(new THREE.Mesh(tyre, black), new THREE.Mesh(rim, chrome));
    this.frontWheel.add(new THREE.Mesh(disc, chrome));

    /* fork */
    const forkGeo = new THREE.CylinderGeometry(0.035, 0.04, 0.72, 6);
    for (const dx of [-0.13, 0.13]) {
      const f = new THREE.Mesh(forkGeo, chrome);
      f.position.set(dx, 0.3, 0.09);
      f.rotation.x = -0.42;
      this.steerPivot.add(f);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 0.05), chrome);
    bar.position.set(0, 0.63, 0.2);
    this.steerPivot.add(bar);

    /* ── body ───────────────────────────────────────────── */
    add(new THREE.BoxGeometry(0.34, 0.34, 0.9), black, 0, 0.46, 0.16);           // engine
    add(new THREE.BoxGeometry(0.2, 0.12, 0.78), black, 0, 0.4, 0.62);            // swingarm
    add(new THREE.BoxGeometry(0.42, 0.3, 0.72), paint, 0, 0.76, -0.06);          // tank
    add(new THREE.BoxGeometry(0.34, 0.14, 0.52), black, 0, 0.85, 0.44);          // seat
    add(new THREE.BoxGeometry(0.26, 0.22, 0.36), paint, 0, 0.88, 0.78);          // tail
    add(new THREE.BoxGeometry(0.4, 0.44, 0.34), paint, 0, 0.86, -0.5);           // fairing
    const pipe = new THREE.CylinderGeometry(0.055, 0.07, 0.9, 8);
    pipe.rotateX(Math.PI / 2);
    this.exhaust = add(pipe, chrome, 0.17, 0.4, 0.62, 0.06, 0, 0);

    /* exhaust heat — rises with revs */
    this.exhaustGlow = a.glowSprite(0xff5a1e, 0.5, 0);
    this.exhaustGlow.position.set(0.17, 0.4, 1.06);
    this.lean.add(this.exhaustGlow);

    /* ── rider ──────────────────────────────────────────── */
    const torso = add(new THREE.CapsuleGeometry(0.17, 0.34, 4, 10), rider, 0, 1.13, 0.24, -0.62);
    torso.scale.set(1, 1, 0.8);
    this.head = add(new THREE.SphereGeometry(0.135, 12, 10), rider, 0, 1.4, -0.06);
    const visorMesh = add(new THREE.SphereGeometry(0.118, 12, 10), visor, 0, 1.395, -0.11);
    const arms = [];
    for (const dx of [-0.19, 0.19]) {
      arms.push(add(new THREE.CapsuleGeometry(0.055, 0.42, 3, 6), rider, dx, 1.02, 0.02, -1.15));
      add(new THREE.CapsuleGeometry(0.085, 0.3, 3, 6), rider, dx * 0.9, 0.74, 0.38, 0.7); // thighs
      add(new THREE.CapsuleGeometry(0.06, 0.26, 3, 6), rider, dx * 0.95, 0.5, 0.5, -0.2); // shins
    }

    /* In first person the camera sits where the rider's head is, so the head
       and the visor wrap around the lens — you end up looking at the inside of
       a blue sphere. Legs and the bike itself stay: they are what you'd see. */
    this.hiddenInFirstPerson = [torso, this.head, visorMesh, ...arms];

    /* ── lights ─────────────────────────────────────────── */
    this.headMat = new THREE.MeshBasicMaterial({ color: neon(0xfff0d8, 4), toneMapped: false });
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), this.headMat);
    lens.position.set(0, 0.88, -0.68);
    lens.scale.set(1.5, 0.8, 0.5);
    this.lean.add(lens);
    this.headGlow = a.glowSprite(0xffeccf, 1.5, 0.5);
    this.headGlow.position.copy(lens.position);
    this.lean.add(this.headGlow);

    this.spot = new THREE.SpotLight(0xfff3e0, 120, 150, 0.44, 0.7, 1.15);
    this.spot.position.set(0, 0.88, -0.7);
    this.spotTarget = new THREE.Object3D();
    this.spotTarget.position.set(0, -0.4, -40);
    this.lean.add(this.spot, this.spotTarget);
    this.spot.target = this.spotTarget;

    /* two cheats that make the rider readable: a cool key from above and the
       warm bounce coming back off the tarmac */
    this.fill = new THREE.PointLight(0x9fb8ff, 4.5, 11, 1.7);
    this.fill.position.set(0.6, 2.6, 1.2);
    this.lean.add(this.fill);
    /* Lifted off the road and pulled in close. Sitting at tarmac level two
       metres ahead it stopped reading as bounce and became a spotlight pointed
       at the ground — obvious once the road itself got darker. */
    this.bounce = new THREE.PointLight(0xffc98a, 1.3, 5, 1.9);
    this.bounce.position.set(0, 0.52, -1.15);
    this.lean.add(this.bounce);

    this.beams = [beam(48, 5.6, 0.022, 0xfff1de), beam(28, 2.4, 0.02, 0xffe9c8)];
    for (const b of this.beams) {
      b.position.set(0, 0.88, -0.72);
      this.lean.add(b);
    }

    /* Indicators, front and rear. Only one pair is ever shown: from the chase
       camera you can see the tail lamps and never the front ones — leaving both
       on meant the front pair glowed through the bike from behind. In first
       person it is the other way round. */
    this.blinkers = { left: [], right: [] };
    const lampGeo = new THREE.BoxGeometry(0.055, 0.055, 0.055);
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'left' : 'right';
      for (const [z, where] of [[-0.52, 'front'], [0.88, 'rear']]) {
        const m = new THREE.Mesh(lampGeo, new THREE.MeshBasicMaterial({
          color: neon(0xff9a1e, 2.4), toneMapped: false,
        }));
        m.position.set(side * 0.24, where === 'front' ? 0.86 : 0.9, z);
        m.visible = false;
        this.lean.add(m);
        const glow = a.glowSprite(0xff9a1e, 0.34, 0);
        glow.position.copy(m.position);
        this.lean.add(glow);
        this.blinkers[key].push({ mesh: m, glow, where });
      }
    }
    this.signal = null;
    this.blinkPhase = 0;

    this.tailMat = new THREE.MeshBasicMaterial({ color: neon(0xff1030, 2), toneMapped: false });
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.07, 0.05), this.tailMat);
    tail.position.set(0, 0.93, 0.96);
    this.lean.add(tail);
    this.tailGlow = a.glowSprite(0xff1230, 0.95, 0.32);
    this.tailGlow.position.copy(tail.position);
    this.lean.add(this.tailGlow);

    /* ── road spray thrown up by the rear wheel ─────────── */
    const n = 160;
    const pos = new Float32Array(n * 3);
    this.sprayLife = new Float32Array(n);
    for (let i = 0; i < n; i++) this.sprayLife[i] = Math.random();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.sprayMat = new THREE.PointsMaterial({
      map: a.tex.glow,
      color: 0x7d90b0,
      size: 0.5,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
      toneMapped: false,
    });
    this.spray = new THREE.Points(g, this.sprayMat);
    this.spray.frustumCulled = false;
    this.lean.add(this.spray);

    this.firstPerson = false;
    this.highBeam = false;
    this.flashLeft = 0;          // seconds of headlamp flash still owed
    this.leanAngle = 0;
    this.steerAngle = 0;
    this.wheelSpin = 0;
    this.bob = 0;
  }

  /** A flash of the headlamp: a greeting, or a warning before pulling out. */
  flash(times = 2) {
    this.flashLeft = Math.max(this.flashLeft, times * 0.34);
  }

  /** Hide the parts of the rider that the camera would otherwise be inside. */
  setFirstPerson(on) {
    if (this.firstPerson === on) return;
    this.firstPerson = on;
    for (const m of this.hiddenInFirstPerson) m.visible = !on;
    // and the beam volumes, whose apex is right under the lens
    for (const b of this.beams) b.visible = !on;
  }

  update(dt, st) {
    const { speed, steer, throttle, brake, rpm, rain, wobble } = st;

    /* roll into the corner; the faster you go the further you lie over */
    const target = -steer * clamp(speed / 26, 0, 1) * 0.72;
    this.leanAngle = damp(this.leanAngle, target, 6.5, dt);
    this.lean.rotation.z = this.leanAngle;

    this.steerAngle = damp(this.steerAngle, steer * 0.24 * (1 - clamp(speed / 60, 0, 0.86)), 12, dt);
    this.steerPivot.rotation.y = this.steerAngle;

    this.wheelSpin += (speed / 0.33) * dt;
    this.rearWheel.rotation.x = this.wheelSpin;
    this.frontWheel.rotation.x = this.wheelSpin;

    /* suspension bob under power and braking */
    this.bob = damp(this.bob, (throttle - brake * 1.6) * 0.035, 7, dt);
    this.lean.position.y = this.bob;
    this.lean.rotation.x = -this.bob * 1.4 + wobble * 0.004;

    /* head follows the corner a touch — the rider looks through the turn */
    this.head.rotation.y = -this.steerAngle * 1.6;

    const revs = clamp(rpm / 9500, 0, 1);
    this.exhaustGlow.material.opacity = Math.pow(revs, 2.4) * 0.75 * throttle;
    this.exhaustGlow.scale.setScalar(0.35 + revs * 0.4);

    /* Look into a headlight from two metres and it is, correctly, blinding —
       but that turns photo mode into a white rectangle. Fade the beam volume
       when the camera is close and in front of it. */
    const fade = st.beamFade ?? 1;

    /* Main beam, and the brief flash of it that riders use to say things to
       each other. Both widen the cone and throw further, so the road ahead
       visibly opens up rather than just getting brighter. */
    this.flashLeft = Math.max(0, this.flashLeft - dt);
    const flashing = this.flashLeft > 0 && Math.sin(this.flashLeft * 18.5) > -0.2;
    const main = this.highBeam || flashing;
    const beamMul = main ? 2.3 : 1;

    this.headMat.color.copy(neon(0xfff0d8, (main ? 4.2 : 2.4) + Math.sin(performance.now() * 0.021) * 0.1));
    this.spot.intensity = (110 + rain * 30) * beamMul;
    this.spot.angle = main ? 0.56 : 0.44;
    this.spotTarget.position.z = main ? -70 : -40;
    for (const b of this.beams) {
      b.material.uniforms.opacity.value = (0.014 + rain * 0.03) * fade * beamMul;
    }
    this.headGlow.material.opacity = 0.5 * (0.35 + 0.65 * fade) * (main ? 1.6 : 1);

    /* indicators: 1.5 Hz, roughly what a real relay does */
    this.blinkPhase += dt;
    const lit = !!this.signal && this.blinkPhase % 0.66 < 0.36;
    const shown = this.firstPerson ? 'front' : 'rear';
    for (const key of ['left', 'right']) {
      for (const b of this.blinkers[key]) {
        const on = lit && this.signal === key && b.where === shown;
        b.mesh.visible = on;
        b.glow.material.opacity = on ? 0.7 : 0;
      }
    }

    const braking = brake > 0.05;
    this.tailMat.color.copy(neon(0xff1030, braking ? 5 : 1.6));
    /* small enough to read as a lamp rather than a red disc painted on the
       road — the bloom does the spreading */
    this.tailGlow.material.opacity = braking ? 0.62 : 0.3;
    this.tailGlow.scale.setScalar(braking ? 1.5 : 0.95);

    this.updateSpray(dt, speed, rain);
  }

  updateSpray(dt, speed, rain) {
    const amount = clamp(speed / 30, 0, 1) * rain;
    this.sprayMat.opacity = amount * 0.5;
    if (amount <= 0.01) return;
    const p = this.spray.geometry.attributes.position;
    const arr = p.array;
    for (let i = 0; i < this.sprayLife.length; i++) {
      this.sprayLife[i] -= dt * (0.7 + speed * 0.02);
      const i3 = i * 3;
      if (this.sprayLife[i] <= 0) {
        this.sprayLife[i] = 1;
        arr[i3] = (Math.random() - 0.5) * 0.25;
        arr[i3 + 1] = 0.06;
        arr[i3 + 2] = 1.0;
      } else {
        const t = 1 - this.sprayLife[i];
        arr[i3] += (Math.random() - 0.5) * 0.9 * dt;
        arr[i3 + 1] = 0.06 + t * t * 1.3;
        arr[i3 + 2] += (2 + speed * 0.28) * dt;
      }
    }
    p.needsUpdate = true;
    this.spray.geometry.computeBoundingSphere();
  }

  /** Place the bike on the centreline at a lateral offset. */
  setPose(pos, heading, pitch) {
    this.root.position.copy(pos);
    this.root.rotation.set(pitch, -heading, 0, 'YXZ');
  }
}
