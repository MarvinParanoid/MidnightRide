import * as THREE from 'three';
import { assets } from './assets.js';
import { mulberry32 } from './geo.js';

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 bottomColor;
  uniform vec3 glowColor;
  uniform vec2 glowDir;
  uniform float glowStrength;
  varying vec3 vDir;

  // cheap hash noise for a little cloud break-up near the horizon
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(bottomColor, topColor, pow(clamp(h, 0.0, 1.0), 0.42));
    col = mix(col, bottomColor * 0.55, clamp(-h * 3.0, 0.0, 1.0));

    // light pollution smeared along the horizon, brightest toward the city
    float band = pow(max(0.0, 1.0 - abs(h) * 5.5), 2.6);
    float dir = 0.42 + 0.58 * pow(max(0.0, dot(normalize(d.xz), glowDir)) , 1.6);
    float clouds = 0.72 + 0.28 * noise(d.xz * 6.0 + vec2(h * 4.0));
    col += glowColor * band * dir * glowStrength * clouds;

    // faint overcast layering higher up
    float overcast = noise(d.xz * 2.2 + 11.0) * smoothstep(0.05, 0.7, h);
    col += glowColor * 0.05 * overcast * glowStrength;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class Sky {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.renderOrder = -10;
    scene.add(this.group);

    this.uniforms = {
      topColor: { value: new THREE.Color(0x03040e) },
      bottomColor: { value: new THREE.Color(0x0a0c20) },
      glowColor: { value: new THREE.Color(0x3a2f6e) },
      glowDir: { value: new THREE.Vector2(0, -1) },
      glowStrength: { value: 1 },
    };

    this.domeGeo = new THREE.SphereGeometry(4200, 32, 20);
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    const dome = new THREE.Mesh(this.domeGeo, this.domeMat);
    dome.frustumCulled = false;
    this.group.add(dome);

    /* stars */
    const rnd = mulberry32(99);
    const n = 900;
    const pos = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = rnd() * Math.PI * 2;
      const v = Math.pow(rnd(), 0.6);
      const y = v;
      const r = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(u) * r * 3600;
      pos[i * 3 + 1] = y * 3600;
      pos[i * 3 + 2] = Math.sin(u) * r * 3600;
      sizes[i] = 8 + Math.pow(rnd(), 3) * 44;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    this.starMat = new THREE.PointsMaterial({
      map: assets().tex.glow,
      color: 0xbfd4ff,
      size: 26,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    /* moon */
    this.moon = assets().glowSprite(0xdfe8ff, 260, 0.9);
    this.moon.position.set(-1500, 900, -2600);
    this.group.add(this.moon);
    this.moonDisc = assets().glowSprite(0xffffff, 78, 1);
    this.moonDisc.position.copy(this.moon.position);
    this.group.add(this.moonDisc);

    /* the two lights that actually touch the world */
    this.ambient = new THREE.HemisphereLight(0x2a3358, 0x05060a, 0.5);
    scene.add(this.ambient);
    this.moonLight = new THREE.DirectionalLight(0x9fb4ff, 0.5);
    this.moonLight.position.set(-1, 1.4, -1.6);
    scene.add(this.moonLight);
  }

  /**
   * Wet tarmac and car paint are mostly mirrors, and a mirror with nothing to
   * reflect is just black. So the sky itself is baked into an environment map —
   * cheap, and it means the road picks up the colour of the night.
   */
  attachEnvironment(renderer, scene, everySeconds = 6) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.envScene = new THREE.Scene();
    const twin = new THREE.Mesh(this.domeGeo, this.domeMat);
    twin.frustumCulled = false;
    this.envScene.add(twin);
    this.targetScene = scene;
    this.envEvery = everySeconds;
    this.envAge = 1e9;
    scene.environmentIntensity = 0.55;
  }

  refreshEnvironment(dt) {
    if (!this.pmrem) return;
    this.envAge += dt;
    if (this.envAge < this.envEvery) return;
    this.envAge = 0;
    const prev = this.targetScene.environment;
    this.targetScene.environment = this.pmrem.fromScene(this.envScene, 0.04, 1, 5000).texture;
    if (prev) prev.dispose();
  }

  update(pal, cameraPos, headingVec) {
    this.uniforms.topColor.value.copy(pal.top);
    this.uniforms.bottomColor.value.copy(pal.bottom).lerp(pal.fog, 0.55);
    this.uniforms.glowColor.value.copy(pal.glow);
    this.uniforms.glowStrength.value = 0.55 + pal.cityGlow * 0.9;
    this.uniforms.glowDir.value.set(headingVec.x, headingVec.z).normalize();
    this.starMat.opacity = pal.stars * 0.95;
    this.moon.material.opacity = pal.moon * 0.55;
    this.moonDisc.material.opacity = pal.moon;
    this.ambient.intensity = pal.ambient * 1.6;
    this.moonLight.intensity = pal.moon * 0.55;
    this.group.position.copy(cameraPos);
  }
}
