import fs from "node:fs";

/* One listener per event, each with its own from:body.

   "a, b from:body" applies the modifier to b alone — a is listened for
   on the element itself, which only fires when the mutation happened to
   originate inside that panel. That is why parking a query refreshed
   Queries but not Overview: the event bubbled through one and never
   reached the other. */
const panels = {
  overview: ["admin:peopleChanged", "admin:queriesChanged", "admin:deliveryChanged"],
  health:   ["admin:pollerChanged", "admin:queriesChanged"],
  delivery: ["admin:deliveryChanged"],
  people:   ["admin:peopleChanged"],
  queries:  ["admin:queriesChanged", "admin:peopleChanged"],
};

for (const [name, events] of Object.entries(panels)) {
  const p = "src/views/partials/admin/" + name + ".ejs";
  let s = fs.readFileSync(p, "utf8");
  const m = s.match(/  hx-trigger="[^"]*"/);
  if (!m) { console.error("MISS " + name); process.exit(1); }
  const trig = '  hx-trigger="' + events.map((e) => e + " from:body").join(", ") + '"';
  fs.writeFileSync(p, s.replace(m[0], trig));
  console.log(name, "->", events.join(", "));
}

// Narrow what each mutation claims to have changed.
const P = "admin:peopleChanged", Q = "admin:queriesChanged",
      D = "admin:deliveryChanged", L = "admin:pollerChanged";
const routes = {
  "/admin/users/:id/verify":     [P],
  "/admin/users/:id/delete":     [P, Q],
  "/admin/queries/:id/toggle":   [Q, L],
  "/admin/queries/:id/sweep":    [L, D],
  "/admin/queries/:id/delete":   [Q],
  "/admin/watches/:id/delete":   [Q],
  "/admin/queries/:id/merge":    [Q],
  "/admin/queries/:id/watchers": [Q],
  "/admin/watches/:id/pack":     [Q],
};

const rp = "src/routes/admin.routes.js";
let s = fs.readFileSync(rp, "utf8");
let n = 0;
for (const [route, events] of Object.entries(routes)) {
  const a = s.indexOf('adminRoutes.post("' + route + '"');
  if (a < 0) { console.error("MISS route " + route); process.exit(1); }
  const b = s.indexOf("\n});\n", a);
  let body = s.slice(a, b);
  const want = "[" + events.map((e) => JSON.stringify(e)).join(", ") + "]";
  const before = body;
  body = body.replace(/answer\(req, res, (`[^`]*`|"[^"]*"), \[[^\]]*\]\)/g,
    (_m, url) => "answer(req, res, " + url + ", " + want + ")");
  if (body === before) { console.error("NO CHANGE " + route); process.exit(1); }
  n += (body.match(/answer\(req, res,/g) || []).length;
  s = s.slice(0, a) + body + s.slice(b);
}
fs.writeFileSync(rp, s);
console.log("retargeted", n, "answers");
