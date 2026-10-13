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

## Still open (with the step that handles it)

| Item | Where |
|---|---|
| Python dependencies of dependencies are not pinned (no lock file). | Step 17, deployment preparation. |
| Pages are checked for accessibility and CSP violations in a real browser. | Step 16, Playwright tests. |
| HTTPS, reverse proxy, backups and restore. | Step 17. |
| Optional context imports (OpenStreetMap, NASA FIRMS, Open-Meteo, data.gov.in, NDMA), listed as optional in PROJECT.md "Data policy". | Not started; needs your decision (some need API keys). |
| Audit log rows still carry `updated_at` / `deleted_at` columns (unused; audit rows are never changed or deleted by the app). | Left as is; removing columns is not worth a risky migration. |
