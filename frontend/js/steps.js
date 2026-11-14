/* Step detector (pure, sampling-rate independent, unit-testable in Node).
   Pipeline: |a| -> remove slow gravity estimate -> low-pass -> adaptive-threshold peak picking
   -> refractory period (no double counting) -> "walking" gate: a run of >=5 candidate steps with regular spacing (CV<=0.3) and similar peak height (CV<=0.35)
   must occur before any step is counted (then those 4 are credited). */
(function (root) {
  "use strict";
  function StepDetector(o) {
    o = o || {};
    this.minInterval = o.minInterval || 280;   // ms, ~3.5 steps/s max
    this.maxInterval = o.maxInterval || 1500;  // ms, longer pause ends the walking run
    this.warmup = o.warmup || 5;
    this.minThr = o.minThr || 1.2;             // m/s^2 above gravity
    this.count = 0; this._sig();
  }
  StepDetector.prototype._sig = function () {
    this.t = null; this.g = null; this.s = 0; this.env = 0; this.p1 = 0; this.p2 = 0; this.pt = 0;
    this.last = null; this.pending = []; this.walking = false; this.avgIv = 0; this.irregular = 0; this.hs = [];
  };
  /** Feed one accelerometer sample (m/s^2, including gravity) with a ms timestamp. Returns steps added. */
  StepDetector.prototype.push = function (ax, ay, az, t) {
    if (!isFinite(ax) || !isFinite(ay) || !isFinite(az) || !isFinite(t)) return 0;
    if (this.t !== null) { var d0 = t - this.t; if (d0 < 5) return 0; if (d0 > 1000) this._sig(); }   // duplicate event / background gap
    var dt = this.t === null ? 20 : t - this.t; this.t = t;
    var m = Math.sqrt(ax * ax + ay * ay + az * az);
    if (this.g === null) this.g = m;
    this.g += dt / (800 + dt) * (m - this.g);
    this.s += dt / (50 + dt) * ((m - this.g) - this.s);
    this.env += dt / (2000 + dt) * (Math.abs(this.s) - this.env);
    var thr = Math.max(this.minThr, 1.1 * this.env), out = 0;
    if (this.p1 > this.p2 && this.p1 >= this.s && this.p1 > thr) out = this._cand(this.pt, this.p1);
    this.p2 = this.p1; this.p1 = this.s; this.pt = t;
    return out;
  };
  StepDetector.prototype._cand = function (tp, h) {
    if (this.last !== null && tp - this.last < this.minInterval) return 0;   // refractory period
    var iv = this.last === null ? null : tp - this.last; this.last = tp;
    if (this.walking) {
      if (iv !== null && iv <= this.maxInterval && iv >= 0.55 * this.avgIv && iv <= 1.8 * this.avgIv) {
        this.avgIv += 0.3 * (iv - this.avgIv); this.irregular = 0; this.count++; return 1;
      }
      if (++this.irregular > 2 || iv === null || iv > this.maxInterval) { this.walking = false; this.pending = [tp]; this.hs = [h]; this.irregular = 0; }
      return 0;   // irregular candidate: not counted
    }
    if (iv === null || iv > this.maxInterval) { this.pending = [tp]; this.hs = [h]; return 0; }
    this.pending.push(tp); this.hs.push(h);
    if (this.pending.length >= this.warmup) {
      var ivs = [], i, sum = 0, sq = 0; for (i = 1; i < this.pending.length; i++) ivs.push(this.pending[i] - this.pending[i - 1]);
      for (i = 0; i < ivs.length; i++) sum += ivs[i];
      var mean = sum / ivs.length; for (i = 0; i < ivs.length; i++) sq += (ivs[i] - mean) * (ivs[i] - mean);
      var hm = 0, hv = 0; for (i = 0; i < this.hs.length; i++) hm += this.hs[i]; hm /= this.hs.length;
      for (i = 0; i < this.hs.length; i++) hv += (this.hs[i] - hm) * (this.hs[i] - hm);
      if (Math.sqrt(sq / ivs.length) / mean <= 0.3 && Math.sqrt(hv / this.hs.length) / hm <= 0.35) {
        var n = this.pending.length; this.walking = true; this.avgIv = mean; this.irregular = 0; this.pending = []; this.hs = []; this.count += n; return n;
      }
      this.pending.shift(); this.hs.shift();
    }
    return 0;
  };
  var api = { StepDetector: StepDetector };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Steps = api;
})(typeof self !== "undefined" ? self : this);
