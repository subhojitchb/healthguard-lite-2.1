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
  var api = { movavg: movavg, bandpass: bandpass, analyzePPG: analyzePPG };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PPG = api;
})(typeof self !== "undefined" ? self : this);
