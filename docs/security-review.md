# Security and quality review (build step 15)

Date: 13 October 2026. Scope: backend API, WebSocket, database schema, website
(Next.js server routes and pages), against PROJECT.md (hard rules, production
quality, roles, multi-tenant isolation).

## Fixed in this step

| Area | Finding | Fix |
|---|---|---|
| Sessions | After a password change or an Administrator's reset, other devices kept working for up to 30 minutes (access tokens are only checked for expiry). | `users.tokens_valid_after`: tokens issued before the change are refused at once. |
| Sessions | A copied refresh token could be used once the owner's copy had been renewed, without anyone noticing. | Refresh tokens record why they ended (`revoked_reason`). A *rotated* token presented again after 30 seconds ends every session of the user and is audited (`auth.refresh_token_reused`). |
| Sessions | A second logout answered 401. | Logout is idempotent (204). |
| Requests | No overall request size limit (only floor imports had one). | 6 MiB limit for every request, checked from Content-Length and while reading (413). |
| Responses | API answers had no security headers and could be cached. | nosniff, X-Frame-Options DENY, no referrer, a "load nothing" CSP and no-store on every API answer. |
| Website | Pages had only a partial Content-Security-Policy. | Strict CSP with a fresh nonce per page (src/proxy.ts, src/lib/server/csp.ts): only this site's scripts run; framing, plugins and foreign form targets are blocked; live-simulation WebSockets only to the configured backend. |
| Logs | Live-simulation stream tokens appear in server logs (WebSocket URLs). | Tokens in query strings are replaced with `[hidden]` in all logs, uvicorn's included. |
| Roles | Staff Users could open the planning pages (and saw links to them), though the API refused their changes. | Navigation, links and direct addresses follow PROJECT.md: Staff Users get Dashboard, Live Simulation, Patients & Staff, Reports, and Settings / Profile for their own account. |
| Database | `updated_at` was only set by the ORM, not by bulk updates. | A trigger sets it for every table. |
| Database | Defaults existed only in Python. | The same defaults now exist in the database; hospitals default to UTC (no country-specific default). |
| Database | The audit log item index did not start with the organization. | `ix_audit_log_org_entity (organization_id, entity_type, entity_id)`. |
| AI assistant | When the AI service was down or overloaded (HTTP 500, 502, 503, 504, 529), users saw "The AI service returned an error (503)" as if something were broken. Found in the step 15 browser check. | After the retries, these now answer 503 "The AI service is temporarily unavailable; try again in a few minutes". Other service errors keep their code. |
| Quality | Deprecated `pythonjsonlogger.jsonlogger` import (a warning in every test run). | `pythonjsonlogger.json`. |
| Quality | `pwdlib` pinned but never used. | Removed from requirements.txt. |
| Stack | Recharts is in the PROJECT.md stack but no chart existed. | Algorithm Comparison (time, distance, risk) and run timelines in Reports & History, each with the same numbers as a table. |

## Checked and already in order

- Every query and the WebSocket are filtered by the organization from the token; tests prove organization A cannot see organization B's data (all APIs and the stream).
- Passwords: 12–72 characters with four character classes, bcrypt; passwords longer than bcrypt can check are refused cleanly (test added).
- Rate limits on login (per IP and per account), sign-up, the AI assistant, reports and password changes, stored in PostgreSQL.
- Errors use one JSON format and never echo submitted values or internal details.
- Website: tokens only in httpOnly, SameSite=Strict cookies (`__Host-` in production); same-origin check on every request that changes data; token endpoints are not reachable through the browser proxy; open-redirect check after login.
- Secrets only in `.env`; production refuses the development JWT secret, short secrets, the placeholder database password and the free Gemini tier.
- AI answers: the user's text is data, never instructions; only stored figures may appear in summaries; nothing runs without "Run it".

## Deployment (step 17)

- Python packages: `requirements.lock.txt` pins every package, including the
  packages they need. The image installs it with `--no-deps --only-binary=:all:`
  and `pip check`, so nothing unpinned or compiled at build time gets in. A test
  keeps it in line with `requirements.txt`.
- Images: the base images are pinned by digest. The API and the website run as
  ordinary users, without Linux capabilities (`cap_drop: ALL`) and with
  `no-new-privileges`. `.dockerignore` files keep `.env` files, `node_modules`
  and backups out of images.
- Network: only Caddy publishes ports, on 127.0.0.1 by default. It sends
  `/api/v1/ws/*` (live streams, which need a run token) to the API and
  everything else to the website. The API's other endpoints and PostgreSQL are
  reachable only inside Docker's private network.
- Visitor IPs: Caddy replaces any X-Forwarded-For sent by a browser. The website
  trusts it (`TRUST_PROXY_HEADERS=true`). The API accepts it only from the fixed
  addresses of Caddy and the website (`FORWARDED_ALLOW_IPS`).
- Secrets: `.env.production` is git-ignored. Docker refuses to start while
  `POSTGRES_PASSWORD` or `JWT_SECRET_KEY` is empty, so the database is never
  created with a missing password. The API's own production checks still apply
  (secret length, no free Gemini tier).
- Backups: `scripts/backup.ps1` and `scripts/restore.ps1` use only the
  production stack. A restore asks for a typed confirmation and makes a safety
  backup first. The `backups` folder is git-ignored.

## Accepted risk

| Item | Decision |
|---|---|
| `npm audit` reports GHSA-vfj7-8cjw-p6xm (`braces`, high) through `eslint-config-next` → `fast-glob` → `micromatch`. | Development tooling only (lint). It is not in the website's server or in the Docker image. `npm audit --omit=dev` reports 0 vulnerabilities, and CI checks that. No fixed version exists yet. `npm audit fix --force` would install an incompatible lint configuration. Check again when `eslint-config-next` is updated. |

## Still open (with the step that handles it)

| Item | Where |
|---|---|
| Optional context imports (OpenStreetMap, NASA FIRMS, Open-Meteo, data.gov.in, NDMA), listed as optional in PROJECT.md "Data policy". | Not started; needs your decision (some need API keys). |
| Audit log rows still carry `updated_at` / `deleted_at` columns (unused; audit rows are never changed or deleted by the app). | Left as is; removing columns is not worth a risky migration. |
| The `postgres:16.6` image is pinned by version, not by digest (shared with the development setup). | Pinned by digest once its digest has been read on your PC. |
