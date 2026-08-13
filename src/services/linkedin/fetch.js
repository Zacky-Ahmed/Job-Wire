// fetch.js
//
// The only place this app makes an outbound HTTP request.
//
// SSRF: the UI lets a user paste a LinkedIn search URL, and this server
// then fetches it. Without an allowlist a user pastes
//   http://169.254.169.254/latest/meta-data/iam/security-credentials/
// and the server happily fetches cloud metadata on their behalf, or
// reaches anything else inside the private network. So:
//
//   · https only
//   · host must be linkedin.com or a subdomain — exact suffix match,
//     not includes(), or "linkedin.com.evil.tld" passes
//   · redirects followed manually, revalidating the host at every hop
//   · resolved IP checked against private ranges (DNS rebinding)
//
// Politeness is the other half: jitter, a real user agent, and hard
// backoff on 429/403 so one blocked response does not become a ban.

import dns from "dns/promises";
import net from "net";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";

const ALLOWED_SUFFIX = ".linkedin.com";
const ALLOWED_EXACT = new Set(["linkedin.com", "www.linkedin.com"]);
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15000;
const MAX_BYTES = 3 * 1024 * 1024; // a search page is ~200KB; anything huge is wrong

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class BlockedByLinkedIn extends Error {
  constructor(status) {
    super(`LinkedIn returned ${status}`);
    this.name = "BlockedByLinkedIn";
    this.status = status;
  }
}

/** Throws unless the URL is an https LinkedIn URL. */
export function assertLinkedInUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error("Only https URLs are allowed");
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_EXACT.has(host) && !host.endsWith(ALLOWED_SUFFIX)) {
    throw new Error(`Only linkedin.com URLs are allowed (got ${host})`);
  }
  if (u.username || u.password) throw new Error("Credentials in URL are not allowed");
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

/** Guards against a hostname that passes the allowlist but resolves inward. */
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
 * Fetch a LinkedIn page as text. Never follows a redirect off LinkedIn.
 * Throws BlockedByLinkedIn on 429/403 so the caller can back off.
 */
export async function fetchLinkedIn(rawUrl, { jitter = true } = {}) {
  let url = assertLinkedInUrl(rawUrl);

  // Random delay so the cadence does not look like a metronome.
  if (jitter && env.fetchJitterMs > 0) {
    await sleep(Math.floor(Math.random() * env.fetchJitterMs));
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: "manual", // we validate each hop ourselves
        signal: ac.signal,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 || res.status === 403) {
      log.warn("linkedin blocked us", { status: res.status, host: url.hostname });
      throw new BlockedByLinkedIn(res.status);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect with no Location (${res.status})`);
      url = assertLinkedInUrl(new URL(loc, url).toString()); // revalidate the hop
      continue;
    }

    if (!res.ok) throw new Error(`LinkedIn returned ${res.status}`);

    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BYTES) throw new Error(`Response too large (${len} bytes)`);

    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("Response too large");
    return text;
  }

  throw new Error("Too many redirects");
}
