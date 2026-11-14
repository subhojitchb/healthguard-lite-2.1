// Smoke test: app.js boots in a stub browser; config guard refuses unsafe API_BASE on a non-local host.
const vm = require("vm"), fs = require("fs"), path = require("path"), assert = require("assert");
function boot({ host, apiBase }) {
  const els = {}; const el = id => els[id] || (els[id] = { innerHTML: "", hidden: false, classList: { add() { this.added = 1; }, toggle() {}, remove() {} }, querySelectorAll: () => [], addEventListener() {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; } });
  const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, performance, Intl, URL, AbortController, Promise,
    window: { API_BASE: apiBase, addEventListener() {}, removeEventListener() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { hostname: host, hash: "" }, navigator: {}, crypto: require("crypto").webcrypto,
    document: { querySelector: s => el(s), createElement: () => ({ getContext: () => ({}) }), addEventListener() {}, removeEventListener() {}, hidden: false },
    fetch: async () => { throw new Error("no network in test"); } };
  ctx.window.window = ctx.window; ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of ["ppg.js", "steps.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", f), "utf8"), ctx, { filename: f });
  return { els, ctx };
}
(async () => {
  let r = boot({ host: "myapp.vercel.app", apiBase: "" }); await new Promise(r => setTimeout(r, 50));
  assert(/no API_BASE configured/.test(r.els["#app"].innerHTML), "prod without API_BASE must show a configuration error, not fall back to localhost");
  r = boot({ host: "myapp.vercel.app", apiBase: "http://localhost:5000" }); await new Promise(r => setTimeout(r, 50));
  assert(/must be the public https URL/.test(r.els["#app"].innerHTML), "prod with localhost API_BASE must be refused");
  r = boot({ host: "myapp.vercel.app", apiBase: "https://api.onrender.com" }); await new Promise(r => setTimeout(r, 50));
  assert(!/Configuration error/.test(r.els["#app"].innerHTML), "valid https API_BASE must boot normally");
  r = boot({ host: "localhost", apiBase: "" }); await new Promise(r => setTimeout(r, 50));
  assert(!/Configuration error/.test(r.els["#app"].innerHTML), "localhost dev fallback allowed");
  console.log("4 boot/config tests passed");
})().catch(e => { console.error(e); process.exit(1); });
