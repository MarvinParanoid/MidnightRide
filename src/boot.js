import './style.css';
import { telemetry, webglSupported } from './telemetry.js';

/**
 * A WebGL game that fails to start looks exactly like a game nobody liked:
 * the store counts the view either way. So the one case worth catching before
 * anything else is "this browser can't run it at all" — say so plainly, and
 * count it separately from people who left.
 */
if (webglSupported()) {
  import('./main.js');
} else {
  telemetry.fail('nowebgl');
  document.body.innerHTML = `
    <div id="start" style="opacity:1">
      <h1>MIDNIGHT RIDE</h1>
      <div class="tag">this browser can't run WebGL</div>
      <div class="keys">
        It needs hardware acceleration switched on.<br />
        In Chrome or Edge: Settings → System → "Use graphics acceleration when available".
      </div>
    </div>
  `;
}
