import * as THREE from 'three';
import { mulberry32, clamp, damp } from './geo.js';

/**
 * 5000 rain streaks, entirely GPU-resident. The whole field lives in a box
 * that rides along with the camera; a single `drift` uniform scrolls it, so
 * there is no per-drop CPU work at any speed.
 */
const VERT = /* glsl */ `
  attribute float end;
  uniform vec3 drift;
  uniform vec3 box;
  uniform vec3 streak;
  varying float vFade;
  void main() {
    vec3 p = position + drift;
    p = mod(p + box * 0.5, box) - box * 0.5;
    float d = length(p.xz) / (box.x * 0.5);
    vFade = 1.0 - clamp(d * d, 0.0, 1.0);
    p += streak * end;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vFade;
  void main() {
    gl_FragColor = vec4(color, vFade * opacity);
  }
`;

const BOX = new THREE.Vector3(80, 46, 80);

export class Rain {
  constructor(scene, count = 5000) {
    const rnd = mulberry32(2024);
    const pos = new Float32Array(count * 6);
    const end = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = (rnd() - 0.5) * BOX.x;
      const y = (rnd() - 0.5) * BOX.y;
      const z = (rnd() - 0.5) * BOX.z;
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2] = 0;
      end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('end', new THREE.BufferAttribute(end, 1));

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        drift: { value: new THREE.Vector3() },
        box: { value: BOX },
        streak: { value: new THREE.Vector3(0, -0.6, 0) },
        color: { value: new THREE.Color(0xa9c4e8) },
        opacity: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });

    this.mesh = new THREE.LineSegments(g, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.count = count;

    this.drift = this.mat.uniforms.drift.value;
    this.vel = new THREE.Vector3();
    this.amount = 0;
    this.wind = new THREE.Vector3();
  }

  /**
   * Thin the rain without rebuilding anything: the drops are all allocated up
   * front, so drawing fewer of them is a draw-range change.
   */
  setDensity(fraction) {
    const n = Math.max(1, Math.floor(this.count * fraction));
    this.mesh.geometry.setDrawRange(0, n * 2);
  }

  /**
   * @param camVel world-space camera velocity — rain leans against your motion
   * @param amount 0..1 downpour
   * @param shelter 0..1 how covered you are (tunnels, canopies)
   */
  update(dt, camPos, camVel, amount, shelter, t) {
    this.amount = damp(this.amount, amount * (1 - shelter), 3, dt);
    this.mat.uniforms.opacity.value = this.amount * 0.36;
    if (this.amount < 0.01) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;

    this.wind.set(Math.sin(t * 0.21) * 3.2, 0, Math.cos(t * 0.17) * 3.2);
    const fall = -14 - this.amount * 10;
    this.vel.set(this.wind.x - camVel.x, fall - camVel.y, this.wind.z - camVel.z);
    this.drift.addScaledVector(this.vel, dt);
    // keep drift inside one box so the shader's mod() never loses precision
    this.drift.x %= BOX.x;
    this.drift.y %= BOX.y;
    this.drift.z %= BOX.z;

    const len = clamp(0.25 + this.vel.length() * 0.022, 0.3, 1.8);
    this.mat.uniforms.streak.value.copy(this.vel).normalize().multiplyScalar(len);

    this.mesh.position.copy(camPos);
  }
}
