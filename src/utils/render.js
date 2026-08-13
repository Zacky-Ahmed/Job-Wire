// render.js
//
// Two-step render so pages stay whole files instead of being split
// across head/foot partials: render the page to a string, then hand it
// to a layout as `body`.

export function page(res, view, locals = {}, layout = "layouts/app") {
  res.render(view, locals, (err, body) => {
    if (err) return res.req.next(err);
    res.render(layout, { ...locals, body }, (err2, html) => {
      if (err2) return res.req.next(err2);
      res.type("text/html").send(html);
    });
  });
}

export const authPage = (res, view, locals) =>
  page(res, view, locals, "layouts/auth");
