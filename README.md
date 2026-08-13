# Job Wire

Watches LinkedIn for job postings matching your keywords and emails you within
minutes of one appearing — while the application window is still open.

## How it works

One loop, running forever:

```
every POLL_TICK_SECONDS:
  find queries where nextFetchAt <= now
  for each:
    build the LinkedIn search URL   (keywords + geoId + f_TPR)
    fetch it, parse out the job IDs
    new = fetched − already seen
    if not primed:  store everything, send nothing, mark primed
    else:           store the new ones, email every subscriber ONE batch
    reschedule nextFetchAt
```

Two rules carry the whole design:

1. **Prime before you alert.** A brand-new watch finds ~25 existing jobs. Store
   them silently. Alert only from the second sweep, or the user's first ever
   email is a wall of stale posts.
2. **Identical searches share one fetch.** 100 users watching "intern / Sri
   Lanka" is one query row and one HTTP request, fanned out to 100 emails.
   This keeps load on LinkedIn flat as users grow.

## Layout

```
src/
  server.js              express app + starts the poller in the same process
  config/                env validation, single Mongo pool
  models/                collection accessors, all indexes created at boot
  routes/                HTMX endpoints — return HTML fragments, not JSON
  middleware/            session, auth guard, rate limits
  services/
    linkedin/            url building, fetching, parsing, geoId table
    poller/              the loop, one sweep, the dedupe rule
    mail/                nodemailer transport, send functions, templates
    auth/                bcrypt, OTP generate/verify
  views/                 ejs pages and HTMX partials
  utils/                 time formatting, logging
public/                  css and the small vanilla JS htmx does not cover
scripts/measure-lag.js   day-one experiment: measure real indexing lag
```

## Running locally

```bash
cp .env.example .env     # then fill it in
npm install
npm run dev
```

Set `POLLER_ENABLED=false` in `.env` to work on the UI without hitting LinkedIn.

## Before you promise users a number

Run the lag experiment first:

```bash
npm run measure-lag
```

It polls one search every 60 seconds for a day and compares LinkedIn's
"posted X minutes ago" against when you caught it. That gives you the real
indexing lag for your market. **Say "within minutes", never "instantly"** —
LinkedIn does not index a post the moment it is published, and no polling
frequency can beat that floor.

## Things that will bite you

- **LinkedIn does not want to be polled.** It is against their terms, they
  rate-limit hard, and shared cloud IPs are often already flagged. All the
  fragility lives in `services/linkedin/parse.js` — keep it isolated and
  tested against saved HTML fixtures so a markup change breaks one file.
- **geoIds must be verified.** A wrong one fails silently and searches the
  wrong country.
- **The TTL index on `seenJobs` is not optional.** Without it the collection
  grows forever on a 512 MB Atlas tier.
- **Gmail app passwords cap at ~500/day** and send from your personal address,
  which eventually means spam folders. `services/mail/transport.js` is the only
  file that knows the provider — swap it for Resend or Brevo when that bites.
- **Do not deploy this to Vercel.** Serverless functions are destroyed between
  requests, so the loop cannot exist. Vercel Cron on the free plan runs about
  once a day. One always-on Node service is both simpler and correct.

## Deploying

**One always-on service.** The web app and the poller share a process, so
anything that sleeps or recycles between requests breaks the product.

### Railway (current target)

`railway.json` sets the start command and points the healthcheck at
`/healthz`. Railway does not idle a service to sleep the way Render's free
tier does, so a hobby plan keeps sweeping.

1. New Project → Deploy from GitHub repo
2. Variables → add everything from `.env.example` **except** `PORT`
   (Railway injects its own; `config/env.js` already reads it)
3. Set `APP_URL` to the generated `*.up.railway.app` domain
4. MongoDB Atlas → Network Access → allow `0.0.0.0/0`, because Railway's
   egress IPs are not fixed

`numReplicas` must stay at **1**. Two replicas means two pollers sweeping
the same queries — double the requests to LinkedIn, and a race for the
same job ids. The unique index stops duplicate emails, but there is no
reason to pay that cost.

### Render (alternative)

`render.yaml` is a blueprint for the same single service. Note that free
instances sleep after ~15 minutes idle, which stops the poller — hence
`plan: starter`.
