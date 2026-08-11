import * as THREE from 'three';
import { mulberry32 } from './geo.js';

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
  return texture(c, { repeat: [3, 40] });
}

/* ────────────────────────────────────────────────────────────
   Lazily-built shared singletons.
   ──────────────────────────────────────────────────────────── */

let cache = null;

export function assets() {
  if (cache) return cache;

  const glow = glowTexture();
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

  cache = {
    tex: { glow, streak, band, wetness, windows },

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
      emissive: 0x080b16, emissiveIntensity: 1, envMapIntensity: 0.35,
    }),
    foliage: new THREE.MeshStandardMaterial({ color: 0x080f0d, roughness: 1.0, metalness: 0.0 }),
    water: new THREE.MeshStandardMaterial({ color: 0x02030a, roughness: 0.08, metalness: 1.0 }),

    /* paint — unlit so it survives the dark and feeds the bloom a little */
    paintWhite: new THREE.MeshBasicMaterial({ color: 0x8d97ab, toneMapped: false }),
    paintYellow: new THREE.MeshBasicMaterial({ color: 0x9b8140, toneMapped: false }),

    /* emissive building windows */
    windows: new THREE.MeshBasicMaterial({
      map: windows,
      transparent: true,
      toneMapped: false,
      side: THREE.DoubleSide,
      color: 0xffffff,
    }),

    /* additive helpers */
    additive,
    glowSprite: (color, scale, opacity = 1) => {
      const m = new THREE.SpriteMaterial({
        map: glow,
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });
      const s = new THREE.Sprite(m);
      s.scale.setScalar(scale);
      return s;
    },
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
