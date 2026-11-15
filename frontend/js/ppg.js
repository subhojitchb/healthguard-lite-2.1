/* Camera-PPG signal analysis (pure functions, unit-testable in Node). */
(function (root) {
  "use strict";
  function movavg(a, w) { var o = new Array(a.length), s = 0; for (var i = 0; i < a.length; i++) { s += a[i]; if (i >= w) s -= a[i - w]; o[i] = s / Math.min(i + 1, w); } return o; }
  function bandpass(ts, x) {
    if (x.length < 10) return x.map(function () { return 0; });
    var fs = x.length / ((ts[ts.length - 1] - ts[0]) / 1000 || 1);
    var slow = movavg(x, Math.max(2, Math.round(fs * 1.0))), fast = movavg(x, Math.max(2, Math.round(fs * 0.12)));
    return x.map(function (_, i) { return fast[i] - slow[i]; });
  }
  /** ts: ms timestamps, red: mean red channel, cover: per-frame "finger covers lens" flags. Never invents a value. */
  function analyzePPG(ts, red, cover) {
    var n = ts.length;
    if (n < 200) return { ok: false, reason: "Not enough frames captured." };
    var dur = (ts[n - 1] - ts[0]) / 1000;
    if (dur < 24) return { ok: false, reason: "Measurement was too short." };
    if (n / dur < 12) return { ok: false, reason: "Camera frame rate too low for a reliable reading." };
    var gaps = 0; for (var g = 1; g < n; g++) if (ts[g] - ts[g - 1] > 400) gaps++;
    if (gaps > 3) return { ok: false, reason: "Frames were dropped during the measurement." };
    if (cover.filter(Boolean).length / n < 0.85) return { ok: false, reason: "Finger was not covering the camera consistently." };
    var cut = Math.floor(n * 0.12), t = ts.slice(cut), r = red.slice(cut);   // drop warm-up
    var sig = bandpass(t, r), sd = Math.sqrt(sig.reduce(function (a, b) { return a + b * b; }, 0) / sig.length);
    if (!(sd >= 0.05)) return { ok: false, reason: "No pulse signal detected." };
    var pk = [];
    for (var i = 2; i < sig.length - 2; i++) {
      if (sig[i] > sd * 0.4 && sig[i] > sig[i - 1] && sig[i] >= sig[i + 1] && sig[i] > sig[i - 2] && sig[i] >= sig[i + 2]) {
        if (!pk.length || t[i] - t[pk[pk.length - 1]] > 330) pk.push(i);
        else if (sig[i] > sig[pk[pk.length - 1]]) pk[pk.length - 1] = i;
      }
    }
    if (pk.length < 15) return { ok: false, reason: "Too few pulse peaks detected." };
    var iv = pk.slice(1).map(function (p, k) { return t[p] - t[pk[k]]; }).filter(function (x) { return x >= 333 && x <= 1500; });
    if (iv.length < 12) return { ok: false, reason: "Pulse was irregular or noisy." };
    var med = iv.slice().sort(function (a, b) { return a - b; })[iv.length >> 1];
    var good = iv.filter(function (x) { return Math.abs(x - med) < med * 0.2; });
    var quality = good.length / iv.length;
    if (quality < 0.7) return { ok: false, reason: "Signal quality too low." };
    var bpm = Math.round(60000 / (good.reduce(function (a, b) { return a + b; }, 0) / good.length));
    if (bpm < 40 || bpm > 200) return { ok: false, reason: "Result out of plausible range." };
    return { ok: true, bpm: bpm, quality: +quality.toFixed(2) };
  }

  /* ===================== v2: streaming monitor (used by the app) =====================
     Replaces the old all-or-nothing "analyse once after 30 s" flow (analyzePPG above is kept for compatibility).
     Frames arrive one at a time; the monitor tracks whether a finger is on the lens, waits for the signal to
     settle, then estimates BPM every second from the most recent ~15 s with TWO independent methods
     (windowed spectrum + beat-interval median). A reading is released only when the last 5 estimates are good and
     stable. Nothing is ever extrapolated or invented. */
  function std(a) { var m = 0, i, v = 0; for (i = 0; i < a.length; i++) m += a[i]; m /= a.length || 1; for (i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m); return Math.sqrt(v / (a.length || 1)); }
  function median(a) { var b = a.slice().sort(function (x, y) { return x - y; }), n = b.length; return n ? (n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2) : 0; }
  function odd(n) { n = Math.max(1, Math.round(n)); return n % 2 ? n : n + 1; }
  function cma(x, w) {   // centred moving average (zero phase); window shrinks at the edges
    var n = x.length, p = new Array(n + 1), o = new Array(n), i, h = (w - 1) >> 1; p[0] = 0;
    for (i = 0; i < n; i++) p[i + 1] = p[i] + x[i];
    for (i = 0; i < n; i++) { var a = Math.max(0, i - h), b = Math.min(n - 1, i + h); o[i] = (p[b + 1] - p[a]) / (b - a + 1); }
    return o;
  }
  function resample(ts, x, t0, t1, fs) {   // uniform grid → removes frame-timing jitter / dropped-frame gaps
    var n = Math.floor((t1 - t0) / 1000 * fs), y = new Array(n), j = 0, i;
    for (i = 0; i < n; i++) {
      var t = t0 + i * 1000 / fs; while (j < ts.length - 2 && ts[j + 1] < t) j++;
      var a = ts[j], b = ts[j + 1], u = b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0; y[i] = x[j] + (x[j + 1] - x[j]) * u;
    }
    return y;
  }
  function pulseFilter(y, fs) {   // DC/baseline removal (1.2 s centred MA) then light smoothing (~0.17 s)
    var base = cma(y, odd(1.2 * fs)), d = y.map(function (v, i) { return v - base[i]; });
    return cma(d, odd(0.17 * fs));
  }
  function spectrum(x, fs) {   // Hann-windowed DFT evaluated only over 0.7–3.3 Hz (42–198 bpm)
    var N = x.length, mean = 0, i, xs = new Array(N), F = [], P = [];
    for (i = 0; i < N; i++) mean += x[i]; mean /= N;
    for (i = 0; i < N; i++) xs[i] = (x[i] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    for (var f = 0.7; f <= 3.3001; f += 0.01) {
      var re = 0, im = 0, k = 2 * Math.PI * f / fs; for (i = 0; i < N; i++) { var a = k * i; re += xs[i] * Math.cos(a); im -= xs[i] * Math.sin(a); }
      F.push(f); P.push(re * re + im * im);
    }
    return { f: F, p: P };
  }
  function beatBpm(x, fs, hz) {   // beat-interval method: peaks ≥0.6 period apart (0.33 s if no hint), intervals 0.3–1.5 s, outliers (>25% off median) dropped
    var k = Math.max(2, Math.round(0.1 * fs)), refr = hz ? 0.6 / hz : 0.33, sd = std(x), pk = [], i, j;
    for (i = k; i < x.length - k; i++) {
      if (x[i] < 0.15 * sd) continue; var m = true; for (j = 1; j <= k; j++) if (x[i - j] >= x[i] || x[i + j] > x[i]) { m = false; break; }
      if (!m) continue;
      if (pk.length && (i - pk[pk.length - 1]) / fs < refr) { if (x[i] > x[pk[pk.length - 1]]) pk[pk.length - 1] = i; } else pk.push(i);
    }
    var iv = []; for (i = 1; i < pk.length; i++) { var d = (pk[i] - pk[i - 1]) / fs; if (d >= 0.3 && d <= 1.5) iv.push(d); }
    if (iv.length < 6) return null;
    var med = median(iv), good = iv.filter(function (d) { return Math.abs(d - med) <= 0.25 * med; });
    if (good.length < 6 || good.length < 0.6 * iv.length) return null;
    return 60 / median(good);
  }
  /** y: uniformly sampled raw red values (fs Hz) of a covered stretch. Returns {bpm, quality 0..1, snr, agree, artifact, flat}. */
  function estimate(y, fs) {
    var e = Math.round(0.6 * fs), x = pulseFilter(y, fs).slice(e, y.length - e), raw = y.slice(e, y.length - e), sd = std(x), i;
    if (x.length < 6 * fs || sd < 0.03) return { bpm: null, quality: 0, flat: true, artifact: 0 };
    var W = Math.round(fs), amps = [], jumps = 0, win = 0, prev = null;   // motion: 1 s windows with outlier amplitude or a raw level jump
    for (i = 0; i + W <= x.length; i += W) { amps.push(std(x.slice(i, i + W))); var mr = raw.slice(i, i + W).reduce(function (a, b) { return a + b; }, 0) / W; if (prev !== null && Math.abs(mr - prev) > 6) jumps++; prev = mr; win++; }
    var ma = median(amps), bad = 0; for (i = 0; i < amps.length; i++) if (amps[i] > 3 * ma) bad++;
    var artifact = Math.min(1, (bad + jumps) / Math.max(1, win));
    var S = spectrum(x, fs), pi = 0, tot = 0; for (i = 0; i < S.p.length; i++) { tot += S.p[i]; if (S.p[i] > S.p[pi]) pi = i; }
    var bandPow = function (f, hw) { var s = 0; hw = hw || 0.15; for (var j = 0; j < S.f.length; j++) if (Math.abs(S.f[j] - f) <= hw) s += S.p[j]; return s; };
    var f0 = S.f[pi];
    var subHz = f0 / 2, pSub = bandPow(subHz, 0.08), pSide = Math.max(bandPow(subHz - 0.25, 0.08), bandPow(subHz + 0.25, 0.08));
    // The main peak may be the 2nd harmonic (dicrotic wave). Halve ONLY if the sub-harmonic is itself a strong, isolated peak;
    // a weaker rule risks reporting half the true rate for fast pulses.
    if (subHz >= 0.7 && pSub >= 0.45 * bandPow(f0, 0.08) && pSub >= 2 * pSide) f0 = subHz;
    var bpmF = f0 * 60, rel = function (a, b) { return Math.abs(a - b) / b; };
    // Is f0 a genuine fundamental (stronger than its own 2nd harmonic)? Only then may the beat detector use f0 to space its peaks;
    // otherwise it runs unaided, so a half-rate noise bump cannot "confirm" itself. No 2x/0.5x tolerance: wrong-octave readings are refused.
    var dom = 2 * f0 > 3.3 || bandPow(f0, 0.08) >= 2 * bandPow(2 * f0, 0.08);
    var bpmT = beatBpm(x, fs, dom ? f0 : 0), agree = !!bpmT && dom && rel(bpmF, bpmT) <= 0.08 || !!bpmT && !dom && rel(bpmF, bpmT) <= 0.08;
    var peak = bandPow(f0) + (2 * f0 <= 3.3 ? bandPow(2 * f0) : 0), snr = peak / Math.max(1e-12, tot - peak);
    var q = Math.max(0, Math.min(1, (snr - 0.6) / (3.0 - 0.6))) * (agree ? 1 : 0.4) * (1 - artifact);
    return { bpm: bpmF, quality: q, snr: snr, agree: agree, artifact: artifact, flat: false };
  }
  /** Classify one camera frame (mean R,G,B of the centre region, and fraction of clipped-red pixels). */
  function classifyFrame(r, g, b, sat) {
    if (r < 40) return "dark";                       // lens blocked / far too little light
    if (sat > 0.5) return "saturated";               // red clipped: no pulsatile range left
    if (r < 1.25 * Math.max(g, b)) return "nofinger";   // not red-dominant → an ordinary scene, not skin over the lens
    return "ok";
  }
  var MESSAGES = {
    nofinger: "Your fingertip wasn’t covering the camera lens and flash for most of the measurement. Cover both completely and keep it there.",
    dark: "The image was too dark. Cover the lens and flash fully; if your device has no flashlight support, try a brighter place.",
    saturated: "The image was over-exposed (pressing too lightly lets the flash wash out the signal). Rest your fingertip flat with gentle, steady pressure.",
    motion: "There was too much movement. Rest your hand on a table, keep still, and breathe normally.",
    irregular: "The pulse signal was inconsistent between methods. Keep the finger flat and still, avoid pressing hard, and try again.",
    weak: "The pulse signal was too weak to measure reliably. Warm hands help; use gentle steady pressure and cover lens and flash fully."
  };
  function Monitor(o) {
    o = o || {}; this.fs = 30; this.settle = o.settle == null ? 3 : o.settle; this.window = o.window || 15; this.minUse = o.minUse || 10;
    this.maxUse = o.maxUse || 30; this.maxTotal = o.maxTotal || 60; this.qMin = o.qMin || 0.6; this.spread = o.spread || 5; this.need = 5;
    this.ts = []; this.red = []; this.t0 = null; this.tLast = null; this.runStart = null; this.lostSince = null; this.hist = []; this.lastEst = 0;
    this.tally = { ok: 0, nofinger: 0, dark: 0, saturated: 0 }; this.recent = []; this.wave = []; this.base = null; this.sm = 0; this.state = null; this.done = null; this.lastCode = "nodata";
  }
  Monitor.prototype.addFrame = function (t, r, g, b, sat) {
    if (this.done || !isFinite(t) || !isFinite(r)) return;
    if (this.tLast !== null && t <= this.tLast) return;   // duplicate / out-of-order frame
    var dt = this.tLast === null ? 33 : t - this.tLast;
    if (this.t0 === null) this.t0 = t; this.tLast = t;
    var c = classifyFrame(r, g, b, sat || 0); this.tally[c]++;
    this.recent.push(c); if (this.recent.length > 10) this.recent.shift();
    var cnt = {}, best = c, k; for (k = 0; k < this.recent.length; k++) cnt[this.recent[k]] = (cnt[this.recent[k]] || 0) + 1;
    for (k in cnt) if (cnt[k] > (cnt[best] || 0)) best = k; this.state = best;     // majority of the last ~10 frames
    if (best === "ok") { if (this.runStart === null) { this.runStart = t; this.hist = []; } this.lostSince = null; }
    else if (this.runStart !== null) { if (this.lostSince === null) this.lostSince = t; if (t - this.lostSince > 600) { this.runStart = null; this.lostSince = null; this.hist = []; } }
    this.ts.push(t); this.red.push(r);
    if (this.base === null) this.base = r; this.base += (r - this.base) * dt / (1000 + dt); this.sm += ((r - this.base) - this.sm) * dt / (90 + dt);
    this.wave.push(this.sm); if (this.wave.length > 240) this.wave.shift();
  };
  Monitor.prototype.waveform = function () { return this.wave; };
  Monitor.prototype._diagnose = function () {
    var n = this.tally.ok + this.tally.nofinger + this.tally.dark + this.tally.saturated || 1, T = this.tally;
    if ((T.nofinger + T.dark) / n > 0.5) return T.dark > T.nofinger ? "dark" : "nofinger";
    if (T.saturated / n > 0.3) return "saturated";
    var h = this.hist.slice(-8); if (h.length) {
      var art = h.filter(function (e) { return e.artifact > 0.25; }).length / h.length; if (art > 0.5) return "motion";
      if (h.filter(function (e) { return !e.agree; }).length / h.length > 0.5) return "irregular";
    }
    return "weak";
  };
  Monitor.prototype._estimate = function () {
    var from = Math.max(this.runStart + this.settle * 1000, this.tLast - this.window * 1000);
    if (this.tLast - from < this.minUse * 1000) return;
    var i0 = 0; while (i0 < this.ts.length - 2 && this.ts[i0] < from) i0++;
    var ts = this.ts.slice(i0), rd = this.red.slice(i0), y = resample(ts, rd, ts[0], this.tLast, this.fs);
    var e = estimate(y, this.fs); e.t = this.tLast; this.hist.push(e); if (this.hist.length > 20) this.hist.shift();
    var last = this.hist.slice(-this.need);
    if (last.length === this.need && last.every(function (h) { return h.bpm && h.quality >= this.qMin && h.agree; }, this)) {
      var b = last.map(function (h) { return h.bpm; });
      if (Math.max.apply(null, b) - Math.min.apply(null, b) <= this.spread)
        this.done = { phase: "done", result: { bpm: Math.round(median(b)), quality: +(last.reduce(function (a, h) { return a + h.quality; }, 0) / this.need).toFixed(2) } };
    }
  };
  /** Call about 4×/s. Returns {phase: waiting|settling|measuring|done|failed, code, hint, quality, usable, remaining, result?}. */
  Monitor.prototype.status = function () {
    if (this.done) return { phase: "done", code: "done", hint: "Measurement complete.", quality: this.done.result.quality, usable: 0, remaining: 0, result: this.done.result };
    if (this.tLast === null) return { phase: "waiting", code: "nodata", hint: "Starting the camera…", quality: 0, usable: 0, remaining: null };
    var total = (this.tLast - this.t0) / 1000, usable = this.runStart === null ? 0 : Math.max(0, (this.tLast - this.runStart) / 1000 - this.settle);
    if (this.runStart !== null && this.tLast - this.lastEst >= 1000) { this.lastEst = this.tLast; this._estimate(); if (this.done) return this.status(); }
    if (usable >= this.maxUse || total >= this.maxTotal || (total >= 30 && usable < 3)) {
      var code = this._diagnose(); return { phase: "failed", code: code, hint: MESSAGES[code], quality: 0, usable: usable, remaining: 0 };
    }
    var st = this.state, q = this.hist.length ? this.hist[this.hist.length - 1].quality : 0, hint, code, phase;
    var remaining = this.runStart === null ? null : Math.max(0, Math.ceil(this.minUse + this.need - 1 - usable));
    if (st !== "ok" && this.runStart === null || st !== "ok" && this.lostSince !== null) {
      phase = "waiting"; code = st === "dark" ? "dark" : st === "saturated" ? "saturated" : "nofinger";
      hint = code === "dark" ? "Too dark — cover the lens and flash completely." : code === "saturated" ? "Too bright — rest your finger flat with gentle pressure." : "Place your fingertip over the camera lens and flash.";
    } else if (usable <= 0) { phase = "settling"; code = "settling"; hint = "Finger detected — hold still while the signal settles…"; }
    else {
      phase = "measuring"; var last = this.hist.length ? this.hist[this.hist.length - 1] : null;
      if (last && last.artifact > 0.25) { code = "motion"; hint = "Too much movement — hold still."; }
      else if (last && last.quality < this.qMin && usable > this.minUse + 2) { code = "weak"; hint = "Weak signal — keep your finger flat, still, with gentle pressure."; }
      else { code = "good"; hint = "Good — keep still, measuring your pulse…"; }
    }
    return { phase: phase, code: code, hint: hint, quality: q, usable: usable, remaining: remaining };
  };
  var api = { movavg: movavg, bandpass: bandpass, analyzePPG: analyzePPG, Monitor: Monitor, estimate: estimate, classifyFrame: classifyFrame, resample: resample, MESSAGES: MESSAGES };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PPG = api;
})(typeof self !== "undefined" ? self : this);
