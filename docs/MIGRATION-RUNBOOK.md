# Hosting migration runbook

This runbook prepares a legitimate provider migration. It does not deploy,
modify production, copy live data, change DNS, contact a provider, or grant
permission to collect from a source.

## Preconditions and evidence

Before changing the old environment, export or preserve:

- the complete Railway restriction/enforcement notice and support case;
- deployment, build, runtime, and available egress logs for both Railway
  projects from 2026-09-10 through the restriction;
- redacted environment-variable snapshots and Mongo database names;
- Mongo scheduler, lease, crawl-log, sweep-run, source-health, worker,
  source-traffic, outbox, and delivery metadata for the same period;
- shell/audit history for manual trace and probe scripts;
- any written LinkedIn or other source authorization.

Use UTC throughout. Do not run a diagnostic crawl to replace missing history.

## Safe cutover sequence

1. Confirm the new provider permits the application and every enabled source.

2. Provision an always-on Node 20/OCI service in the same region as Mongo.

3. Configure secrets and variables from `docs/DEPLOYMENT.md` with:
   `POLLER_ENABLED=false`, `SOURCES_DISABLED=linkedin`, and
   `LINKEDIN_ACCESS_CONFIRMED=false`.

4. Prefer pointing the candidate at the existing Mongo database initially.
   This avoids a stateful database migration; restrict its network access to
   the new provider and retain a rollback path.

5. Start one candidate instance. Verify `/healthz`, `/readyz`, HTTPS,
   secure-cookie behavior, sign-in, read-only wire/admin pages, index success,
   and that logs say the poller is disabled and LinkedIn is disabled.

6. Verify the mail provider without sending a bulk alert. Prefer
   Brevo/another idempotent HTTPS provider with an authenticated sending
   domain.

7. Stop the old poller or old application. Confirm it no longer renews the
   poller lease. Wait at least the lease TTL when a clean release cannot be
   proved.

8. Enable `POLLER_ENABLED=true` on exactly one new instance. Confirm its
   worker ID owns the current lease and that standby instances do not crawl.

9. Observe at least two complete fixed slots for all enabled, permitted
   sources. Verify outbox claims and deliveries before DNS cutover.

10. Cut DNS only after the worker state is stable. Keep LinkedIn disabled
    until the separate permission and host-acceptance prerequisites are
    satisfied.

## Database migration risks

The safest first migration shares the existing Mongo database. If a database
copy is required, take a point-in-time-consistent copy of the complete
database; do not copy only users and queries.

These collections are coupled:

- `queries`, `subscriptions`, `seenJobs`, and `alertedJobs` determine what is
  new and what has already been mailed;
- `outbox` and `emailLog` determine what is still owed and what a provider may
  already have accepted;
- `pollerLease`, `pollerWorkers`, and `pollerState` identify crawl ownership;
- `sourceTraffic` carries deployment-wide request budgets and blocked circuits;
- `sessions` contains login state and depends on the unchanged session secret;
- telemetry collections explain historical behavior but do not own work.

A stale or partial copy can re-prime queries, rediscover jobs, duplicate
alerts, lose pending deliveries, reset a blocked-source pause, or allow two
independent pollers. During a copied-database cutover:

1. disable polling and delivery on the old environment;
2. wait for or explicitly resolve in-flight sweep/outbox claims;
3. take a consistent snapshot;
4. restore all coupled collections and indexes;
5. point exactly one disabled candidate at the new database;
6. inspect pending outbox rows and lease ownership;
7. enable one worker only after the old database can no longer be used by an
   active worker.

Outbox uniqueness prevents duplicate obligations, but it cannot unsend mail.
Brevo's stored idempotency keys protect retries; Gmail SMTP has no equivalent
for an acknowledgement lost after acceptance. Treat any Gmail row in an
ambiguous sending state as a manual migration decision.

## DNS and domain migration

1. Inventory apex, www, verification, mail, SPF, DKIM, DMARC, MX, and any
   provider-validation records. Web migration must not accidentally replace
   mail records.

2. Lower only the web-record TTL 24-48 hours before the planned cutover.

3. Add the custom domain at the new provider and complete its ownership check.

4. Provision and verify TLS before switching public traffic.

5. Set `APP_URL` to the final HTTPS origin and verify canonical, reset,
   verification, and unsubscribe links in a non-production recipient flow.

6. Change the required A/AAAA/ALIAS/CNAME records exactly as the provider
   documents. Avoid leaving conflicting records from the old service.

7. Check both apex and www, redirects, IPv4/IPv6 resolution, certificate
   chain, `/healthz`, `/readyz`, secure sessions, robots, and sitemap from
   independent resolvers.

8. Monitor 4xx/5xx, authentication, Mongo connections, lease ownership,
   outbox age, and mail acceptance through at least the old TTL window.

9. Restore a normal TTL only after the rollback window closes.

## Rollback

The restricted Railway workspace is not a dependable rollback target. Retain a
known application image/commit on the new provider or another already-approved
environment.

**Before DNS cutover:** If the candidate application is unhealthy, keep
`POLLER_ENABLED=false`, stop it, and correct configuration without touching
the old worker.

**After worker cutover:**

1. disable the candidate poller first;
2. wait for its in-flight fenced sweep and outbox claims, or wait for their
   expiry if the process is unreachable;
3. start the retained version against the same database with LinkedIn still
   disabled;
4. confirm one lease owner and inspect ambiguous mail rows;
5. revert DNS only if HTTP service cannot be restored in place;
6. preserve logs and state before retrying the migration.

The `sourceTraffic` collection is additive and older code ignores it. Do not
delete it during rollback; doing so resets the safety budget/circuit history.

## Verification checklist

- [ ] Railway enforcement notice and both project logs preserved.
- [ ] New provider has approved the workload and enabled sources.
- [ ] `NODE_ENV=production`; `APP_URL` is HTTPS; session secret is 32+ chars.
- [ ] `HOST=0.0.0.0`, injected `PORT`, and exact `TRUST_PROXY_HOPS` verified.
- [ ] `/healthz` returns 200 and `/readyz` reflects Mongo availability.
- [ ] Mongo database/name match across every intended replica.
- [ ] Index creation succeeds, including `source_traffic_by_source`.
- [ ] Candidate begins with `POLLER_ENABLED=false`.
- [ ] `SOURCES_DISABLED` includes `linkedin` and `LINKEDIN_ACCESS_CONFIRMED=false`.
- [ ] No startup, test, trace, or probe command performs a live diagnostic crawl.
- [ ] Old worker stopped; one new poller lease owner confirmed.
- [ ] Fixed slots skip missed work rather than burst catch-up.
- [ ] Crawl and delivery lanes operate independently.
- [ ] Outbox claims, pending age, provider idempotency, and daily cap verified.
- [ ] Secure cookies and client IP behavior match the configured proxy hops.
- [ ] Mail sender domain SPF/DKIM/DMARC and unsubscribe links verified.
- [ ] DNS records and TLS verified at apex and www.
- [ ] Rollback image, database target, and operator steps recorded.

## LinkedIn re-enable gate

Do not enable LinkedIn until **all** boxes are satisfied:

- [ ] Written LinkedIn authorization or a licensed/approved data arrangement
      explicitly covers collection, storage, display, alerting, and volume.
- [ ] The hosting provider confirms the authorized workload is allowed.
- [ ] Contractual rate, attribution, caching, retention, and deletion limits are
      translated into configuration and tests.
- [ ] `LINKEDIN_REQUEST_BUDGET_PER_HOUR` is no higher than the authorized limit.
- [ ] The honest `OUTBOUND_USER_AGENT` and any required authentication are set.
- [ ] A non-production, authorized validation shows 403/429 opens the shared
      circuit and does not trigger repeated normal-cadence network attempts.
- [ ] Only then: remove `linkedin` from `SOURCES_DISABLED` and set
      `LINKEDIN_ACCESS_CONFIRMED=true`.
