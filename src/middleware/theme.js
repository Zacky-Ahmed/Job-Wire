// theme.js
//
// The theme is resolved on the SERVER from a cookie and rendered into
// <html data-theme="...">.
//
// Doing it in client JS meant the page painted in the default theme and
// then snapped to the chosen one — a visible flash on every single
// navigation. The usual fix is a tiny inline script in <head>, but our
// CSP is script-src 'self', so inline scripts are blocked. A cookie is
// read before the first byte is written, so there is nothing to flash.
//
// Default is LIGHT, deliberately, and prefers-color-scheme is ignored
// once a choice exists. Following the OS meant a user on a dark laptop
// got dark every visit no matter what they picked.

const COOKIE = "jw.theme";

export function theme(req, res, next) {
  const raw = req.headers.cookie || "";
  const match = raw.match(/(?:^|;\s*)jw\.theme=(light|dark)/);
  res.locals.theme = match ? match[1] : "light";

  /* The collapsed sidebar rides along, for exactly the same reason.
     
     It was first written to localStorage and applied by a deferred
     script, which cannot work here: the rail is 216px wide and the
     content is padded to clear it, so the page painted full width and
     then jumped 140px sideways on every navigation. localStorage is not
     readable before the first byte; a cookie is. */
  res.locals.sidebarCollapsed = /(?:^|;\s*)jw\.sidebar=1/.test(raw);
  next();
}

export const THEME_COOKIE = COOKIE;
