const MAP = {
  KeyW: 'throttle', ArrowUp: 'throttle',
  KeyS: 'brake', ArrowDown: 'brake',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'boost', ShiftRight: 'boost',
  Space: 'stoppie',
};

export class Input {
  constructor(target = window) {
    this.held = new Set();
    this.taps = new Map();
    this.touch = null;

    target.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const a = MAP[e.code];
      if (a) {
        this.held.add(a);
        e.preventDefault();
      }
      const cb = this.taps.get(e.code);
      if (cb) {
        cb();
        e.preventDefault();
      }
    });

    target.addEventListener('keyup', (e) => {
      const a = MAP[e.code];
      if (a) this.held.delete(a);
    });

    target.addEventListener('blur', () => this.held.clear());

    /* touch: left half steers, right half is throttle, two fingers brake */
    const canvas = document.getElementById('scene');
    if (canvas) {
      const onTouch = (e) => {
        e.preventDefault();
        const w = window.innerWidth;
        let steer = 0, throttle = false, brake = false;
        for (const t of e.touches) {
          if (t.clientX < w * 0.5) steer = ((t.clientX / (w * 0.5)) - 0.5) * 2;
          else if (t.clientY > window.innerHeight * 0.6) brake = true;
          else throttle = true;
        }
        this.touch = e.touches.length ? { steer, throttle, brake } : null;
      };
      canvas.addEventListener('touchstart', onTouch, { passive: false });
      canvas.addEventListener('touchmove', onTouch, { passive: false });
      canvas.addEventListener('touchend', onTouch, { passive: false });
    }
  }

  /** Fire `cb` once per press of a physical key. */
  on(code, cb) {
    this.taps.set(code, cb);
  }

  get throttle() {
    return this.held.has('throttle') || this.touch?.throttle ? 1 : 0;
  }

  get brake() {
    return (this.held.has('brake') || this.touch?.brake ? 1 : 0) + (this.held.has('stoppie') ? 1 : 0);
  }

  get boost() {
    return this.held.has('boost');
  }

  get steer() {
    if (this.touch) return Math.max(-1, Math.min(1, this.touch.steer));
    return (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
  }
}
