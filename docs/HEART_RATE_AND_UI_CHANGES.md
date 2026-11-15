# HealthGuard Lite 2.3 — heart-rate repair & UI polish (change report)

## Modified files (everything else is byte-identical to 2.2)
| File | Change |
|---|---|
| `frontend/js/ppg.js` | **Added** a streaming analysis (`Monitor`, `estimate`, `classifyFrame`). Existing functions (`analyzePPG`, `bandpass`, `movavg`) are kept untouched but no longer used by the UI. |
| `frontend/js/app.js` | **Replaced the `measureHR()` function** (the release/abort cleanup logic is preserved) and added two helpers (`openRearCamera`, `showHRFailure`); `modal()/closeModal()` gained an exit transition. Nothing else in the file changed (auth, steps, history, emergency, profile are identical). |
| `frontend/css/style.css` | New palette values in `:root` and an append-only "polish layer" at the end; no existing rule deleted. |
| `frontend/tests/ppg-monitor.test.js`, `hr-flow.test.js`, `views.test.js` | New tests. |
| `docs/HEART_RATE_AND_UI_CHANGES.md` | This report. |

Not touched: backend, migrations, auth/email/JWT, `index.html`, `service-worker.js`, `steps.js`, vercel/render config, README, API contracts. The save call is the same `POST /api/health/records {heart_rate, signal_quality, measurement_type:"camera_ppg"}`; the server's rule (quality ≥ 0.6) is still satisfied because the client's acceptance threshold is also 0.6.

## The heart-rate bug(s)
Found by reading the code and reproducing it with synthetic recordings (see `/tmp`-style repro in the tests): the old pipeline **rejected the recording before looking for a pulse**.
1. **All-or-nothing finger gate over the whole 30 s.** A frame counted as "finger" only if `r > 120 && g < 0.5·r`, and ≥ 85 % of *all* frames had to pass, including the seconds before the user had placed the finger. Placing the finger 5 s late already fails (reproduced: "Finger was not covering the camera consistently").
2. **Hard colour thresholds.** Phones that render skin with g/r ≈ 0.55 fail the ratio; any capture without a torch (iOS Safari has none; many Android devices/browsers too) is too dim for `r > 120` → *always* fails. (Both reproduced.)
3. **Sampling from `requestAnimationFrame`** (~60 Hz) of a ~30 fps camera: duplicate samples and timing jitter instead of one sample per camera frame.
4. **Single verdict at the end** with strict criteria (≥ 15 peaks, every interval within ±20 % of the median, quality ≥ 0.7) and a generic message; the user stared at a countdown with no feedback and no way to learn what was wrong.
Not verified: whether auto-exposure on specific phones also flattens the pulse (plausible, needs real devices).

## What changed in the algorithm
- **Per-frame sampling** via `requestVideoFrameCallback` (fallback: `requestAnimationFrame` skipping repeated frames). Uniform 30 Hz resampling removes jitter/dropped-frame gaps.
- **Finger state** per frame: dark / saturated (red clipped) / not red-dominant / ok — relative, not absolute thresholds, so dim no-torch captures work. Finger lifted > 0.6 s resets progress; the clock only starts when the finger is on.
- **Settling**: first 3 s after placement are ignored; estimates need ≥ 10 s of covered signal (window = last 15 s).
- **DC/baseline removal** (1.2 s centred moving average) + light smoothing; ROI is the centre half of the frame (1,024 px averaged).
- **Two independent estimates**: Hann-windowed spectrum over 42–198 bpm *and* beat-interval median. They must agree within 8 %; a dominant 2nd harmonic is handled; wrong-octave results are refused, not "fixed".
- **Quality** = spectral SNR × agreement × (1 − motion). **Motion** = outlier 1-s windows or sudden brightness jumps.
- **Release rule**: the last 5 one-second estimates must each be good (≥ 0.6) and within 5 bpm. Typical time ≈ 20 s (median in simulation), maximum 30 s of covered signal / 60 s total, then a specific failure message (no finger, too dark, over-exposed, movement, inconsistent, weak) and **Try again**. Failed measurements are never saved or shown.
- **Camera/torch**: tries `exact` → `ideal` environment → any camera; torch only requested if the track reports support, and "on" is shown only if the track confirms it (otherwise "not supported"/"failed"/"on (unconfirmed)" plus a note). Front-camera fallback is flagged. Cleanup (torch off, tracks stopped) runs on finish, failure, cancel, error, camera loss, backgrounding and navigation.
- **Live UI**: instruction + live hint, ring state (waiting / settling / good pulse-glow / weak), quality meter, countdown of remaining seconds, wave. Existing disclaimer kept and repeated in the modal.

## UI polish (CSS only + modal exit)
Cooler off-white background, deeper navy ink, refined teal/turquoise, layered card shadows, hover-lift (hover devices only), staggered card entrance, smoother page rise, button hover/press/focus-visible states, input focus ring, translucent blurred nav, slower progress-bar easing, modal fade/slide in and out, gentle SOS glow, `prefers-reduced-motion` disables all animation/transition. Contrast (WCAG): button text 3.26 → 5.17:1, secondary button 2.87 → 4.62:1, danger 3.91 → 4.54:1, muted text 4.85 → 5.33:1, hero card white text 6.0:1 at its darkest and 4.5:1 at 60 % (3.1:1 only in the bottom-right corner).

## Tests actually run (all pass)
- **Algorithm, synthetic recordings** (`ppg-monitor.test.js`, 24 tests): clean/late finger/skin colour variants/no torch/48–180 bpm/HRV/drift/respiration/harmonics/frame-rate variation accepted and accurate; no-finger, flat, saturated, dark, motion rejected with the right reason; **0 false readings in 260 pure-noise recordings and 60 motion recordings**; 100 random valid recordings all within max(3 bpm, 3 %). One-off larger sweep: of 1,500 deliberately hard/noisy recordings 646 were accepted, **0 wrong**; 150 clean-ish recordings: all accepted, median 20.3 s (max 23.7 s).
- **App lifecycle with a fake camera** (`hr-flow.test.js`, 11 tests, real `app.js`): success path saves exactly one record and turns torch on→off; unreliable signal saves nothing and shows guidance + retry; cancel; permission denied; no-torch device; `exact` facingMode rejected → fallback; front-camera warning; backgrounding; double tap; rAF fallback.
- **Regression**: backend 90 tests (SQLite and PostgreSQL 16 local); step detector 16, boot/config 4, auth screens 1; Home/History/Emergency/Profile render and modal race test (`views.test.js`, 7). CSS parses with no errors.

## NOT tested / limitations
- **No real device was used.** Nothing here proves the heart-rate feature works on real phones, cameras, fingertips or lighting. The simulations encode my assumptions about real signals; real recordings may be noisier or have different amplitude/auto-exposure behaviour. Thresholds (quality 0.6, 5 bpm stability, finger colour ratios) may need tuning after real-device trials.
- Not visually checked in a browser (no browser here): layout, colours, animation feel, blur support are untested. Not verified: iOS Safari / Android Chrome behaviour, `requestVideoFrameCallback` `captureTime` semantics on real streams, torch on specific devices, PWA install.
- Torch: unsupported on iOS Safari and many desktop browsers; measurement then runs in ambient light and is less reliable. Camera access needs HTTPS (or localhost).
- A signal whose 2nd harmonic is stronger than its fundamental is refused rather than guessed.
- Wellness estimate only — not a medical device.

## Recommended real-device check before relying on it
Android Chrome (torch), iPhone Safari (no torch), a desktop webcam (should say it can't measure well). Compare 5 readings per device with a pulse oximeter/chest strap; note failures and the on-screen reason; send me the numbers if thresholds need tuning.
