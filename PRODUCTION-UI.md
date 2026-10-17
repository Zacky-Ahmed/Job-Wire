# Production UI migration

The approved design is integrated into the existing Express/EJS shell. Collection scheduling and the durable delivery worker are unchanged.

- `/wire`: database-backed source/text/date filters, 20-job pages, optional personal-interest matching, shared 14-day history. Default pages use a database facet; title-based interest matching evaluates retained metadata using the sender's rules.
- `/saved`: account-owned snapshots, capped at 500, retained until removal or account deletion. Mutations are authenticated and CSRF protected.
- `/interests`: existing preference parser and preview with ownership checks; no historical resend.
- `/delivery`: latest 100 own outbox records, with provider acceptance distinct from inbox receipt.
- `/wire/job/:id`: authenticated details scoped to subscribed queries or own shortlist. Existing public `/job/:id` email URLs remain unchanged.
- Admin: tabbed existing operations, aggregated job tracing, external-script destructive-action confirmation compatible with CSP. No sample telemetry or fake DNS verification.

The feed does not repeatedly replace rows while someone reads. A small authenticated version check runs at most once a minute in visible Wire tabs and offers refresh when new data appears.

Validation: 54 unit/regression tests, DOM interaction checks, read-only database-backed rendering for all main pages and email/job routes, dependency audit. Browser automation was disabled, so screenshot/visual QA remains a limitation. No verification or test email is sent by the read-only validation script.

Run `NODE_ENV=test node --experimental-test-module-mocks --test scripts/test-*.test.js`. The read-only integration script `scripts/check-production-ui-readonly.js` requires existing deployment configuration, runs only a temporary loopback server and performs no writes or mail calls.
