import * as THREE from 'three';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { clamp, damp } from './geo.js';

/**
 * Photo mode. For a project like this it is the marketing: people will make
 * better pictures of it than any screenshot I'd take, and then post them.
 *
 * Freezes the world, hands you a free camera around the bike, gives you a real
 * depth of field, and writes a PNG straight out of the drawing buffer.
 */
export class PhotoMode {
  constructor({ camera, renderer, scene, composer, canvas }) {
    this.camera = camera;
    this.renderer = renderer;
    this.scene = scene;
    this.composer = composer;
    this.canvas = canvas;

    this.active = false;
    this.hideUi = false;
    this.wantShot = false;

    this.yaw = 0.6;
    this.pitch = 0.16;
    this.dist = 7.5;
    this.fov = 42;
    this.focus = 8;
    this.aperture = 0.006;
    this.autoFocus = true;

    this.target = new THREE.Vector3();
    this.dragging = false;
    this.lastX = 0;
    this.lastY = 0;
    this.savedFov = 60;

    this.bindPointer();
  }

  bindPointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.active || !this.dragging) return;
      this.yaw -= (e.clientX - this.lastX) * 0.006;
      this.pitch = clamp(this.pitch + (e.clientY - this.lastY) * 0.004, -0.35, 1.15);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    const stop = (e) => {
      this.dragging = false;
      if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointercancel', stop);
    c.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      if (e.shiftKey) this.fov = clamp(this.fov + Math.sign(e.deltaY) * 2, 12, 100);
      else this.dist = clamp(this.dist * (1 + Math.sign(e.deltaY) * 0.09), 1.6, 60);
    }, { passive: false });
  }

  enter(bikePos, heading) {
    this.active = true;
    this.savedFov = this.camera.fov;
    this.yaw = -heading + 0.7;
    this.pitch = 0.16;
    this.dist = 7.5;
    this.autoFocus = true;
    if (!this.bokeh) {
      this.bokeh = new BokehPass(this.scene, this.camera, {
        focus: this.focus, aperture: this.aperture, maxblur: 0.012,
      });
    }
    // straight after the render pass, so bloom still blooms the blurred image
    this.composer.insertPass(this.bokeh, 1);
  }

  exit() {
    this.active = false;
    if (this.bokeh) this.composer.removePass(this.bokeh);
    this.camera.fov = this.savedFov;
    this.camera.updateProjectionMatrix();
  }

  nudge(what, dir) {
    if (what === 'focus') {
      this.autoFocus = false;
      this.focus = clamp(this.focus * (1 + dir * 0.12), 0.6, 400);
    } else if (what === 'aperture') {
      this.aperture = clamp(this.aperture * (1 + dir * 0.25), 0.0004, 0.03);
    }
  }

  update(dt, bikePos) {
    this.target.copy(bikePos);
    this.target.y += 0.95;

    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist
    );
    this.camera.lookAt(this.target);
    this.camera.fov = damp(this.camera.fov, this.fov, 10, dt);
    this.camera.updateProjectionMatrix();

    if (this.autoFocus) this.focus = this.dist;
    if (this.bokeh) {
      this.bokeh.uniforms.focus.value = this.focus;
      this.bokeh.uniforms.aperture.value = this.aperture;
    }
  }

  /** Called immediately after the frame is rendered, while the buffer is intact. */
  maybeCapture(place) {
    if (!this.wantShot) return null;
    this.wantShot = false;
    try {
      const url = this.canvas.toDataURL('image/png');
      const a = document.createElement('a');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `midnight-ride-${(place || 'night').toLowerCase().replace(/\s+/g, '-')}-${stamp}.png`;
      a.href = url;
      a.click();
      return a.download;
    } catch {
      return null;
    }
  }

  get readout() {
    return {
      fov: Math.round(this.camera.fov),
      focus: this.focus.toFixed(1),
      // not a real f-stop, so don't dress it up as one
      blur: (this.aperture * 1000).toFixed(1),
      dist: this.dist.toFixed(1),
    };
  }
}
