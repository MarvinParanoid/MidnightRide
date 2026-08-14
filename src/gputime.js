/**
 * How long the GPU actually spent on the frame.
 *
 * Everything in this project has been measured except the one number that
 * matters for performance. Wall-clock time around a draw call measures nothing:
 * the calls are queued and return long before the GPU has done any of the work,
 * and three separate attempts here produced a spread wider than the effect
 * being measured.
 *
 * EXT_disjoint_timer_query_webgl2 is the answer. The GPU timestamps its own
 * command stream and the result comes back a few frames later, asynchronously,
 * without stalling anything.
 *
 * Two constraints shape the code. Only one TIME_ELAPSED query may be active at
 * a time, so this times the whole frame rather than individual passes. And a
 * query can come back "disjoint" — the GPU was interrupted or throttled during
 * it — in which case the number is meaningless and gets thrown away rather than
 * averaged in.
 */
export class GpuTime {
  constructor(renderer) {
    const gl = renderer.getContext();
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.ms = 0;
    this.active = false;
    /* Not on every browser: it was pulled from Chrome and Firefox in 2016 over
       a timing-attack worry and only came back to desktop Chrome. */
    this.supported = !!this.ext;
  }

  begin() {
    if (!this.supported || this.active) return;
    const gl = this.gl;
    this.query = gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.query);
    this.active = true;
  }

  end() {
    if (!this.active) return;
    const gl = this.gl;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.query);
    this.active = false;
    this.poll();
  }

  poll() {
    const gl = this.gl;
    /* Results arrive a frame or three late; anything still in flight stays in
       the queue. The queue is bounded because a query is only added once a
       frame and removed as soon as it resolves. */
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        const ms = ns / 1e6;
        // smoothed, because a single frame's number bounces around
        this.ms = this.ms ? this.ms * 0.85 + ms * 0.15 : ms;
      }
      gl.deleteQuery(q);
    }
    if (this.pending.length > 8) gl.deleteQuery(this.pending.shift());
  }
}
