import * as THREE from 'three';
import { mulberry32 } from './geo.js';
import { Glow, GlowField } from './glow.js';

/* ────────────────────────────────────────────────────────────
   Every texture in the game is drawn here, at runtime, on a
   canvas. No binary assets, no loading screen.
   ──────────────────────────────────────────────────────────── */

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function texture(c, { repeat = null, srgb = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/** Soft radial falloff — used for every light bloom, halo and pool. */
function glowTexture() {
  const [c, x] = canvas(128, 128);
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.62)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.15)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return texture(c);
}

/** A soft dot for point sprites, deliberately without mipmaps.
    A GL point that covers a handful of pixels samples a coarse mip level, and
    a coarse mip of a radial gradient has averaged out to a flat disc of alpha —
    so the point stops fading towards its own edge and draws as a square. The
    same failure put a grey square on the verge next to a street lamp. Points
    are small by nature, so there is nothing for mipmaps to do here anyway. */
function dotTexture() {
  const [c, x] = canvas(64, 64);
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.4)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.08)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = texture(c);
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

/** A vertical smear: bright at the top, dissolving downward. Wet-asphalt reflection. */
function streakTexture() {
  const [c, x] = canvas(64, 256);
  for (let y = 0; y < 256; y++) {
    const t = 1 - y / 255;
    const a = Math.pow(t, 2.1);
    for (let px = 0; px < 64; px++) {
      const dx = Math.abs(px - 31.5) / 31.5;
      // reflections spread out as they travel away from the source
      const spread = 1 - Math.pow(dx, 1.4 + t * 1.6);
      const wobble = 0.72 + 0.28 * Math.sin(y * 0.19 + px * 0.05);
      x.fillStyle = `rgba(255,255,255,${Math.max(0, a * spread * wobble)})`;
      x.fillRect(px, y, 1, 1);
    }
  }
  return texture(c);
}

/** Fades away from the centre horizontally, constant along its length.
    For light bands smeared down the road — tunnel walls, bridge rails. */
function bandTexture() {
  const [c, x] = canvas(64, 4);
  for (let px = 0; px < 64; px++) {
    const d = Math.abs(px - 31.5) / 31.5;
    const a = Math.pow(1 - d, 2.2);
    x.fillStyle = `rgba(255,255,255,${a})`;
    x.fillRect(px, 0, 1, 4);
  }
  const t = texture(c);
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Lit apartment windows. Alpha-punched so unlit windows read as holes. */
function windowTexture(seed = 7) {
  const rnd = mulberry32(seed);
  const [c, x] = canvas(128, 256);
  x.fillStyle = '#000';
  x.fillRect(0, 0, 128, 256);
  const cols = 8, rows = 20;
  const cw = 128 / cols, rh = 256 / rows;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      if (rnd() > 0.26) continue;
      const warm = rnd();
      const col =
        warm > 0.82 ? [120, 190, 255] : warm > 0.6 ? [255, 214, 150] : [255, 176, 90];
      const a = 0.18 + rnd() * 0.5;
      x.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`;
      x.fillRect(i * cw + cw * 0.2, r * rh + rh * 0.25, cw * 0.6, rh * 0.45);
    }
  }
  return texture(c, { repeat: [1, 1], srgb: true });
}

/**
 * An atlas of sign characters, drawn stroke by stroke.
 *
 * Not a font: a CJK font is not on every machine this runs on, and a missing
 * one renders as tofu boxes, which is a worse sign than no sign. Han characters
 * are strokes on a square grid — horizontals that rise slightly to the right,
 * verticals that sometimes hook, a few diagonals — assembled as one part, or a
 * narrow radical beside a body, or two halves stacked. Built that way they read
 * correctly at the size and distance a neon sign is ever seen from, and they
 * cannot accidentally spell anything.
 */
function glyphTexture(seed = 41) {
  const rnd = mulberry32(seed);
  const GRID = 4, CELL = 128, PAD = 22;
  const [c, x] = canvas(GRID * CELL, GRID * CELL);
  x.strokeStyle = '#fff';
  x.lineCap = 'round';
  x.lineJoin = 'round';

  for (let i = 0; i < GRID * GRID; i++) {
    const ox = (i % GRID) * CELL + PAD;
    const oy = ((i / GRID) | 0) * CELL + PAD;
    const size = CELL - PAD * 2;
    x.lineWidth = Math.max(2.5, size * 0.085);

    const U = (v) => ox + v * size;
    const V = (v) => oy + v * size;
    const line = (x0, y0, x1, y1) => {
      x.beginPath(); x.moveTo(U(x0), V(y0)); x.lineTo(U(x1), V(y1)); x.stroke();
    };
    /* A horizontal stroke lifts a little to the right — the single thing that
       stops a grid of straight lines looking like a waffle. */
    const hor = (y, x0, x1) => line(x0, y, x1, y - 0.02);
    const ver = (xx, y0, y1, hook) => {
      x.beginPath(); x.moveTo(U(xx), V(y0)); x.lineTo(U(xx), V(y1));
      if (hook) x.lineTo(U(xx - 0.1), V(y1 - 0.06));
      x.stroke();
    };

    /** One component, inside the box it is given. */
    const part = (x0, x1, y0, y1) => {
      const w = x1 - x0, h = y1 - y0;
      const style = (rnd() * 4) | 0;
      if (style === 0) {                       // stacked bars through a stem
        const n = 2 + ((rnd() * 3) | 0);
        for (let k = 0; k < n; k++) hor(y0 + (h * (k + 0.5)) / n, x0, x1);
        ver(x0 + w * (0.35 + rnd() * 0.3), y0, y1, rnd() < 0.4);
      } else if (style === 1) {                // an enclosure with something in it
        x.strokeRect(U(x0), V(y0), w * size, h * size);
        hor(y0 + h * 0.5, x0 + w * 0.18, x1 - w * 0.18);
        if (rnd() < 0.5) ver(x0 + w * 0.5, y0 + h * 0.2, y1 - h * 0.2, false);
      } else if (style === 2) {                // a roof over a pair of legs
        hor(y0 + h * 0.16, x0, x1);
        line(x0 + w * 0.5, y0 + h * 0.3, x0 + w * 0.08, y1);
        line(x0 + w * 0.5, y0 + h * 0.3, x1 - w * 0.08, y1);
        if (rnd() < 0.45) hor(y0 + h * 0.6, x0 + w * 0.2, x1 - w * 0.2);
      } else {                                 // a stem crossed once or twice
        ver(x0 + w * 0.5, y0, y1, rnd() < 0.5);
        hor(y0 + h * (0.3 + rnd() * 0.2), x0, x1);
        if (rnd() < 0.6) hor(y0 + h * 0.75, x0 + w * 0.12, x1 - w * 0.12);
      }
    };

    const layout = rnd();
    if (layout < 0.4) part(0, 1, 0, 1);
    else if (layout < 0.75) { part(0, 0.34, 0.05, 0.95); part(0.46, 1, 0, 1); }
    else { part(0, 1, 0, 0.44); part(0.06, 0.94, 0.56, 1); }
  }

  return texture(c);
}

/** Patchy roughness: dark = mirror-smooth puddle, light = dry tarmac. */
function wetnessTexture(seed = 3) {
  const rnd = mulberry32(seed);
  const [c, x] = canvas(256, 256);
  x.fillStyle = '#c8c8c8';
  x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 90; i++) {
    const px = rnd() * 256, py = rnd() * 256, r = 8 + rnd() * 46;
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    const dark = 10 + rnd() * 40;
    g.addColorStop(0, `rgba(${dark},${dark},${dark},0.9)`);
    g.addColorStop(1, 'rgba(200,200,200,0)');
    x.fillStyle = g;
    x.beginPath();
    x.ellipse(px, py, r, r * (0.35 + rnd() * 0.5), rnd() * Math.PI, 0, Math.PI * 2);
    x.fill();
  }
  // fine grain so the tarmac isn't a flat mirror
  const img = x.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 46;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  x.putImageData(img, 0, 0);
  /* Three tiles across the carriageway and four along the same distance.
     It was [3, 40], and that is where the washboard on the road came from: the
     ribbon's v runs one unit per sixteen metres, so forty repeats laid the map
     down every forty-two centimetres along the road while still spanning four
     metres across it. A tile ten times longer than it is wide, seen at the
     angle a road is always seen at, is a picket fence — and no amount of
     anisotropic filtering helps, because the fence is in the content and not in
     the sampling. Measured on a frame at the start line: the ripple across the
     tarmac reads 1.19 at [3, 40] and 0.10 with the map switched off entirely.
     Square tiles instead, about four metres each way, which is what a puddle
     is. */
  return texture(c, { repeat: [3, 4] });
}

/* ────────────────────────────────────────────────────────────
   Lazily-built shared singletons.
   ──────────────────────────────────────────────────────────── */

let cache = null;

export function assets() {
  if (cache) return cache;

  const glow = glowTexture();
  const dot = dotTexture();
  const glyphs = glyphTexture();
  const streak = streakTexture();
  const band = bandTexture();
  const wetness = wetnessTexture();
  const windows = windowTexture();

  const additive = (map, color, opacity = 1) =>
    new THREE.MeshBasicMaterial({
      map,
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

  /* A cone of lit air under a lamp. It only exists when there is something in
     the air to scatter off — dry night, no shaft — so its strength is driven
     from the weather each frame rather than baked into the chunk. */
  const shaft = new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(0xffc074) },
      opacity: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float opacity;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        /* Bright at the lamp, gone before the road — a shaft that reaches the
           tarmac at full strength reads as a solid cone of plastic. */
        float down = pow(1.0 - vUv.y, 1.7);
        /* And fade where the shell turns edge-on to you. The first version
           faded across the unwrapped circumference instead, which put a dark
           seam down one side of the cone and left the opposite side at full
           strength — the straight hard edge that gave the whole thing away as
           a piece of geometry rather than lit air. */
        /* normalize() of a zero vector is a division by zero, and the result is
           NaN. A cone whose top and bottom rings coincide has zero-area faces,
           computeVertexNormals() hands those a zero normal, and the NaN lands in
           the alpha — where this GPU flushes it to nothing and another paints
           black. That is what the ring of dark dashes under every lamp was, and
           it cost a day precisely because it could not be reproduced here. The
           geometry no longer degenerates, but nothing downstream should be able
           to make a shader produce black either. */
        float nl = length(vNormal), vl = length(vView);
        float face = nl > 1e-5 && vl > 1e-5
          ? pow(abs(dot(vNormal / nl, vView / vl)), 0.55)
          : 0.0;
        gl_FragColor = vec4(color, max(0.0, down * face * opacity));
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });

  cache = {
    shaft,
    tex: { glow, dot, streak, band, wetness, windows, glyphs },

    /* surfaces */
    asphalt: new THREE.MeshStandardMaterial({
      color: 0x07080c,
      roughness: 0.34,
      metalness: 0.62,
      roughnessMap: wetness,
    }),
    shoulder: new THREE.MeshStandardMaterial({ color: 0x0a0a0d, roughness: 0.9, metalness: 0.1 }),
    ground: new THREE.MeshStandardMaterial({
      color: 0x05060a, roughness: 1.0, metalness: 0.0, emissive: 0x04060e, emissiveIntensity: 1,
    }),
    /* Double-sided on purpose: a tunnel is a shell you stand inside, and the
       ribbons that make it wind outward, so single-sided walls and ceiling are
       invisible from the one place you ever see them from. */
    concrete: new THREE.MeshStandardMaterial({
      color: 0x0e1015, roughness: 0.78, metalness: 0.14, side: THREE.DoubleSide,
    }),
    metal: new THREE.MeshStandardMaterial({ color: 0x232936, roughness: 0.34, metalness: 0.92 }),
    // a touch of self-illumination so building masses read against the sky
    dark: new THREE.MeshStandardMaterial({
      color: 0x090a10, roughness: 0.85, metalness: 0.25,
      // low enough that walls stay silhouettes: at higher values a flat face
      // picks up the whole sky and reads as an untextured purple panel
      emissive: 0x080b16, emissiveIntensity: 1, envMapIntensity: 0.16,
    }),
    foliage: new THREE.MeshStandardMaterial({ color: 0x080f0d, roughness: 1.0, metalness: 0.0 }),
    /* A perfect mirror at night reflects a black sky and disappears. A little
       roughness catches the horizon glow, and a trace of emissive keeps the sea
       a shade lighter than the land it meets. */
    water: new THREE.MeshStandardMaterial({
      color: 0x03060f, roughness: 0.16, metalness: 0.95,
      emissive: 0x050b1c, emissiveIntensity: 1, envMapIntensity: 2.2,
    }),

    /* Paint — unlit so it survives the dark and feeds the bloom a little.
       Offset in the depth buffer's own units rather than in metres. Road paint
       is a coplanar surface, and lifting it by a fixed distance cannot work:
       the buffer's resolution falls off as the square of the range, so any gap
       that is comfortable up close is below the noise floor further out, and
       the road and its markings then win alternate pixels — the paint breaks
       into black dashes along a band at a fixed distance. Polygon offset moves
       the paint by a fraction of whatever the local depth step happens to be,
       which is the same everywhere. */
    paintWhite: new THREE.MeshBasicMaterial({
      color: 0x8d97ab, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
    }),
    paintYellow: new THREE.MeshBasicMaterial({
      color: 0x9b8140, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6,
    }),

    /* Emissive building windows.
       Additive, and that is not a stylistic choice. The texture is lit windows
       drawn on a black field, and with ordinary blending a coarse mip level
       averages that into dark grey at partial opacity — so a distant or
       edge-on facade stopped being windows and became a sheet of tinted glass
       laid over whatever was behind it. That is the dark translucent rectangle
       that has been turning up next to lamps. Lit windows add light; they do
       not occlude, and an averaged black field adds nothing. */
    windows: new THREE.MeshBasicMaterial({
      map: windows,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      /* One side, now that the quads are all wound outward. Measured on a city
         frame: drawing both lit eighteen thousand pixels that the front faces
         alone do not, and those are the far walls of buildings adding light
         through their own shells. */
      side: THREE.FrontSide,
      color: 0xffffff,
    }),

    /* additive helpers */
    additive,
    /* Not a THREE.Sprite any more — a handle the GlowField renders in one
       instanced draw. Same properties, so nothing at the call sites changed. */
    glowField: new GlowField(),
    glowSprite: (color, scale, opacity = 1) => new Glow(color, scale, opacity),
  };

  return cache;
}

/** HDR-ish colour: values above 1.0 punch through the bloom threshold. */
export function neon(hex, intensity = 1) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(intensity);
  return c;
}

export const NEON_PALETTE = [0xff2f6d, 0x24d6ff, 0xb14dff, 0xff8a1e, 0x2bffb0, 0xff3fd0];
