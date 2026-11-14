# Deployment verification checklist
Tick each item yourself after deploying. Nothing below has been run against your Render/Vercel/Neon accounts.

## A. Before deploying
- [ ] `cd backend && pytest -q` passes (and, ideally, with `TEST_DATABASE_URL` pointing to a throwaway Neon branch)
- [ ] `cd frontend && node tests/signal.test.js && node tests/boot.test.js` pass
- [ ] No `.env` committed; `git grep -nE "postgres(ql)?://[^ ]*:[^ ]*@|SECRET_KEY *= *[^ \$]" -- . ':!.env.example' ':!README.md'` prints nothing

## B. Neon
- [ ] Database exists; connection string copied; SSL required

## C. Render (backend)
- [ ] Env: `DATABASE_URL`, `SECRET_KEY` (32+ chars), `CORS_ORIGINS` (https Vercel URL, no trailing slash), `TRUST_PROXY=1`, `PYTHON_VERSION` set
- [ ] Build log shows `Running upgrade ... a1c2e3f4b5d6` (or "already at head"), no errors
- [ ] Service starts (a bad config shows "Invalid configuration:" in the log and the deploy fails — expected)
- [ ] `curl https://<api>/api/health-check` → `{"backend":"running","database":"connected","ok":true}` (first call may take ~30-50 s on the free tier)
- [ ] `curl -i https://<api>/api/auth/me` → `401` JSON, `Cache-Control: no-store`
- [ ] CORS: `curl -i -X OPTIONS https://<api>/api/auth/login -H "Origin: https://<vercel-app>" -H "Access-Control-Request-Method: POST"` returns `Access-Control-Allow-Origin: https://<vercel-app>`; the same with `Origin: https://evil.example` returns **no** such header

## D. Vercel (frontend)
- [ ] `API_BASE` set for Production (and Preview); build log shows `[build-frontend] API_BASE = https://...`
- [ ] Negative check (optional): remove `API_BASE` in a preview → the build **fails** with a clear message
- [ ] `https://<app>/js/config.js` contains your Render URL and no secrets
- [ ] `https://<app>/service-worker.js` and `/manifest.json` load with correct content types (not HTML)

## E. End-to-end in Chrome (DevTools → Network)
- [ ] Register → `POST /api/auth/register 201` to the Render host; row in Neon `users`
- [ ] Reload → still signed in (`GET /api/auth/me 200`)
- [ ] Add contact → survives reload; Edit/Delete work
- [ ] SOS → countdown → `POST /api/emergency/sos 201`; row in `emergency_events`; 112 and contact call links shown; no claim of SMS
- [ ] Logout → afterwards the old token returns 401 (`curl -H "Authorization: Bearer <old>" https://<api>/api/auth/me`)
- [ ] Two accounts: B cannot see A's contacts/readings/events (UI and direct API calls)
- [ ] Render logs show the requests (access log enabled)
- [ ] Block the network (DevTools → Offline): the app shows a clear error and nothing is reported as saved

## F. Physical phone (NOT automated — must be done by hand)
- [ ] HTTPS site installs as a PWA
- [ ] Heart rate: permission prompt; torch turns on (device-dependent); 30 s scan; plausible BPM vs a reference device; row saved. Check: cancel mid-scan → torch off and camera indicator off; switch app mid-scan → measurement cancelled and camera released; cover lens badly → "No result", nothing saved
- [ ] Steps: (iOS) motion permission prompt; walk 50 steps and compare to a manual count (note the error %); stand still / drive / shake the phone → no large false counts; Stop → saved, total updates; reload mid-session → "Interrupted step session" prompt; stop while offline → "kept on this device", then online → synced once (no duplicates in `activity_records`)
- [ ] Time zone: a session started shortly after local midnight appears under the new local date in History
- [ ] Location permission granted/denied both handled in SOS

## G. Record results
Date, device/browser, pass/fail per item. Anything not ticked is untested.
