# Match Receipts, Why This Matched, and Backscan — design

Written to be reviewed **before** any of it is built. Everything below was
checked against the code at `d1b3400`, not recalled.

The governing principle:

> The intelligence layer may explain truth, organise truth, and replay
> truth. It may never manufacture truth.

Which in this codebase has a sharper form, because we spent two rounds
establishing it:

> `UNKNOWN` is never `YES`. An explanation may describe a decision. It
> may never re-derive one.

---

## 1. How a Match Receipt differs from `matchedBy`

`matchedBy` already exists. It is not enough, and looking at what it
actually does turned up a real gap.

**What the matcher produces today** (`linkedin.js:512-560`):

```js
{ matchedBy: "title",        matchKind: "title" }
{ matchedBy: "Internship",   matchKind: "tag", matchField: "employment type" }
{ matchedBy: "unverified",   matchKind: "unverified" }
```

`matchKind` is the load-bearing field — the delivery guard at
`sweep.js:860` refuses anything that is not `tag` or a proven title
match. `matchedBy` is a **display string**: it carries the tag's own
value (`"Internship"`) because that is what a reader wants to see.

**What survives into the corpus** (`seenJobs.js:194-203`):

```js
update: { $set: { matched: true, matchedBy: j.matchedBy || "keyword" } }
```

`matchKind` and `matchField` are **dropped**. The default is
`"keyword"` — a value no matcher produces.

So the corpus cannot currently answer "why did this match?" even
approximately:

| question | answerable from `seenJobs` today? |
|---|---|
| did it match? | yes |
| was it a title or a tag match? | **no** — `matchKind` was discarded |
| which keyword hit? | **no** — never recorded |
| what text was the evidence? | only by re-deriving it |
| which field carried the tag? | **no** — `matchField` discarded |
| under which matcher? | **no** — no version anywhere |
| why was it *rejected*? | **no** — `unmatch()` stores a reason string only |

That last row matters for "Why Not".

**The receipt is a record of the decision that already happened**, with
the structure the guard reasons about, plus the evidence a human needs:

```js
{
  queryId, jobId,
  decision: "MATCH" | "NO_MATCH" | "UNKNOWN",
  reason: {
    kind: "TITLE" | "EMPLOYMENT_TYPE" | "SENIORITY"
        | "TITLE_NO_MATCH" | "TAG_MISMATCH" | "DETAIL_UNAVAILABLE",
    keyword,          // which of the watch's words hit
    field,            // "employment type" / "seniority"
    expected,         // what the watch asked for
    observed,         // what the employer's field said
    evidence,         // the exact text the decision was made on
    verified,         // did we actually read the detail page
  },
  decidedAt,
  matcherVersion,
  provenance: { source, surface, firstObservedAt },  // when available
}
```

It is **emitted by the matcher**, not reconstructed afterwards. There is
no second matching implementation anywhere in this design — that is the
whole point.

**Decision → permission stays a lookup table**, not a judgement:

```
MATCH      may alert
NO_MATCH   may not
UNKNOWN    may not
```

The renderer has no authority. It reads a row.

---

## 2. New collection, or a field on `seenJobs`?

**A new collection, `matchReceipts`.** Three reasons, in order of weight.

**A receipt outlives the corpus row.** `seenJobs` has a 14-day TTL
(`SEEN_JOB_TTL_DAYS`). "Why did I get emailed about this?" is a question
people ask about an email from three weeks ago. A field on a row that
evaporates cannot answer it. The receipt needs its own, longer retention
— 90 days is a reasonable opening position.

**`seenJobs` is the dedupe ledger and the wire feed.** It is written on
every discovery, read by the sweep's hot path, and already carries job
text, timestamps, flags and openings. Adding a nested evidence object to
the row the sweep bulk-writes for the whole country feed makes the
expensive collection more expensive for data only two screens read.

**Rejections need rows too.** For "Why Not" we want `NO_MATCH` receipts,
and those are for jobs `seenJobs` holds as `matched: false` — the
majority of the corpus. Selectively writing receipts is much easier in a
collection whose only job is receipts.

Indexes:

```
{ queryId: 1, jobId: 1 }   unique   the lookup, and idempotence
{ jobId: 1, decidedAt: -1 }         one job across every watch
{ decidedAt: 1 }           TTL      90 days
```

**Migration: none.** No backfill, no rewrite. Receipts start at the
commit that ships them. Anything older renders per §3.

---

## 3. Old matches with no receipt

They say so:

```
Match explanation unavailable

This job was matched before Job Wire started recording its reasoning.
```

Explicitly **not**: running today's matcher to produce a retrospective
explanation. That is the failure mode this whole design exists to
prevent, and it is a subtle one — the sentence would look right, and it
would be a fabrication about a decision made by different code.

`matcherVersion` is what makes this checkable later. When the matcher
changes — word boundaries, employment-type handling, seniority rules —
old receipts still render the reasoning that actually applied. A receipt
written under `v7` is never re-rendered under `v9`.

Version on the **receipt**, not derived from a constant at read time, or
a deploy silently rewrites history.

---

## 4. How Backscan performs zero writes

This is where checking the code changed the feature, so the constraints
come before the mechanism.

### The corpus is per-query, and a new watch has none

`seenJobs` is keyed `(queryId, jobId)` — unique index, `indexes.js:113`.
Every row belongs to **one search**. A watch created five minutes ago has
**zero rows of its own**.

So Backscan cannot replay "this watch's history". It has to read rows
**other watches discovered**, and that bounds what it can honestly claim:

- a new Sri Lanka watch can be replayed against whatever *other* Sri
  Lanka watches happened to pull in;
- if yours is the first watch in a country, Backscan finds **nothing**,
  and must say that rather than implying the market was empty;
- coverage is a function of who else is watching — genuinely uneven, and
  the UI has to not pretend otherwise.

### The window is 14 days at most, usually less

TTL is 14 days on `firstSeenAt`. The reviewer's caution was right and is
sharper than expected: **do not say "the last 7 days"**. Say what was
actually searched:

```
Backscan searched 1,847 jobs Job Wire observed in Sri Lanka
between 30 Aug and 13 Sep.
```

### Employment-type rescue cannot be replayed

`refine()` makes an HTTP request per job to read employment type
(`linkedin.js`, the `detailPage` path). For historical jobs that is
either a network call each — against postings that may be closed and
gone — or nothing.

Per the reviewer's item 6: **an UNKNOWN must not be upgraded to a MATCH
to make Backscan look better.** So:

> **Backscan is title-only.** A historical job whose title does not match
> is reported as `UNKNOWN`, never as a match.

This is a real limitation and the UI states it. It also means Backscan
systematically under-counts exactly the jobs the tag rescue exists for —
the ones titled "Trainee Programme" that LinkedIn tags Internship. Worth
saying out loud rather than discovering as a complaint.

### The mechanism

One function, `mutate: false` not as a flag but as a structural
property — it calls nothing that writes:

```js
export async function backscan({ keywords, geoId, limit = 200 }) {
  const rows = await collections.seenJobs()
    .find({ /* geo-scoped via queries, matched or not */ },
          { projection: { jobId: 1, title: 1, company: 1, url: 1,
                          postedAt: 1, firstSeenAt: 1, surfaces: 1 } })
    .sort({ firstSeenAt: -1 }).limit(limit).toArray();

  // The canonical matcher. Not a copy, not a looser variant.
  return rows.map((r) => ({
    job: r,
    receipt: evaluateTitleOnly(r, keywords),   // TITLE or UNKNOWN, never TAG
  }));
}
```

What guarantees zero writes is that it **imports nothing that can
write**: no `Outbox`, no `Ledger`, no `SeenJobs` mutators, no
`Queries`. Not a flag that a future edit can forget to check.

Asserted, not asserted-in-a-comment:

```
a backscan of N jobs writes zero outbox rows
a backscan does not create alertedJobs entries
a backscan does not change nextFetchAt or primed
a backscan of a title that does not match yields UNKNOWN, never MATCH
running backscan twice produces identical output and no side effects
```

Plus the load-bearing one:

```
for every job in the corpus, backscan's decision equals
the live matcher's decision on the same title and keywords
```

If those ever diverge, two matchers exist and the design has failed.

---

## 5. Mock UI

### Watch created

```
┌──────────────────────────────────────────────────────────┐
│  WATCH CREATED                                           │
│                                                          │
│  Data Analyst · Sri Lanka                                │
│                                                          │
│  LIVE MONITORING      Active — first sweep in 4m 12s     │
│                                                          │
│  BACKSCAN             11 matches                         │
│  Searched 1,847 jobs seen between 30 Aug and 13 Sep      │
│  Newest 24m ago · oldest 11d ago                         │
│                                                          │
│  [ View Backscan ]                                       │
│                                                          │
│  Backscan matches on job titles only. Roles that need    │
│  an employer tag checked can't be verified retro-        │
│  actively — your live watch still catches those.         │
└──────────────────────────────────────────────────────────┘
```

Empty case, which must not read as "no jobs exist":

```
  BACKSCAN             nothing to search yet

  Job Wire hasn't observed this country before — yours is
  the first watch here. Live monitoring starts now.
```

### Wire, with the two kept apart

```
  LIVE  3          BACKSCAN  11

  ─ LIVE ───────────────────────────────────────────────
  Data Analyst — Dialog Axiata          24m ago   [why?]

  ─ BACKSCAN ───────────────────────────────────────────
  Found before your watch existed. Not emailed.
  Junior Data Analyst — MAS             2d ago    [why?]
```

**Backscan results are never emailed.** A new watch finding 47 jobs must
not produce 47 alerts, and live and historical discovery stay
semantically different.

### Why This Matched — title

```
┌──────────────────────────────────────────────────────────┐
│  WHY THIS MATCHED                                        │
│                                                          │
│  Watch        Intern · Sri Lanka                         │
│  Matched by   TITLE                                      │
│  Keyword      intern                                     │
│  Evidence     "Software Engineer Intern"                 │
│                       ▔▔▔▔▔▔                             │
│  Decided      13 Sep 14:21:09 · matcher v1               │
│                                                          │
│  Found on     LinkedIn guest keyword surface             │
│  Observed     14:22:07   Matched 14:22:09   Sent 14:22:11│
└──────────────────────────────────────────────────────────┘
```

### Why This Matched — the tag rescue

The interesting one, and the reason the feature is worth building:

```
│  The title doesn't contain "intern".                     │
│                                                          │
│  LinkedIn employment type    Internship  ✓ verified      │
│                                                          │
│  That employer-set tag satisfied your watch. This is why │
│  Job Wire found it and a title search would not have.    │
```

### Why Not — later, same receipts

```
│  WHY YOU WEREN'T ALERTED                                 │
│                                                          │
│  Junior Data Associate — Hemas                           │
│                                                          │
│  ✓ Sri Lanka                                             │
│  ✗ Title doesn't match "data analyst"                    │
│  ? Employment type not checked — title decided it        │
│                                                          │
│  No alert was sent.                                      │
```

Near Miss is a **separate surface**. It never enters the live alert
path, and nothing in it can promote a job.

---

## What this does not touch

Frozen while production latency data accumulates: scheduler, poller
lease, LinkedIn pagination, Radar, streaming, outbox delivery.

Backscan reads `seenJobs` and writes nothing. "Why This Matched" reads
`matchReceipts` and writes nothing. Emitting a receipt adds one bulk
write per sweep alongside `markMatched` — measured before it ships.

## Build order

1. `matchReceipts` + emit from the canonical matcher (invisible)
2. Why This Matched (reads receipts)
3. Backscan (read-only replay)
4. Why Not / Near Miss (reads `NO_MATCH` receipts)

Each is useful alone and none needs the next.

## Open question for you

`markMatched` discards `matchKind` today. Receipts fix that going
forward — but should `markMatched` **also** start persisting `matchKind`
on the `seenJobs` row?

Argument for: the wire could then distinguish a title hit from a tag
rescue without joining receipts.

Argument against: it duplicates the receipt, and two copies of a verdict
is how "matchedBy" and "matchKind" came to disagree in the first place.

My inclination is **no** — one home for the verdict, joined when needed.
