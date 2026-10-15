// guardedFetch.js
//
// The only place this app makes an outbound HTTP request.
//
// This used to live in services/linkedin/ with linkedin.com hardcoded.
// Now that several job sources exist, the allowlist is passed in per
// call — but it is still an ALLOWLIST. A user pastes a URL when creating
// a watch, and without one the server would happily fetch
//   http://169.254.169.254/latest/meta-data/iam/security-credentials/
// on their behalf, or anything else inside the private network.
//
// Rules that must not be relaxed:
//   · https only
//   · host must exactly match, or be a subdomain of, an allowed host —
//     suffix matching, never includes(), or "linkedin.com.evil.tld" passes
//   · redirects followed manually, revalidating the host at every hop
//   · the resolved IP checked against private ranges (DNS rebinding)

import dns from "dns/promises";
import net from "net";
import { env } from "../../config/env.js";
import { getDb } from "../../config/db.js";
import { log } from "../../utils/logger.js";
import { takeRequestSlot } from "./requestBudget.js";
import { createCooldown } from "./sourceCooldown.js";

const linkedinCooldown = createCooldown({ collection: () => getDb().collection("sourceCooldowns") });
export async function getLinkedInCooldown() {
  return getDb().collection("sourceCooldowns").findOne({ _id: "linkedin" });
}

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15000;
const MAX_BYTES = 5 * 1024 * 1024;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class BlockedBySource extends Error {
  constructor(status, host) {
    super(`${host} returned ${status}`);
    this.name = "BlockedBySource";
    this.status = status;
    this.deferred = true;
  }
}

/** Throws unless the URL is https and on an allowed host. */
export function assertAllowed(raw, allowHosts) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error("Only https URLs are allowed");
  if (u.username || u.password) throw new Error("Credentials in URL are not allowed");

  const host = u.hostname.toLowerCase();
  const allowed = allowHosts.some(
    (h) => host === h.toLowerCase() || host.endsWith("." + h.toLowerCase())
  );
  if (!allowed) throw new Error(`Host not allowed: ${host}`);
  return u;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // cloud metadata
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function assertPublicHost(hostname) {
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`Cannot resolve ${hostname}`);
  }
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`${hostname} resolves to a private address`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string}   rawUrl
 * @param {string[]} allowHosts  hosts this source is permitted to reach
 * @param {object}   opts        { jitter, accept, charset }
 */
export async function guardedFetch(
  rawUrl, allowHosts, { jitter = true, accept, charset, method = "GET", body, discovery = false } = {}
) {
  let url = assertAllowed(rawUrl, allowHosts);

  const linkedin = url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com");
  const probe = linkedin ? await linkedinCooldown.enter({ discovery }) : false;

  // Random delay so a schedule does not look like a metronome.
  if (jitter && env.fetchJitterMs > 0) {
    await sleep(Math.floor(Math.random() * env.fetchJitterMs));
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (linkedin) await takeRequestSlot(getDb().collection("sourceRequestBudgets"));
    let dnsTimer;
    try {
      await Promise.race([
        assertPublicHost(url.hostname),
        new Promise((_, reject) => {
          dnsTimer = setTimeout(() => reject(new Error(`DNS lookup timed out: ${url.hostname}`)), 8000);
          dnsTimer.unref();
        }),
      ]);
    } finally { clearTimeout(dnsTimer); }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: ac.signal,
        method,
        // Only ever set for a source whose search endpoint takes a POST —
        // rooster.jobs wants its query in a JSON body. The SSRF guard above
        // does not care about the verb, and the allowlist still decides
        // which hosts can be reached at all, so this widens the shape of a
        // request without widening where it can go.
        ...(body === undefined ? {} : { body }),
        headers: {
          "User-Agent": UA,
          Accept: accept || "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
      });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    timer.unref();
    try {

      if (res.status === 429 || res.status === 403) {
        log.warn("source blocked us", { status: res.status, host: url.hostname });
        await res.body?.cancel();
        const err = new BlockedBySource(res.status, url.hostname);
        if (linkedin) {
          try { err.retryAt = await linkedinCooldown.block(res.headers.get("retry-after")); }
          catch (persistError) {
            log.error("could not persist LinkedIn cooldown; requests paused locally", { message: persistError.message });
            throw err;
          }
          err.message += `; paused until ${new Date(err.retryAt).toISOString()}`;
        }
        throw err;
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel();
        if (!loc) throw new Error(`Redirect with no Location (${res.status})`);
        url = assertAllowed(new URL(loc, url).toString(), allowHosts); // revalidate the hop
        // A redirected POST is not replayed. Browsers turn 301/302 into a
        // GET and 307/308 keep the method, and guessing wrong either loses
        // the query or repeats a write. No source here needs it, so refuse
        // rather than invent a rule.
        if (method !== "GET") {
          throw new Error(`${url.hostname} redirected a ${method}; not replaying it`);
        }
        continue;
      }

      if (!res.ok) throw new Error(`${url.hostname} returned ${res.status}`);

      const len = Number(res.headers.get("content-length") || 0);
      if (len > MAX_BYTES) throw new Error(`Response too large (${len} bytes)`);

      // res.text() always decodes as UTF-8 in Node, whatever the response
      // declares. topjobs serves iso-8859-1, so every en-dash and accented
      // character came back as "?" — "Intern ? Human Resources Operations".
      // A source that knows its own encoding can say so.
      const chunks = [];
      let bytes = 0;
      for await (const chunk of res.body || []) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { ac.abort(); throw new Error("Response too large"); }
        chunks.push(chunk);
      }
      const buf = Buffer.concat(chunks);
      if (buf.length > MAX_BYTES) throw new Error("Response too large");
      const text = new TextDecoder(charset || "utf-8").decode(buf);
      if (probe) await linkedinCooldown.recovered();
      return text;
    } finally { clearTimeout(timer); }
  }

  throw new Error("Too many redirects");
}
