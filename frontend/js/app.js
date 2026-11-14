"use strict";
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const S = { user: null, route: "home", stepSession: null, charts: [] };
const TOKEN_KEY = "hg_token"; // only the auth token is stored client-side; all health data lives in PostgreSQL

// ---------- API ----------
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const localDay = d => { const x = new Date(d); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); };
// API base: injected at deploy time into js/config.js. Falls back to localhost ONLY when the page itself is served from localhost.
const API = (() => {
  const raw = String(window.API_BASE || "").trim().replace(/\/+$/, "");
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  if (!raw) return local ? { base: "http://localhost:5000" } : { err: "This deployment has no API_BASE configured, so it cannot reach the backend. Set API_BASE in Vercel and redeploy." };
  if (!local && (!/^https:\/\/[^/\s]+$/.test(raw) || /(^|\/\/)(localhost|127\.0\.0\.1)/.test(raw))) return { err: "API_BASE must be the public https URL of the backend (not localhost)." };
  return { base: raw };
})();
async function api(path, method = "GET", body) {
  if (API.err) throw new Error(API.err);
  const h = { "Content-Type": "application/json" };
  const t = localStorage.getItem(TOKEN_KEY); if (t) h.Authorization = "Bearer " + t;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 45000);   // Render free tier can take ~30-50 s to wake
  let res, j = {};
  try {
    res = await fetch(API.base + "/api" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    if (!(res.headers.get("content-type") || "").includes("json")) throw Object.assign(new Error("Unexpected (non-JSON) response from the server. Check API_BASE."), { status: res.status || 502 });
    j = await res.json();
  } catch (e) {
    if (e.status) throw e;
    throw new Error(e.name === "AbortError" ? "The server took too long to respond (it may be waking up). Try again." : "Cannot reach the server. Check your connection.");
  } finally { clearTimeout(timer); }
  if (res.status === 401 && t && !path.startsWith("/auth/login")) {
    localStorage.removeItem(TOKEN_KEY); if (S.stepSession) stopSteps(false); S.user = null; render();
  }
  if (!res.ok || j.ok === false) throw Object.assign(new Error(j.error || "Request failed (" + res.status + ")"), { status: res.status });
  return j.data;
}
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 3200); }
const fmt = d => d ? new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
const dayStr = localDay;   // local calendar date (never UTC)
function modal(html) { $("#sheet").innerHTML = html; $("#modal").hidden = false; }
function closeModal() { $("#modal").hidden = true; $("#sheet").innerHTML = ""; }
$("#modal").addEventListener("click", e => { if (e.target.id === "modal" && !S.lock) closeModal(); });
function countUp(el, to) { const t0 = performance.now(); (function f(t) { const p = Math.min((t - t0) / 700, 1); el.textContent = Math.round(to * p); if (p < 1) requestAnimationFrame(f); })(t0); }

// ---------- router ----------
const routes = { home: viewHome, history: viewHistory, emergency: viewEmergency, profile: viewProfile };
function go(r) { location.hash = r; }
window.addEventListener("hashchange", render);
async function render() {
  S.charts.forEach(c => c.destroy()); S.charts = []; S.abortHR?.();   // leaving a screen cancels any running measurement
  const app = $("#app"), nav = $("#nav");
  if (!S.user) { nav.hidden = true; return viewAuth(app); }
  nav.hidden = false;
  S.route = routes[location.hash.slice(1)] ? location.hash.slice(1) : "home";
  nav.querySelectorAll("a").forEach(a => a.classList.toggle("on", a.dataset.r === S.route));
  app.innerHTML = '<div class="skel"></div><br><div class="skel"></div>';
  try { await routes[S.route](app); } catch (e) { app.innerHTML = `<div class="card">⚠️ ${esc(e.message)}<br><br><button onclick="render()">Retry</button></div>`; }
}
$("#nav").addEventListener("click", e => { const a = e.target.closest("a"); if (a) go(a.dataset.r); });

// ---------- auth ----------
function viewAuth(app) {
  let mode = "login";
  const draw = () => {
    app.innerHTML = `<div class="card" style="margin-top:12vh"><h2>${mode === "login" ? "Welcome back" : "Create account"}</h2>
    <form id="f">${mode === "register" ? '<label>Full name</label><input name="full_name" required minlength="2" autocomplete="name">' : ""}
    <label>Email</label><input name="email" type="email" required autocomplete="email">
    <label>Password (min 8)</label><input name="password" type="password" required minlength="8" autocomplete="${mode === "login" ? "current-password" : "new-password"}">
    <button style="width:100%;margin-top:8px">${mode === "login" ? "Log in" : "Register"}</button></form>
    <p class="mut" style="text-align:center"><a href="#" id="sw">${mode === "login" ? "New here? Register" : "Have an account? Log in"}</a></p>
    ${mode === "login" ? '<p class="mut" style="text-align:center"><a href="#" id="fp">Forgot password?</a></p>' : ""}</div>`;
    $("#sw").onclick = e => { e.preventDefault(); mode = mode === "login" ? "register" : "login"; draw(); };
    if (mode === "login") $("#fp").onclick = e => { e.preventDefault(); showForgot(app); };
    $("#f").onsubmit = async e => {
      e.preventDefault(); const b = e.target.querySelector("button"); b.disabled = true;
      try {
        const d = await api("/auth/" + mode, "POST", Object.fromEntries(new FormData(e.target)));
        if (d.verification_required) return showVerify(app, d.user.email, d.email_sent, d.email_sent ? d.resend_in : 0);
        localStorage.setItem(TOKEN_KEY, d.token); S.user = d.user; await render(); checkInterrupted(); flushOutbox();
      } catch (er) {
        if (er.status === 403 && /not verified/i.test(er.message)) return showVerify(app, e.target.email.value.trim().toLowerCase(), false, 0);
        toast(er.message); b.disabled = false;
      }
    };
  }; draw();
}

// ---------- email verification & password reset (codes are only ever held in the input fields, never stored) ----------
function otpCountdown(btn, secs, label) {
  clearInterval(S.otpTimer); let n = secs;
  const tick = () => { if (!btn.isConnected) return clearInterval(S.otpTimer); btn.disabled = n > 0; btn.textContent = n > 0 ? `${label} (${n}s)` : label; n--; };
  tick(); S.otpTimer = setInterval(tick, 1000);
}
function showVerify(app, email, sent = true, wait = 60) {
  app.innerHTML = `<div class="card" style="margin-top:12vh"><h2>Verify your email</h2>
  <p class="mut">${sent ? "We sent a 6-digit code to" : "Enter the code we emailed to, or request a new one for"} <b>${esc(email)}</b>. Codes expire after 10 minutes.</p>
  <form id="vf"><label>Verification code</label><input name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">
  <button style="width:100%;margin-top:8px">Verify</button></form>
  <p style="text-align:center"><button class="sec" id="rs" type="button">Resend code</button></p>
  <p class="mut" style="text-align:center"><a href="#" id="bk">Back to login</a></p></div>`;
  otpCountdown($("#rs"), wait, "Resend code");
  if (!sent) toast("We couldn't email a code yet — tap Resend code.");
  $("#bk").onclick = e => { e.preventDefault(); clearInterval(S.otpTimer); viewAuth(app); };
  $("#rs").onclick = async () => { try { const d = await api("/auth/resend-verification", "POST", { email }); toast(d.message); otpCountdown($("#rs"), d.resend_in, "Resend code"); } catch (er) { toast(er.message); } };
  $("#vf").onsubmit = async e => {
    e.preventDefault(); const b = e.target.querySelector("button"); b.disabled = true;
    try {
      const d = await api("/auth/verify-email", "POST", { email, code: e.target.code.value.trim() });
      clearInterval(S.otpTimer); localStorage.setItem(TOKEN_KEY, d.token); S.user = d.user; await render(); checkInterrupted(); flushOutbox();
    } catch (er) { toast(er.message); b.disabled = false; }
  };
}
function showForgot(app) {
  app.innerHTML = `<div class="card" style="margin-top:12vh"><h2>Reset password</h2><p class="mut">Enter your account email and we'll send a 6-digit code.</p>
  <form id="ff"><label>Email</label><input name="email" type="email" required autocomplete="email"><button style="width:100%;margin-top:8px">Send code</button></form>
  <p class="mut" style="text-align:center"><a href="#" id="bk">Back to login</a></p></div>`;
  $("#bk").onclick = e => { e.preventDefault(); viewAuth(app); };
  $("#ff").onsubmit = async e => {
    e.preventDefault(); const b = e.target.querySelector("button"); b.disabled = true; const email = e.target.email.value.trim().toLowerCase();
    try { const d = await api("/auth/forgot-password", "POST", { email }); toast(d.message); showReset(app, email, d.resend_in); }
    catch (er) { toast(er.message); b.disabled = false; }
  };
}
function showReset(app, email, wait = 60) {
  app.innerHTML = `<div class="card" style="margin-top:12vh"><h2>Choose a new password</h2>
  <p class="mut">If <b>${esc(email)}</b> is registered, a 6-digit code was sent. It expires in 10 minutes.</p>
  <form id="rf"><label>Reset code</label><input name="code" required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code">
  <label>New password (min 8)</label><input name="pw" type="password" required minlength="8" autocomplete="new-password">
  <button style="width:100%;margin-top:8px">Reset password</button></form>
  <p style="text-align:center"><button class="sec" id="rs" type="button">Send a new code</button></p>
  <p class="mut" style="text-align:center"><a href="#" id="bk">Back to login</a></p></div>`;
  otpCountdown($("#rs"), wait, "Send a new code");
  $("#bk").onclick = e => { e.preventDefault(); clearInterval(S.otpTimer); viewAuth(app); };
  $("#rs").onclick = async () => { try { const d = await api("/auth/forgot-password", "POST", { email }); toast(d.message); otpCountdown($("#rs"), d.resend_in, "Send a new code"); } catch (er) { toast(er.message); } };
  $("#rf").onsubmit = async e => {
    e.preventDefault(); const b = e.target.querySelector("button"); b.disabled = true;
    try { await api("/auth/reset-password", "POST", { email, code: e.target.code.value.trim(), new_password: e.target.pw.value }); clearInterval(S.otpTimer); toast("Password updated. Please log in."); viewAuth(app); }
    catch (er) { toast(er.message); b.disabled = false; }
  };
}
async function logout() {
  S.abortHR?.(); try { await stopSteps(false); } catch {}
  try { await api("/auth/logout", "POST"); } catch (e) { toast("Signed out on this device; the server could not be reached to revoke the token."); }
  localStorage.removeItem(TOKEN_KEY); S.user = null; location.hash = ""; render();
}

// ---------- home ----------
async function viewHome(app) {
  const [latest, daily] = await Promise.all([api("/health/latest"), api("/activity/daily?days=1&tz=" + encodeURIComponent(TZ))]);
  const today = daily.find(d => d.date === dayStr(new Date())); S.baseSteps = today ? today.steps : 0;
  const h = new Date().getHours(), greet = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  app.innerHTML = `<h2>${greet}, ${esc(S.user.full_name.split(" ")[0])}</h2><div class="mut">${new Date().toLocaleDateString([], { dateStyle: "full" })}</div>
  <div class="card grad"><div class="row"><b>❤️ Heart rate</b><span class="pill">${latest ? "Last: " + fmt(latest.recorded_at) : "No measurement yet"}</span></div>
    ${latest && latest.heart_rate ? `<div class="big"><span class="pulse">♥</span> <span id="bpm">0</span> <small>BPM</small></div>` : '<p>No heart-rate reading yet. Measure to see your first value.</p>'}
    <p class="mut">Approximate wellness measurement — not a medical diagnosis.</p><button class="sec" id="mhr">Measure heart rate</button></div>
  <div class="grid"><div class="card"><b>🩸 SpO₂</b><p class="mut">Unavailable. Phone cameras can't reliably measure blood oxygen; no compatible external sensor is connected.</p></div>
  <div class="card"><b>👟 Steps today</b><div class="big" id="steps">0</div><div class="mut">Goal 8,000</div>
    <div style="height:8px;background:#dff5f3;border-radius:9px;margin:8px 0"><div id="bar" style="height:100%;border-radius:9px;background:var(--teal);width:0;transition:width .6s"></div></div>
    <div class="row"><button id="sst">Start counting</button><button class="sec" id="sps" disabled>Stop</button></div><div class="mut" id="smsg"></div></div></div>
  <div class="card row"><span>Monitoring: <b>${S.stepSession ? "Counting steps" : "Idle"}</b></span><button class="danger" onclick="go('emergency')">🆘 Emergency</button></div>`;
  if (latest && latest.heart_rate) countUp($("#bpm"), latest.heart_rate);
  updateSteps(); $("#mhr").onclick = measureHR; $("#sst").onclick = startSteps; $("#sps").onclick = () => stopSteps(false);
  if (S.stepSession) { $("#sst").disabled = true; $("#sps").disabled = false; }
  showOutbox();
}
function updateSteps() { const el = $("#steps"); if (!el) return; const n = S.baseSteps + (S.stepSession ? S.stepSession.count : 0); el.textContent = n; $("#bar").style.width = Math.min(100, n / 80) + "%"; }

// ---------- heart rate (camera PPG) ----------
async function measureHR() {
  if (S.measuring) return;   // never run two measurements / open two camera streams
  if (!navigator.mediaDevices?.getUserMedia) return toast("Camera access is not supported in this browser (HTTPS required).");
  S.measuring = true; S.lock = true;
  const R = { stream: null, track: null, torch: false, raf: 0, wd: 0, video: null, released: false };
  const ts = [], red = [], cover = [], set = (id, txt) => { const e = $(id); if (e) e.textContent = txt; };
  const onHide = () => { if (document.hidden) abort("Measurement cancelled: the app went to the background."); };
  // release(): idempotent and never throws. Torch off first, then every track stopped, then the video detached.
  const release = async () => {
    if (R.released) return; R.released = true;
    cancelAnimationFrame(R.raf); clearInterval(R.wd);
    document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", release);
    try { if (R.track && R.torch) await Promise.race([R.track.applyConstraints({ advanced: [{ torch: false }] }), new Promise(r => setTimeout(r, 400))]); } catch {}
    try { R.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); }); } catch {}
    try { if (R.video) { R.video.pause(); R.video.srcObject = null; } } catch {}
    S.measuring = false; S.lock = false; S.abortHR = null;
  };
  const abort = async msg => { await release(); closeModal(); if (msg) toast(msg); };
  S.abortHR = () => abort();
  document.addEventListener("visibilitychange", onHide); window.addEventListener("pagehide", release);
  modal(`<h2>Measuring…</h2><p class="mut">Gently cover the rear camera <b>and flash</b> with your fingertip. Stay still.</p>
  <div class="ring"><span id="cd">30</span></div><canvas id="wave" width="460" height="90" style="width:100%"></canvas>
  <p class="mut">Camera: <b id="cs">starting</b> · Flashlight: <b id="fs">off</b> · <span id="qs"></span></p><button class="sec" id="cx" style="width:100%">Cancel</button>`);
  $("#cx").onclick = () => abort();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: 320, height: 240 }, audio: false });
    if (R.released) { stream.getTracks().forEach(t => t.stop()); return; }   // cancelled while the permission prompt was open
    R.stream = stream; R.track = stream.getVideoTracks()[0];
    R.track.onended = () => abort("The camera was disconnected or taken by another app.");
    set("#cs", "active");
    try {
      if (R.track.getCapabilities?.().torch) { await R.track.applyConstraints({ advanced: [{ torch: true }] }); R.torch = true; set("#fs", "on"); }
      else set("#fs", "not supported");
    } catch { set("#fs", "failed"); }
    if (R.released) return;
    const v = R.video = document.createElement("video"); v.srcObject = stream; v.muted = true; v.playsInline = true;
    try { await v.play(); } catch (e) { return abort("Could not start the camera preview: " + (e.message || e.name)); }
    if (R.released) return;
    const cv = document.createElement("canvas"); cv.width = cv.height = 24; const cx = cv.getContext("2d", { willReadFrequently: true });
    const wave = $("#wave")?.getContext("2d"), T0 = performance.now(), DUR = 30000; let lastFrame = T0;
    R.wd = setInterval(() => {   // watchdog: camera that never starts, or stalls mid-measurement
      const now = performance.now();
      if (!ts.length && now - T0 > 5000) abort("No camera frames received. Try again or use another browser.");
      else if (ts.length && now - lastFrame > 3000) abort("The camera stopped delivering frames.");
    }, 1000);
    const loop = () => {
      if (R.released) return;
      try {
        const t = performance.now() - T0;
        if (v.videoWidth) {
          cx.drawImage(v, v.videoWidth / 2 - 24, v.videoHeight / 2 - 24, 48, 48, 0, 0, 24, 24);
          const d = cx.getImageData(0, 0, 24, 24).data; let r = 0, g = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; }
          r /= 576; g /= 576; ts.push(t); red.push(r); cover.push(r > 120 && g < r * 0.5); lastFrame = performance.now();
          if (wave) {
            const sm = PPG.bandpass(ts, red).slice(-200); wave.clearRect(0, 0, 460, 90); wave.beginPath(); wave.strokeStyle = "#0e9f9a"; wave.lineWidth = 2;
            const mx = Math.max(1e-6, ...sm.map(Math.abs)); sm.forEach((y, i) => { const X = i / 200 * 460, Y = 45 - y / mx * 38; i ? wave.lineTo(X, Y) : wave.moveTo(X, Y); }); wave.stroke();
          }
          const c = cover.slice(-30).filter(Boolean).length / Math.min(30, cover.length); set("#qs", c > 0.8 ? "Finger detected ✓" : "Cover camera & flash");
        }
        set("#cd", Math.max(0, Math.ceil((DUR - t) / 1000)));
        if (t >= DUR) { finish(); return; }
      } catch (e) { abort("Measurement failed: " + (e.message || e)); return; }
      R.raf = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) {
    const msg = { NotAllowedError: "Camera permission was denied.", NotFoundError: "No camera was found.", NotReadableError: "The camera is in use by another app.", OverconstrainedError: "No suitable rear camera.", SecurityError: "Camera access needs a secure (https) page." }[e.name];
    await abort("Camera unavailable: " + (msg || e.message || e.name));
  }
  async function finish() {
    await release(); closeModal();   // camera + torch are off before any analysis or network call
    try {
      const res = PPG.analyzePPG(ts, red, cover);
      if (!res.ok) return toast("No result: " + res.reason + " Please try again.");   // insufficient quality → nothing is reported or saved
      try { await api("/health/records", "POST", { heart_rate: res.bpm, signal_quality: res.quality, measurement_type: "camera_ppg" }); toast(`Saved: ${res.bpm} BPM (approximate)`); render(); }
      catch (e) { toast("Measured " + res.bpm + " BPM but could not save: " + e.message); }
    } catch (e) { toast("Could not analyse the signal: " + (e.message || e)); }
  }
}

// ---------- steps (DeviceMotion) ----------
// Active session is checkpointed to localStorage (count + times only) so an interrupted session can be recovered explicitly.
// Completed sessions go through an outbox with a client UUID: failed saves are retried and the server de-duplicates, so nothing is lost or double-counted.
// PostgreSQL stays the source of truth for all history.
const stepKey = uid => "hg_active_steps_" + uid, outKey = uid => "hg_outbox_" + uid;
const readJSON = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const newId = () => crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
function persistSession() { const s = S.stepSession; if (s) writeJSON(stepKey(s.uid), { id: s.id, start: s.start, count: s.det.count, updated: Date.now() }); }
function stepVis() { if (document.hidden) persistSession(); else acquireWake(); }
async function acquireWake() { try { const s = S.stepSession; if (s && navigator.wakeLock && !s.wake) { s.wake = await navigator.wakeLock.request("screen"); s.wake.addEventListener("release", () => { if (S.stepSession === s) s.wake = null; }); } } catch {} }
function releaseWake(s) { try { s.wake?.release(); } catch {} s.wake = null; }
function queueActivity(uid, p) { const q = readJSON(outKey(uid)) || []; if (!q.some(x => x.client_id === p.client_id)) q.push(p); writeJSON(outKey(uid), q); }
async function flushOutbox(announce) {
  if (S.flushing || !S.user) return; S.flushing = true; const uid = S.user.id; let saved = 0, left = 0;
  try {
    let q = readJSON(outKey(uid)) || [];
    for (const item of [...q]) {
      try { await api("/activity", "POST", item); saved++; }
      catch (e) {
        if (e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status)) toast("A step session was rejected by the server and discarded: " + e.message);   // permanently invalid
        else { left = q.length; break; }   // offline / 5xx / auth: keep for the next attempt
      }
      q = q.filter(x => x.client_id !== item.client_id); writeJSON(outKey(uid), q);
    }
    if (!left) localStorage.removeItem(outKey(uid));
  } finally { S.flushing = false; }
  if (announce) toast(left ? "Steps kept on this device; they will sync when the server is reachable." : saved ? "Steps saved" : "");
  if (saved && S.route === "home" && S.user) render();
}
function showOutbox() { const q = S.user && readJSON(outKey(S.user.id)); const m = $("#smsg"); if (q?.length && m && !S.stepSession) { m.innerHTML = `⏳ ${q.length} session(s) waiting to sync — <a href="#" id="rsync">retry</a>`; $("#rsync").onclick = e => { e.preventDefault(); flushOutbox(true); }; } }
function checkInterrupted() {
  if (!S.user || S.stepSession) return; const uid = S.user.id, prev = readJSON(stepKey(uid)); if (!prev) return;
  if (Date.now() - prev.updated < 6000) return;   // still being counted by another tab
  if (!prev.count) { localStorage.removeItem(stepKey(uid)); return; }
  modal(`<h2>Interrupted step session</h2><p>The app closed or reloaded while counting. <b>${prev.count} steps</b> were counted between ${fmt(prev.start)} and ${fmt(prev.updated)}. Phone sensors stop when the app closes, so any later steps were not counted.</p>
  <button id="rs" style="width:100%">Save these steps</button><br><br><button class="sec" id="rd" style="width:100%">Discard</button>`);
  $("#rs").onclick = async () => { queueActivity(uid, { steps: prev.count, duration_seconds: Math.max(0, Math.round((prev.updated - prev.start) / 1000)), started_at: new Date(prev.start).toISOString(), ended_at: new Date(prev.updated).toISOString(), client_id: prev.id }); localStorage.removeItem(stepKey(uid)); closeModal(); await flushOutbox(true); };
  $("#rd").onclick = () => { localStorage.removeItem(stepKey(uid)); closeModal(); };
}
async function startSteps() {
  if (S.stepSession) return;   // exactly one session and one listener at a time
  if (!("DeviceMotionEvent" in window)) return toast("Motion sensors are not supported on this device/browser.");
  const prev = readJSON(stepKey(S.user.id));
  if (prev && Date.now() - prev.updated < 6000) return toast("Another tab or window is already counting steps.");
  if (prev) return checkInterrupted();   // resolve the interrupted session first
  if (typeof DeviceMotionEvent.requestPermission === "function") {   // iOS: must be requested from the tap itself
    try { if (await DeviceMotionEvent.requestPermission() !== "granted") return toast("Motion permission denied."); } catch { return toast("Motion permission failed."); }
  }
  if (S.stepSession) return;
  const ss = S.stepSession = { id: newId(), uid: S.user.id, start: Date.now(), det: new Steps.StepDetector(), got: false, count: 0, lastSave: 0, wake: null };
  ss.h = e => {
    const a = e.accelerationIncludingGravity; if (!a || a.x == null || a.y == null || a.z == null) return;
    ss.got = true;
    if (ss.det.push(a.x, a.y, a.z, e.timeStamp || performance.now())) { ss.count = ss.det.count; updateSteps(); }
    const now = Date.now(); if (now - ss.lastSave > 2000) { ss.lastSave = now; persistSession(); }
  };
  window.addEventListener("devicemotion", ss.h); document.addEventListener("visibilitychange", stepVis); window.addEventListener("pagehide", persistSession);
  persistSession(); acquireWake();
  setTimeout(() => { if (S.stepSession === ss && !ss.got) { toast("No motion data received — the sensor is unavailable."); stopSteps(true); } }, 3000);
  if ($("#sst")) { $("#sst").disabled = true; $("#sps").disabled = false; $("#smsg").textContent = "Counting… keep the phone on you while walking. Keep the app open."; }
}
async function stopSteps(discard) {
  const ss = S.stepSession; if (!ss) return; S.stepSession = null;   // clear first: a second call is a no-op
  window.removeEventListener("devicemotion", ss.h); document.removeEventListener("visibilitychange", stepVis); window.removeEventListener("pagehide", persistSession); releaseWake(ss);
  const count = ss.det.count, end = Date.now();
  if (!discard && count > 0) queueActivity(ss.uid, { steps: count, duration_seconds: Math.max(0, Math.round((end - ss.start) / 1000)), started_at: new Date(ss.start).toISOString(), ended_at: new Date(end).toISOString(), client_id: ss.id });
  localStorage.removeItem(stepKey(ss.uid));   // only after the session is safely in the outbox
  if ($("#sst")) { $("#sst").disabled = false; $("#sps").disabled = true; $("#smsg").textContent = ""; }
  if (!discard && count > 0) await flushOutbox(true);
}

// ---------- history ----------
async function viewHistory(app) {
  const [hr, daily] = await Promise.all([api("/health/records?limit=60"), api("/activity/daily?days=14&tz=" + encodeURIComponent(TZ))]);
  app.innerHTML = `<h2>History</h2><div class="card"><b>Heart rate</b>${hr.length ? '<canvas id="c1" height="160"></canvas>' : '<p class="mut">No heart-rate records yet.</p>'}</div>
  <div class="card"><b>Daily steps (14 days)</b>${daily.length ? '<canvas id="c2" height="160"></canvas>' : '<p class="mut">No activity recorded yet.</p>'}</div>
  <div class="card"><b>View by date</b><input type="date" id="dt" max="${dayStr(new Date())}"><div id="dr" class="mut">Pick a date to see readings.</div></div>
  <div class="card"><b>Recent measurements</b>${hr.slice(0, 10).map(r => `<div class="row"><span>${r.heart_rate ?? "—"} BPM</span><span class="mut">${fmt(r.recorded_at)}</span></div>`).join("") || '<p class="mut">Nothing yet.</p>'}</div>`;
  const opt = { responsive: true, animation: { duration: 900 }, plugins: { legend: { display: false } } };
  if (hr.length && window.Chart) { const d = [...hr].reverse(); S.charts.push(new Chart($("#c1"), { type: "line", data: { labels: d.map(r => new Date(r.recorded_at).toLocaleDateString()), datasets: [{ data: d.map(r => r.heart_rate), borderColor: "#0e9f9a", backgroundColor: "rgba(42,212,200,.2)", fill: true, tension: .35 }] }, options: opt })); }
  if (daily.length && window.Chart) S.charts.push(new Chart($("#c2"), { type: "bar", data: { labels: daily.map(d => d.date.slice(5)), datasets: [{ data: daily.map(d => d.steps), backgroundColor: "#2ad4c8", borderRadius: 8 }] }, options: opt }));
  $("#dt").onchange = async e => { try { const r = await api("/health/records?date=" + e.target.value + "&tz=" + encodeURIComponent(TZ)); $("#dr").innerHTML = r.length ? r.map(x => `<div class="row"><b>${x.heart_rate} BPM</b><span>${fmt(x.recorded_at)}</span></div>`).join("") : "No readings on this date."; } catch (er) { toast(er.message); } };
}

// ---------- emergency ----------
async function viewEmergency(app) {
  const [contacts, events] = await Promise.all([api("/emergency/contacts"), api("/emergency/events")]);
  app.innerHTML = `<h2>Emergency</h2><button class="sosbtn danger" id="sos">SOS</button>
  <p class="mut" style="text-align:center">Records the event and gives you call/share options. It does <b>not</b> send SMS automatically.</p>
  <a class="btn danger" href="tel:112" style="width:100%;text-align:center">📞 Call 112 (India)</a>
  <div class="card"><div class="row"><b>Emergency contacts</b><button class="sec" id="ac">+ Add</button></div>
  ${contacts.map(c => `<div class="row" style="margin-top:10px"><div><b>${esc(c.contact_name)}</b><div class="mut">${esc(c.relationship || "")} ${esc(c.phone_number)}</div></div>
  <div><a class="btn" href="tel:${esc(c.phone_number)}">Call</a> <button class="sec" data-e="${c.id}">Edit</button> <button class="sec" data-d="${c.id}">🗑</button></div></div>`).join("") || '<p class="mut">No contacts yet.</p>'}</div>
  <div class="card"><b>Past SOS events</b>${events.map(e => `<div class="row"><span>${esc(e.event_status)}${e.latitude != null ? " · 📍" : ""}</span><span class="mut">${fmt(e.created_at)}</span></div>`).join("") || '<p class="mut">None.</p>'}</div>`;
  $("#ac").onclick = () => contactForm(); $("#sos").onclick = sosFlow;
  app.querySelectorAll("[data-e]").forEach(b => b.onclick = () => contactForm(contacts.find(c => c.id == b.dataset.e)));
  app.querySelectorAll("[data-d]").forEach(b => b.onclick = async () => { if (!confirm("Delete this contact?")) return; try { await api("/emergency/contacts/" + b.dataset.d, "DELETE"); render(); } catch (e) { toast(e.message); } });
}
function contactForm(c) {
  modal(`<h2>${c ? "Edit" : "Add"} contact</h2><form id="cf"><label>Name</label><input name="contact_name" required value="${esc(c?.contact_name)}"><label>Phone</label><input name="phone_number" type="tel" required value="${esc(c?.phone_number)}"><label>Relationship</label><input name="relationship" value="${esc(c?.relationship)}"><button style="width:100%">Save</button></form>`);
  $("#cf").onsubmit = async e => { e.preventDefault(); try { await api(c ? "/emergency/contacts/" + c.id : "/emergency/contacts", c ? "PUT" : "POST", Object.fromEntries(new FormData(e.target))); closeModal(); render(); } catch (er) { toast(er.message); } };
}
function sosFlow() {
  let n = 5, stop = false; S.lock = true;
  modal(`<div style="text-align:center"><h2>Activating SOS</h2><div class="ring" style="border-top-color:var(--red)"><span id="sn">5</span></div><button class="sec" id="sc" style="width:100%">Cancel</button></div>`);
  const iv = setInterval(() => { n--; if ($("#sn")) $("#sn").textContent = n; if (n <= 0) { clearInterval(iv); if (!stop) fire(); } }, 1000);
  $("#sc").onclick = () => { stop = true; clearInterval(iv); S.lock = false; closeModal(); };
  async function fire() {
    let loc = {}; if (navigator.geolocation) loc = await new Promise(r => navigator.geolocation.getCurrentPosition(p => r({ latitude: p.coords.latitude, longitude: p.coords.longitude }), () => r({}), { timeout: 8000, enableHighAccuracy: true }));
    S.lock = false;
    try {
      const d = await api("/emergency/sos", "POST", loc);
      const link = loc.latitude != null ? `https://maps.google.com/?q=${loc.latitude},${loc.longitude}` : null;
      modal(`<h2>SOS recorded</h2><p class="mut">${loc.latitude != null ? "Location captured." : "Location not available/denied."} No message has been sent automatically.</p>
      <a class="btn danger" href="tel:112" style="width:100%;text-align:center">Call 112</a>${d.contacts.map(c => `<p><a class="btn" href="tel:${esc(c.phone_number)}">Call ${esc(c.contact_name)}</a></p>`).join("")}
      ${link && navigator.share ? '<button id="shr" style="width:100%">Share my location</button>' : link ? `<p><a href="${link}">${link}</a></p>` : ""}<br><button class="sec" onclick="closeModal();render()" style="width:100%">Close</button>`);
      if ($("#shr")) $("#shr").onclick = () => navigator.share({ title: "My emergency location", text: "I need help. My location:", url: link }).catch(() => {});
    } catch (e) {
      modal(`<h2>Could not record SOS</h2><p>${esc(e.message)}</p><a class="btn danger" href="tel:112" style="width:100%;text-align:center">Call 112 now</a><br><br><button class="sec" onclick="closeModal()" style="width:100%">Close</button>`);
    }
  }
}

// ---------- profile ----------
async function viewProfile(app) {
  const p = await api("/profile"); S.user = { ...S.user, ...p };
  app.innerHTML = `<h2>Profile</h2><div class="card"><form id="pf"><label>Full name</label><input name="full_name" required value="${esc(p.full_name)}"><label>Email</label><input value="${esc(p.email)}" disabled>
  <label>Phone</label><input name="phone_number" type="tel" value="${esc(p.phone_number)}"><label>Date of birth (optional)</label><input name="date_of_birth" type="date" value="${esc(p.date_of_birth)}"><button style="width:100%">Save changes</button></form></div>
  <div class="card"><div class="row"><span>Install app</span><button class="sec" id="inst" hidden>Install</button></div><p class="mut">Emergency contacts are managed in the Emergency tab.</p></div>
  <button class="danger" id="lo" style="width:100%">Log out</button>`;
  $("#pf").onsubmit = async e => { e.preventDefault(); try { S.user = { ...S.user, ...await api("/profile", "PUT", Object.fromEntries(new FormData(e.target))) }; toast("Profile saved"); } catch (er) { toast(er.message); } };
  $("#lo").onclick = logout; if (S.installEv) { $("#inst").hidden = false; $("#inst").onclick = () => S.installEv.prompt(); }
}
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); S.installEv = e; });

// ---------- boot ----------
(async function boot() {
  if (API.err) { $("#app").innerHTML = `<div class="card"><h2>Configuration error</h2><p>${esc(API.err)}</p></div>`; $("#splash").classList.add("gone"); return; }
  window.addEventListener("online", () => flushOutbox(true));
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("service-worker.js").catch(() => {});
  if (localStorage.getItem(TOKEN_KEY)) { try { S.user = await api("/auth/me"); } catch { localStorage.removeItem(TOKEN_KEY); } }
  await render(); setTimeout(() => $("#splash").classList.add("gone"), 900);
  if (S.user) { checkInterrupted(); flushOutbox(); }
})();
