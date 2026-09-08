// starterWatch.js
//
// The watch a new account already has when it first sees the wire.
//
// Signing up landed on an empty page and a form. That asks someone to
// configure a thing before they have watched it do anything, and the very
// next sweep is the priming one — which stores everything and alerts on
// nothing — so the reward for filling the form in correctly was a second
// wait with nothing to show for it.
//
// Given away for free by the shared-query design: the "intern / Sri Lanka"
// row already exists and is already primed, so a new subscriber joins a
// search that is warm. They see the wire fill on the next sweep instead of
// waiting out a priming pass.
//
// Two things this must not do, both of which the surrounding code already
// guarantees and this relies on:
//
//   · alert on a backlog. fanOut skips any subscription created after the
//     sweep started, and the wire scopes every watch to its own createdAt,
//     so a new watcher sees what is found from now on and nothing older.
//   · split the shared query. The key is built exactly as the new-watch
//     form builds it, so upsert joins the existing row rather than
//     creating a second copy of the same search — the thing that once
//     stretched a five minute cycle to nine.

import * as Queries from "../../models/queries.js";
import * as Subs from "../../models/subscriptions.js";
import { collections } from "../../config/db.js";
import { canonicalKey } from "../linkedin/buildUrl.js";
import { findGeo, isKnownGeo } from "../linkedin/geoIds.js";
import { sourcesForCountry, DEFAULT_SOURCE } from "../sources/index.js";
import { keywords as cleanKeywords } from "../../utils/sanitize.js";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";

/**
 * Give this account its first watch, once.
 *
 * Idempotent by checking for ANY existing subscription rather than for
 * this particular one: somebody who has deleted the starter watch has
 * decided they do not want it, and verifying again — or a second call from
 * anywhere else — must not put it back.
 *
 * Never throws. A failure here means a new account has no starter watch,
 * which is the state every account was in before this existed; it must not
 * mean a verified user cannot get into the app.
 */
/**
 * What a new account will start out watching, for the signup page to say.
 *
 * Derived from the same config the watch itself is built from, so the
 * promise on the form and the row that appears cannot drift apart. Null
 * when the starter watch is switched off or misconfigured, and the page
 * then says nothing rather than something untrue.
 */
export function describeStarterWatch() {
  const kw = cleanKeywords(env.starterWatchKeywords);
  if (!kw.length || !isKnownGeo(env.starterWatchGeoId)) return null;
  return { keywords: kw.join(", "), location: findGeo(env.starterWatchGeoId).name };
}

export async function ensureStarterWatch(userId) {
  try {
    const kw = cleanKeywords(env.starterWatchKeywords);
    if (!kw.length) return null;                       // switched off

    const geoId = env.starterWatchGeoId;
    if (!isKnownGeo(geoId)) {
      log.warn("STARTER_WATCH_GEO_ID is not a country this app knows", { geoId });
      return null;
    }

    const already = await collections.subscriptions().countDocuments({ userId });
    if (already) return null;

    const sources = sourcesForCountry(geoId);
    if (!sources.length) sources.push(DEFAULT_SOURCE);

    const query = await Queries.upsert({
      // Byte-for-byte what watches.routes.js builds, so this joins the
      // shared row instead of creating a rival spelling of the same search.
      keywordsKey: canonicalKey(kw),
      keywords: kw,
      geoId,
      location: findGeo(geoId).name,
      everyMinutes: env.defaultSweepMinutes,
      sources,
      matchAll: false,
    });

    const label = env.starterWatchLabel || kw[0];
    const sub = await Subs.create({ userId, queryId: query._id, label });
    if (!sub) return null;                             // raced; fine

    log.info("gave a new account its starter watch", {
      userId: String(userId), keywords: kw.join("+"), location: findGeo(geoId).name,
    });
    return sub;
  } catch (err) {
    log.error("could not create the starter watch — the account is fine without one", {
      userId: String(userId), message: err.message,
    });
    return null;
  }
}
