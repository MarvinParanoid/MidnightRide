import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

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
    uThickness: { value: 0.55 },
    uRes: { value: new THREE.Vector2(1, 1) },
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
    uniform float uStrength, uWet, uSteps, uThickness, uDebug;
    uniform vec2 uRes;
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
      if (wet < 0.01) { gl_FragColor = vec4(0.0); return; }

      vec3 P = viewPos(vUv);
      // sky, or so far off that a reflection would be a single pixel of noise
      if (-P.z > 260.0 || -P.z < 0.05) { gl_FragColor = vec4(0.0); return; }

      /* The normal comes from the depth buffer's own slope. On a road that is
         steady; on a silhouette edge it is nonsense, which is exactly where the
         "is this floor" test throws it away. */
      vec3 n = normalize(cross(dFdx(P), dFdy(P)));
      /* Resolve the winding against the eye, never against world up. Flipping
         it towards up turns a tunnel ceiling into a floor, and the ceiling then
         mirrors the sodium bands into a great orange cross across the frame. */
      if (dot(n, P) > 0.0) n = -n;
      float floorness = smoothstep(0.88, 0.98, dot(n, uUpView));
      if (floorness < 0.01) { gl_FragColor = vec4(0.0); return; }

      vec3 V = normalize(P);
      vec3 R = reflect(V, n);
      /* A ray coming back towards the eye can only ever hit something already
         in front of what it is reflecting, so it is fade rather than cut: a
         hard cut there is a visible line across the road. */
      float towardsEye = 1.0 - smoothstep(-0.15, 0.05, R.z);
      if (towardsEye < 0.01) { gl_FragColor = vec4(0.0); return; }

      /* March in screen space, one pixel at a time.
         The first version stepped through view space by a distance that grew
         geometrically — which oversamples near the camera, undersamples far
         from it, and never covers the whole ray, so a lamp fifty metres off
         could not be found at all. Walking the projected line instead means
         every step lands on a new pixel and the stride is chosen so the ray's
         whole screen-space length fits in the budget. This is the DDA setup
         from kode80's write-up, with the perspective-correct 1/w carried along
         so the depth at each pixel is exact rather than interpolated linearly. */
      vec3 startV = P + n * 0.05;
      vec3 endV = startV + R * 140.0;
      if (endV.z > -0.1) endV = startV + R * ((-0.1 - startV.z) / R.z);   // clip to the near plane

      vec4 h0 = uProj * vec4(startV, 1.0);
      vec4 h1 = uProj * vec4(endV, 1.0);
      float k0 = 1.0 / h0.w, k1 = 1.0 / h1.w;
      vec3 q0 = startV * k0, q1 = endV * k1;
      vec2 p0 = (h0.xy * k0 * 0.5 + 0.5) * uRes;
      vec2 p1 = (h1.xy * k1 * 0.5 + 0.5) * uRes;
      if (distance(p0, p1) < 1.0) p1 += vec2(1.0);

      vec2 dxy = p1 - p0;
      bool permute = abs(dxy.x) < abs(dxy.y);      // step along the longer axis
      if (permute) { p0 = p0.yx; p1 = p1.yx; dxy = dxy.yx; }
      float sx = sign(dxy.x);
      float invdx = sx / dxy.x;
      vec2 dp = vec2(sx, dxy.y * invdx);
      vec3 dq = (q1 - q0) * invdx;
      float dk = (k1 - k0) * invdx;

      // one step per pixel where the budget allows it, longer when it does not
      float stride = max(1.0, abs(dxy.x) / uSteps);
      dp *= stride; dq *= stride; dk *= stride;

      float dither = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
      vec2 pp = p0 + dp * dither;
      vec3 qq = q0 + dq * dither;
      float kk = k0 + dk * dither;

      float prevZ = startV.z;
      float found = 0.0;
      float travelled = 0.0;
      vec2 hitUv = vec2(0.0);
      vec2 prevP = pp;
      float prevQz = qq.z, prevK = kk;

      for (int i = 0; i < 64; i++) {
        if (float(i) >= uSteps) break;
        prevP = pp; prevQz = qq.z; prevK = kk;
        pp += dp; qq += dq; kk += dk;
        vec2 uv = (permute ? pp.yx : pp) / uRes;
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

        float rayZ = qq.z / kk;
        float sceneZ = viewPos(uv).z;
        travelled = abs(rayZ - startV.z);
        /* A crossing: the ray was in front of the surface and is now behind it,
           and not so far behind that it has passed through something thin. */
        if (prevZ >= sceneZ && rayZ < sceneZ && sceneZ - rayZ < uThickness + travelled * 0.04) {
          vec2 lo = prevP, hi = pp;
          float lq = prevQz, hq = qq.z, lk = prevK, hk = kk;
          for (int b = 0; b < 4; b++) {
            vec2 mp = (lo + hi) * 0.5;
            float mq = (lq + hq) * 0.5, mk = (lk + hk) * 0.5;
            vec2 muv = (permute ? mp.yx : mp) / uRes;
            if (mq / mk < viewPos(muv).z) { hi = mp; hq = mq; hk = mk; }
            else { lo = mp; lq = mq; lk = mk; }
          }
          hitUv = (permute ? hi.yx : hi) / uRes;
          found = 1.0;
          break;
        }
        prevZ = rayZ;
      }

      if (found < 0.5) { gl_FragColor = vec4(0.0); return; }
      /* The further a ray had to travel to find anything, the less it is worth
         trusting — and the reflection has to thin out rather than stop dead. */
      /* Long reflections are the point on a wet road — a lamp fifty metres off
         streaks all the way back to you. Fading them out at fourteen metres
         removed the artefacts and the subject with them. */
      float reach = 1.0 - smoothstep(45.0, 110.0, travelled);
      {
        vec3 refl = texture2D(tDiffuse, hitUv).rgb;
        /* Fade at the edges of the screen, where the information simply is not
           there, and by grazing angle — a road seen from above barely mirrors. */
        vec2 e = abs(hitUv - 0.5) * 2.0;
        float edge = (1.0 - smoothstep(0.75, 1.0, max(e.x, e.y)));
        float fresnel = pow(1.0 - max(0.0, dot(-V, n)), 2.4);
        float k = clamp(uStrength * wet * floorness * fresnel * edge * reach * towardsEye, 0.0, 0.85);
        gl_FragColor = vec4(refl, k);
      }
    }
  `,
};


/** Lay the half-resolution reflection over the frame it was computed from. */
const SSRCompositeShader = {
  uniforms: { tDiffuse: { value: null }, tRefl: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tRefl;
    varying vec2 vUv;
    void main() {
      vec4 r = texture2D(tRefl, vUv);
      gl_FragColor = vec4(mix(texture2D(tDiffuse, vUv).rgb, r.rgb, r.a), 1.0);
    }
  `,
};

/**
 * The reflection is computed at half resolution and blended back at full.
 *
 * Marching every pixel of the road was enough to push a machine below the frame
 * rate the quality guard watches, and the guard then stepped the whole renderer
 * down a tier — so the reflections appeared for a few seconds and vanished. A
 * reflection on wet tarmac is a low-frequency thing; at half resolution it
 * costs a quarter as much and looks the same.
 */
class SSRPass extends Pass {
  constructor(depthTexture, scale = 0.5) {
    super();
    this.scale = scale;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SSRShader.uniforms),
      vertexShader: SSRShader.vertexShader,
      fragmentShader: SSRShader.fragmentShader,
    });
    this.material.uniforms.tDepth.value = depthTexture;
    this.composite = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SSRCompositeShader.uniforms),
      vertexShader: SSRCompositeShader.vertexShader,
      fragmentShader: SSRCompositeShader.fragmentShader,
    });
    this.quadA = new FullScreenQuad(this.material);
    this.quadB = new FullScreenQuad(this.composite);
  }

  setSize(w, h) {
    const sw = Math.max(2, Math.floor(w * this.scale));
    const sh = Math.max(2, Math.floor(h * this.scale));
    this.target.setSize(sw, sh);
    // the march walks pixels, so it has to know how many there are
    this.material.uniforms.uRes.value.set(sw, sh);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    this.quadA.render(renderer);

    this.composite.uniforms.tDiffuse.value = readBuffer.texture;
    this.composite.uniforms.tRefl.value = this.target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quadB.render(renderer);
  }

  /**
   * What fraction of the road actually found a reflection, 0..1.
   *
   * The pass has been silently doing nothing twice: once with an empty depth
   * buffer, once marching twenty steps when the profile asked for forty-eight.
   * Both times it was configured correctly and produced not one pixel. Reading
   * the alpha it wrote is the only statement that means anything.
   *
   * This stalls the pipeline, so it is for the developer panel and nothing else.
   */
  coverage(renderer) {
    const w = Math.min(128, this.target.width);
    const h = Math.min(64, Math.floor(this.target.height * 0.4));
    const x = Math.floor((this.target.width - w) / 2);
    if (!this._read || this._read.length !== w * h * 4) this._read = new Uint16Array(w * h * 4);
    try {
      renderer.readRenderTargetPixels(this.target, x, 0, w, h, this._read);
    } catch { return -1; }
    /* Half floats, because the target is HDR — neon reflects brighter than 1. */
    const half = (u) => {
      const e = (u & 0x7c00) >> 10, f = u & 0x03ff;
      if (e === 0) return (f / 1024) * 6.103515625e-5;
      if (e === 0x1f) return 1;
      return Math.pow(2, e - 15) * (1 + f / 1024);
    };
    let hit = 0;
    for (let i = 3; i < this._read.length; i += 4) if (half(this._read[i]) > 0.02) hit++;
    return hit / (w * h);
  }

  dispose() {
    this.target.dispose();
    this.quadA.dispose();
    this.quadB.dispose();
  }
}

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

  const ssr = new SSRPass(target.depthTexture);
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
