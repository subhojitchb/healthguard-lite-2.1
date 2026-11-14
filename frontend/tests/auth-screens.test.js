// Wiring test for the new email screens in a stub browser: correct endpoints/bodies, codes never written to storage.
const vm = require("vm"), fs = require("fs"), path = require("path"), assert = require("assert");
const els = {}, calls = [], stored = {};
const el = id => els[id] || (els[id] = { innerHTML: "", classList: { add() {}, toggle() {} }, querySelectorAll: () => [], isConnected: true, disabled: false, addEventListener() {} });
const reply = (path, body) => path.endsWith("forgot-password") ? { message: "sent", resend_in: 60 } : path.endsWith("reset-password") ? { message: "ok" }
  : path.endsWith("verify-email") ? { token: "T", user: { id: 1, full_name: "A B", email: body.email } } : path.endsWith("register") ? { user: { email: body.email }, verification_required: true, email_sent: true, resend_in: 60 } : { message: "x", resend_in: 60 };
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, performance, Intl, URL, AbortController, Promise, FormData: class { constructor(f) { this.f = f; } *[Symbol.iterator]() { yield* Object.entries(this.f.fields || {}); } },
  window: { API_BASE: "https://api.example.com", addEventListener() {}, removeEventListener() {} },
  localStorage: { getItem: k => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; }, removeItem: k => { delete stored[k]; } },
  sessionStorage: { setItem() { throw new Error("sessionStorage must not be used"); } },
  location: { hostname: "x.vercel.app", hash: "" }, navigator: {}, crypto: require("crypto").webcrypto,
  document: { querySelector: s => el(s), createElement: () => ({ getContext: () => ({}) }), addEventListener() {}, removeEventListener() {}, hidden: false },
  fetch: async (url, o) => { const b = o.body ? JSON.parse(o.body) : null; calls.push({ url, b }); return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => ({ ok: true, data: reply(url, b || {}) }) }; } };
ctx.window.window = ctx.window; ctx.self = ctx; vm.createContext(ctx);
for (const f of ["ppg.js", "steps.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", f), "utf8"), ctx, { filename: f });
const form = (fields, extra) => ({ ...extra, querySelector: () => ({ disabled: false }), preventDefault() {} });
(async () => {
  await new Promise(r => setTimeout(r, 30));
  const app = el("#app"); assert(/Forgot password\?/.test(app.innerHTML), "login screen has Forgot password link");
  // forgot → reset
  el("#fp").onclick({ preventDefault() {} }); assert(/Reset password/.test(app.innerHTML));
  const ff = { email: { value: "A@x.com " }, querySelector: () => ({ disabled: false }) }; await el("#ff").onsubmit({ preventDefault() {}, target: ff });
  assert.deepStrictEqual(calls.at(-1), { url: "https://api.example.com/api/auth/forgot-password", b: { email: "a@x.com" } });
  assert(/Choose a new password/.test(app.innerHTML));
  const rf = { code: { value: "123456" }, pw: { value: "new-password1" }, querySelector: () => ({ disabled: false }) }; await el("#rf").onsubmit({ preventDefault() {}, target: rf });
  assert.deepStrictEqual(calls.at(-1).b, { email: "a@x.com", code: "123456", new_password: "new-password1" });
  assert(/Welcome back/.test(app.innerHTML), "returns to login after reset");
  // verify
  ctx.showVerify(app, "a@x.com", true, 60); assert(/6-digit code/.test(app.innerHTML));
  const vf = { code: { value: " 654321" }, querySelector: () => ({ disabled: false }) }; await el("#vf").onsubmit({ preventDefault() {}, target: vf });
  assert.deepStrictEqual(calls.find(c => c.url.endsWith("verify-email")).b, { email: "a@x.com", code: "654321" });
  assert.strictEqual(stored.hg_token, "T");
  assert(!JSON.stringify(stored).includes("654321") && !JSON.stringify(stored).includes("123456"), "codes never stored");
  console.log("auth screen wiring tests passed"); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
