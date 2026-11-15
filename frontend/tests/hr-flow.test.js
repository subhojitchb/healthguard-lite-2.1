// Runs the real measureHR() from js/app.js in a stub browser with a FAKE camera track fed by synthetic frames.
// Verifies lifecycle/wiring (camera, torch, cleanup, save/no-save). It does NOT prove anything about real devices.
const vm = require("vm"), fs = require("fs"), path = require("path"), assert = require("assert");
let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function makeEnv(opts) {
  const els = {}, calls = [], gum = [], torchLog = [], handlers = {};
  const el = id => els[id] || (els[id] = { innerHTML: "", hidden: false, style: {}, dataset: {}, onclick: null, isConnected: true, disabled: false, textContent: "", addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [], getContext: () => ({ clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }) });
  var state = { torch: undefined, stopped: false, vfc: null, raf: null, video: null, t: 0 };
  const track = { getCapabilities: () => opts.torch === false ? { } : opts.noCaps ? undefined : { torch: true }, getSettings: () => ({ facingMode: opts.facing || "environment", torch: state.torch }),
    applyConstraints: async c => { const t = c.advanced && c.advanced[0] && c.advanced[0].torch; if (t !== undefined) { if (opts.torch === false) throw new Error("no torch"); torchLog.push(t); state.torch = t; } }, stop() { state.stopped = true; }, onended: null };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, performance, Intl, URL, AbortController, Promise, FormData: class {}, cancelAnimationFrame() { state.raf = null; }, requestAnimationFrame(cb) { state.raf = cb; return 1; },
    window: { API_BASE: "https://api.example.com", addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, location: { hostname: "x.vercel.app", hash: "" }, crypto: require("crypto").webcrypto,
    navigator: { mediaDevices: { getUserMedia: async c => { gum.push(c.video); if (opts.deny) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      if (c.video && c.video.facingMode && c.video.facingMode.exact && opts.failExact) throw Object.assign(new Error("oc"), { name: "OverconstrainedError" }); return stream; } } },
    document: { hidden: false, querySelector: s => el(s), addEventListener(t, f) { handlers[t] = f; }, removeEventListener(t) { delete handlers[t]; },
      createElement: tag => tag === "video" ? (state.video = { srcObject: null, videoWidth: 320, videoHeight: 240, currentTime: 0, play: async () => {}, pause() {}, ...(opts.noVFC ? {} : { requestVideoFrameCallback(cb) { state.vfc = cb; return 1; }, cancelVideoFrameCallback() { state.vfc = null; } }) })
        : { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => { const [r, g, b] = opts.pixel(state.t / 1000), d = new Uint8ClampedArray(32 * 32 * 4); for (let i = 0; i < d.length; i += 4) { d[i] = r + 2 * gauss(); d[i + 1] = g + 2 * gauss(); d[i + 2] = b + 2 * gauss(); d[i + 3] = 255; } return { data: d }; } }) } },
    fetch: async (url, o) => { calls.push({ url, method: o.method, body: o.body ? JSON.parse(o.body) : null }); return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ ok: true, data: {} }) }; } };
  ctx.window.window = ctx.window; ctx.self = ctx; vm.createContext(ctx);
  for (const f of ["ppg.js", "steps.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", f), "utf8"), ctx, { filename: f });
  return { ctx, els, calls, gum, torchLog, handlers, state, track };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function drive(env, secs, until) {   // feed 30 fps frames through requestVideoFrameCallback (or the rAF fallback, with duplicate rAF ticks)
  for (let i = 0; i < secs * 30; i++) {
    env.state.t = 1000 + i * 1000 / 30;
    if (env.state.vfc) { const cb = env.state.vfc; env.state.vfc = null; cb(env.state.t, {}); }
    else if (env.state.raf) { env.state.video.currentTime = env.state.t / 1000; for (let k = 0; k < 2; k++) { const cb = env.state.raf; if (!cb) break; env.state.raf = null; cb(env.state.t + k * 8); } }   // 2 rAF ticks per camera frame
    else break;
    if (until && until(i / 30)) break; if (i % 60 === 0) await wait(0);
  }
  await wait(20);
}
const fingerTorch = (place, bpm = 72) => { let ph = 0; return s => { if (s - 1 < place) return [118, 112, 105]; ph = (s - 1 - place) * bpm / 60; return [215 + 1.2 * Math.sin(2 * Math.PI * ph) + 0.3 * gauss(), 70, 55]; }; };
let pass = 0; const t = async (n, f) => { await f(); pass++; console.log("ok -", n); };
const saved = e => e.calls.filter(c => c.url.endsWith("/health/records"));

(async () => {
  await t("success: rear camera (exact), torch on then OFF, tracks stopped, ONE record saved with quality ≥ 0.6", async () => {
    const e = makeEnv({ pixel: fingerTorch(4) }); const p = e.ctx.measureHR(); await wait(20);
    assert.strictEqual(JSON.stringify(e.gum[0].facingMode), '{"exact":"environment"}'); assert.strictEqual(e.els["#fs"].textContent, "on"); assert.strictEqual(e.els["#cs"].textContent, "rear camera");
    await drive(e, 60); await wait(30);
    const s = saved(e); assert.strictEqual(s.length, 1, "saved " + s.length); assert(Math.abs(s[0].body.heart_rate - 72) <= 3, s[0].body.heart_rate);
    assert(s[0].body.signal_quality >= 0.6 && s[0].body.measurement_type === "camera_ppg");
    assert.deepStrictEqual(e.torchLog, [true, false]); assert(e.state.stopped); assert.strictEqual(e.state.video.srcObject, null);
  });
  await t("unreliable signal: NO save, failure screen with guidance + retry, camera/torch released", async () => {
    const e = makeEnv({ pixel: s => [215 + 0.2 * gauss(), 70, 55] }); e.ctx.measureHR(); await wait(20); await drive(e, 90); await wait(30);
    assert.strictEqual(saved(e).length, 0); assert(/reliable reading/.test(e.els["#sheet"].innerHTML) && /Try again/.test(e.els["#sheet"].innerHTML) && /Nothing was saved/.test(e.els["#sheet"].innerHTML));
    assert.deepStrictEqual(e.torchLog, [true, false]); assert(e.state.stopped);
  });
  await t("finger never placed: failure explains 'fingertip wasn't covering…'", async () => {
    const e = makeEnv({ pixel: s => [118, 112, 105] }); e.ctx.measureHR(); await wait(20); await drive(e, 90); await wait(30);
    assert.strictEqual(saved(e).length, 0); assert(/fingertip/.test(e.els["#sheet"].innerHTML)); assert(e.state.stopped);
  });
  await t("cancel mid-measurement: released immediately, nothing saved", async () => {
    const e = makeEnv({ pixel: fingerTorch(2) }); e.ctx.measureHR(); await wait(20); await drive(e, 8); e.els["#cx"].onclick(); await wait(40);
    assert(e.state.stopped); assert.deepStrictEqual(e.torchLog, [true, false]); assert.strictEqual(saved(e).length, 0); assert.strictEqual(e.state.vfc, null);
  });
  await t("permission denied: clear message, single getUserMedia attempt, no stream, no save", async () => {
    const e = makeEnv({ deny: true, pixel: fingerTorch(0) }); await e.ctx.measureHR(); await wait(20);
    assert.strictEqual(e.gum.length, 1); assert(/permission was denied/.test(e.els["#toast"].textContent)); assert.strictEqual(saved(e).length, 0);
  });
  await t("no torch support (iOS-like): says so, never claims on, never requests torch, still measures + saves", async () => {
    const e = makeEnv({ torch: false, pixel: s => { const ph = (s - 3) * 1.2; return s < 3 ? [118, 112, 105] : [92 + 0.7 * Math.sin(2 * Math.PI * ph) + 0.25 * gauss(), 33, 27]; } });
    e.ctx.measureHR(); await wait(20);
    assert.strictEqual(e.els["#fs"].textContent, "not supported"); assert(/No flashlight/.test(e.els["#note"].textContent)); assert.deepStrictEqual(e.torchLog, []);
    await drive(e, 60); await wait(30); assert.strictEqual(saved(e).length, 1); assert(Math.abs(saved(e)[0].body.heart_rate - 72) <= 3); assert(e.state.stopped);
  });
  await t("exact facingMode rejected → falls back to ideal environment and still works", async () => {
    const e = makeEnv({ failExact: true, pixel: fingerTorch(1) }); e.ctx.measureHR(); await wait(20);
    assert.strictEqual(e.gum.length, 2); assert.strictEqual(JSON.stringify(e.gum[1].facingMode), '{"ideal":"environment"}'); await drive(e, 60); await wait(30); assert.strictEqual(saved(e).length, 1);
  });
  await t("browser WITHOUT requestVideoFrameCallback: rAF fallback ignores duplicate ticks and still measures correctly", async () => {
    const e = makeEnv({ noVFC: true, pixel: fingerTorch(2) }); e.ctx.measureHR(); await wait(20); await drive(e, 60); await wait(30);
    assert.strictEqual(saved(e).length, 1); assert(Math.abs(saved(e)[0].body.heart_rate - 72) <= 3, saved(e)[0].body.heart_rate); assert(e.state.stopped);
  });
  await t("front camera only: warns that flash is unavailable", async () => {
    const e = makeEnv({ facing: "user", torch: false, pixel: fingerTorch(1) }); e.ctx.measureHR(); await wait(20);
    assert(/front camera/i.test(e.els["#note"].textContent)); e.els["#cx"].onclick(); await wait(30); assert(e.state.stopped);
  });
  await t("app goes to background mid-measurement: cancelled and fully released", async () => {
    const e = makeEnv({ pixel: fingerTorch(1) }); e.ctx.measureHR(); await wait(20); await drive(e, 5);
    e.ctx.document.hidden = true; e.handlers.visibilitychange(); await wait(40);
    assert(e.state.stopped); assert.deepStrictEqual(e.torchLog, [true, false]); assert.strictEqual(saved(e).length, 0);
  });
  await t("double-tap Measure does not open a second camera stream", async () => {
    const e = makeEnv({ pixel: fingerTorch(1) }); e.ctx.measureHR(); e.ctx.measureHR(); await wait(30); assert.strictEqual(e.gum.length, 1); e.els["#cx"].onclick(); await wait(30);
  });
  console.log(pass + " heart-rate flow tests passed"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
