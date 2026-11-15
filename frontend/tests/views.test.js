// Regression smoke test (stub browser): every main view renders from API data, and the modal open/close transition has no race.
const vm = require("vm"), fs = require("fs"), path = require("path"), assert = require("assert");
const els = {}; const el = id => els[id] || (els[id] = { innerHTML: "", hidden: false, style: {}, dataset: {}, isConnected: true, disabled: false, textContent: "", addEventListener() {}, value: "",
  classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle() {}, contains(c) { return this._s.has(c); } }, querySelectorAll: () => [] });
const D = { "/health/latest": { heart_rate: 71, recorded_at: new Date().toISOString() }, "/activity/daily": [], "/health/records": [{ heart_rate: 71, recorded_at: new Date().toISOString() }],
  "/emergency/contacts": [{ id: 1, contact_name: "Mom", phone_number: "+919000000001", relationship: "Mother" }], "/emergency/events": [{ id: 1, event_status: "recorded", created_at: new Date().toISOString() }],
  "/profile": { id: 1, full_name: "Asha Rao", email: "a@x.co", phone_number: "+911234567890", date_of_birth: "2000-01-01" } };
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, performance, Intl, URL, AbortController, Promise, FormData: class {}, cancelAnimationFrame() {}, requestAnimationFrame() { return 0; },
  window: { API_BASE: "https://api.example.com", addEventListener() {}, removeEventListener() {} }, localStorage: { getItem: k => k === "hg_token" ? "T" : null, setItem() {}, removeItem() {} },
  location: { hostname: "x.vercel.app", hash: "" }, navigator: {}, crypto: require("crypto").webcrypto, confirm: () => true,
  document: { hidden: false, querySelector: s => el(s), createElement: () => ({ getContext: () => ({}) }), addEventListener() {}, removeEventListener() {} },
  fetch: async (url, o) => { const p = url.replace("https://api.example.com/api", "").split("?")[0]; const data = p === "/auth/me" ? D["/profile"] : D[p] !== undefined ? D[p] : {}; return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ ok: true, data }) }; } };
ctx.window.window = ctx.window; ctx.self = ctx; vm.createContext(ctx);
for (const f of ["ppg.js", "steps.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", f), "utf8"), ctx, { filename: f });
const wait = ms => new Promise(r => setTimeout(r, ms)); let n = 0; const ok = m => { n++; console.log("ok -", m); };
(async () => {
  await wait(60); const app = els["#app"];
  assert(/Good (morning|afternoon|evening), Asha/.test(app.innerHTML) && /Measure heart rate/.test(app.innerHTML) && /id="bpm"/.test(app.innerHTML) && /Steps today/.test(app.innerHTML) && /not a medical diagnosis/.test(app.innerHTML)); ok("Home: greeting, heart-rate card (latest reading shown), SpO2 note, steps, wellness disclaimer");
  ctx.location.hash = "#history"; await vm.runInContext("render()", ctx); assert(/History/.test(app.innerHTML) && /Recent measurements/.test(app.innerHTML) && /71 BPM/.test(app.innerHTML)); ok("History renders records");
  ctx.location.hash = "#emergency"; await vm.runInContext("render()", ctx); assert(/SOS/.test(app.innerHTML) && /Mom/.test(app.innerHTML) && /tel:112/.test(app.innerHTML) && /Past SOS events/.test(app.innerHTML)); ok("Emergency: SOS button, contact, 112 link, events");
  ctx.location.hash = "#profile"; await vm.runInContext("render()", ctx); assert(/Asha Rao/.test(app.innerHTML) && /Log out/.test(app.innerHTML)); ok("Profile renders and offers logout");
  // modal transition: open → close → (reopen within 160 ms must survive the pending close timer) → close completes
  const m = els["#modal"]; ctx.modal("<b>A</b>"); assert.strictEqual(m.hidden, false);
  ctx.closeModal(); assert(m.classList.contains("closing") && m.hidden === false); ctx.modal("<b>B</b>"); await wait(220);
  assert.strictEqual(m.hidden, false, "re-opened modal must not be hidden by the stale close timer"); assert(!m.classList.contains("closing") && /B/.test(els["#sheet"].innerHTML)); ok("Modal: re-open during close animation is not hidden");
  ctx.closeModal(); await wait(220); assert.strictEqual(m.hidden, true); assert.strictEqual(els["#sheet"].innerHTML, ""); ok("Modal: closes after the exit transition and clears content");
  ctx.contactForm(); assert(/Add contact/.test(els["#sheet"].innerHTML) && m.hidden === false); ctx.closeModal(); await wait(220); ok("Emergency contact form opens/closes through the new modal code");
  console.log(n + " view/modal regression tests passed"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
