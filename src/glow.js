import * as THREE from 'three';

/**
 * Every light bloom, halo and lamp reflection in the game, in one draw call.
 *
 * These used to be THREE.Sprite objects, one each. Measured on a highway frame:
 * 128 of the 346 draw calls — thirty-nine per cent of the frame — were sprites,
 * and there were no instanced meshes at all. A sprite is a quad with a texture;
 * there is no reason for each one to be its own call.
 *
 * The catch is that the glows live all over the scene graph — bolted to cars, to
 * the bike, to chunk props — and they inherit those transforms. So the handles
 * stay exactly where they were, as plain Object3Ds: they cost nothing to render
 * because an Object3D is not renderable, but the graph still positions them.
 * Once a frame this walks the visible scene, reads their world matrices, and
 * fills the instance buffers of a single quad mesh.
 *
 * Walking the graph rather than keeping a registry means a chunk that gets
 * disposed simply stops being visited — no bookkeeping, and nothing to leak.
 */

/** A stand-in for THREE.Sprite: same handful of properties the game sets. */
export class Glow extends THREE.Object3D {
  constructor(color, scale, opacity = 1) {
    super();
    this.isGlow = true;
    this.scale.setScalar(scale);
    // shaped like a material so existing code can keep setting .opacity/.color
    this.material = { color: new THREE.Color(color), opacity };
  }
}

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    vUv = uv;
    vColor = instanceColor;
    /* Billboard: take only the instance's world position into view space, then
       offset in view space, so the quad always squarely faces the camera. */
    vec3 t = instanceMatrix[3].xyz;
    vec2 s = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
    vec4 mv = modelViewMatrix * vec4(t, 1.0);
    mv.xy += position.xy * s;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  void main() {
    /* Computed, not sampled. A mipmapped radial gradient flattens to a solid
       disc of alpha at coarse levels, so a glow that is small on screen stops
       fading towards its edge and draws as a translucent square. Same defect
       that put a square on the verge and turned road spray into confetti.
       Exponent fitted against the texture it replaces by integrated energy,
       not by eye: 2.6 came out 15% dim in a same-position comparison, 2.4
       matches it to within 2%. */
    float r = length(vUv - 0.5) * 2.0;
    float a = pow(max(0.0, 1.0 - r), 2.4);
    /* Premultiplied, so additive blending is a straight ONE/ONE add. */
    gl_FragColor = vec4(vColor * a, a);
  }
`;

export class GlowField {
  constructor(max = 1024) {
    this.max = max;
    const material = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;      // the glows span the whole world
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 6;            // additive light sits on top of the wet road
    this.mesh.count = 0;
    this._m = new THREE.Matrix4();
    this._c = new THREE.Color();
  }

  /** Call after the world has moved and before rendering. */
  update(scene) {
    scene.updateMatrixWorld();
    const im = this.mesh.instanceMatrix.array;
    const ic = this.mesh.instanceColor.array;
    let n = 0;
    scene.traverseVisible((o) => {
      if (!o.isGlow || n >= this.max) return;
      const op = o.material.opacity;
      if (op <= 0.002) return;            // a glow that is off costs nothing
      const e = o.matrixWorld.elements;
      const sx = Math.hypot(e[0], e[1], e[2]);
      const sy = Math.hypot(e[4], e[5], e[6]);
      const i = n * 16;
      im[i] = sx; im[i + 1] = 0; im[i + 2] = 0; im[i + 3] = 0;
      im[i + 4] = 0; im[i + 5] = sy; im[i + 6] = 0; im[i + 7] = 0;
      im[i + 8] = 0; im[i + 9] = 0; im[i + 10] = 1; im[i + 11] = 0;
      im[i + 12] = e[12]; im[i + 13] = e[13]; im[i + 14] = e[14]; im[i + 15] = 1;
      const c = o.material.color;
      const j = n * 3;
      // fold opacity into the colour: with an additive blend that is identical
      ic[j] = c.r * op; ic[j + 1] = c.g * op; ic[j + 2] = c.b * op;
      n++;
    });
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    return n;
  }
}
