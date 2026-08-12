export class Hud {
  constructor(root = document.getElementById('ui')) {
    root.innerHTML = `
      <div class="vig"></div>
      <div class="pane tl">
        <div class="place" data-place>—</div>
        <div class="clock" data-clock>--:--</div>
        <div class="wx" data-wx>—</div>
      </div>
      <div class="pane bl"><div class="spd" data-spd>0</div><div class="unit">km/h</div></div>
      <div class="tach" data-tachwrap><i data-tach></i></div>
      <div class="gear" data-gear>N</div>
      <div class="pane br">
        <div data-biome>—</div>
        <div><b data-odo>0.0</b> km</div>
        <div data-bpm>♪ 84</div>
      </div>
      <div class="pane tr">
        <div><kbd>W</kbd> / <kbd>S</kbd> throttle · brake</div>
        <div><kbd>A</kbd> / <kbd>D</kbd> steer</div>
        <div><kbd>Shift</kbd> boost · <kbd>E</kbd> autopilot</div>
        <div><kbd>C</kbd> camera · <kbd>F</kbd> photo</div>
        <div><kbd>R</kbd> rain · <kbd>M</kbd> music · <kbd>T</kbd> time</div>
      </div>
      <div class="auto" data-autoflag>AUTOPILOT</div>
      <button class="chip" data-auto type="button">AUTO</button>
      <div class="toast" data-toast></div>
    `;
    this.root = root;
    const q = (sel) => root.querySelector(sel);
    this.el = {
      place: q('[data-place]'),
      clock: q('[data-clock]'),
      wx: q('[data-wx]'),
      spd: q('[data-spd]'),
      tach: q('[data-tach]'),
      tachWrap: q('[data-tachwrap]'),
      gear: q('[data-gear]'),
      biome: q('[data-biome]'),
      odo: q('[data-odo]'),
      bpm: q('[data-bpm]'),
      toast: q('[data-toast]'),
      autoFlag: q('[data-autoflag]'),
      chip: q('[data-auto]'),
    };
    this.toastT = 0;
    this.lastSpeed = -1;
    root.classList.add('pre');      // interface stays out of the title screen

    this.start = document.createElement('div');
    this.start.id = 'start';
    this.start.innerHTML = `
      <h1>MIDNIGHT RIDE</h1>
      <div class="tag">No destination. No finish line.<br />Just you, the road, and the night.</div>
      <div class="sub" data-startsub>—</div>
      <div class="back" data-startback></div>
      <!-- No key list on purpose. The hints sit in the corner while you ride,
           and a first screen is not the place for a manual. Touch devices get
           one line here instead, since they have no corner hints. -->
      <div class="keys" data-startkeys></div>
      <div class="go" data-startgo>press any key to ride</div>
    `;
    document.body.appendChild(this.start);

    /* the world comes up out of black a beat after the title goes */
    this.fade = document.createElement('div');
    this.fade.id = 'fade';
    document.body.appendChild(this.fade);

    this.shot = document.createElement('div');
    this.shot.className = 'shotflash';
    document.body.appendChild(this.shot);

    this.bar = document.createElement('div');
    this.bar.className = 'photobar';
    this.bar.innerHTML = `
      <span data-pm></span>
      <em>drag</em> orbit · <em>wheel</em> dolly · <em>shift+wheel</em> lens
      · <em>[ ]</em> focus · <em>- =</em> aperture · <em>H</em> interface
      · <em>Enter</em> save · <em>F</em> back
    `;
    document.body.appendChild(this.bar);
    this.el.pm = this.bar.querySelector('[data-pm]');

    this.rotate = document.createElement('div');
    this.rotate.className = 'rotate';
    this.rotate.textContent = 'turn your phone';
    document.body.appendChild(this.rotate);
  }

  /** Touch layout: on-screen autopilot toggle, thumb-zone instructions. */
  setTouch(onToggleAuto) {
    document.body.classList.add('touch');
    this.el.chip.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggleAuto();
    });
    this.start.querySelector('[data-startkeys]').innerHTML =
      'left thumb steers · right thumb rides<br />AUTO lets it ride itself';
    this.start.querySelector('[data-startgo]').textContent = 'tap anywhere to ride';
  }

  setAuto(on) {
    this.el.autoFlag.classList.toggle('on', on);
    this.el.chip.classList.toggle('on', on);
  }

  setIntro(text) {
    this.start.querySelector('[data-startsub]').textContent = text;
  }

  /** "Welcome back, rider — 184 km travelled." The only progression here. */
  setReturning(km) {
    if (!(km > 1)) return;
    this.start.querySelector('[data-startback]').textContent =
      `Welcome back, rider — ${km < 1000 ? km.toFixed(0) : (km / 1000).toFixed(1) + 'k'} km travelled`;
  }

  /** Lift the black so the world shows through behind the title. */
  revealWorld(delay = 700) {
    setTimeout(() => this.fade.classList.add('clear'), delay);
  }

  dismiss() {
    this.start.classList.add('gone');
    this.root.classList.remove('pre');
    setTimeout(() => this.start.remove(), 1300);
  }

  photoBar(on, readout) {
    this.bar.classList.toggle('on', on);
    if (on && readout) {
      this.el.pm.textContent =
        `${readout.fov}° · focus ${readout.focus}m · blur ${readout.blur} `;
    }
  }

  flashShot() {
    this.shot.classList.add('on');
    setTimeout(() => this.shot.classList.remove('on'), 220);
  }

  toast(text) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('on');
    this.toastT = 3.2;
  }

  photo(on) {
    this.root.classList.toggle('photo', on);
  }

  update(dt, s) {
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) this.el.toast.classList.remove('on');
    }

    const kmh = Math.round(s.kmh);
    if (kmh !== this.lastSpeed) {
      this.el.spd.textContent = kmh;
      this.lastSpeed = kmh;
    }
    this.el.clock.textContent = s.clock;
    this.el.place.textContent = s.place;
    this.el.wx.textContent = `${s.temp}°C · ${s.weather}`;
    this.el.tach.style.width = `${Math.min(100, s.rpm / 98)}%`;
    this.el.tachWrap.classList.toggle('red', s.rpm > 8600);
    this.el.gear.textContent = s.kmh < 2 ? 'N' : `${s.gear}`;
    this.el.biome.textContent = s.biome;
    this.el.odo.textContent = (s.odo / 1000).toFixed(1);
    this.el.bpm.textContent = `♪ ${Math.round(s.bpm)}`;
  }
}

export function formatClock(d = new Date()) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
