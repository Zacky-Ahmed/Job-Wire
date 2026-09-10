// render.js
//
// Two-step render so pages stay whole files instead of being split
// across head/foot partials: render the page to a string, then hand it
// to a layout as `body`.

export function page(res, view, locals = {}, layout = "layouts/app") {
  // Two renders per page, so they are marked separately: "the admin page is
  // slow" has a different answer depending on whether the body or the
  // surrounding shell is the expensive half.
  const t = res.locals.t;
  res.render(view, locals, (err, body) => {
    if (err) return res.req.next(err);
    if (t) t.mark("render-body");
    res.render(layout, { ...locals, body }, (err2, html) => {
      if (err2) return res.req.next(err2);
      if (t) t.mark("render-shell");
      res.type("text/html").send(html);
    });
  });
}

export const authPage = (res, view, locals) =>
  page(res, view, locals, "layouts/auth");
