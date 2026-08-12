import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Vignette + grain + chromatic fringe + radial speed blur, in one pass. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uSpeed: { value: 0 },     // 0..1, drives the radial blur
    uAberration: { value: 1 },
    uGrain: { value: 0.055 },
    uVignette: { value: 1.0 },
    uWet: { value: 0 },       // droplet wobble on the "lens"
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uSpeed, uAberration, uGrain, uVignette, uWet;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c);

      // a few taps outward from the centre — the world smears past you
      vec2 dir = c * (0.006 + uSpeed * 0.055) * smoothstep(0.05, 0.75, r);
      vec3 col = vec3(0.0);
      float wsum = 0.0;
      for (int i = 0; i < 5; i++) {
        float t = float(i) / 4.0;
        float w = 1.0 - t * 0.72;
        vec2 uv = vUv - dir * t;
        // chromatic split grows with the blur
        float ab = (0.0009 + uSpeed * 0.0035) * uAberration;
        col.r += texture2D(tDiffuse, uv + c * ab).r * w;
        col.g += texture2D(tDiffuse, uv).g * w;
        col.b += texture2D(tDiffuse, uv - c * ab).b * w;
        wsum += w;
      }
      col /= wsum;

      // rain on the lens: subtle refractive wobble near the edges
      if (uWet > 0.001) {
        vec2 q = vUv * vec2(9.0, 5.0);
        float n = hash(floor(q + vec2(0.0, floor(uTime * 1.7))));
        float drop = smoothstep(0.86, 1.0, n) * uWet * smoothstep(0.15, 0.6, r);
        col += texture2D(tDiffuse, vUv + vec2(0.0, drop * 0.012)).rgb * drop * 0.55;
      }

      col *= mix(1.0, smoothstep(1.15, 0.22, r), uVignette);
      float g = hash(vUv * 512.0 + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/**
 * Run the bloom chain at a fraction of the screen resolution. Its radius is in
 * buffer pixels, so at half res the same number smears twice as far across the
 * picture — scale it back down to match, or a phone gets a different look
 * rather than a cheaper one.
 */
export function applyBloomScale(bloom, size, scale) {
  bloom.setSize(Math.max(2, size.x * scale), Math.max(2, size.y * scale));
  bloom.radius = 0.72 * (0.35 + 0.65 * scale);
}

export function createComposer(renderer, scene, camera, quality = {}) {
  const { bloomScale = 1, samples = 2 } = quality;
  /* Drawing-buffer pixels, not CSS pixels. The composer sizes its targets in
     real pixels, so feeding it CSS ones renders the whole post chain at half
     resolution on any HiDPI screen. */
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const composer = new EffectComposer(
    renderer,
    new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples })
  );
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(size.clone().multiplyScalar(bloomScale), 0.95, 0.72, 0.42);
  composer.addPass(bloom);
  applyBloomScale(bloom, size, bloomScale);   // after addPass: it re-sizes passes

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  composer.addPass(new OutputPass());

  return { composer, bloom, grade };
}
