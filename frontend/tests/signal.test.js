// Synthetic-signal unit tests (node tests/signal.test.js). They check the algorithms' logic, NOT real-world accuracy.
const assert = require("assert");
const { analyzePPG } = require("../js/ppg.js");
const { StepDetector } = require("../js/steps.js");
let seed = 42; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
let pass = 0; const t = (name, fn) => { fn(); pass++; console.log("ok -", name); };

function ppg({ bpm = 72, secs = 30, fps = 30, amp = 1.5, noise = 0.3, cover = true, drop = 0 }) {
  const ts = [], red = [], cov = [];
  for (let i = 0; i < secs * fps; i++) { if (drop && i % drop === 0) i += 15; const x = i * 1000 / fps; ts.push(x); red.push(200 + amp * Math.sin(2 * Math.PI * bpm / 60 * x / 1000) + noise * gauss()); cov.push(cover); }
  return [ts, red, cov];
}
t("PPG: 72 bpm recovered within 3 bpm", () => { const r = analyzePPG(...ppg({})); assert(r.ok, r.reason); assert(Math.abs(r.bpm - 72) <= 3, r.bpm); });
t("PPG: 55 and 110 bpm recovered", () => { for (const b of [55, 110]) { const r = analyzePPG(...ppg({ bpm: b })); assert(r.ok, r.reason); assert(Math.abs(r.bpm - b) <= 4, b + " -> " + r.bpm); } });
t("PPG: flat signal rejected, no value invented", () => { const r = analyzePPG(...ppg({ amp: 0, noise: 0.001 })); assert(!r.ok && r.bpm === undefined); });
t("PPG: pure noise rejected", () => { const r = analyzePPG(...ppg({ amp: 0, noise: 1.5 })); assert(!r.ok); });
t("PPG: finger not covering rejected", () => { assert(!analyzePPG(...ppg({ cover: false })).ok); });
t("PPG: too short / low fps / dropped frames rejected", () => {
  assert(!analyzePPG(...ppg({ secs: 10 })).ok); assert(!analyzePPG(...ppg({ fps: 6, secs: 40 })).ok); assert(!analyzePPG(...ppg({ drop: 60 })).ok);
});

function walk({ hz = 2, secs = 30, rate = 60, amp = 3, noise = 0.1, from = 0, to = secs }) {
  const d = new StepDetector(); let n = 0;
  for (let i = 0; i < secs * rate; i++) { const x = i * 1000 / rate, s = x / 1000; const on = s >= from && s < to;
    const a = 9.81 + (on ? amp * Math.sin(2 * Math.PI * hz * s) : 0) + noise * gauss(); n += d.push(0.3 * a, 0.2 * a, 0.93 * a, x); }
  return [d, n];
}
t("Steps: 2 Hz walking for 30 s ≈ 60 steps (±10%)", () => { const [d, n] = walk({}); assert(d.count >= 54 && d.count <= 66, d.count); assert.strictEqual(n, d.count); });
t("Steps: slow 1.4 Hz and fast 2.8 Hz walking", () => { for (const [hz, exp] of [[1.4, 42], [2.8, 84]]) { const [d] = walk({ hz }); assert(Math.abs(d.count - exp) <= exp * 0.12, hz + " -> " + d.count); } });
t("Steps: stationary phone counts nothing", () => { const [d] = walk({ amp: 0, noise: 0.05 }); assert.strictEqual(d.count, 0); });
t("Steps: slow tilt (constant |a|) counts nothing", () => {
  const d = new StepDetector(); for (let i = 0; i < 1800; i++) { const x = i * 1000 / 60, a = 0.4 * x / 1000; d.push(9.81 * Math.sin(a), 0, 9.81 * Math.cos(a), x); } assert.strictEqual(d.count, 0); });
t("Steps: irregular hand/pocket jostle (low-frequency sway + random bumps) counts ≤ 8 over 30 s", () => {
  const d = new StepDetector(); let nextBump = 1500 + rnd() * 3000, bump = 0;
  for (let i = 0; i < 1800; i++) { const x = i * 1000 / 60, s = x / 1000;
    if (x >= nextBump) { bump = 3.5 * (0.5 + rnd()); nextBump = x + 1500 + rnd() * 3500; } bump *= 0.9;
    const a = 9.81 + 2 * Math.sin(2 * Math.PI * 0.45 * s + 1) + 1.5 * Math.sin(2 * Math.PI * 0.9 * s + 2) + bump + 0.3 * gauss(); d.push(0, 0, a, x); }
  assert(d.count <= 8, d.count); });
t("Steps: KNOWN LIMITATION - extreme white noise is not fully rejected (documented, bounded below real walking)", () => { const [d] = walk({ amp: 0, noise: 2.5 }); assert(d.count < 45, d.count); });
t("Steps: walk 10-20 s only counts the walking window", () => { const [d] = walk({ from: 10, to: 20 }); assert(d.count >= 16 && d.count <= 24, d.count); });
t("Steps: duplicate / out-of-order events are not double-counted", () => {
  const a = new StepDetector(), b = new StepDetector();
  for (let i = 0; i < 1800; i++) { const x = i * 1000 / 60, v = 9.81 + 3 * Math.sin(2 * Math.PI * 2 * x / 1000);
    a.push(0, 0, v, x); b.push(0, 0, v, x); b.push(0, 0, v, x + 1); b.push(0, 0, v, x); } assert.strictEqual(a.count, b.count); });
t("Steps: background gap ends the run, resume needs new warm-up", () => {
  const d = new StepDetector(); let x = 0;
  const burst = (secs) => { for (let i = 0; i < secs * 60; i++) { x += 1000 / 60; d.push(0, 0, 9.81 + 3 * Math.sin(2 * Math.PI * 2 * x / 1000), x); } };
  burst(10); const c1 = d.count; x += 20000; burst(10); assert(c1 >= 17 && d.count >= c1 + 17, c1 + "," + d.count); });
t("Steps: invalid samples ignored", () => { const d = new StepDetector(); assert.strictEqual(d.push(NaN, 0, 0, 0), 0); assert.strictEqual(d.push(0, 0, 9.8, undefined), 0); });
console.log(pass + " tests passed");
