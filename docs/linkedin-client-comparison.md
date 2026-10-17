# LinkedIn client comparison

The default `LINKEDIN_CLIENT_MODE=compare` alternates Stealth-Requests and native Node fetch across eligible scheduled sweeps. Both pages use the same client. `native` or `stealth` pins one client for rollback or later selection. Changing the mode requires a container restart.

Both clients use the same URL, parser, two-page cap, shared request budget and cooldown. A blocked request does not trigger a fallback request. The ordinary storage and email pipeline handles results, including existing deduplication and email packs.

Read results with `docker exec jobwire node scripts/linkedin-client-report.js`. Records in `sourceClientComparisons` contain client, time, page, parsed IDs/count, duration, outcome and HTTP error status. Deferred checks are not HTTP failures. Successful records mean a recognized result list was parsed, not complete coverage or email delivery. This is an alternating observational comparison: changing listings and a shared IP/cooldown prevent a controlled causal conclusion.

Stealth uses a short-lived Python process without application secrets, automatic redirects or retries. The Node guard validates each redirect and charges it to the shared budget. Python independently rejects non-public destinations and caps the response body. The image pins stealth-requests 2.0.6 and curl_cffi 0.16.3.
