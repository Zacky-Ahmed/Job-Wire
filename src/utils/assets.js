// assets.js
//
// Cache-busting for CSS and JS.
//
// Static files are served with a long max-age, which is right for speed
// and wrong for deploys: a browser holding app.css for an hour shows the
// previous design after a release, and the bug looks like "the CSS did
// not apply" rather than "you are looking at yesterday's file".
//
// So every asset URL carries ?v=<hash of its contents>. The hash changes
// only when the file changes, so caching still works — it just cannot
// serve a stale version.

import fs from "fs";
import path from "path";
import crypto from "crypto";

const hashes = new Map();

function hashFile(publicDir, urlPath) {
  const file = path.join(publicDir, urlPath);
  try {
    const buf = fs.readFileSync(file);
    return crypto.createHash("sha1").update(buf).digest("hex").slice(0, 8);
  } catch {
    return null; // missing file: fall through to the bare path
  }
}

/**
 * Builds res.locals.asset(), used as asset("/css/app.css") in templates.
 * Hashes are computed once at boot in production and per request in
 * development, so editing a file is visible on refresh without a restart.
 */
export function assets(publicDir, { cache = true } = {}) {
  return function assetsMiddleware(req, res, next) {
    res.locals.asset = (urlPath) => {
      if (!cache) {
        const h = hashFile(publicDir, urlPath);
        return h ? `${urlPath}?v=${h}` : urlPath;
      }
      if (!hashes.has(urlPath)) hashes.set(urlPath, hashFile(publicDir, urlPath));
      const h = hashes.get(urlPath);
      return h ? `${urlPath}?v=${h}` : urlPath;
    };
    next();
  };
}
