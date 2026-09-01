// e2e.js
//
// Drives the SIGNED-IN pages against a running server.
// Start the server first, then:  npm run e2e
//
// Seeds a pre-verified user directly in Mongo
// so the run does not depend on reading a real inbox.
const { connectDb, collections, closeDb } = await import("../src/config/db.js");
const pw = await import("../src/services/auth/password.js");
const { canonicalKey } = await import("../src/services/linkedin/buildUrl.js");

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
// A user with no watches is not waiting for the wire to catch something —
// nothing is being swept at all, and the old copy told them to wait for an
// event that could never arrive.
ok(html.includes("No watches yet"), "empty wire tells a watchless user the truth");
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
// Scoped to THIS test's search. Counting every query in the database
// asserted that nobody else exists — it passed only while this developer
// was the sole user, and broke the moment a real second account created a
// watch for another country. Same family of mistake as the cleanup that
// once ran deleteMany({}).
const qCount = await collections.queries()
  .countDocuments({ keywordsKey: canonicalKey(["intern"], ["linkedin"]), geoId: "100446352" });
ok(qCount === 1, `identical searches share ONE query row (found ${qCount})`);

console.log("\n── toggle + delete ──");
html = await (await get("/watches")).text();
token = csrf(html);
const id = html.match(/action="\/watches\/([a-f0-9]{24})\/toggle"/)?.[1];
ok(!!id, "watch id present in the row");
await post(`/watches/${id}/toggle`, { _csrf: token });
html = await (await get("/watches")).text();
ok(html.includes("Resume"), "hold flips the control to Resume");
const deletedQueryId = (await collections.subscriptions().findOne({ _id: new (await import("mongodb")).ObjectId(id) }))?.queryId;
await post(`/watches/${id}/delete`, { _csrf: token });
html = await (await get("/watches")).text();
ok(html.includes("No watches"), "delete removes it");

// A shared query with no subscribers left must stop sweeping. One was
// found in production doing the opposite: zero subscribers, swept to 110
// tracked jobs, spending requests for an audience of nobody.
if (deletedQueryId) {
  const q = await collections.queries().findOne({ _id: deletedQueryId });
  const stillSubscribed = await collections.subscriptions().countDocuments({ queryId: deletedQueryId });
  ok(stillSubscribed > 0 || q?.nextFetchAt == null,
    "abandoned query stops sweeping once nobody watches it");
  const due = await collections.queries()
    .countDocuments({ _id: deletedQueryId, nextFetchAt: { $lte: new Date(), $type: "date" } });
  ok(stillSubscribed > 0 || due === 0,
    "a parked query is not matched by the due scan (null is not < now)");
}

console.log("\n── catch-everything watch ──");
// Keywords can only ever match a job TITLE. Employers routinely tag a job
// "Internship" while titling it "Real Estate Sales Agent" — it shows in a
// logged-in search for "intern" and no title filter can reach it. So this
// mode must be creatable with no keywords at all; that is its whole point.
//
// Runs last, on the empty list the delete above leaves behind, so it does
// not perturb the single-watch assumptions the earlier assertions make.
token = csrf(html);
r = await post("/watches", { _csrf: token, label: "Everything SL", matchAll: "on", geoId: "100446352", every: "5" });
html = await r.text();
ok(html.includes("Everything SL"), "keywordless watch accepted when matchAll is on");
const allQ = await collections.queries().findOne({ matchAll: true });
ok(!!allQ, "matchAll persisted on the query row");
ok(!!allQ && /@@all$/.test(allQ.keywordsKey),
  "matchAll owns a distinct key — it must never share a row with the keyword watch");

console.log("\n── one account never sees another account’s data ──");
// Query rows are SHARED. Reading one unscoped handed a new account the
// whole history of a search other people had been running for weeks, and
// the "emails sent" figure was the whole instance’s, so an empty inbox
// was greeted by other people’s send count.
const other = await collections.users().insertOne({
  email: `e2e-other-${Date.now()}@example.invalid`,
  passHash: await pw.hash(PASS), verified: true, verifiedAt: new Date(), createdAt: new Date(),
});
await collections.emailLog().insertOne({
  userId: other.insertedId, queryId: null, jobIds: ["linkedin:e2e-not-yours"],
  status: "sent", attempts: 0, sentAt: new Date(),
});
const EmailLog2 = await import("../src/models/emailLog.js");
const mine = await EmailLog2.countTodayForUser((await collections.users().findOne({ email: EMAIL }))._id);
const everyone = await EmailLog2.countToday();
ok(everyone > mine, `the shared total (${everyone}) is not shown as this user’s count (${mine})`);
html = await (await get("/wire")).text();
ok(html.includes(">Your alerts<"), "the alerts card is labelled as the reader’s own");
await collections.emailLog().deleteMany({ userId: other.insertedId });
await collections.users().deleteOne({ _id: other.insertedId });

console.log("\n── a local board cannot be attached to a foreign country ──");
// topjobs and Keells only cover Sri Lanka. The form hides them once you
// pick elsewhere, but a hidden checkbox is not a rule — a hand-written
// POST must not be able to bolt a Sri Lankan board onto a German watch
// and leave it sweeping forever for a country it cannot serve.
html = await (await get("/watches?new=1")).text();
token = csrf(html);
r = await post("/watches", { _csrf: token, label: "Germany probe", keywords: "intern",
  geoId: "101282230", every: "5", sources: ["topjobs", "keells"] });
await r.text();
const gq = await collections.queries().findOne({ geoId: "101282230" });
ok(!!gq, "the German watch was created");
ok(!!gq && !gq.sources.includes("topjobs") && !gq.sources.includes("keells"),
  `Sri Lanka-only boards stripped from a German watch (got ${gq ? gq.sources.join()  : "?"})`);
ok(!!gq && gq.sources.includes("linkedin"),
  "it falls back to a source that actually covers that country");

console.log("\n── a held watch stops costing anything ──");
// Deleting the last watch already parked its query. Pausing the last one
// did not, so a held watch went on spending a full sweep — every page of
// every source, plus a detail request per new job — to fan out to nobody.
html = await (await get("/watches")).text();
token = csrf(html);
const heldId = html.match(/action="\/watches\/([a-f0-9]{24})\/toggle"/)?.[1];
if (heldId) {
  const heldQ = (await collections.subscriptions()
    .findOne({ _id: new (await import("mongodb")).ObjectId(heldId) }))?.queryId;
  await post(`/watches/${heldId}/toggle`, { _csrf: token });
  const others = await collections.subscriptions()
    .countDocuments({ queryId: heldQ, active: true });
  const q1 = await collections.queries().findOne({ _id: heldQ });
  ok(others > 0 || q1?.nextFetchAt == null,
    "pausing the last active watch parks its query");
  await post(`/watches/${heldId}/toggle`, { _csrf: token });
  const q2 = await collections.queries().findOne({ _id: heldQ });
  ok(q2?.nextFetchAt != null, "resuming it starts the query again");
}

console.log("\n── one account cannot touch another’s watch ──");
// Scoping the dashboard is the easy half. The hole that actually gets
// exploited is the object id: guess a watch id and pause or delete
// someone else’s. Every mutating watch route must filter on userId as
// well as _id, not just _id.
const victimUser = await collections.users().insertOne({
  email: `e2e-victim-${Date.now()}@example.invalid`,
  passHash: await pw.hash(PASS), verified: true, verifiedAt: new Date(), createdAt: new Date(),
});
const victimQ = await collections.queries().findOne({});
const victimSub = await collections.subscriptions().insertOne({
  userId: victimUser.insertedId, queryId: victimQ._id,
  label: "not yours", active: true, createdAt: new Date(),
});
const vid = String(victimSub.insertedId);

html = await (await get("/watches")).text();
token = csrf(html);
ok(!html.includes("not yours"), "another account’s watch is not listed");

await post(`/watches/${vid}/toggle`, { _csrf: token });
let still = await collections.subscriptions().findOne({ _id: victimSub.insertedId });
ok(still && still.active === true, "cannot pause a watch belonging to someone else");

await post(`/watches/${vid}/delete`, { _csrf: token });
still = await collections.subscriptions().findOne({ _id: victimSub.insertedId });
ok(!!still, "cannot delete a watch belonging to someone else");

await collections.subscriptions().deleteOne({ _id: victimSub.insertedId });
await collections.users().deleteOne({ _id: victimUser.insertedId });

console.log("\n── admin actions refuse a non-admin ──");
// The page is hidden from non-admins, but hiding a page is not access
// control — every mutating route has to refuse on its own. A guard that
// only exists on the GET is the classic way admin panels get abused.
const victim = await collections.users().findOne({ email: EMAIL });
const anyQuery = await collections.queries().findOne({});
const attacks = [
  ["verify another account", `/admin/users/${victim._id}/verify`],
  ["delete another account", `/admin/users/${victim._id}/delete`],
  ["park a query",           `/admin/queries/${anyQuery._id}/toggle`],
  ["force a sweep",          `/admin/queries/${anyQuery._id}/sweep`],
  ["delete a query",         `/admin/queries/${anyQuery._id}/delete`],
  ["remove somebody's watch", `/admin/watches/${anyQuery._id}/delete`],
  ["merge two searches",      `/admin/queries/${anyQuery._id}/merge`],
];
html = await (await get("/wire")).text();
token = csrf(html);
let refused = 0;
for (const [what, path] of attacks) {
  const res = await post(path, { _csrf: token });
  if (res.status === 404) refused++;
  else ok(false, `${what} was NOT refused (got ${res.status})`);
}
ok(refused === attacks.length, `all ${attacks.length} admin actions refuse a non-admin`);

// and the refusal must not have done the thing anyway
const stillThere = await collections.users().findOne({ email: EMAIL });
ok(!!stillThere, "the refused delete did not delete anything");

console.log("\n── admin stays hidden from ordinary accounts ──");
// This account is not in ADMIN_EMAILS. 404 rather than 403 is deliberate:
// "forbidden" confirms to a stranger that an admin area lives at this URL.
r = await get("/admin");
ok(r.status === 404, `a normal signed-in user gets 404 from /admin (got ${r.status})`);
html = await r.text();
ok(!html.includes("@example.invalid") && !html.includes("Queries"),
  "the admin 404 leaks no account or query data");
html = await (await get("/wire")).text();
ok(html.indexOf('href="/admin"') === -1, "no Admin tab is drawn for a non-admin");

console.log("\n── sign out ──");
await post("/signout", { _csrf: csrf(html) });
r = await get("/wire");
ok(r.status === 302, "signed out user is bounced from /wire");

// Runs after sign-out on purpose: /signin and /forgot both redirect an
// authenticated visitor to /wire, so every assertion here would have been
// checking the wire page instead of the one it names.
console.log("\n── forgotten password ──");
// Only the paths that send no mail. Driving the happy path from here
// would fire a real message at an @example.invalid recipient on every
// run, and bouncing mail off a reserved domain is a poor way to treat a
// sender reputation this project has already had to repair once.
html = await (await get("/signin")).text();
ok(html.includes('href="/forgot"'), "the sign-in page offers a way out");

html = await (await get("/forgot")).text();
ok(html.includes("Forgotten password"), "the reset page renders");
r = await post("/forgot", { _csrf: csrf(html), email: "no-such-account@example.invalid" });
html = await r.text();
// Never "no account with that email": that turns this form into a
// membership oracle, and helps a mistyped address not at all.
ok(/If that address has an account/.test(html),
  "an unknown address is not told it is unknown");
ok(!/no account|not found|does not exist/i.test(html), "no wording leaks account existence");
const strays = await collections.users().countDocuments({ email: "no-such-account@example.invalid" });
ok(strays === 0, "asking about an unknown address creates nothing");

// A reset code is meaningless without the session that requested it,
// so a stolen or guessed code cannot be aimed at another account.
r = await post("/reset", { _csrf: csrf(html), email: EMAIL,
  d1: "1", d2: "2", d3: "3", d4: "4", d5: "5", d6: "6",
  password: "attackerpassword", password2: "attackerpassword" });
ok(/not valid/.test(await r.text()), "a reset with no pending request is refused");
const untouched = await collections.users().findOne({ email: EMAIL });
ok(await pw.verify(PASS, untouched.passHash), "and the password is unchanged");


// One search, however it is spelled.
//
// Every one of these used to create a separate query row issuing an
// identical fetch, and sweeps run one at a time — so each duplicate put
// another two minutes in front of everybody else's watch.
const { keywords: kwClean } = await import("../src/utils/sanitize.js");
const kwA = kwClean("Intern, intern , INTERN");
ok(kwA.length === 1, `"Intern, intern, INTERN" is one keyword (got ${kwA.length})`);
ok(kwClean("full  stack")[0] === "full stack", "a double space is not a second keyword");
ok(canonicalKey(["b", "A"]) === canonicalKey(["a", "B"]),
  "order and case do not change the key");

const QMod = await import("../src/models/queries.js");
ok(QMod.identityOf({ keywords: ["Intern"], geoId: "x" }) ===
   QMod.identityOf({ keywords: ["intern "], geoId: "x" }),
  "identityOf ignores case and padding");
ok(QMod.identityOf({ keywords: ["a"], geoId: "x", matchAll: true }) ===
   QMod.identityOf({ keywords: ["z"], geoId: "x", matchAll: true }),
  "two match-all searches in one country are the same search");
ok(QMod.identityOf({ keywords: ["a"], geoId: "x" }) !==
   QMod.identityOf({ keywords: ["a"], geoId: "y" }),
  "the same words in another country are not");

// A watch created under a legacy key must JOIN the modern row, not sit
// beside it. This is the case that produced three copies of "intern".
const legacyGeo = "e2e-legacy";
const legacy = await collections.queries().insertOne({
  keywordsKey: "intern@@linkedin", keywords: ["intern"], geoId: legacyGeo,
  matchAll: false, createdAt: new Date(), nextFetchAt: new Date(), everyMinutes: 5,
});
const joined = await QMod.upsert({
  keywordsKey: canonicalKey(["intern"]), keywords: ["intern"], geoId: legacyGeo,
  location: "E2E", everyMinutes: 5, sources: ["linkedin"], matchAll: false,
});
ok(String(joined._id) === String(legacy.insertedId),
  "a new watch joins the legacy row instead of splitting the search");
const legacyCount = await collections.queries().countDocuments({ geoId: legacyGeo });
ok(legacyCount === 1, `and no second row was created (found ${legacyCount})`);
await collections.queries().deleteMany({ geoId: legacyGeo });



// A sweep that finishes AFTER its query is retired must not revive it.
//
// syncSchedule parks a search by setting nextFetchAt to null, but a sweep
// already in flight lands in reschedule() afterwards. That used to re-arm
// the row unconditionally, so a search with zero subscribers went back into
// the rotation and swept for ever — it happened in production on
// 2026-09-01 and cost a third of the cycle.
const Queries = await import("../src/models/queries.js");
const ghost = await collections.queries().insertOne({
  keywordsKey: `e2e-ghost-${Date.now()}`, keywords: ["ghost"], geoId: "e2e",
  matchAll: false, createdAt: new Date(), nextFetchAt: null, retiredAt: new Date(),
});
await Queries.reschedule(ghost.insertedId, { everyMinutes: 5, tracked: 7 });
const afterGhost = await collections.queries().findOne({ _id: ghost.insertedId });
ok(afterGhost.nextFetchAt === null, "a retired query is not revived by a late sweep");
ok(afterGhost.trackedCount === 7, "but its last result is still recorded");

const alive = await collections.queries().insertOne({
  keywordsKey: `e2e-alive-${Date.now()}`, keywords: ["alive"], geoId: "e2e",
  matchAll: false, createdAt: new Date(), nextFetchAt: new Date(0),
});
await Queries.reschedule(alive.insertedId, { everyMinutes: 5, tracked: 3 });
const afterAlive = await collections.queries().findOne({ _id: alive.insertedId });
ok(afterAlive.nextFetchAt > new Date(), "a live query is still rescheduled");
await collections.queries().deleteMany({ _id: { $in: [ghost.insertedId, alive.insertedId] } });


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
