# Job Wire — the scaling problem, in detail

A problem statement written to be handed to someone else, or to another
assistant, cold. Everything numbered here was measured on the live system in
September 2026. Where something is an estimate it says so.

---

## 1. What the system does

Job Wire watches job boards and emails a user when a new posting matches their
keywords. A user creates a **watch**: keywords, a country, and a sweep
interval (5-60 minutes).

A background poller loops forever. Each tick it takes the searches that are
due and sweeps them one at a time.

Seven sources, all covering Sri Lanka:

| source | what it is | how it is read |
|---|---|---|
| LinkedIn | global job board | scraped: 3 public surfaces, unioned |
| topjobs.lk | Sri Lankan board | scraped HTML, ~306 listings |
| XpressJobs | Sri Lankan board | JSON API, ~400 listings |
| Rooster | regional platform | JSON API (POST), ~490 listings |
| MAS Holdings | one employer | Oracle Recruiting JSON API |
| John Keells | one employer | scraped HTML |
| ITPro.lk | Sri Lankan IT board | scraped HTML |

There is no supported public search/read API suitable for the LinkedIn
discovery case. Several of the others do expose JSON endpoints — MAS through
Oracle Recruiting, XpressJobs and Rooster through the APIs their own front ends
call — but those carry no support guarantee and can change without notice.
LinkedIn is read through its unauthenticated public endpoints, which are
rate-limited and degrade silently.

LinkedIn's official Talent Solutions APIs do not close this gap: the Job
Posting API is for approved ATS and job-distribution partners to *create* jobs,
not a search feed, and new partnerships for it are not currently being
accepted.

---

## 2. The goal

> Every matching job reaches the user within about five minutes of appearing
> on the board, **for any number of users and any number of distinct
> keywords.**

**That sentence is not a usable target, because it measures something the
system does not control.** It has to be split:

| | measured from | to | controllable? |
|---|---|---|---|
| **source observability lag** | the employer posting it | the first moment any monitored source exposes it | **no** |
| **processing latency** | our first observation | a durable alert queued | **yes** |

The measured numbers say why this matters. Source observability lag on
LinkedIn is a median of **19 minutes** and a 90th percentile of **46**, with
only 11% under five minutes. Processing latency is a median of **3 seconds**.

So a five-minute promise measured from the employer's timestamp is not
achievable against LinkedIn at any architecture. Measured from first
observation, it is already comfortably met — and the real question is how many
distinct searches can be observed at all, which is §4a.

---

## 3. Current architecture

### 3.1 Data model

```
queries        one row per DISTINCT SEARCH  (keywords + country)
subscriptions  one row per USER per WATCH   (points at a query)
seenJobs       one row per (query, job)     dedupe + the user-facing feed
alertedJobs    one row per (query, job)     have we ever emailed this
```

The key property: **a query is shared.** Ten users watching `intern` in Sri
Lanka produce ten subscription rows and **one** query row. The poller sweeps
queries, not users.

Identity is normalised so spelling cannot defeat it:

```
identityKey = country + "::" + sorted, lowercased, de-duplicated keywords
```

`Intern`, `intern `, `intern, INTERN` and the legacy key `intern@@linkedin`
all resolve to one row.

### 3.2 The sweep

For one due query:

1. Fetch every source covering the country, **concurrently** (different
   hosts). Within a source, pages are walked serially.
2. Subtract everything in `alertedJobs` to get the new jobs.
3. Match on title, at word boundaries. LinkedIn additionally spends **one HTTP
   request per new job** to read its employment type, which is the only way to
   catch a job the employer tagged Internship while titling it something else.
   Budget 45 per sweep.
4. Withhold anything too old to act on.
5. Send one email per subscriber per sweep, carrying every new job at once.

### 3.3 What LinkedIn costs

`linkedin.fetchJobs()` makes **three separate walks** per search:

| surface | keyword-dependent | shareable across searches |
|---|---|---|
| unfiltered country feed | **no**, identical for every search in a country | **yes** |
| guest API keyword query | yes | no |
| JSERP search page | yes | no |

Each walk pages up to 40 pages of 10, stopping after 2 pages that add nothing.
Measured wall time for one LinkedIn fetch: **78-92 seconds**. Every other
source is 1-15 seconds.

---

## 4. The cost model

Let **N** be the number of distinct searches in one country.

**Two different units, and conflating them is a mistake this document made
in its first version.** An *adapter call* is one call to `fetchJobs()`. A
*surface walk* is one paginated crawl of one endpoint. LinkedIn is one adapter
call and **three** surface walks, so the two counts diverge badly.

Adapter calls:

```
before any sharing:   7N
today:            4 + 3N
```

Surface walks, which is what the network and the rate limiter actually see:

| component | per country | per search |
|---|---:|---:|
| topjobs, MAS, XpressJobs, ITPro | 4 | 0 |
| LinkedIn country feed | 0 | 1 |
| LinkedIn guest keyword query | 0 | 1 |
| LinkedIn JSERP keyword query | 0 | 1 |
| Keells | 0 | 1 |
| Rooster | 0 | 1 |
| **total** | **4** | **5N** |

```
before any sharing:   7N   adapter calls  =  9N   surface walks
today:            4 + 3N   adapter calls  =  4 + 5N surface walks
```

Pre-sharing is **9N**, not 7N: six sources contribute one walk each and
LinkedIn contributes three.

Sharing LinkedIn's country feed — the step described in §6 — moves the
LinkedIn part from `3N` walks to `1 + 2N`, and the whole system to
`5 + 4N` walks. It does **not** produce `5 + 2N`; that figure came from
mixing the two units.

Four sources (topjobs, MAS, XpressJobs, ITPro) fetch a whole listing and then
filter it in the adapter. Those are now fetched **once per country, unfiltered**,
and each search filters the shared result locally, which is free.

**"Once per cycle" is what this document used to say, and it is not what the
code does.** The share is a process-memory cache with a **four-minute TTL**
([`fetchCache.js`](../src/services/poller/fetchCache.js)), not a boundary tied
to a pass over the due queue. If a pass takes longer than four minutes — which
it will as N grows, since LinkedIn alone is ~80s per search — a later search in
the *same* logical pass refetches a source an earlier one already had. The
`4` in `4 + 5N` is therefore a floor, not a guarantee, and it degrades exactly
when scale makes it matter most. The fix is an explicit immutable snapshot
keyed by (source, country, snapshotId) that a pass pins for its duration,
rather than a wall-clock TTL that a slow pass outlives.

Three remain per-search:

- **LinkedIn**, the long pole and the one that throttles.
- **Keells and Rooster**, which filter server-side, so a shared result would be
  missing other searches' jobs. Cheap (5s, 1s), so not urgent.

Counted in **surface walks**, which is what the rate limiter sees:

| N | before sharing (9N) | today (4+5N) | shared LI feed (5+4N) | shared feed, no JSERP (5+3N) |
|---:|---:|---:|---:|---:|
| 5 | 45 | 29 | 25 | 20 |
| 20 | 180 | 104 | 85 | 65 |
| 50 | 450 | 254 | 205 | 155 |

Still linear in N, and the linear part is the slowest, most fragile source.

---

## 5. What has been tried, and what happened

### 5.1 Share one board fetch across searches — CAUSED TWO OUTAGES

**Attempt A.** Cache the adapter result per (source, country) for a cycle.

Failed because every one of these adapters filters by keyword *inside itself*.
The cache stored a **filtered** result, so whichever search ran first decided
what every other search saw. The IT search ran first; the intern watch was
emailed *IT Manager*, *IT Technician*, *Senior Executive - IT*.

**Attempt B.** Cache the **unfiltered** listing and filter per search.

Failed because a match-all watch existed, meaning every job in the country. A
match-all fetch *is* the unfiltered listing, so it filled the cache with 400
jobs — and the sweep had never filtered by keyword at any point in its
history; it had always relied on the adapter. The intern watch was emailed
*Burger King Crew Member*, *Lorry Driver*, *Chef De Partie*. 673 to 1303 rows
in one sweep.

**Now working** for the four keyword-independent sources: fetch unfiltered,
filter per search in the sweep. Verified by reproducing the exact failure —
IT sweeps first, then intern reads the same cached 306-job listing and gets 24
jobs with zero foreign titles.

Lesson: the boundary between what is fetched and what is matched was implicit
and undocumented. Sharing is only safe if the shared artefact is the
*unfiltered* one and matching happens strictly after it.

### 5.2 Use the unfiltered country feed for everyone — LOSSY

Tempting, since that surface is identical for every search.

Measured for keyword intern, counting only title matches:

```
keyword search finds   12
country feed finds      9
in both                 6
only in keyword search  6
only in the feed        3
true union             15
```

One posting **36 minutes old** sat inside the feed 28-hour window and was not
returned. The feed is not a superset. Dropping the keyword query loses roughly
40% of matches.

### 5.3 Send fewer, broader keyword queries — NO BENEFIT

Measured, four keywords, same country:

```
intern                    183 jobs
data analyst              183 jobs
intern + data analyst     182 jobs
4 data-science titles     173 jobs
```

The keyword barely changes the count. But the *sets* differ:

```
intern 209, data analyst 191, business analyst 203, it 217
pairwise overlap 79-86%
four fetches -> 259 distinct jobs
largest single fetch alone -> 217
```

Four requests buy **42 extra jobs**, and cost the throttling below. Rotating
which keyword drives a shared fetch was implemented, then reverted with 5.1.

### 5.4 Narrow the time window to make queries cheap — LIES

The f_TPR parameter, tested twice against live LinkedIn:

```
2026-08-13  r3600  returned an empty document, while r7200 showed a job
                   posted 23 minutes earlier
2026-08-14  r7200  returned 2 jobs and omitted one posted 30 minutes
                   earlier; r14400 returned it; r86400 returned 27
```

The filter silently drops recent postings. Sorting by date is also not
honoured, so fetching just the newest two pages is unavailable. **Full
pagination is mandatory**, which is why one LinkedIn fetch costs 80+ seconds.

### 5.5 Poll the employer ATS instead of the index — WRONG SUBSET

Most companies use an applicant tracking system with a public JSON API.
Verified live:

```
greenhouse  171 jobs  1168ms  no auth  real timestamps
ashby       140 jobs  1036ms  no auth  real timestamps
```

Complete, fast, and *ahead* of LinkedIn, which is a downstream copy.

But it only covers jobs that came *from* an ATS. A job posted directly into
LinkedIn, via Easy Apply, exists nowhere else — and for Sri Lankan
internships, small companies posting by hand, that is a large share of the
target set. A fast lane, not a replacement.

---

## 6. The open problem, stated precisely

> Fetch cost is **O(distinct searches)** when the thing being fetched only
> varies by **country**. The dominant term is LinkedIn, which must be
> paginated in full, costs about 85 seconds, and rate-limits when called too
> often.

### What throttling looks like

Not an error. A silent shortfall:

```
intern            saw 365/429
data analyst      saw   1/207   <- collapsed
business analyst  saw 233/233
data scientist    saw   2/202   <- collapsed
it                saw 300/300
```

Two searches returning almost nothing, every request HTTP 200.
Indistinguishable from a quiet morning unless compared against each search own
historical peak.

### The known next step

LinkedIn three surfaces are not equal. The **unfiltered country feed** is
identical for every search in a country and is one of the three walks. Sharing
only that half, while each search keeps its own keyword query, is lossless and
takes LinkedIn from 3N surface walks to 1 + 2N.

**The size of the request saving is not yet known.** If P_f is the number of
page requests the country feed costs, the saving is exactly (N-1) x P_f — and
nothing measured so far says what fraction of LinkedIn traffic P_f is. An
earlier version of this document claimed it would "roughly halve" LinkedIn
requests. That was unsupported. On the stated worst-case limits (40 pages per
surface, 45 detail requests) the ceiling is 165 requests per search, so at
N=50 the reduction would be about 24%, not 50%. Instrument per-surface request
counts before quoting any figure.

Not yet implemented. It requires linkedin.js to accept an injected feed rather
than fetching its own: a change inside the adapter, not a cache around it.

### What that still does not solve

Even at 5 + 4N whole-system walks (1 + 2N for LinkedIn alone), cost grows with
N. Genuinely flat cost requires one of:

- **one crawl, many matchers** — but 5.2 shows the unfiltered feed is not a
  superset, so this is lossy against LinkedIn specifically;
- **distributing requests across IPs**, a proxy pool, which is how commercial
  scrapers scale. Costs money, raises blocking and terms-of-service exposure;
- **accepting tiered coverage** — everyone gets the shared feed within five
  minutes, and per-keyword probes rotate on a request budget, so coverage
  degrades with keyword popularity instead of collapsing.

---

## 7. Constraints any solution must respect

1. **Positive and negative evidence are not symmetric.** A job seen on page 1
   of a scan that later fails is still a real job and can be acted on. An
   *empty* result can only be believed from a scan that completed healthily.
   The current rule — a source that cannot decide must throw rather than return
   an empty array — is the crude version of this; the precise version is that
   absence requires proof of completeness, presence does not. Every outage here
   has had the shape of absence being trusted when it should not have been.
2. **Matching happens after fetching, never inside a shared artefact.** See 5.1.
3. **A job must never be emailed twice.** The alertedJobs ledger records every
   job a search has ever seen, with a long TTL, separate from the 14-day feed
   memory. Getting this wrong sent 110 duplicate emails.
4. **Never widen what a watch matches.** A guard immediately before sending
   refuses any job whose title does not match the watch keywords, unless it was
   kept for an employer tag rather than its title.
5. **Requests to one host stay serial.** Different hosts may run concurrently;
   ten parallel requests to LinkedIn is what a scraper looks like.
6. **Email is capped.** About 450 a day, and measured usage is about 31 emails
   per user per day, so mail becomes the binding constraint at roughly 15 to 20
   users regardless of fetching.

---

## 8. Measured reference data

| measurement | value |
|---|---|
| LinkedIn detection lag, median | **19 min** |
| 75th / 90th percentile | 32 min / 46 min |
| under 5 min | 11% |
| under 15 min | 38% |
| whole-country sweep, 7 boards concurrent | **78-92s**, entirely LinkedIn-bound |
| topjobs / MAS / Keells / ITPro / Xpress / Rooster | 9.4s / 8.1s / 5.3s / 2.2s / 1.3s / 1.0s |
| LinkedIn country feed depth | 210-220 jobs, about 28h of history |
| detection to email handoff | median **3s**, not the bottleneck |
| jobs fetched by more than one watch in a week | 2,092 |
| alerts sent later than the job was already in memory | 1,975, median **21.9 min** late |

That last row is worth reading twice: before cross-watch sharing was added,
**the architecture was a bigger source of delay than the LinkedIn index.**

---

## 9. Where to look in the code

```
src/services/poller/sweep.js        the sweep: fetch, match, gate, send
src/services/poller/fetchCache.js   per-country shared fetch, and why
src/services/sources/linkedin.js    the three surfaces
src/services/sources/index.js       the adapter contract
src/models/queries.js               identityKey, shared query rows
src/models/alertedJobs.js           the never-mail-twice ledger
src/utils/match.js                  title matching
```

Each of those carries comments explaining why it is shaped as it is, usually
naming the failure that shaped it. Read those before changing anything: most
obvious improvements have already been tried and reverted, and the comments
say which.

---

## 10. The impossibility result, stated plainly

Worth putting near the front of anyone's thinking, because it stops a lot of
wasted effort:

> **There is no lossless O(1) solution against LinkedIn's observed interfaces.**
> Query-specific searches expose jobs that are absent from the
> query-independent feed, so guaranteed coverage for arbitrary distinct
> keywords requires query-dependent observations. The scalable product has to
> optimise the number and scheduling of those observations rather than pretend
> they can be eliminated.

The proof is §5.2. For the keyword `intern`: the feed found 9 title matches,
the keyword query found 12, the union was 15, and one posting 36 minutes old
was inside the feed's own window and simply not returned. Neither endpoint
dominates the other. If job J is only ever exposed by query Q, a crawler that
never runs anything equivalent to Q cannot know J exists.

This is an information-acquisition problem, not a compute problem. Caching,
a faster server, a better scheduler and a bigger database all leave it exactly
where it was.

---

## 11. Two structural changes worth making regardless

### 11.1 A global job corpus

`seenJobs` is keyed `(query, job)`, so the same posting is stored once per
search that saw it. Measured over the existing data:

```
distinct LinkedIn jobs ever stored : 6,724
(job, query) rows                  : 8,528
jobs appearing under >1 query      :   887  (13%)
rows a global corpus would collapse: 1,804  (21%)
```

At five searches, 21% of the rows are duplication. The share grows with N.
The fix is a global `jobs` table plus a `queryMatches` join, so a job is one
object and the query relationship lives downstream.

**That 21% is storage and bookkeeping, not HTTP.** A global fact cache saves a
*request* only when the same job triggers employment-type enrichment under more
than one query — and enrichment is already skipped whenever the title matches.
Measure duplicate detail calls directly before quoting a request saving. At the
time of writing N=1, so the measured duplicate-detail count is zero and the
question is open.

### 11.2 A global fact cache for employment type

The per-job detail request that reads employment type is already **lazy** — a
job whose title matches the keywords skips it entirely. What is missing is
that the result is not shared: if the same job fails the title test for three
searches, its detail is fetched three times.

Employment type is a property of the **job**, not the watch. Caching it by
LinkedIn job id turns `O(searches x duplicate jobs)` detail requests into
`O(distinct jobs needing enrichment)`. Lossless.

### 11.3 Immutable snapshots

Both outages in §5.1 happened because one cached object was allowed to mean
two different things: "the raw listing" and "the results for query X".
Making that structurally impossible is better than a comment asking people not
to do it:

```
CountrySnapshot { cycleId, country, source, fetchedAt, jobs }   immutable
QueryProjection { snapshotId, queryId, matchedJobIds }          derived
```

No matcher may modify a snapshot; matching produces a new object.

---

## 12. The measurement that should come next

Not latency. **Marginal recall per surface.**

Every discovered LinkedIn job should carry a provenance mask recording which
of the three surfaces saw it: country feed, guest keyword query, JSERP page.
After a few days that answers a question nothing here has answered yet:

> How many *actionable* jobs does the JSERP page find that the feed and the
> guest query would both have missed?

Existing log lines hint that it is small — the page has been observed adding
1 to 8 jobs on top of roughly 200 to 250 — but that is raw jobs, not title
matches, and it is not enough to decide on.

If JSERP's unique contribution is negligible, deleting it takes LinkedIn from
`3N` walks to `2N` immediately, and to `1 + N` once the feed is shared. That
is a larger and cheaper win than any caching scheme, and it needs one
instrumentation change rather than an architecture.

---

## 13. The constraint nobody had modelled: capacity

Everything above counts **requests**. None of it counts **time**, and time is
what actually broke.

Searches are swept one at a time. Let a search `q` cost `Cq` seconds of
LinkedIn service time and ask for an interval of `Iq` seconds. A single serial
lane is oversubscribed when

```
U = sum( Cq / Iq )  >=  1
```

With the measured midpoint `Cq ~= 85s` and every watch on the five-minute
floor:

```
Nmax  ~=  300 / 85  ~=  3.5
```

**Three and a half searches.** Not fifty, not twenty — between three and four
is where a five-minute promise stops being arithmetically possible, before
throttling is considered at all.

| N | one full round | vs a 5-minute interval |
|---:|---:|---|
| 1 | ~85s | fine |
| 3 | ~4.3 min | fine |
| 4 | ~5.7 min | already late |
| 5 | ~7.1 min | permanent backlog |
| 20 | ~28 min | the interval is fiction |

This reframes the outage in §6. Five searches were not merely making too many
requests; the system had promised more work than one serial lane could
perform. Throttling and oversubscription arrived together, and the wire showed
one number for both.

Two consequences:

1. **Capacity and email are independent ceilings.** Fifteen users on one shared
   query hit the mail cap first. Five users with five distinct searches hit
   LinkedIn capacity first. Neither number predicts the other.
2. **An interval the lane cannot honour should be refused, not accepted.** The
   form currently offers five minutes to everyone regardless of how many
   distinct searches exist. Admission control — or an honest "checked about
   every N minutes" derived from measured utilisation — is more truthful than
   a promise the scheduler cannot keep.

### The scheduling change this implies

Make the LinkedIn crawler a **page-level** worker rather than a query-level
one. Today a single search holds the host lane for 80+ seconds while every
other search waits. If the unit of work is one page, the scheduler can
interleave by deadline, and a job found on page 1 can be matched and queued
immediately instead of after the whole three-surface union completes.

This removes no requests at all. What it changes is fairness, observability of
the constraint, and time-to-alert for the jobs that happen to appear early.

---

## 14. What is already built, so nobody rebuilds it

Reviews of this document have twice proposed things the system already does.
For the avoidance of doubt:

- **Lazy enrichment.** `refine()` already skips the employment-type request
  entirely when the title already matches. What is missing is only that the
  result is not shared *between* searches.
- **A recipient-level outbox.** `emailLog.open()` writes a `sending` row keyed
  by user before the provider is called; `settle()` finalises it; the retry
  queue reclaims both failed rows and rows abandoned mid-flight, with an
  attempt limit. It is the transactional-outbox pattern in everything but a
  database transaction.
- **Cross-watch sharing.** A completed sweep already offers what it fetched to
  every other live watch in the same country, matched on title, spending no
  extra requests.
- **A never-mail-twice ledger,** separate from the wire's own memory, with a
  long TTL.
- **A pre-send guard** that refuses to mail any job whose title does not match
  the watch's keywords, unless it was kept for an employer tag rather than its
  title.
