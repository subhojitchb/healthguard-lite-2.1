// Synthetic-recording tests for PPG.Monitor (node tests/ppg-monitor.test.js).
// These validate the ALGORITHM against simulated finger recordings. They are NOT real-device validation.
const assert = require("assert");
const { Monitor, classifyFrame } = require("../js/ppg.js");
let seed = 1; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

/** Simulate a recording. Returns what the monitor concluded and when. Frame = [r,g,b,saturatedFraction]. */
function simulate(o = {}) {
  const { bpm = 72, secs = 60, fps = 30, place = 0, amp = 1.2, noise = 0.35, rBase = 215, gRatio = 0.3, hrv = 0.05, drift = 0, resp = 0,
    motion = 0, motionAmp = 25, jitter = 6, sat = 0, harmonic = 0, finger = true, flat = false, colored = 0, startNoise = 0 } = o;
  const m = new Monitor(); let phase = 0, rw = 0, status = null, doneAt = null, codes = {}, t = 0, nextMove = 2;
  for (let i = 0; i < secs * fps; i++) {
    t = i * 1000 / fps + (rnd() - .5) * jitter; const s = t / 1000; let r, g, b, sf = 0;
    if (!finger || s < place) { r = 118 + 6 * gauss(); g = 112 + 6 * gauss(); b = 105 + 6 * gauss(); }
    else {
      const f = bpm / 60 * (1 + hrv * Math.sin(2 * Math.PI * 0.11 * s)); phase += f / fps; rw += (rnd() - .5) * colored;
      const pulse = flat ? 0 : amp * (Math.sin(2 * Math.PI * phase) + harmonic * Math.sin(4 * Math.PI * phase + 1));
      if (motion && s >= nextMove) { rw += (rnd() - .5) * 2 * motionAmp; nextMove = s + 1 + rnd() * 1.5; }
      r = rBase + drift * Math.sin(2 * Math.PI * s / 40) + 1.0 * Math.sin(2 * Math.PI * 0.25 * s) * (resp ? 1 : 0) + pulse + rw + (s < place + 4 ? startNoise * gauss() : 0) + noise * gauss();
      g = r * gRatio; b = r * gRatio * 0.8; sf = sat;
    }
    m.addFrame(t, r, g, b, sf);
    if (i % 8 === 0) { status = m.status(); codes[status.code] = (codes[status.code] || 0) + 1; if (status.phase === "done" || status.phase === "failed") { doneAt = s; break; } }
  }
  return { phase: status.phase, bpm: status.result && status.result.bpm, quality: status.result && status.result.quality, code: status.code, doneAt, codes };
}
let pass = 0; const t = (n, f) => { f(); pass++; console.log("ok -", n); };
const accepts = (r, bpm, tol = 3) => { assert.strictEqual(r.phase, "done", JSON.stringify(r)); assert(Math.abs(r.bpm - bpm) <= tol, `expected ~${bpm} got ${r.bpm}`); assert(r.quality >= 0.6, "quality " + r.quality); };

t("frame classifier: skin+torch, skin no torch, ordinary scene, blocked lens, clipped", () => {
  assert.strictEqual(classifyFrame(230, 90, 60, 0), "ok"); assert.strictEqual(classifyFrame(240, 165, 120, 0), "ok");   // g/r 0.69 is fine
  assert.strictEqual(classifyFrame(90, 32, 25, 0), "ok");                                                          // no torch
  assert.strictEqual(classifyFrame(120, 112, 105, 0), "nofinger"); assert.strictEqual(classifyFrame(5, 3, 3, 0), "dark"); assert.strictEqual(classifyFrame(255, 120, 80, 0.9), "saturated");
});
t("clean recording → accepted, accurate, within ~20 s", () => { const r = simulate(); accepts(r, 72, 2); assert(r.doneAt <= 22, "took " + r.doneAt); });
t("finger placed late (5 s and 12 s) → still accepted (old pipeline rejected this)", () => { accepts(simulate({ place: 5 }), 72); accepts(simulate({ place: 12 }), 72); });
t("phone renders skin with g/r = 0.55 and 0.68 → accepted", () => { accepts(simulate({ gRatio: 0.55 }), 72); accepts(simulate({ gRatio: 0.68 }), 72); });
t("no torch / dim finger (r≈90, small AC) → accepted", () => accepts(simulate({ rBase: 90, gRatio: 0.35, amp: 0.5, noise: 0.2 }), 72));
t("heart rates 48, 60, 90, 120, 150, 180 recovered (±3 bpm)", () => { for (const b of [48, 60, 90, 120, 150, 180]) accepts(simulate({ bpm: b }), b); });
t("heart-rate variability (±12%) → accepted near the mean rate", () => accepts(simulate({ hrv: 0.12 }), 72, 4));
t("auto-exposure drift ±15 + respiration baseline wander + noise → accepted", () => accepts(simulate({ drift: 15, resp: 1, noise: 0.5 }), 72));
t("noisy first seconds after placement (settling) → accepted, not failed", () => accepts(simulate({ place: 2, startNoise: 6 }), 72));
t("2nd harmonic present (fundamental stronger): rate not doubled; harmonic STRONGER than fundamental: never a wrong rate", () => {
  accepts(simulate({ harmonic: 0.7, bpm: 66 }), 66, 3);
  const r = simulate({ harmonic: 1.4, bpm: 66 }); assert(r.phase === "failed" || Math.abs(r.bpm - 66) <= 3, "must refuse or be right, got " + r.bpm); });
t("slow random-walk baseline (coloured noise) + pulse → accepted", () => accepts(simulate({ colored: 0.6, noise: 0.4 }), 72));
t("frame-rate variation 24 fps / 15 fps with jitter → accepted", () => { accepts(simulate({ fps: 24, jitter: 14 }), 72); accepts(simulate({ fps: 15, jitter: 20, bpm: 70 }), 70); });
t("low but real pulse (amp 0.35, noise 0.2) → accepted", () => accepts(simulate({ amp: 0.35, noise: 0.2 }), 72));

t("finger never placed → fails with 'nofinger' guidance, no BPM", () => { const r = simulate({ finger: false }); assert.strictEqual(r.phase, "failed"); assert.strictEqual(r.code, "nofinger"); assert(r.bpm == null); });
t("covered but flat (no pulse) → fails 'weak', no BPM", () => { const r = simulate({ flat: true, noise: 0.15 }); assert.strictEqual(r.phase, "failed"); assert(r.bpm == null); assert(["weak", "irregular"].includes(r.code), r.code); });
t("saturated (red clipped) → fails 'saturated'", () => { const r = simulate({ sat: 0.9, rBase: 254, amp: 0 }); assert.strictEqual(r.phase, "failed"); assert.strictEqual(r.code, "saturated"); });
t("dark image (blocked lens, no light) → fails 'dark'", () => { const r = simulate({ rBase: 20, gRatio: 0.4, amp: 0.2 }); assert.strictEqual(r.phase, "failed"); assert.strictEqual(r.code, "dark"); });
t("continuous large movement → rejected (no BPM), reported as motion", () => { const r = simulate({ motion: 1, motionAmp: 40, noise: 0.5 }); assert.strictEqual(r.phase, "failed", JSON.stringify(r)); assert(r.bpm == null); assert.strictEqual(r.code, "motion"); });
t("finger lifted mid-measurement resets progress; waits, then succeeds after replacement", () => {
  const m = new Monitor(); let ph = 0, s = 0, done = null;
  for (let i = 0; i < 60 * 30 && !done; i++) { const tt = i * 1000 / 30; s = tt / 1000; const on = s < 7 || s > 11; ph += 1.2 / 30;
    on ? m.addFrame(tt, 215 + 1.2 * Math.sin(2 * Math.PI * ph) + .35 * gauss(), 65, 55, 0) : m.addFrame(tt, 120, 112, 105, 0);
    if (i % 8 === 0) { const st = m.status(); if (s > 8.5 && s < 10.5) assert.strictEqual(st.phase, "waiting"); if (st.phase === "done") done = st; } }
  assert(done && Math.abs(done.result.bpm - 72) <= 3);
});

t("FALSE POSITIVES: 100 white-noise recordings (finger 'covered') never produce a reading", () => {
  let accepted = 0; for (let k = 0; k < 100; k++) { seed = 1000 + k * 7919; if (simulate({ flat: true, noise: 0.1 + 0.9 * rnd(), secs: 45 }).phase === "done") accepted++; } assert.strictEqual(accepted, 0, accepted + "/100 false readings"); });
t("FALSE POSITIVES: 100 random-walk + noise recordings never produce a reading", () => {
  let accepted = 0; for (let k = 0; k < 100; k++) { seed = 5000 + k * 104729; if (simulate({ flat: true, noise: 0.3, colored: 0.5 + rnd(), secs: 45 }).phase === "done") accepted++; } assert.strictEqual(accepted, 0, accepted + "/100 false readings"); });
t("FALSE POSITIVES: 60 recordings with random large motion never produce a reading", () => {
  let accepted = 0; for (let k = 0; k < 60; k++) { seed = 9000 + k * 15485863; if (simulate({ flat: true, motion: 1, motionAmp: 10 + 40 * rnd(), noise: 0.4, secs: 45 }).phase === "done") accepted++; } assert.strictEqual(accepted, 0, accepted + "/60 false readings"); });
t("ACCURACY sweep: 100 random valid recordings (45-180 bpm, realistic noise/drift/late finger), all accepted within max(3 bpm, 3%)", () => {
  let bad = []; for (let k = 0; k < 100; k++) { seed = 321 + k * 7919; const b = 45 + Math.round(rnd() * 135);
    const r = simulate({ bpm: b, noise: 0.15 + rnd() * 0.35, amp: 0.6 + rnd() * 1.5, hrv: rnd() * 0.04, drift: rnd() * 12, place: rnd() * 6, gRatio: 0.25 + rnd() * 0.4 });
    if (r.phase !== "done" || Math.abs(r.bpm - b) > Math.max(3, 0.03 * b)) bad.push(`${b}->${r.bpm}/${r.phase}`); }
  assert.strictEqual(bad.length, 0, bad.join(" ")); });
t("WRONG-READING guard: 200 weak/noisy recordings — every one that IS accepted is within max(4 bpm, 4%); report acceptance rate", () => {
  let acc = 0, wrong = []; for (let k = 0; k < 200; k++) { seed = 777 + k * 104729; const b = 45 + Math.round(rnd() * 135);
    const r = simulate({ bpm: b, amp: 0.3 + rnd() * 0.6, noise: 0.4 + rnd() * 0.8, hrv: rnd() * 0.05, drift: rnd() * 10, colored: rnd() * 0.5, secs: 45 });
    if (r.phase === "done") { acc++; if (Math.abs(r.bpm - b) > Math.max(4, 0.04 * b)) wrong.push(`${b}->${r.bpm}`); } }
  console.log(`      weak-signal acceptance: ${acc}/200 (rest correctly refused); wrong readings among accepted: ${wrong.length}`); assert.strictEqual(wrong.length, 0, wrong.join(" ")); });
console.log(pass + " monitor tests passed");
