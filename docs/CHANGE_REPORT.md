# Change report — hardening pass

## Verified here (actually run)
- Backend: 61 pytest tests pass on SQLite **and** on a local PostgreSQL 16.2 (embedded server; not Neon).
- Migrations: fresh upgrade on PostgreSQL; upgrade of an old-schema database containing rows (existing users get `token_version=0`, activities `client_id=NULL`); `flask db check` shows models and migrations identical.
- Frontend: 16 synthetic-signal tests for the PPG and step algorithms, 4 boot/config-guard tests (stub DOM), build-script behaviour for 6 `API_BASE` cases, JS syntax checks.

## NOT verified
Real browsers/UI, real camera/torch/accelerometer (detector accuracy on real phones is unknown), PWA install, Render/Vercel/Neon deployments, Vercel running the Node build command and the rewrite regex, service-worker behaviour, CORS from a deployed origin (tested only with Flask's test client), `flask db downgrade`.

## Changes
1. **Camera**: single idempotent `release()` (torch off → tracks stopped → video detached) called on finish, cancel, errors, `getUserMedia`/`play()` failure, track `ended`, tab hidden/pagehide, route change, logout; cancel during permission prompt stops the late stream; watchdog for no/stalled frames; double-start guard. Analysis now also rejects short, low-fps or frame-dropping captures; backend rejects camera readings with quality < 0.6 and SpO₂ from the camera.
2. **Steps**: new detector (`js/steps.js`): gravity removal, low-pass, adaptive threshold, refractory period, 5-step regular-rhythm gate with peak-height consistency, ignores duplicate/out-of-order events and background gaps. Single-session/single-listener guard; checkpoints + explicit "interrupted session" recovery; save outbox with retry and server-side idempotency (`client_id` unique per user); wake lock; backend plausibility checks. *Known weakness*: extreme white noise is still partly counted (test documents it).
3. **Auth**: `iss/iat/exp/jti/tv` claims, required-claim and issuer checks, 24 h default (cap 168 h), real server-side logout via `token_version`, login throttling + timing equalisation, `SECRET_KEY` ≥ 32 chars enforced. Cookie approach evaluated and **not** adopted (reasons in README). Test walks every route to prove private endpoints return 401.
4. **Timezone**: `/activity/daily` and `/health/records?date=` take an IANA `tz`; grouping by local date (DB-agnostic); frontend sends its zone and no longer uses UTC date strings. Naive/aware datetime normalised.
5. **Backend**: JSON-object body enforcement, strict int/float typing, safe query parsing (no more 500s on `limit=abc`), HTTP errors returned as JSON (previously 400/413 would become 500), rollback on every failed commit, `IntegrityError`→409 for races, 503 when DB unreachable, contact cap and E.164-style phone normalisation, `no-store` + security headers, `ProxyFix` behind Render, pinned dependencies (incl. `tzdata`), Neon-friendly engine options (TLS auto-added, pre-ping, recycle, keepalives), startup config validation.
6. **Migration `a1c2e3f4b5d6`** (`users.token_version`, `activity_records.client_id` + unique, `ck_spo2_range`). **Deploying it changes the schema; take a Neon branch/backup first.**
7. **Deployment**: `scripts/build-frontend.js` fails the build on missing/unsafe `API_BASE`; runtime guard refuses localhost fallback unless the page is served from localhost; `render.yaml` pins Python, access logs, proxy trust; `vercel.json` security headers, no-cache for `config.js`/service worker, safer SPA rewrite; service worker caches only successful same-origin GETs.
8. **Docs/tests**: pytest suite (auth, duplicates, health, activity, contacts, SOS, isolation, timezone, config, migrations), deployment checklist, README.

## Behaviour changes to be aware of
Logout now signs the account out on all devices. Daily steps use local dates. Contact phone numbers are stored without spaces/hyphens. Tokens issued before this update are rejected (they have no `iss` claim), so every user must sign in once more after deploy. Passwords are unaffected.
