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

There is no official API for any of them. LinkedIn is read through its
unauthenticated public endpoints, which are rate-limited and degrade silently.

---

## 2. The goal

> Every matching job reaches the user within about five minutes of appearing
> on the board, **for any number of users and any number of distinct
> keywords.**

The second half is the problem. The first half already works.

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

```
before any sharing:   7N   board fetches per cycle
today:            4 + 3N   board fetches per cycle
```

Four sources (topjobs, MAS, XpressJobs, ITPro) fetch a whole listing and then
filter it in the adapter. Those are now fetched **once per country per cycle,
unfiltered**, and each search filters the shared result locally, which is free.

Three remain per-search:

- **LinkedIn**, the long pole and the one that throttles.
- **Keells and Rooster**, which filter server-side, so a shared result would be
  missing other searches' jobs. Cheap (5s, 1s), so not urgent.

```
 5 searches ->  35 fetches before,  19 now
20 searches -> 140 fetches before,  64 now
50 searches -> 350 fetches before, 154 now
```

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
would take the model from 4 + 3N to roughly 5 + 2N — and roughly halve
LinkedIn request rate, which is what throttling responds to.

Not yet implemented. It requires linkedin.js to accept an injected feed rather
than fetching its own: a change inside the adapter, not a cache around it.

### What that still does not solve

Even at 5 + 2N, cost grows with N. Genuinely flat cost requires one of:

- **one crawl, many matchers** — but 5.2 shows the unfiltered feed is not a
  superset, so this is lossy against LinkedIn specifically;
- **distributing requests across IPs**, a proxy pool, which is how commercial
  scrapers scale. Costs money, raises blocking and terms-of-service exposure;
- **accepting tiered coverage** — everyone gets the shared feed within five
  minutes, and per-keyword probes rotate on a request budget, so coverage
  degrades with keyword popularity instead of collapsing.

---

## 7. Constraints any solution must respect

1. **A source that cannot decide must throw, never return an empty array.**
   Empty means nothing today, and is indistinguishable from a silent failure.
   Every outage here has had that shape.
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
