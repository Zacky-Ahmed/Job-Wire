# Deployment forensic report — 2026-09-13

Completed before implementation changes. Repository inspected at `efb4081`.

## Evidence boundary

No Railway deployment export, enforcement notice, production environment history,
or production database/logs were supplied or accessed. Neither the last successful
production SHA nor the pre-restriction deployment SHA is established. Git history
starts at `484245e` (2026-08-13); it cannot substantiate months of unchanged runtime.
Do not label a convenient Git revision as a confirmed production baseline.

The reproducible recent code comparison is `a82eda9..efb4081`, with `a82eda9`
immediately before the fixed-slot change. Older traffic changes are listed below.
Dates and commit messages are repository evidence, not deployment evidence.

## Before/after matrix

| Behavior | Before (`a82eda9`) | At `efb4081` | Finding |
|---|---|---|---|
| Successful sweeps/hour | Approximately 60/(interval + service time + other waits), minutes | Fixed grid, subject to load and tick delay | Confirmed algorithm change in `ceace88` |
| Example five-minute watch, 80-second service | About 9.47/hour before tick/mail delay | Up to about 12/hour if capacity permits | Calculated ~27% increase; NOT observed production traffic |
| Requests/hour | Sweeps × actual listing/detail requests, plus manual requests and redirects | Same formula, potentially more sweeps | Actual count unknown; request tallies historically understated volume |
| Country-feed pages/sweep | Up to 40; stop on empty/unrecognised response or two stale pages | Same | No recent depth increase |
| Guest-keyword pages/sweep | Up to 40 when applicable | Same | No recent depth increase |
| JSERP pages/sweep | Up to 40 when applicable, with stale-page stop | Same | No automatic deep shadow walk added |
| Listing ceiling | Up to 120 logical listing calls for three applicable surfaces | Same | Excludes detail calls and up to four HTTP hops per logical call |
| Detail requests | Refine/closure checks; two-minute raw-page cache | Same cache | Existing detail dedupe retained |
| HTTP retries | No automatic same-request retry; redirects up to three | Same | 403/429 throw; no source-wide cooldown |
| Entire-query failure | Interval ×2; blocked exponential backoff capped at 120 minutes | Same basic backoff | `sweep.js` only takes this path when every source fails |
| Partial source failure | Other sources let query succeed; failed source tried on next sweep | Same, potentially sooner on fixed slots | Existing isolation gap, not proof of new retries |
| Park recovery | Could park indefinitely | One recovery attempt after a day, later waits longer | `ceace88` restores intentional recovery traffic |
| Query selection | One frozen `findDue(10)` list | Fresh pool up to 50, select one, pass budget ten | `42629fb` reduces avoidable idle/starvation; not 50 concurrent crawls |
| Delivery | Mail awaited in crawl lane | Independent delivery timer | `42629fb` may increase crawl throughput by removing mail waits |
| Concurrency | Sources within query parallel; LinkedIn surface/page loops serial | Same; mail now concurrent | No new LinkedIn page parallelism found |
| Headers/user-agent | Fixed Chrome/131 user-agent in guarded fetch | Same | No recent header/identity rotation |
| Source-health/crawlLog | Observations and partial instrumentation | Per-page timing/IDs, sweep correlation and progress writes | Extra Mongo work, not extra LinkedIn requests |
| `trace-job`, `--seen-now` | Manual diagnostic | Without flag reads stored records; --seen-now attempts three listing pages and one detail page, then writes a marker | Four logical live calls when policy permits; redirects may add transactions |
| Shadow/probe commands | Manual commands | Manual latency and JSERP pagination probes | Live traffic if invoked; startup does not invoke them |
| Distinct keyword queries | Database/watch dependent | Database/watch dependent | Cannot count from source code |

## Confirmed changes and relevant history

* `ceace88`: `src/models/queries.js:reschedule` changes finish-plus-interval to
  scheduled-slot arithmetic; `setInterval` can pull a deadline forward when a
  subscriber requests a faster cadence. `park` restores a bounded recovery attempt.
* `42629fb`: `src/services/poller/loop.js` separates delivery and repeatedly selects
  fresh due work. Keep fairness and lanes; control traffic independently.
* `cc9772f`: `src/services/sources/linkedin.js:collect` adds page logs and
  `CrawlLog.record`; it retains the same loop and stop conditions. Probe code lives
  in `scripts/probe-linkedin-latency.js`, not server startup.
* `b61e746` adds manual pagination investigation; `33af3d9` corrects tracer evidence
  boundaries. `trace-job --seen-now` performs four live spot checks before recording its database marker. The command is manual, not automatic production instrumentation.
* `d1d3334` (Aug 19) increased feed depth; `e4ea13f` (Sep 1) added the JSERP surface;
  `331f93b` (Sep 1) added closure lookups. These older changes matter if the true
  production baseline predates them. The recent baseline already contains them.
* `a95f08b` and `e40c2f6` isolate test databases. Historical comments describe a test
  watch reaching production; the time, host, and effect require runtime evidence.
* `efb4081` removes disabled sources from the registry, but direct adapter imports
  and guarded HTTP calls bypass that registry. Policy must also guard network I/O.

## Findings by confidence

**Confirmed:** the above scheduling changes can increase the request envelope;
source-level block handling does not persist across successful multi-source sweeps;
registry-only policy is insufficient for manual imports. Fixed-slot arithmetic also
uses ceil at exact boundaries, allowing a slot equal to now instead of strictly
future, both in the production model and its separate simulator helper.

**Plausible, unproven:** increased sustained crawl utilization, manual probes from
the deployment environment, more active queries, provider policy enforcement or
complaints could explain the timing. None establishes Railway's actual trigger.

**No extra production LinkedIn I/O found:** page-log instrumentation, progress
heartbeats, trace markers, UI changes, test isolation, outbox correctness, worker
telemetry identity, and lease fencing. These should not be rolled back wholesale.

## Policy and root-cause limit

Railway's [current acceptable-use policy](https://railway.com/legal/acceptable-use)
prohibits bots/scrapers that violate applicable service terms. LinkedIn's
[official policy](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions?lang=en)
prohibits unauthorized scraping/automated access. Checked 2026-09-13. The current
guest HTML adapter is scraping, not evidence of approved API access. This is a
credible policy incompatibility, not proof of the specific enforcement event.
Reducing traffic or changing hosts does not establish permission.

Obtain the exact enforcement notice, successful/restricted deployment SHA and UTC
times, sanitized environment changes, replica counts and restart history, active
query cadence history, outbound logs and manual command history. Preserve short-TTL
crawlLog/sweepRuns/observations exports before expiry; do not run diagnostic crawls
to recreate missing evidence. Compare actual windows using the same query population
and account for redirects/detail requests and the introduction of telemetry.

## Implementation decision

Keep the scheduler, fencing, independent lanes, outbox and adapters. Add network
policy enforcement, source-wide 403/429 cooldown, configurable LinkedIn rolling
request ceiling, and strictly future fixed slots. Prepare a provider-neutral
container configuration with LinkedIn disabled pending permitted access. Budget
values are operator controls, not a claimed reconstruction of historical traffic.
See DEPLOYMENT.md for migration, rollback and verification. No production changes.

## Correction and additional Work evidence — 2026-09-13

The initial version incorrectly described --seen-now as database-only. Inspection
of scripts/trace-job.js confirms three listing calls and one detail call inside
the flag branch. This correction does not establish production-host execution.

The supplied Work report additionally reports GitHub deployment status evidence:
d1b3400bc70ace94053fbc27912d9b5eb3780523 succeeded at 08:36:15 UTC;
4ebfec2b13089853b3fab04222c45e38844afabb was attempted at 08:59:27 UTC
without recorded success; efb4081 had no deployment record. These are attributed
to the supplied report, not independently verified deployment records here. Its
reported two-project overlap also requires environment and lease evidence before
concluding duplicate traffic. A successful latest deployment is not necessarily
the long-running historical baseline.

Work reports implementation commit 1433b27dc3bb6b7f251c0b6e3927f7a1921ce0b2.
That object is absent from this checkout; no patch was supplied in the text
attachments. Its Mongo-shared budget, persistent circuit, access attestation and
mail isolation have not been reviewed or integrated here. Local validation results
in DEPLOYMENT.md apply only to this checkout, not that separate implementation.
