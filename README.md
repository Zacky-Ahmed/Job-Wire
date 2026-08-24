# Job Wire

Watches four job boards for postings matching your keywords and emails you
within minutes of one appearing — while the application window is still open.

Sri Lanka is the home market, so three of the four sources are local boards
that publish the instant an employer posts. LinkedIn covers every employer but
runs behind its own index by anything from a few minutes to over an hour.

## Sources

Which sites get searched is **derived from the country**, not chosen. Nobody
wants fewer sites searched for the same keyword, and the only wrong answers
were the available ones — ticking a Sri Lankan board for a German watch built
something that could never match.

| Source | Coverage | How data arrives | Lag |
|---|---|---|---|
| LinkedIn | every country | guest endpoint, HTML fragments | minutes to 1h+ |
| topjobs.lk | Sri Lanka | server-rendered listing pages | instant |
| John Keells Group | Sri Lanka | server-rendered careers search | instant |
| MAS Holdings | Sri Lanka | Oracle Cloud Recruiting REST API | instant |

Adding a board means writing one file in `services/sources/` and registering
it. Nothing downstream — dedupe, storage, email, the UI — knows which site a
job came from. Sources are resolved at **sweep time**, so a new adapter reaches
every existing watch without anyone editing anything.

## How it works

One loop, running forever:

```
every POLL_TICK_SECONDS:
  find queries where nextFetchAt <= now
  for each, ONE AT A TIME:
    for every source that covers this country:
      fetch, parse, normalise to the shared job shape
    new = fetched − already seen          (unique index on queryId+jobId)
    if not primed:  store everything, send nothing, mark primed
    else:
      refine the newest N          (LinkedIn only: one request per job)
      drop matches too old to act on
      email every subscriber ONE batch
    reschedule nextFetchAt
```

Four rules carry the design:

1. **Prime before you alert.** A brand-new watch finds hundreds of existing
   jobs. Store them silently. Alert only from the second sweep, or the first
   email is a wall of stale posts.
2. **Identical searches share one fetch.** A hundred users watching
   "intern / Sri Lanka" is one query row and one set of requests, fanned out
   to a hundred emails. Load scales with *distinct searches*, not users.
3. **Sweep serially.** Ten simultaneous requests from one IP is what a scraper
   looks like; a steady trickle is what a browser looks like.
4. **A silent shortfall is the failure mode.** Every bug this project has had
   returned success and simply saw less. See below.

## The thing that will keep biting you

**Every LinkedIn failure has been silent.** Not an error — a sweep that
succeeded and returned fewer jobs, which is indistinguishable from a quiet
morning. Measured against the live site, all of these were real:

| What looked fine | What was actually happening |
|---|---|
| `f_TPR=r3600` (last hour) | returned an empty document while jobs existed; floored at `r86400` |
| `sortBy=DD` | not honoured — the newest jobs appear on pages 2–3 |
| `keywords=Intern` | 24 results one minute, 3 the next; a relevance ranker, not a filter |
| pagination cap of 100 | the Sri Lanka feed is **232 deep**; a 40-minute-old internship sat on page 19 |
| `matchedBy: unverified` | a *failed request* was being treated as a match, emailing three non-internships |

Two defences exist because of this, and both are worth keeping:

- **Coverage check.** Each sweep compares against the best that query has ever
  done and logs `COVERAGE DROP` when it sees less than half. A query that
  normally yields 60 and suddenly yields 10 has not gone quiet, it has gone
  blind.
- **`npm run parity`** diffs our results against the live LinkedIn search page
  and prints `MISSING` and `EXTRA`, exiting non-zero if anything is missing.
  Run it before believing a quiet day.

## Matching

Keywords match as **whole words with ordinary endings**, so `intern` reaches
*internship* and *interning* but not *internal*, *international* or *internet*
— substring matching once dragged in a Chief Human Resources Officer and
sixteen others in a single sweep.

Words that mean the same job expand automatically: `intern` also finds
*trainee*. The table is deliberately tiny — `graduate` and `junior` are
excluded, because plenty of those want experience an intern has not got.

For **LinkedIn only**, a job whose title does not match costs one extra request
to read its employment type, seniority and description. Employers routinely tag
a role "Internship" while titling it "Real Estate Sales Agent", and no title
filter can reach that. Those requests are budgeted per sweep and spent on the
newest jobs first; the rest carry forward on a pending queue.

A watch can also ask for **every job in the country**, ignoring keywords
entirely.

## Layout

```
src/
  server.js              express app + starts the poller in the same process
  config/                env validation, single Mongo pool
  models/                collection accessors, all indexes created at boot
  routes/                HTMX endpoints — return HTML fragments, not JSON
  middleware/            session, csrf, auth guard, admin guard, rate limits
  services/
    http/guardedFetch.js the ONLY outbound HTTP path — SSRF allowlist
    sources/             one file per job board, behind a shared contract
    linkedin/            url building, HTML parsing, geoId table
    poller/              the loop, one sweep, the dedupe rule, retry queue
    mail/                transport, send functions, templates
    auth/                bcrypt, code generate/verify
  views/                 ejs pages and HTMX partials
  utils/                 matching, time formatting, logging
public/                  css and the small vanilla JS htmx does not cover
scripts/                 see below
```

### The adapter contract

Every source exports the same handful of things:

```js
export const id            = "topjobs";        // also the jobId prefix
export const label         = "topjobs.lk";     // what a user sees
export const hosts         = ["topjobs.lk"];   // guardedFetch allowlist
export const countries     = ["100446352"];    // empty = worldwide
export const timePrecision = "day";            // or "minute"
export async function fetchJobs({ keywords, geoId, matchAll }) { … }
export async function refine(jobs, { keywords }) { … }   // optional
```

`timePrecision` is load-bearing. Boards that print a **date and no time**
resolve every posting to midnight, so a job put up this morning already reads
as hours old — the freshness gate skips them entirely and relies on priming
plus dedupe instead. Getting this wrong meant Keells jobs appeared on the wire
and were never once emailed.

`refine` is optional. Sources that decide during the fetch cost no extra
requests and are exempt from the per-sweep budget.

## Running locally

```bash
cp .env.example .env     # then fill it in
npm install
npm run dev
```

Set `POLLER_ENABLED=false` in `.env` to work on the UI without hitting any job
board. **Do this.** Running a local poller against the production database
sends real email alongside the deployed instance — pairs of identical alerts
two seconds apart are the symptom.

Rate limits skip loopback outside production. Four password resets an hour is
right for the internet and wrong for the machine building the feature.

### Scripts

| Command | What it does |
|---|---|
| `npm run e2e` | 48 assertions against a running server |
| `npm run parity` | diff our results against the live LinkedIn page |
| `npm run test-sweep` | one sweep, no email, prints what it found |
| `npm run verify-geoids` | check every geoId returns jobs in the right country |
| `npm run preview-email` | render the emails + 14 deliverability checks |
| `npm run measure-lag` | measure real indexing lag for your market |
| `npm run set-password` | set a password from the terminal, echo off |
| `npm run test-db` / `test-mail` | connectivity checks |

## Accounts and access

Email plus password with bcrypt, and a six-digit emailed code before a first
sign-in. Forgotten passwords use the same six-digit mechanism — a code, not a
link, because a clickable reset URL is the thing spam filters distrust most.

The reset endpoint never reveals whether an address has an account. Identical
wording is not enough on its own: awaiting the email send made the endpoint
answer in ~5s for a real address and ~0.7s for an unknown one, which reduces
the whole protection to a stopwatch. The send is detached for that reason.

**Admin** is an env var, not a database flag:

```
ADMIN_EMAILS=you@example.com,someone@else.com
```

Nothing with write access to Mongo can promote itself, and there is no
first-admin bootstrap problem. `/admin` lists accounts and the shared queries
behind them, flags any query that is orphaned or stalled, and shows whether
mail is actually deliverable. It is read-only on purpose — buttons that mutate
other people's accounts need a better permission story than one env var. A
non-admin gets a **404, not a 403**: "forbidden" confirms the page is real.

## Email deliverability

A new user's first email is their verification code. If that lands in spam they
cannot sign up at all, so this matters more than any feature.

**The one thing that matters most.** Sending *as* a `gmail.com` address
*through* a third-party relay breaks DMARC — only Google may send as
gmail.com, so the relay claims a domain it cannot prove. Gmail accepts the
message and files it as spam, and the provider reports **zero failures** the
entire time. Symptom: `74/280 sent, 0 failed` and an empty inbox.

Sending through Google's own SMTP aligns SPF and DKIM and fixes it at no cost.
`services/mail/transport.js` is the only file that knows which provider is in
use — with `BREVO_API_KEY` unset it uses Gmail SMTP at ~450/day, which is
correct for a personal instance.

The proper fix, when you outgrow that: buy a domain, authenticate it in a
transactional provider with SPF and DKIM, and send as `alerts@yourdomain`. The
`/admin` Delivery panel flags the misalignment until you do.

**What the templates already do** — verified by `npm run preview-email`: no
images, no coloured CTA buttons, no bulk-mail footer phrases, a real
`text/plain` alternative, short clean subjects, a working Reply-To. The
verification mail is deliberately plainer than the alert mail, because it is
the one that must never be filtered.

## Things that will bite you

- **LinkedIn does not want to be polled.** It is against their terms, they
  rate-limit hard, and shared cloud IPs are often already flagged. All the
  fragility lives in `services/linkedin/parse.js` — keep it isolated.
- **A 200 is not a success.** Responses are classified, not assumed: markup
  with no job cards raises an error rather than reporting zero jobs. Oracle's
  API will happily return `200` with no `requisitionList` if the finder syntax
  is wrong.
- **geoIds must be verified.** A wrong one fails silently and searches the
  wrong country. `npm run verify-geoids` checks all 45.
- **The TTL index on `seenJobs` is not optional.** Without it the collection
  grows forever on a 512 MB Atlas tier. With it, storage is steady state.
- **`numReplicas` must stay at 1.** Two replicas means two pollers sweeping the
  same queries. The unique index stops duplicate emails, but there is no reason
  to pay that cost.
- **Do not deploy to Vercel.** Serverless functions are destroyed between
  requests, so the loop cannot exist. Vercel Cron on the free plan runs about
  once a day.
- **`pkill` does not kill node on Windows.** Use `taskkill //F //IM node.exe`,
  or a stale server keeps port 3000 and your health check passes against code
  from an hour ago.

## Deploying

**One always-on service.** The web app and the poller share a process, so
anything that sleeps or recycles between requests breaks the product.

### Railway (current target)

`railway.json` builds from the `Dockerfile` and points the healthcheck at
`/healthz`.

1. New Project → Deploy from GitHub repo
2. Variables → add everything from `.env.example` **except** `PORT`
   (Railway injects its own; `config/env.js` already reads it)
3. Set `APP_URL` to the generated `*.up.railway.app` domain
4. MongoDB Atlas → Network Access → allow `0.0.0.0/0`, because Railway's
   egress IPs are not fixed

The Dockerfile forces IPv4 DNS ordering. Without it, outbound SMTP fails with
`ENETUNREACH` on an IPv6 address that has no route — 43 consecutive send
failures in one evening before that was found.

### Render (alternative)

`render.yaml` is a blueprint for the same single service. Free instances sleep
after ~15 minutes idle, which stops the poller — hence `plan: starter`.
