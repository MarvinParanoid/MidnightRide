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
 * Screen-space reflections, for the road.
 *
 * Wet asphalt at night is mostly reflection, and until now it reflected an
 * environment map of the sky — a gradient. Tail lights, neon and street lamps
 * were simply not in it, which is why every reflection on the road had to be
 * faked with a decal underneath the thing casting it, and why those decals kept
 * turning up as rectangles.
 *
 * This is a narrower thing than general SSR, and narrower on purpose: the only
 * surfaces it touches are the near-horizontal ones. That is not a limitation
 * here, it is the whole subject — and knowing the normal is roughly up before
 * marching makes the march shorter and the result far steadier than a general
 * pass that has to trust a normal buffer.
 */
const SSRShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uProj: { value: new THREE.Matrix4() },
    uInvProj: { value: new THREE.Matrix4() },
    uUpView: { value: new THREE.Vector3(0, 1, 0) },
    uStrength: { value: 0.55 },
    uWet: { value: 0 },
    uSteps: { value: 20 },
    uDebug: { value: 0 },
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
    uniform sampler2D tDepth;
    uniform mat4 uProj, uInvProj;
    uniform vec3 uUpView;
    uniform float uStrength, uWet, uSteps, uDebug;
    varying vec2 vUv;

    vec3 viewPos(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      vec4 v = uInvProj * clip;
      return v.xyz / v.w;
    }

    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      if (uDebug > 0.5) {
        vec3 dp = viewPos(vUv);
        if (uDebug < 1.5) { gl_FragColor = vec4(vec3(-dp.z / 120.0), 1.0); return; }
        vec3 dn = normalize(cross(dFdx(dp), dFdy(dp)));
        if (dot(dn, dp) > 0.0) dn = -dn;
        gl_FragColor = vec4(vec3(max(0.0, dot(dn, uUpView))), 1.0); return;
      }
      float wet = uWet;
      if (wet < 0.01) { gl_FragColor = vec4(col, 1.0); return; }

      vec3 P = viewPos(vUv);
      // sky, or so far off that a reflection would be a single pixel of noise
      if (-P.z > 260.0 || -P.z < 0.05) { gl_FragColor = vec4(col, 1.0); return; }

      /* The normal comes from the depth buffer's own slope. On a road that is
         steady; on a silhouette edge it is nonsense, which is exactly where the
         "is this floor" test throws it away. */
      vec3 n = normalize(cross(dFdx(P), dFdy(P)));
      /* Resolve the winding against the eye, never against world up. Flipping
         it towards up turns a tunnel ceiling into a floor, and the ceiling then
         mirrors the sodium bands into a great orange cross across the frame. */
      if (dot(n, P) > 0.0) n = -n;
      float floorness = smoothstep(0.88, 0.98, dot(n, uUpView));
      if (floorness < 0.01) { gl_FragColor = vec4(col, 1.0); return; }

      vec3 V = normalize(P);
      vec3 R = reflect(V, n);
      if (R.z > 0.0) { gl_FragColor = vec4(col, 1.0); return; }   // pointing behind the eye

      /* Start each ray a random fraction of a step along. Without it every ray
         in a neighbourhood crosses the surface at the same step index and the
         reflection arrives as chunky parallelograms — the march's own stride,
         drawn on the road. Jitter turns that banding into noise, which the eye
         reads as the texture of wet tarmac rather than as an artefact. */
      float dither = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
      float stepLen = 0.35 + (-P.z) * 0.02;
      vec3 pos = P + n * 0.06 + R * stepLen * dither;
      float found = 0.0;
      vec2 hitUv = vec2(0.0);
      vec3 prev = pos;

      for (int i = 0; i < 40; i++) {
        if (float(i) >= uSteps) break;
        prev = pos;
        pos += R * stepLen;
        stepLen *= 1.16;
        vec4 clip = uProj * vec4(pos, 1.0);
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
        float sceneZ = viewPos(uv).z;
        float behind = sceneZ - pos.z;           // >0 when the ray is behind the surface
        if (behind > 0.0 && behind < stepLen * 2.2) {
          /* Halve back and forth a few times: the coarse step says which stride
             the crossing is in, this says where in it. */
          vec3 lo = prev, hi = pos;
          for (int k = 0; k < 4; k++) {
            vec3 mid = (lo + hi) * 0.5;
            vec4 c2 = uProj * vec4(mid, 1.0);
            vec2 u2 = c2.xy / c2.w * 0.5 + 0.5;
            if (viewPos(u2).z - mid.z > 0.0) hi = mid; else lo = mid;
          }
          vec4 c3 = uProj * vec4(hi, 1.0);
          hitUv = c3.xy / c3.w * 0.5 + 0.5;
          found = 1.0;
          break;
        }
      }

      if (found > 0.5) {
        vec3 refl = texture2D(tDiffuse, hitUv).rgb;
        /* Fade at the edges of the screen, where the information simply is not
           there, and by grazing angle — a road seen from above barely mirrors. */
        vec2 e = abs(hitUv - 0.5) * 2.0;
        float edge = (1.0 - smoothstep(0.75, 1.0, max(e.x, e.y)));
        float fresnel = pow(1.0 - max(0.0, dot(-V, n)), 2.4);
        float k = clamp(uStrength * wet * floorness * fresnel * edge, 0.0, 0.85);
        col = mix(col, refl, k);
      }

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
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples });
  /* The reflection pass needs to know how far away every pixel is. Both of the
     composer's ping-pong buffers share this one depth texture, which is safe
     because only the scene pass ever writes to it and the reflection pass reads
     it immediately afterwards. */
  target.depthTexture = new THREE.DepthTexture(size.x, size.y);
  target.depthTexture.type = THREE.UnsignedIntType;
  const composer = new EffectComposer(renderer, target);
  /* EffectComposer keeps two buffers and clones the one it is given — and the
     clone gets a depth texture of its own. The scene pass writes into whichever
     buffer is current, so half the time the depth the reflection pass reads is
     the one nobody wrote to. It measured as a depth buffer that was empty
     everywhere. Point both at the same texture and drop the spare, which the
     frame-budget test would otherwise count as a leak. */
  if (composer.renderTarget2.depthTexture) composer.renderTarget2.depthTexture.dispose();
  composer.renderTarget2.depthTexture = target.depthTexture;
  composer.addPass(new RenderPass(scene, camera));

  const ssr = new ShaderPass(SSRShader);
  ssr.material.uniforms.tDepth.value = target.depthTexture;
  composer.addPass(ssr);

  /* Leave the threshold alone. Raising it from 0.42 to 0.70 to shrink the halo
     under the bike was measured and it was wrong on every axis: bright pixels
     18938 against 878, frame-to-frame flicker 29.6% against 19.5%, and the halo
     itself twenty times worse. The radius argument here is decorative anyway —
     applyBloomScale overwrites it on the next line. */
  const bloom = new UnrealBloomPass(size.clone().multiplyScalar(bloomScale), 0.95, 0.72, 0.42);
  composer.addPass(bloom);
  applyBloomScale(bloom, size, bloomScale);   // after addPass: it re-sizes passes

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  composer.addPass(new OutputPass());

  return { composer, bloom, grade, ssr };
}
