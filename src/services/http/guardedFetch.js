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
import { log } from "../../utils/logger.js";

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
 * @param {object}   opts        { jitter, accept }
 */
export async function guardedFetch(rawUrl, allowHosts, { jitter = true, accept } = {}) {
  let url = assertAllowed(rawUrl, allowHosts);

  // Random delay so a schedule does not look like a metronome.
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
        redirect: "manual",
        signal: ac.signal,
        headers: {
          "User-Agent": UA,
          Accept: accept || "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 || res.status === 403) {
      log.warn("source blocked us", { status: res.status, host: url.hostname });
      throw new BlockedBySource(res.status, url.hostname);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect with no Location (${res.status})`);
      url = assertAllowed(new URL(loc, url).toString(), allowHosts); // revalidate the hop
      continue;
    }

    if (!res.ok) throw new Error(`${url.hostname} returned ${res.status}`);

    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BYTES) throw new Error(`Response too large (${len} bytes)`);

    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("Response too large");
    return text;
  }

  throw new Error("Too many redirects");
}
