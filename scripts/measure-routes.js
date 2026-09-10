// measure-routes.js
//
//   npm run measure-routes
//
// Where a workspace page actually spends its time, read off the
// Server-Timing header the app now emits.
//
// This exists because "the admin page feels slow" has at least four
// different answers — Mongo, the shaping loops, EJS, or the fact that a
// hard navigation throws away a perfectly good shell and rebuilds it —
// and they have completely different fixes. Guessing between them is how
// you rewrite a frontend and then discover the database was the problem.
//
// Needs a signed-in admin account and a server on :3000. It reads pages
// only; it changes nothing.
//
// NOTE ON ABSOLUTE NUMBERS: run from a developer machine these include
// the round trip to Atlas, which is not the same as the deployed app's.
// The SHAPE is what transfers — how many sequential round trips a page
// makes, and how little of the time is rendering.

const BASE = "http://localhost:3000";
const jar = new Map();
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const store = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const [p] = c.split(";"); const i = p.indexOf("="); jar.set(p.slice(0, i), p.slice(i + 1)); } };
const get = async (path) => { const r = await fetch(BASE + path, { headers: { cookie: cookie() }, redirect: "manual" }); store(r); return r; };

// sign in
let r = await get("/signin");
let html = await r.text();
const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
r = await fetch(BASE + "/signin", {
  method: "POST", redirect: "manual",
  headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ _csrf: csrf, email: "ui-audit@example.invalid", password: "uiauditpassword" }),
});
store(r);
if (r.status !== 302) { console.error("sign-in failed", r.status); process.exit(1); }

const parse = (h) => Object.fromEntries((h || "").split(",").map((s) => {
  const m = s.trim().match(/^([^;]+);dur=([\d.]+)$/); return m ? [m[1], Number(m[2])] : null;
}).filter(Boolean));

const pct = (xs, q) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * q))]; };

const RUNS = 12;
for (const path of ["/wire", "/watches", "/admin"]) {
  const totals = [], bytes = [], stages = new Map();
  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    const res = await get(path);
    const body = await res.text();
    const wall = Date.now() - t0;
    const st = parse(res.headers.get("server-timing"));
    totals.push(st.total ?? wall);
    bytes.push(body.length);
    for (const [k, v] of Object.entries(st)) {
      if (k === "total") continue;
      if (!stages.has(k)) stages.set(k, []);
      stages.get(k).push(v);
    }
  }
  console.log(`\n=== ${path} ===  ${RUNS} samples, ${Math.round(bytes[0]/1024)}KB of HTML`);
  console.log(`  server total   p50 ${pct(totals,0.5).toFixed(0)}ms   p95 ${pct(totals,0.95).toFixed(0)}ms`);
  const rows = [...stages].map(([k, v]) => [k, pct(v, 0.5), pct(v, 0.95)]).sort((a, b) => b[1] - a[1]);
  for (const [k, p50, p95] of rows) {
    if (p50 < 0.5 && p95 < 2) continue;
    console.log(`    ${k.padEnd(18)} p50 ${p50.toFixed(1).padStart(7)}ms   p95 ${p95.toFixed(1).padStart(7)}ms`);
  }
}
process.exit(0);
