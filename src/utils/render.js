// render.js
//
// Two-step render so pages stay whole files instead of being split
// across head/foot partials: render the page to a string, then hand it
// to a layout as `body`.

/**
 * Is this request an in-app navigation asking for just the middle?
 *
 * htmx stamps HX-Target with the id of the element it is about to
 * replace, so this is not a guess about intent — it is the request
 * saying which part of the page it has room for. Anything else, including
 * a first visit, a reload, a crawler, or a browser with script off, is
 * unmarked and gets the whole document.
 *
 * A history restore is deliberately excluded. htmx sends HX-Request on
 * those too, but it needs the FULL page back so it can find the history
 * element inside it; answering with a fragment leaves the back button
 * restoring nothing.
 */
function wantsMainOnly(req) {
  return req.get("hx-request") === "true"
    && req.get("hx-target") === "workspaceMain"
    && req.get("hx-history-restore-request") !== "true";
}

export function page(res, view, locals = {}, layout = "layouts/app") {
  // Two renders per page, so they are marked separately: "the admin page is
  // slow" has a different answer depending on whether the body or the
  // surrounding shell is the expensive half.
  const t = res.locals.t;
  const req = res.req;
  const shell = layout === "layouts/app" && wantsMainOnly(req)
    ? "layouts/workspace-main"
    : layout;

  res.render(view, locals, (err, body) => {
    if (err) return res.req.next(err);
    if (t) t.mark("render-body");
    res.render(shell, { ...locals, body }, (err2, html) => {
      if (err2) return res.req.next(err2);
      if (t) t.mark("render-shell");
      /* Two URLs, one for the shell and one for the middle, would be
         cached as the same entry by anything in front of this. Vary says
         they are different answers to the same address. */
      res.vary("HX-Request");
      res.vary("HX-Target");
      res.type("text/html").send(html);
    });
  });
}

export const authPage = (res, view, locals) =>
  page(res, view, locals, "layouts/auth");
