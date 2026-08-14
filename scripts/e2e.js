// e2e.js
//
// Drives the SIGNED-IN pages against a running server.
// Start the server first, then:  npm run e2e
//
// Seeds a pre-verified user directly in Mongo
// so the run does not depend on reading a real inbox.
const { connectDb, collections, closeDb } = await import("../src/config/db.js");
const pw = await import("../src/services/auth/password.js");

const BASE = "http://localhost:3000";
const EMAIL = `e2e-${Date.now()}@example.invalid`;
const PASS = "correcthorsebattery";
const jar = new Map();
const ok = (c, m) => console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);

const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
function store(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [p] = c.split(";"); const i = p.indexOf("=");
    jar.set(p.slice(0, i), p.slice(i + 1));
  }
}
async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts, headers: { cookie: cookie(), ...(opts.headers || {}) }, redirect: "manual",
  });
  store(res); return res;
}
const get = (p) => req(p);
const post = (p, fields) => req(p, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields),
});
const csrf = (h) => h.match(/name="_csrf" value="([^"]+)"/)?.[1] ?? "";

await connectDb();
await collections.users().insertOne({
  email: EMAIL, passHash: await pw.hash(PASS),
  verified: true, verifiedAt: new Date(), createdAt: new Date(),
});

console.log("\n── sign in ──");
let html = await (await get("/signin")).text();
let r = await post("/signin", { _csrf: csrf(html), email: EMAIL, password: PASS });
ok(r.status === 302 && r.headers.get("location") === "/wire", "verified user reaches /wire");

console.log("\n── the wire ──");
r = await get("/wire");
html = await r.text();
ok(r.status === 200, "GET /wire renders");
ok(html.includes("Nothing caught yet"), "empty state shown honestly");
ok(html.includes(EMAIL), "layout shows the signed-in address");

console.log("\n── watches ──");
r = await get("/watches");
html = await r.text();
ok(r.status === 200, `GET /watches renders (got ${r.status})`);
ok(html.includes("No watches"), "empty state");

r = await get("/watches?new=1");
html = await r.text();
ok(html.includes("New watch"), "new-watch dialog opens");
let token = csrf(html);

console.log("\n── create ──");
r = await post("/watches", { _csrf: token, label: "", keywords: "intern", geoId: "100446352", every: "5" });
ok((await r.text()).includes("Give it a name"), "empty label rejected");

r = await post("/watches", { _csrf: token, label: "Interns SL", keywords: "", geoId: "100446352", every: "5" });
ok((await r.text()).includes("At least one keyword"), "empty keywords rejected");

r = await post("/watches", { _csrf: token, label: "Hack", keywords: "intern", geoId: "999999999", every: "5" });
ok((await r.text()).includes("Pick a country"), "unknown geoId rejected");

r = await post("/watches", { _csrf: token, label: "Interns SL", keywords: "Intern", geoId: "100446352", every: "5" });
html = await r.text();
ok(html.includes("Interns SL"), "watch created and listed");
ok(html.includes("first sweep only memorises") || html.includes("memorises"), "priming explained");
// f_TPR and geoId used to be printed on the row. They are internal details
// a user has no reason to see, and one of them was wrong for weeks without
// anyone noticing. Assert what the row should actually say instead.
ok(/checked every \d+ min/.test(html), "row states the check interval in plain words");
ok(!/f_TPR|geoId/.test(html), "no scraping internals leak into the UI");
ok(/LinkedIn/.test(html), "row shows which source it watches");

console.log("\n── shared query + duplicates ──");
r = await post("/watches", { _csrf: token, label: "Same thing", keywords: " intern ", geoId: "100446352", every: "9" });
ok((await r.text()).includes("already watch this exact query"), "duplicate rejected (canonical key)");
const qCount = await collections.queries().countDocuments();
ok(qCount === 1, `identical searches share ONE query row (found ${qCount})`);

console.log("\n── toggle + delete ──");
html = await (await get("/watches")).text();
token = csrf(html);
const id = html.match(/action="\/watches\/([a-f0-9]{24})\/toggle"/)?.[1];
ok(!!id, "watch id present in the row");
await post(`/watches/${id}/toggle`, { _csrf: token });
html = await (await get("/watches")).text();
ok(html.includes("Resume"), "hold flips the control to Resume");
await post(`/watches/${id}/delete`, { _csrf: token });
html = await (await get("/watches")).text();
ok(html.includes("No watches"), "delete removes it");

console.log("\n── sign out ──");
await post("/signout", { _csrf: csrf(html) });
r = await get("/wire");
ok(r.status === 302, "signed out user is bounced from /wire");

// cleanup
//
// Scoped to THIS run's account only. Two earlier versions were wrong:
// a bare deleteMany({}) wiped the real user's watches, and matching
// /^e2e-/ deleted the accounts of any run happening concurrently — which
// showed up as a second run failing every authenticated assertion with
// a 302, because its user vanished mid-test.
const testUsers = await collections.users().find({ email: EMAIL })
  .project({ _id: 1 }).toArray();
const testIds = testUsers.map((u) => u._id);
const testSubs = await collections.subscriptions()
  .find({ userId: { $in: testIds } }).project({ queryId: 1 }).toArray();
await collections.subscriptions().deleteMany({ userId: { $in: testIds } });
await collections.users().deleteMany({ _id: { $in: testIds } });
// Only remove a query if no OTHER subscription still points at it.
for (const q of new Set(testSubs.map((s) => String(s.queryId)))) {
  const stillUsed = await collections.subscriptions().countDocuments({ queryId: testSubs.find((x) => String(x.queryId) === q).queryId });
  if (!stillUsed) {
    const qid = testSubs.find((x) => String(x.queryId) === q).queryId;
    await collections.seenJobs().deleteMany({ queryId: qid });
    await collections.queries().deleteOne({ _id: qid });
  }
}
await closeDb();
console.log("\ncleaned up test data");
