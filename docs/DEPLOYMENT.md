# Portable deployment and migration

Read [the forensic report](DEPLOYMENT-FORENSICS.md) first. Production has not been
changed. The existing Railway configuration is optional platform metadata; the app
does not read Railway-specific environment variables or call Railway APIs.

## Changes prepared

* `sourcePolicy.js`: enforce SOURCES_DISABLED before DNS/HTTP in both request
  clients, including direct diagnostic calls; reject unknown source names at boot.
* 403/429 pauses a source across subsequent queries for at least 15 minutes and
  honors a longer Retry-After. Other sources continue. The LinkedIn ceiling defaults
  to 600 request attempts per rolling hour per process, including detail calls and
  redirects. Budget rejection marks failure/degradation instead of fabricating jobs.
  Failed DNS attempts conservatively consume budget too. This is not a permission
  claim or a reconstruction of the old envelope. Set a lower approved ceiling when
  needed; lower ceilings can reduce coverage. Do not raise it to defeat a restriction.
* Fixed-slot calculation is shared by production and simulation and always advances
  to a future slot, including exact boundaries. Fairness, fencing, outbox persistence
  and independent mail/crawl lanes remain.
* Source HTTP timeouts now cover response-body consumption, not just headers.
  Streaming byte ceilings stop oversized bodies before unbounded buffering.
* HOST and TRUST_PROXY_HOPS are configurable. Health endpoints bypass sessions and
  application rate limiting. `/healthz` is liveness; `/readyz` requires completed
  indexes, a database ping, and no shutdown in progress. Source/mail outages do not
  independently fail web readiness. Inspect admin source and delivery health too.
* Shutdown waits for HTTP requests before closing Mongo, does not drain alerts in
  a web-only deployment, and exits without releasing the crawler lease if its
  active sweep did not finish within the drain window.
* Docker uses Node 24, a non-root user and readiness healthcheck. Build context
  excludes dotenv secrets, scripts, Git metadata and investigation documents.
  Compose supplies a provider-neutral, read-only container behind a TLS proxy.
  Render's optional blueprint starts with workers off and LinkedIn disabled.

## Hosting requirements

Use an always-on Node 24 process or Docker host, outbound Mongo access, HTTPS to
permitted sources and the configured mail API, DNS resolution, and a TLS reverse
proxy. Do not deploy the timer-driven worker to sleeping/serverless request-only
compute. Start with ONE instance and one crawler process; do not add an external
cron invoking probes or sweeps. Provide around 130 seconds termination grace when
possible, above the default 120-second app deadline. Size CPU/RAM from measured
heap, query count and source service time; no verified capacity benchmark is present.

No local persistent disk is required. Mongo holds users, sessions, watches, seen
history, alert ledger, outbox, lease and telemetry. Local source snapshots, detail
caches, cooldown and request-budget state reset on restart. The new gate is NOT a
distributed persistent limiter: multiple manual processes or frequent restarts can
exceed an aggregate envelope. Keep probes off deployment hosts; do not scale this
configuration to multiple crawlers without a shared durable source limiter.
Source isolation limits technical failures; it cannot prevent a host from restricting
an account for an enabled workload. Confirm permissions before enabling each source.

## Environment

`.env.example` lists every supported application setting with migration defaults.
Do not reuse the local `.env` without reviewing it: existing values take precedence
and may enable the poller. Never bake secrets into an image.

| Variables | Requirement |
|---|---|
| MONGODB_URI, MONGODB_DB | Required URI; DB defaults to jobwire. Keep the same DB for host-only migration. Allow only intended host network access. |
| SESSION_SECRET | Required; at least 32 random characters in production. Preserve it to retain signed sessions. |
| NODE_ENV, APP_URL | production and the canonical public HTTPS origin. APP_URL generates email and canonical links. |
| BREVO_API_KEY, MAIL_FROM | HTTPS mail option; verified sender and matching account credentials. MAIL_FROM must be set. |
| GMAIL_USER, GMAIL_APP_PASSWORD, MAIL_FROM | Alternative when BREVO_API_KEY is empty and host permits Gmail SMTP. App password is 16 characters; From matches account. |
| HOST, PORT | Defaults 0.0.0.0 and 3000. Provider-injected PORT supported. |
| TRUST_PROXY_HOPS | Defaults 1. Use actual proxy topology, 0 for direct HTTP. Prevent direct public access behind a trusted proxy and strip forged forwarded headers. |
| POLLER_ENABLED | Explicit false for staging/cutover preparation; true only on the selected worker instance. Gates delivery and crawling together. |
| SOURCES_DISABLED | Migration value linkedin; comma-separated known IDs. Implementation retained. Empty only when every enabled source is permitted. |
| LINKEDIN_REQUESTS_PER_HOUR, SOURCE_BLOCKED_COOLDOWN_MS | Defaults 600 and 900000; process-local controls as described above. |
| POLL_TICK_SECONDS, DELIVERY_TICK_SECONDS | Defaults 30 and 15; positive integers. |
| DEFAULT_SWEEP_MINUTES, MIN_SWEEP_MINUTES | Defaults 5 and 5. Existing watch cadences are stored in Mongo; changing defaults does not rewrite them. |
| FETCH_JITTER_MS, MAX_FAIL_COUNT | Defaults 4000 and 6. Jitter spreads load; it is not a permission mechanism. |
| SHUTDOWN_GRACE_MS | Default 120000. Align host termination grace. |
| SEEN_JOB_TTL_DAYS, ALERT_TTL_DAYS, STALE_ALERT_DAYS | Defaults 14, 1095, 90; preserve retention during migration. |
| ADMIN_EMAILS, GOOGLE_SITE_VERIFICATION | Optional admin allowlist and public verification token. |
| STARTER_WATCH_KEYWORDS, STARTER_WATCH_GEO_ID, STARTER_WATCH_LABEL | Optional starter watch; defaults intern, 100446352, Intern. Empty keywords disables automatic starter watch. |

## Provider-neutral launch

For Docker Compose, prepare reviewed `.env` with production credentials,
POLLER_ENABLED=false and SOURCES_DISABLED=linkedin. Then:

```sh
docker compose config --quiet
docker compose build
docker compose up -d
curl --fail http://127.0.0.1:3000/readyz
```

Compose binds only loopback. Terminate HTTPS with your host's reverse proxy and
forward to port 3000. On a managed container service, deploy the same Dockerfile,
supply its secrets/environment, select `/readyz` and route to PORT. On a Node host,
use Node 24, `npm ci --omit=dev`, then `npm start`; use a process supervisor with
SIGTERM forwarding. Docker is unavailable in the current workspace, so the image
build and real provider deployment remain verification steps, not claimed successes.

## Database and worker cutover

1. Save old image/SHA and sanitized settings. Obtain a consistent Mongo backup and
   verify restoration in an isolated database. Preserve short-lived forensic logs.
2. Prefer retaining the existing Mongo cluster and database. No schema/data rewrite
   is introduced here, but startup still runs the existing index reconciler. Review
   its changes against staging before pointing a new version at the production DB.
3. Validate new host against a separate staging DB and a mail sandbox/test account.
   Workers stay off. Application mail verification at startup does contact the mail
   provider; normal signup/password-reset actions also send mail with workers off.
4. Stop old instance completely (including its delivery loop), or explicitly disable
   and restart its workers. Wait for shutdown/lease expiry. Do not rely on crawl
   fencing to serialize mail: the legacy failed-send queue can overlap across hosts.
5. Start new instance on the existing database, first with workers off. Check health,
   indexes and sessions, then enable its poller after source policy review. Keep
   LinkedIn disabled pending an approved collection arrangement.
6. Check new lease owner, next scheduled times, source degradation, outbox age and
   mail-provider acceptance. Do not clear seenJobs/alertedJobs/outbox or re-prime all
   watches: that changes deduplication and can resend or suppress alerts.

If changing Mongo providers too, stop ALL writers (web and workers), take a consistent
snapshot including sessions, ledgers/outbox and indexes, restore and verify counts
and indexes, then change URI/DB. Two writable divergent copies are not a migration.
Avoid combining database and hosting migration if unnecessary. Email exactly-once
behavior depends on transport/provider idempotency; do not promise it for SMTP or
legacy retries. Old provider acceptance may be ambiguous after a forced termination.

## DNS/domain

Record current A/AAAA/CNAME, proxy mode and TTL. Lower TTL before cutover, establish
the new custom domain and TLS certificate, then change only the relevant records.
Remove stale AAAA records when the new endpoint does not serve IPv6. Preserve mail
MX/SPF/DKIM/DMARC records unless intentionally changing email providers. Keep APP_URL
on the canonical HTTPS domain; verify secure cookies, forwarded IPs and reset links.
Existing sessions can survive when domain, Mongo database and secret stay the same.
Expect re-login when using a different domain. Keep old worker stopped during DNS
propagation; web traffic must not create two active worker installations.

## Rollback

Stop the new worker first. Restore the prior reviewed image and environment on a
permitted host, with the same current Mongo database and source restrictions. Do not
roll back the database snapshot after live writes without reconciling outbox and
accepted emails. Restore DNS if needed and verify TLS. Never restart the prohibited
workload on a new Railway identity. Keep this patch available: reverting to an old
image also removes its request protection. A web-only rollback is safer while the
source-access question is unresolved.

## Verification checklist

Local validation on Node 24.11.0: ten deployment regression tests passed, 103
existing source assertions passed with fake credentials and no production DB, and
all six scheduler simulation scenarios completed. Syntax and whitespace checks
passed. Live Mongo/SMTP/provider tests and container build were not run; do those
against staging before cutover. These results do not certify a production deployment.

- Offline: `npm run test-deployment`, `npm run test-sources`, `npm run simulate`.
- Container: clean build, no dotenv secrets/probe scripts in image, non-root startup,
  correct PORT/HOST, `/readyz` becomes healthy after indexes.
- Staging: database unavailable gives readiness 503; source failure does not kill web;
  disabled LinkedIn cannot be reached through either HTTP client; no automatic probes.
- Proxy/auth: HTTPS cookies, sign-in, CSRF, reset links, rate-limit IPs, real client IP.
- Worker: one lease holder, fixed-slot fairness, no catch-up storm, delivery independent
  of crawling; source failure/403 respects cooldown while others continue.
- Delivery: pending outbox preserved across SIGTERM; no second legacy retry sender;
  inspect provider acceptance before replaying ambiguous SMTP attempts.
- Cutover: domain/TLS, data counts/indexes, session continuity, source permissions,
  budget degradation/coverage and mail health reviewed before declaring migration done.

## Keeping legitimate LinkedIn capability

Keep the adapter and policy switch. Seek an explicit LinkedIn-approved data-access
arrangement covering this use case; do not assume a general job-search API is
available to any developer. Alternatively procure a licensed feed whose contract
permits display and alerts, obtain employer career-site permission, or integrate
permitted Greenhouse/Ashby/Lever postings and other authorized boards. These are
integration options, not claims that this repository already implements those ATS
adapters or that a particular vendor grants redistribution rights. A new approved
adapter can implement the existing source contract without changing delivery logic.
