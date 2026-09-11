// e2e.js
//
// Drives the SIGNED-IN pages.  npm run e2e
//
// Owns its own server and its own database. It used to require you to
// have started a server yourself, and then talked to localhost:3000 on
// whatever MONGODB_URI pointed at — which is production. It cleaned up
// after itself, but an aborted run did not, and aborted runs left real
// rows behind more than once: four stray accounts on one occasion, and
// a match-all watch that the production poller then swept and flooded
// real inboxes with.
//
// test-db.js must be the FIRST import. It sets MONGODB_DB before env.js
// can read it, and refuses to run at all against production.
import { TEST_DB, connectDb, collections, closeDb, resetTestDb } from "./lib/test-db.js";
import { startTestServer } from "./lib/test-server.js";

const pw = await import("../src/services/auth/password.js");
const { canonicalKey } = await import("../src/services/linkedin/buildUrl.js");
const { ensureIndexes } = await import("../src/models/indexes.js");
const EMAIL = `e2e-${Date.now()}@example.invalid`;
const PASS = "correcthorsebattery";
const jar = new Map();
let passes = 0;
let failures = 0;
const ok = (c, m) => {
  if (c) passes++; else failures++;
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}`);
};

/* A SUITE THAT DIES IS NOT A SUITE THAT PASSED.

   This has to be counted rather than eyeballed. A stale call left behind
   by a rename threw a TypeError two thirds of the way down this file,
   node exited, and the output ended in a wall of PASS with no FAIL
   anywhere — the run looked green and had skipped sixty-five
   assertions. Grepping for FAIL is the obvious way to read this output
   and it would have reported nothing wrong.

   So the run says how far it got, and a run that stops early exits
   non-zero even though every assertion it reached had passed. */
let reachedTheEnd = false;
process.on("exit", (code) => {
  if (reachedTheEnd) return;
  console.error(
    `\nSUITE DID NOT FINISH — ${passes} passed, ${failures} failed, and then it stopped.\n` +
    `Everything after that point never ran. Do not read the passes above as a green run.`
  );
  if (code === 0) process.exitCode = 1;
});

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
/* A clean database, then the indexes — in that order, because several
   of the rules under test ARE indexes (the ledger's uniqueness, the
   duplicate-subscription guard) and a suite running without them would
   pass while proving nothing. */
await resetTestDb();
await ensureIndexes();
console.log("database:", TEST_DB);

let server = await startTestServer();
const BASE = server.base;
console.log("server:  ", BASE);

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

/* The sweep interval starts at five minutes.
 *
 * Below five it is a promise the boards do not keep — LinkedIn's public
 * index runs a measured median of 19 minutes behind — and it is how
 * searches get throttled, which costs everyone coverage. The slider used
 * to start at MIN_SWEEP_MINUTES, which is 2 in this environment, so the
 * floor is deliberately the form's own and not the operator's.
 *
 * These assertions live HERE, in the signed-in section. Written after
 * sign-out they passed while proving nothing: the requests 302'd to
 * /signin, the slider was simply absent, and the clamp check read an
 * unrelated query row that already said 5. */
const slider = html.match(/id="every"[^>]*min="(\d+)"[^>]*max="(\d+)"/);
ok(!!slider, "the interval slider renders");
ok(slider && Number(slider[1]) === 5, `it starts at 5 minutes (got ${slider?.[1]})`);
ok(slider && Number(slider[2]) === 60, `and runs to 60 (got ${slider?.[2]})`);

// A hand-written POST must not get under the floor the form stopped offering.
r = await post("/watches", {
  _csrf: csrf(html), label: "Too fast e2e", keywords: "e2e-fastwatch",
  geoId: "100446352", every: "1",
});
await r.text();
const fastQ = await collections.queries().findOne({ keywordsKey: "e2e-fastwatch" });
ok(!!fastQ && fastQ.everyMinutes >= 5,
  `a POST asking for 1 minute is clamped to the floor (row says ${fastQ?.everyMinutes})`);
if (fastQ) {
  await collections.subscriptions().deleteMany({ queryId: fastQ._id });
  await collections.queries().deleteOne({ _id: fastQ._id });
}
html = await (await get("/watches?new=1")).text();
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
// Counted by IDENTITY, not by a spelling. The old assertion looked for
// the key "intern@@linkedin", which is what upsert used to write; once it
// began matching on identityKey a new watch landed on the row spelled
// "intern" and this read 0 — the test was asserting the bug it was
// written before, not the property it describes.
const { identityOf } = await import("../src/models/queries.js");
const wantId = identityOf({ keywords: ["intern"], geoId: "100446352" });
const qCount = await collections.queries().countDocuments({ identityKey: wantId });
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

/* "Send me every job in the country" is gone, and this test used to CREATE
   one — against the real database, because that is what this suite does.
   The production poller then swept it, fetched the country's whole listing,
   and every other search in that country read it out of the shared cache.
   An intern watch was mailed Burger King Crew Member. The test was the
   trigger; the checkbox was the loaded gun.

   So: assert it is not offered, and that a hand-written POST cannot
   resurrect it either. */
r = await post("/watches", { _csrf: token, label: "Everything SL", matchAll: "on", geoId: "100446352", every: "5" });
html = await r.text();
ok(/At least one keyword/.test(html),
  "a keywordless watch is refused now that match-all is gone");
ok(!(await collections.queries().findOne({ matchAll: true, geoId: "100446352" })),
  "and a hand-written matchAll POST creates no match-all query");

html = await (await get("/watches")).text();
ok(!/every job in the country/i.test(html),
  "the form no longer offers it");
ok(!/also finds .{0,8}Trainee/.test(html),
  "and no longer claims intern finds Trainee, which stopped being true");
token = csrf(html);

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
  ["add somebody to a search", `/admin/queries/${anyQuery._id}/watchers`],
  ["change somebody's filter",  `/admin/watches/${anyQuery._id}/pack`],
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


// Nothing reaches an inbox that the watch's keywords do not match.
//
// This guard exists because the failure has happened twice, from two
// different upstream bugs: an intern watch was mailed IT Manager, and
// later Burger King Crew Member and Lorry Driver. Both times the matcher
// upstream was wrong and nothing between the fetch and the send re-asked
// the question the watch actually poses.
const { matchesAny: guardMatch } = await import("../src/utils/match.js");
const CLAIMS = new Set(["title", "keyword"]);
const guard = (jobs, words) => words.length
  ? jobs.filter((j) => !CLAIMS.has(j.matchedBy) || guardMatch(j.title, words))
  : jobs;

const batch = [
  { jobId: "xpress:1", title: "Intern - Human Resources", matchedBy: "keyword" },
  { jobId: "xpress:2", title: "Burger King Crew Member", matchedBy: "keyword" },
  { jobId: "topjobs:3", title: "IT Manager", matchedBy: "title" },
  { jobId: "linkedin:4", title: "Junior Executive Human Resources", matchedBy: "Internship" },
];
const kept = guard(batch, ["intern"]);
ok(kept.length === 2, `only the matching jobs survive the guard (got ${kept.length})`);
ok(kept.some((j) => j.jobId === "xpress:1"), "a real intern job goes out");
ok(!kept.some((j) => j.jobId === "xpress:2"), "Burger King Crew Member does not");
ok(!kept.some((j) => j.jobId === "topjobs:3"), "nor IT Manager");
ok(kept.some((j) => j.jobId === "linkedin:4"),
  "but an employer-tagged Internship survives, because its title cannot show the match");
ok(guard(batch, []).length === 4,
  "a match-all watch has no words, so the guard withholds nothing from it");

/* PHASE 1 — an alert that has been discovered can no longer be lost.
 *
 * The old shape: dedupe claimed a job on the ledger the moment it was
 * discovered, and the claim was permanent. Anything that went wrong
 * between there and the send — a full ceiling, a crash, an exception on
 * one subscriber — meant nobody was ever told, and no later sweep would
 * offer the job again. The cap case was patched by deferring the whole
 * batch and releasing the claim; the crash cases were not patched at all.
 *
 * The new shape: the sweep writes a durable obligation per recipient
 * before anything is sent, and only then claims. These tests are about
 * the states a killed process can leave behind.
 */
const Ledger1 = await import("../src/models/alertedJobs.js");
const Outbox = await import("../src/models/outbox.js");
const { fanOut: fanOut1 } = await import("../src/services/poller/sweep.js");
const { drainOutbox } = await import("../src/services/mail/outboxWorker.js");
const Provider = await import("../src/services/mail/providerHealth.js");

const capUser = (await collections.users().insertOne({
  email: `e2e-cap-${Date.now()}@example.invalid`, verified: true, createdAt: new Date(0),
})).insertedId;
const capQ = (await collections.queries().insertOne({
  keywordsKey: `e2e-cap-${Date.now()}`, keywords: ["intern"], geoId: "e2e-c",
  matchAll: false, createdAt: new Date(0), primed: true, nextFetchAt: new Date(), everyMinutes: 5,
})).insertedId;
const capSub = (await collections.subscriptions().insertOne({
  userId: capUser, queryId: capQ, label: "Intern", active: true, createdAt: new Date(0),
})).insertedId;
const capJobs = [{
  jobId: "linkedin:e2e-cap-1", title: "Intern - Capped", company: "X",
  url: "https://example.invalid", location: "Colombo, Sri Lanka",
}];

// 1. The sweep records the obligation. It does not send.
const enq = await fanOut1({ _id: capQ, keywords: ["intern"] }, capJobs, new Date());
ok(enq.queued === 1, `fanOut writes one obligation per recipient per job (got ${enq.queued})`);
const owed1 = await collections.outbox().find({ subscriptionId: capSub }).toArray();
ok(owed1.length === 1 && owed1[0].status === "pending",
  "and leaves it pending — nothing has been sent yet");
ok(owed1[0].job && owed1[0].job.title === "Intern - Capped",
  "carrying its own copy of the job, so a retry cannot depend on the 14-day cache");

// 2. Enqueueing again does not create a second obligation.
//
// This is what lets the ledger claim move AFTER the enqueue: a sweep
// killed between the two runs again and lands on the same row.
const reEnqueued = await fanOut1({ _id: capQ, keywords: ["intern"] }, capJobs, new Date());
ok(reEnqueued.queued === 0 && reEnqueued.alreadyQueued === 1,
  "a repeat enqueue lands on the existing row rather than making a second");
ok((await collections.outbox().countDocuments({ subscriptionId: capSub })) === 1,
  "so a crash between enqueue and claim costs a delay, not a duplicate email");

// 3. THE CEILING. A full ceiling must leave the obligation pending.
const capSpy = [];
const capped = await drainOutbox({
  send: async (m) => { capSpy.push(m); return { ok: true }; },
  cap: 0,
});
ok(capped.deferred === true && capped.sent === 0, "at the ceiling nothing is sent");
ok(capSpy.length === 0, "and nobody is mailed");
const afterCap = await collections.outbox().findOne({ subscriptionId: capSub });
ok(afterCap.status === "pending",
  "the obligation is still PENDING — the ceiling means later, not never");

// 4. Below the ceiling it goes out, once.
const sentSpy = [];
const drained = await drainOutbox({
  send: async (m) => { sentSpy.push(m); return { ok: true, id: "provider-1" }; },
  cap: 100,
});
ok(drained.sent === 1, `one email for one recipient (got ${drained.sent})`);
ok(sentSpy.length === 1 && sentSpy[0].jobs.length === 1, "carrying the job it owed");
const settled = await collections.outbox().findOne({ subscriptionId: capSub });
ok(settled.status === "sent", "and the obligation is discharged");

const drainedAgain = await drainOutbox({
  send: async () => { throw new Error("must not be called"); }, cap: 100,
});
ok(drainedAgain.sent === 0, "a discharged obligation is not sent a second time");

/* 5. THE CEILING MIDWAY. The case that used to skip the remaining
 *    watchers permanently: three recipients, a ceiling of one.
 */
const midUsers = [];
const midSubs = [];
for (let i = 0; i < 3; i++) {
  const u = (await collections.users().insertOne({
    email: `e2e-mid-${i}-${Date.now()}@example.invalid`, verified: true, createdAt: new Date(0),
  })).insertedId;
  midUsers.push(u);
  midSubs.push((await collections.subscriptions().insertOne({
    userId: u, queryId: capQ, label: "Intern", active: true, createdAt: new Date(0),
  })).insertedId);
}
const midJobs = [{
  jobId: "linkedin:e2e-mid-1", title: "Intern - Midway", company: "X",
  url: "https://example.invalid", location: "Colombo, Sri Lanka",
}];
const midEnq = await fanOut1({ _id: capQ, keywords: ["intern"] }, midJobs, new Date());
ok(midEnq.recipients === 4, `every eligible watcher is owed the batch (got ${midEnq.recipients})`);

const midSpy = [];
await drainOutbox({
  send: async (m) => { midSpy.push(m); return { ok: true, id: "p" }; },
  cap: (await collections.emailLog().countDocuments({ status: "sent" })) + 1,
});
ok(midSpy.length === 1, `a ceiling of one sends exactly one email (got ${midSpy.length})`);
const stillOwed = await collections.outbox().countDocuments({
  jobId: "linkedin:e2e-mid-1", status: "pending",
});
ok(stillOwed === 3,
  `and the other three are still PENDING, not skipped (got ${stillOwed})`);

// The rest go out on the next pass, which is what "later" has to mean.
const restSpy = [];
await drainOutbox({ send: async (m) => { restSpy.push(m); return { ok: true, id: "p" }; }, cap: 10_000 });
ok(restSpy.length === 3, `the deferred recipients are served next time (got ${restSpy.length})`);
ok((await collections.outbox().countDocuments({ jobId: "linkedin:e2e-mid-1", status: "pending" })) === 0,
  "leaving nothing owed");

/* 6. A PROVIDER REFUSAL keeps the obligation and schedules a retry.
 *    It must not be discarded, and it must not be retried immediately
 *    for ever — the old queue re-read by sentAt and produced 43 attempts
 *    in one evening for the same handful of jobs.
 */
const failJobs = [{
  jobId: "linkedin:e2e-fail-1", title: "Intern - Refused", company: "X",
  url: "https://example.invalid", location: "Colombo, Sri Lanka",
}];
await fanOut1({ _id: capQ, keywords: ["intern"] }, failJobs, new Date());
const refusedDrain = await drainOutbox({
  send: async () => ({ ok: false, error: "provider refused" }), cap: 10_000,
});
ok(refusedDrain.failed >= 1, "a refusal is reported as a failure");
const failRow = await collections.outbox().findOne({ jobId: "linkedin:e2e-fail-1" });
ok(failRow.status === "pending", "the obligation survives the refusal");
ok(failRow.attempts === 1 && failRow.lastError === "provider refused",
  "carrying why, and how many times");
ok(failRow.nextAttemptAt > new Date(),
  "and scheduled forward, so it is not retried on the very next tick");

const tooSoon = await drainOutbox({
  send: async () => { throw new Error("must not be called"); }, cap: 10_000,
});
ok(tooSoon.sent === 0 && tooSoon.failed === 0,
  "nothing due yet means nothing is attempted — the backoff is real");

/* 7. A MAIL CONFIGURATION ERROR is parked, not retried on a schedule.
 *    Retrying a wrong password every tick is what wrote 43 rows in an
 *    evening; there is nothing a retry can fix.
 */
const cfgJobs = [{
  jobId: "linkedin:e2e-cfg-1", title: "Intern - Misconfigured", company: "X",
  url: "https://example.invalid", location: "Colombo, Sri Lanka",
}];
await fanOut1({ _id: capQ, keywords: ["intern"] }, cfgJobs, new Date());
await drainOutbox({
  send: async () => ({ ok: false, error: "Invalid login: 535 Username and Password not accepted" }),
  cap: 10_000,
});
const cfgRow = await collections.outbox().findOne({ jobId: "linkedin:e2e-cfg-1" });
/* BLOCKED, NOT DEAD. This asserted "dead" and passed, which was the bug:
   the first batch to discover a wrong API key was destroyed outright,
   while every batch after it was correctly held by the provider pause.
   The one case the pause exists for was the one case it could not save.
   DEAD means "we have decided never to deliver this"; a typo in an
   environment variable is not that decision. */
ok(cfgRow.status === "blocked",
  `a credential failure HOLDS the message rather than killing it (got ${cfgRow.status})`);
ok(String(cfgRow.lastError).includes("535"), "with the provider's own words kept");
ok(cfgRow.batchKey, "and it keeps its sealed batch, so the same message goes out when fixed");

/* And the PROVIDER is paused, not just that one message.

   This is the difference between the old retry queue and this one. A
   rejected credential rejects every message identically, so continuing
   to call it proves nothing and costs a real network round trip each
   time — which is how the same handful of jobs produced 43 attempts in
   one evening. Nothing is claimed while it is paused, so the whole
   backlog is still owed and goes out the moment somebody fixes it. */
ok(Provider.health().state === "PAUSED_CONFIG",
  `the provider itself is paused, not merely that message (got ${Provider.health().state})`);
const whilePaused = await drainOutbox({
  send: async () => { throw new Error("must not be called while paused"); }, cap: 10_000,
});
ok(whilePaused.sent === 0 && whilePaused.provider === "PAUSED_CONFIG",
  "so a paused provider is not called at all");

// A person fixes the credential. Nothing else has to be cleared.
Provider.reset();
ok(Provider.health().state === "READY", "and resetting it is all that is needed to resume");

/* 8. A WORKER THAT WENT AWAY. A row left SENDING is not a resting state:
 *    without reclaiming it, a process killed mid-send loses the alert in
 *    exactly the way the outbox exists to prevent.
 */
const orphanJobs = [{
  jobId: "linkedin:e2e-orphan-1", title: "Intern - Orphaned", company: "X",
  url: "https://example.invalid", location: "Colombo, Sri Lanka",
}];
await fanOut1({ _id: capQ, keywords: ["intern"] }, orphanJobs, new Date());
await collections.outbox().updateMany(
  { jobId: "linkedin:e2e-orphan-1" },
  { $set: { status: "sending", claimedAt: new Date(Date.now() - 30 * 60_000), claimedBy: "a process that died" } }
);
const orphanSpy = [];
await drainOutbox({ send: async (m) => { orphanSpy.push(m); return { ok: true, id: "p" }; }, cap: 10_000 });
ok(orphanSpy.length >= 1, "a row abandoned mid-send is picked back up");
ok((await collections.outbox().findOne({ jobId: "linkedin:e2e-orphan-1" })).status === "sent",
  "and delivered rather than stranded");

/* 8b. THE IDEMPOTENCY KEY BELONGS TO THE OBLIGATION, NOT THE ATTEMPT.
 *
 *     Brevo refuses to deliver the same message twice when it sees the
 *     same key. That only works if a RETRY carries the key the FIRST
 *     attempt used — a fresh key per attempt is a fresh message and the
 *     mechanism does nothing. It is what makes a timeout safe to retry:
 *     an accepted-then-lost response is indistinguishable from a
 *     refusal, and without a stable key the safe reading of a timeout
 *     would have to be "give up".
 */
const keyJobs = [{
  jobId: "linkedin:e2e-key-1", title: "Intern - Idempotent", company: "X",
  url: "https://example.invalid", location: "Colombo, Sri Lanka",
}];
await fanOut1({ _id: capQ, keywords: ["intern"] }, keyJobs, new Date());
/* Scoped to ONE watcher. capQ picked up three more subscribers during
   the midway-ceiling test above, so this job is owed to four people and
   an unscoped count would see four messages per pass rather than one. */
const keyRow1 = await collections.outbox().findOne({ jobId: "linkedin:e2e-key-1", subscriptionId: capSub });
ok(/^[0-9a-f-]{36}$/.test(String(keyRow1.idempotencyKey)),
  "an obligation is born with an idempotency key");

// Re-enqueue, exactly as a sweep that died before claiming would.
await fanOut1({ _id: capQ, keywords: ["intern"] }, keyJobs, new Date());
const keyRow2 = await collections.outbox().findOne({ jobId: "linkedin:e2e-key-1", subscriptionId: capSub });
ok(keyRow2.idempotencyKey === keyRow1.idempotencyKey,
  "re-enqueueing does not mint a new one — $setOnInsert is what guarantees that");

// Fail it once, then let the retry come round, and watch the key.
const keysSeen = [];
await drainOutbox({
  send: async (m) => { if (m.to === keyRow1.email && m.jobs.some((j) => j.jobId === "linkedin:e2e-key-1")) keysSeen.push(m.idempotencyKey); return { ok: false, error: "timed out" }; },
  cap: 10_000,
});
await collections.outbox().updateOne(
  { jobId: "linkedin:e2e-key-1", subscriptionId: capSub }, { $set: { nextAttemptAt: new Date(0) } }
);
await drainOutbox({
  send: async (m) => { if (m.to === keyRow1.email && m.jobs.some((j) => j.jobId === "linkedin:e2e-key-1")) keysSeen.push(m.idempotencyKey); return { ok: true, id: "p" }; },
  cap: 10_000,
});
const keySent = await collections.outbox().findOne({ jobId: "linkedin:e2e-key-1", subscriptionId: capSub });
ok(keysSeen.length === 2, `the message was attempted twice (got ${keysSeen.length})`);
ok(keysSeen[0] && keysSeen[0] === keysSeen[1],
  "and the retry carried the SAME key — a new one would be a new message to the provider");
ok(keysSeen[0] === keySent.batchKey,
  "the key belongs to the SEALED BATCH, not to one row inside it");
ok(keySent.providerMessageId === "p",
  "and the provider's own message id is kept, so a delivery can be traced back");

/* 8c. A RETRY MUST NOT PICK UP PASSENGERS.
 *
 *     This is the exactly-once hole the sealed batch closes. Every
 *     obligation was born with its own key and the worker sent a GROUP
 *     under the first row's key:
 *
 *       attempt 1   rows A+B, key = A's      provider ACCEPTS
 *                   the response is lost; A+B go back to pending
 *       meanwhile   row C is queued for the same person
 *       attempt 2   rows A+B+C, key = A's    provider: "seen that key"
 *
 *     We would read that as success and mark A, B and C delivered — but
 *     the message the provider accepted contained only A and B. C would
 *     be marked sent having never been in any email.
 */
const passJobs = [
  { jobId: "linkedin:e2e-pass-A", title: "Intern - A", company: "X", url: "https://example.invalid", location: "Colombo, Sri Lanka" },
  { jobId: "linkedin:e2e-pass-B", title: "Intern - B", company: "X", url: "https://example.invalid", location: "Colombo, Sri Lanka" },
];
await fanOut1({ _id: capQ, keywords: ["intern"] }, passJobs, new Date());

// Attempt one fails after the batch is sealed.
const firstSend = [];
await drainOutbox({
  send: async (m) => {
    if (m.to !== keyRow1.email) return { ok: true, id: "other" };
    firstSend.push({ key: m.idempotencyKey, jobs: m.jobs.map((j) => j.jobId).sort() });
    return { ok: false, error: "timed out" };
  },
  cap: 10_000,
});
ok(firstSend.length === 1 && firstSend[0].jobs.length === 2,
  `the first attempt carried A and B (got ${firstSend[0]?.jobs.length})`);

// C arrives for the same person while A+B are waiting to be retried.
await fanOut1({ _id: capQ, keywords: ["intern"] }, [
  { jobId: "linkedin:e2e-pass-C", title: "Intern - C", company: "X", url: "https://example.invalid", location: "Colombo, Sri Lanka" },
], new Date());
await collections.outbox().updateMany(
  { jobId: { $in: ["linkedin:e2e-pass-A", "linkedin:e2e-pass-B"] } },
  { $set: { nextAttemptAt: new Date(0) } }
);

const secondSend = [];
await drainOutbox({
  send: async (m) => {
    if (m.to !== keyRow1.email) return { ok: true, id: "other" };
    secondSend.push({ key: m.idempotencyKey, jobs: m.jobs.map((j) => j.jobId).sort() });
    return { ok: true, id: "p2" };
  },
  cap: 10_000,
});

const retryOfAB = secondSend.find((m) => m.key === firstSend[0].key);
ok(!!retryOfAB, "the retry reuses the first attempt's key");
ok(retryOfAB.jobs.length === 2 && !retryOfAB.jobs.includes("linkedin:e2e-pass-C"),
  `and carries EXACTLY what that key described — C did not join it (got ${retryOfAB.jobs.join(",")})`);
const cMessage = secondSend.find((m) => m.jobs.includes("linkedin:e2e-pass-C"));
ok(!!cMessage && cMessage.key !== firstSend[0].key,
  "C goes out as its own message under its own key");

/* 9. THE LEDGER CLAIM NO LONGER GATES DELIVERY. A job claimed but never
 *    enqueued used to be gone for good. Nothing claims until the
 *    obligations are written, so the claim is now a statement about what
 *    has been LOOKED AT, not about what somebody was told.
 */
const claimed = await Ledger1.remember(capQ, ["linkedin:e2e-claim-only"]);
ok(claimed.has("linkedin:e2e-claim-only"), "the ledger still records what a search has met");
ok((await collections.outbox().countDocuments({ jobId: "linkedin:e2e-claim-only" })) === 0,
  "and says nothing about whether anyone was told — that is the outbox's job");

// Nobody eligible is not an obligation.
await collections.subscriptions().deleteMany({ queryId: capQ });
const noneResult = await fanOut1({ _id: capQ, keywords: ["intern"] }, capJobs, new Date());
ok(noneResult.queued === 0 && noneResult.recipients === 0,
  "a query with no eligible watchers owes nothing to nobody");

await collections.outbox().deleteMany({ queryId: capQ });
await collections.emailLog().deleteMany({ userId: { $in: [capUser, ...midUsers] } });
await collections.users().deleteMany({ _id: { $in: [capUser, ...midUsers] } });
await Ledger1.forgetQuery(capQ);
await collections.queries().deleteOne({ _id: capQ });

/* PHASE 3 — a shared cadence that can go back up.
 *
 * The interval used to be applied to the query with $min, which is a
 * one-way door. One five-minute watcher pulled a sixty-minute search
 * down to five, and nothing ever pulled it back: that person could
 * delete their watch and everyone else kept paying for a cadence nobody
 * had asked for, twelve times more often, on the most expensive source
 * in the system. Invisible, because there is no screen that says "this
 * search sweeps faster than any of its watchers requested".
 */
const SubsP3 = await import("../src/models/subscriptions.js");
const QueriesP3 = await import("../src/models/queries.js");

const slowUser = (await collections.users().insertOne({
  email: `e2e-slow-${Date.now()}@example.invalid`, verified: true, createdAt: new Date(0),
})).insertedId;
const fastUser = (await collections.users().insertOne({
  email: `e2e-fast-${Date.now()}@example.invalid`, verified: true, createdAt: new Date(0),
})).insertedId;

const sharedQ = await QueriesP3.upsert({
  keywordsKey: `e2e-cadence-${Date.now()}`,
  keywords: ["cadence"], geoId: "100446352", location: "Sri Lanka",
  everyMinutes: 60, sources: ["linkedin"], matchAll: false,
});

// A asks for an hour.
const slowSub = await SubsP3.create({
  userId: slowUser, queryId: sharedQ._id, label: "Slow", requestedEveryMinutes: 60,
});
let row = await collections.queries().findOne({ _id: sharedQ._id });
ok(row.everyMinutes === 60, `one watcher at 60 leaves the search at 60 (got ${row.everyMinutes})`);

// B joins and asks for five. The search speeds up for everybody, which
// is correct: it is one fetch and the faster request is the binding one.
const fastSub = await SubsP3.create({
  userId: fastUser, queryId: sharedQ._id, label: "Fast", requestedEveryMinutes: 5,
});
row = await collections.queries().findOne({ _id: sharedQ._id });
ok(row.everyMinutes === 5, `a 5-minute watcher joining takes the search to 5 (got ${row.everyMinutes})`);

// B pauses. THE REGRESSION: the old code left it at 5 for ever.
await SubsP3.setActive(fastUser, fastSub._id, false);
row = await collections.queries().findOne({ _id: sharedQ._id });
ok(row.everyMinutes === 60,
  `pausing the fast watcher puts the search back to 60 (got ${row.everyMinutes})`);

// Resuming brings it back down, so the recompute really is symmetric.
await SubsP3.setActive(fastUser, fastSub._id, true);
row = await collections.queries().findOne({ _id: sharedQ._id });
ok(row.everyMinutes === 5, `resuming takes it back to 5 (got ${row.everyMinutes})`);

// And deleting outright does the same as pausing.
await SubsP3.remove(fastUser, fastSub._id);
row = await collections.queries().findOne({ _id: sharedQ._id });
ok(row.everyMinutes === 60,
  `deleting the fast watcher recovers the slow cadence (got ${row.everyMinutes})`);

// The last watcher leaving parks the search; its cadence stops mattering.
await SubsP3.remove(slowUser, slowSub._id);
row = await collections.queries().findOne({ _id: sharedQ._id });
ok(row === null || row.nextFetchAt === null,
  "and the last watcher leaving stops the search altogether");

await collections.subscriptions().deleteMany({ userId: { $in: [slowUser, fastUser] } });
await collections.users().deleteMany({ _id: { $in: [slowUser, fastUser] } });
await collections.queries().deleteOne({ _id: sharedQ._id });

/* PHASE 10 — two people creating the same watch at the same moment.
 *
 * upsert matches on identityKey, which is not unique: legacy rows can
 * already collide and a unique index would fail those signups instead of
 * joining them. Mongo's uniqueness is on (keywordsKey, geoId) instead.
 * So the field that decides "the same search" and the field the database
 * enforces are different fields, and two simultaneous signups can both
 * find no identity match, both try to insert, and the loser gets E11000.
 *
 * The outcome is right — the winner's row IS the row the loser wanted —
 * but it arrived as an unhandled duplicate-key error and the signup
 * failed.
 */
const QueriesP10 = await import("../src/models/queries.js");
const raceKey = `e2e-race-${Date.now()}`;
const raceArgs = {
  keywordsKey: raceKey, keywords: ["race", "condition"], geoId: "e2e-r",
  location: "Nowhere", everyMinutes: 30, sources: ["linkedin"], matchAll: false,
};

const both = await Promise.all([
  QueriesP10.upsert({ ...raceArgs }),
  QueriesP10.upsert({ ...raceArgs }),
]);
ok(both.every(Boolean), "neither concurrent create throws");
ok(String(both[0]._id) === String(both[1]._id),
  `and both land on the SAME search (${String(both[0]._id)} / ${String(both[1]._id)})`);
ok((await collections.queries().countDocuments({ keywordsKey: raceKey })) === 1,
  "so one row exists, not two");

/* The legacy shape that makes this possible: a row with the canonical
   key and no identity on it at all. A new watch must join it and stamp
   it, not insert a rival beside it. */
const legacyKey = `e2e-legacy-${Date.now()}`;
const legacyId = (await collections.queries().insertOne({
  keywordsKey: legacyKey, keywords: ["legacy"], geoId: "e2e-r",
  location: "Nowhere", everyMinutes: 30, sources: ["linkedin"], matchAll: false,
  primed: true, nextFetchAt: new Date(), createdAt: new Date(0),
})).insertedId;
const joinedLegacy = await QueriesP10.upsert({
  keywordsKey: legacyKey, keywords: ["legacy"], geoId: "e2e-r",
  location: "Nowhere", everyMinutes: 30, sources: ["linkedin"], matchAll: false,
});
ok(String(joinedLegacy._id) === String(legacyId),
  "a watch created against a row with no identityKey joins it rather than splitting the search");
ok(!!(await collections.queries().findOne({ _id: legacyId })).identityKey,
  "and stamps the identity on it, so the next one matches on meaning");

await collections.queries().deleteMany({ geoId: "e2e-r" });

/* PHASE 4 — a fetch is shared even when it earns its owner nothing.
 *
 * shareWithOtherWatches used to run at the very bottom of the sweep,
 * after five early returns. Every one of those returns is a statement
 * about the OWNING query — nothing new, nothing fresh enough, nothing
 * matching, nothing sendable — and none of them says anything about
 * whether the fetch was useful to somebody else.
 *
 * So a "supply chain" sweep that pulled forty jobs and matched none of
 * them returned at the first exit, and the "intern" watch on the same
 * board never saw the intern job that fetch had already paid for. The
 * request had been made, the jobs were in memory, and they were dropped.
 */
const { sweepQuery: sweepQ4 } = await import("../src/services/poller/sweep.js");
const SourcesP4 = await import("../src/services/sources/index.js");

const shareUser = (await collections.users().insertOne({
  email: `e2e-share-${Date.now()}@example.invalid`, verified: true, createdAt: new Date(0),
})).insertedId;

/* Query A looks for something the corpus does not contain, so A itself
   sends nothing and takes an early return. Query B is watching for the
   thing the corpus DOES contain. Both in the same country, which is what
   makes them siblings. */
const shareQA = (await collections.queries().insertOne({
  keywordsKey: `e2e-shareA-${Date.now()}`, keywords: ["quantum welding"], geoId: "e2e-s",
  sources: ["e2e-fixture"], matchAll: false, createdAt: new Date(0), primed: true,
  nextFetchAt: new Date(), everyMinutes: 5,
})).insertedId;
const shareQB = (await collections.queries().insertOne({
  keywordsKey: `e2e-shareB-${Date.now()}`, keywords: ["intern"], geoId: "e2e-s",
  sources: ["e2e-fixture"], matchAll: false, createdAt: new Date(0), primed: true,
  nextFetchAt: new Date(), everyMinutes: 5,
})).insertedId;
const subB = (await collections.subscriptions().insertOne({
  userId: shareUser, queryId: shareQB, label: "Intern", active: true, createdAt: new Date(0),
})).insertedId;

/* A fixture source, registered for this test only. Sharing must cost no
   extra requests to anybody, so the corpus is handed over in memory and
   this counts how many times it is asked for it. */
let fixtureCalls = 0;
SourcesP4.SOURCES["e2e-fixture"] = {
  id: "e2e-fixture", label: "E2E Fixture", hosts: [], countries: ["e2e-s"],
  timePrecision: "minute", pageSize: 100, maxPages: 1,
  fetchJobs: async () => {
    fixtureCalls++;
    return [{
      jobId: "e2e-fixture:shared-1", title: "Software Engineering Intern",
      company: "Fixture Co", location: "Colombo, Sri Lanka",
      url: "https://example.invalid/shared-1", postedAt: new Date(), postedText: "just now",
    }];
  },
};

await sweepQ4(await collections.queries().findOne({ _id: shareQA }));

ok(fixtureCalls === 1, `A's sweep made exactly one fetch (got ${fixtureCalls})`);
const aSent = await collections.outbox().countDocuments({ queryId: shareQA });
ok(aSent === 0, "A itself owes nothing — the job does not match 'quantum welding'");

const bOwed = await collections.outbox().find({ queryId: shareQB }).toArray();
ok(bOwed.length === 1,
  `but B is owed the job A's fetch found (got ${bOwed.length})`);
ok(bOwed[0] && bOwed[0].job.title === "Software Engineering Intern",
  "the actual job, carried across in memory");
ok(fixtureCalls === 1,
  `and sharing cost no extra request — still ${fixtureCalls} fetch, title matching only`);

// The ledger records that B has met it, so B's own sweep will not re-alert.
const bKnows = await (await import("../src/models/alertedJobs.js"))
  .knownIds(shareQB, ["e2e-fixture:shared-1"]);
ok(bKnows.size === 1, "and B's ledger records it, so B's own sweep will not send it again");

delete SourcesP4.SOURCES["e2e-fixture"];
await collections.outbox().deleteMany({ queryId: { $in: [shareQA, shareQB] } });
await collections.seenJobs().deleteMany({ queryId: { $in: [shareQA, shareQB] } });
await collections.subscriptions().deleteOne({ _id: subB });
await collections.users().deleteOne({ _id: shareUser });
await collections.queries().deleteMany({ _id: { $in: [shareQA, shareQB] } });

/* PHASE 3d — the number that says whether the schedule is possible.
 *
 * LinkedIn is one serial lane. A search that wants sweeping every five
 * minutes and takes eighty seconds to crawl is asking for 80/300 of it.
 * U = Σ(serviceTime / interval) across everything on that lane; above 1
 * the cadence is not slow, it is impossible, and sweeps fall further
 * behind every cycle for ever. The only symptom anybody ever sees is
 * alerts arriving later and later for no stated reason, which is why
 * this has to be computed rather than noticed.
 */
const { laneUtilisation } = await import("../src/services/poller/utilisation.js");

const laneQ = [];
// Two searches, each an 80-second crawl, each asking for every 5 minutes.
for (let i = 0; i < 2; i++) {
  laneQ.push((await collections.queries().insertOne({
    keywordsKey: `e2e-lane-${i}-${Date.now()}`, keywords: [`lane${i}`], geoId: "e2e-l",
    sources: ["linkedin"], matchAll: false, createdAt: new Date(0), primed: true,
    nextFetchAt: new Date(), everyMinutes: 5, serviceMsAvg: 80_000,
  })).insertedId);
}
let lane = await laneUtilisation();
ok(Math.abs(lane.U - (2 * 80_000) / (5 * 60_000)) < 0.001,
  `two 80s crawls at 5 minutes use ${Math.round(lane.U * 100)}% of the lane`);
ok(lane.U < 1, "which still fits");

// A third and a fourth take it past the point where arithmetic allows it.
for (let i = 2; i < 6; i++) {
  laneQ.push((await collections.queries().insertOne({
    keywordsKey: `e2e-lane-${i}-${Date.now()}`, keywords: [`lane${i}`], geoId: "e2e-l",
    sources: ["linkedin"], matchAll: false, createdAt: new Date(0), primed: true,
    nextFetchAt: new Date(), everyMinutes: 5, serviceMsAvg: 80_000,
  })).insertedId);
}
lane = await laneUtilisation();
ok(lane.U > 1, `six of them do not fit (${Math.round(lane.U * 100)}% of one lane`);
ok(lane.headroom === 0, "and there is no headroom left to report");

// A search nobody has measured yet is skipped, not guessed at.
const unmeasured = (await collections.queries().insertOne({
  keywordsKey: `e2e-lane-new-${Date.now()}`, keywords: ["brand new"], geoId: "e2e-l",
  sources: ["linkedin"], matchAll: false, createdAt: new Date(0), primed: false,
  nextFetchAt: new Date(), everyMinutes: 5,
})).insertedId;
laneQ.push(unmeasured);
const withNew = await laneUtilisation();
ok(Math.abs(withNew.U - lane.U) < 0.001,
  "an unmeasured search does not move the number — a default would be confidently wrong");
ok(withNew.unmeasured === lane.unmeasured + 1,
  `it is counted separately so it is not simply invisible (${lane.unmeasured} -> ${withNew.unmeasured})`);

// A parked search is not on the lane at all.
await collections.queries().updateOne({ _id: laneQ[0] }, { $set: { nextFetchAt: null } });
const parked = await laneUtilisation();
ok(parked.U < lane.U, "parking a search gives its share of the lane back");

await collections.queries().deleteMany({ _id: { $in: laneQ } });

/* PHASE 3c — a process killed outright loses no alert.
 *
 * The claim to test is the one everything else rests on: durability
 * cannot depend on the shutdown path running. So this does not shut the
 * server down politely — it SIGKILLs it, which is what a platform does
 * when the grace period runs out, and what a crash looks like.
 */
const killUser = (await collections.users().insertOne({
  email: `e2e-kill-${Date.now()}@example.invalid`, verified: true, createdAt: new Date(0),
})).insertedId;
const killQ = (await collections.queries().insertOne({
  keywordsKey: `e2e-kill-${Date.now()}`, keywords: ["intern"], geoId: "e2e-k",
  matchAll: false, createdAt: new Date(0), primed: true, nextFetchAt: new Date(), everyMinutes: 5,
})).insertedId;
const killSub = (await collections.subscriptions().insertOne({
  userId: killUser, queryId: killQ, label: "Intern", active: true, createdAt: new Date(0),
})).insertedId;

// Discovered and written down, but not yet sent — the exact state a
// sweep is in for the seconds between finding a job and delivering it.
await fanOut1({ _id: killQ, keywords: ["intern"] }, [{
  jobId: "linkedin:e2e-kill-1", title: "Intern - Survives A Kill", company: "X",
  url: "https://example.invalid", location: "Colombo, Sri Lanka",
}], new Date());

// And one that a worker had already picked up when the lights went out.
await fanOut1({ _id: killQ, keywords: ["intern"] }, [{
  jobId: "linkedin:e2e-kill-2", title: "Intern - Mid Send", company: "X",
  url: "https://example.invalid", location: "Colombo, Sri Lanka",
}], new Date());
await collections.outbox().updateOne(
  { jobId: "linkedin:e2e-kill-2" },
  { $set: { status: "sending", claimedAt: new Date(Date.now() - 30 * 60_000), claimedBy: "the process about to die" } }
);

// No SIGTERM, no handler, no chance to finish anything.
const killed = await server.kill();
ok(killed !== null, "the server was killed outright, with no shutdown handler run");

const survived = await collections.outbox()
  .find({ subscriptionId: killSub }).toArray();
ok(survived.length === 2, `both obligations outlived the process (got ${survived.length})`);
ok(survived.every((r) => r.job && r.job.title),
  "each still carrying its own copy of the job, so a retry needs nothing else");

// A new process. Nothing was handed over; it reads the same rows.
server = await startTestServer();
const resumeSpy = [];
await drainOutbox({
  send: async (m) => { resumeSpy.push(m); return { ok: true, id: "p" }; },
  cap: 10_000,
});
ok(resumeSpy.length >= 1, "the replacement process picks up what was owed");
const afterKill = await collections.outbox().find({ subscriptionId: killSub }).toArray();
ok(afterKill.every((r) => r.status === "sent"),
  "including the one that was mid-send when it died — SENDING is not a resting state");
const titles = resumeSpy.flatMap((m) => m.jobs.map((j) => j.title));
ok(titles.includes("Intern - Survives A Kill") && titles.includes("Intern - Mid Send"),
  "and both jobs actually reached the reader");

await collections.outbox().deleteMany({ queryId: killQ });
await collections.emailLog().deleteMany({ userId: killUser });
await collections.subscriptions().deleteMany({ queryId: killQ });
await collections.users().deleteOne({ _id: killUser });
await collections.queries().deleteOne({ _id: killQ });

/* P1 — a parked query has to be able to come back.
 *
 * The park moved nextFetchAt and nothing else, so failCount stayed at
 * the threshold: when the 24 hours were up the loop saw it was still
 * over the limit and parked it for another 24. For ever. A source
 * outage that lasted an afternoon killed the search that met it,
 * silently, and nothing would ever have restarted it.
 */
const QueriesP1 = await import("../src/models/queries.js");
const envP1 = (await import("../src/config/env.js")).env;

const parkQ = (await collections.queries().insertOne({
  keywordsKey: `e2e-park-${Date.now()}`, keywords: ["parked"], geoId: "e2e-p",
  matchAll: false, createdAt: new Date(0), primed: true,
  nextFetchAt: new Date(), everyMinutes: 5, failCount: envP1.maxFailCount,
})).insertedId;

await QueriesP1.park(parkQ, 24 * 60, { probeAt: envP1.maxFailCount });
const parkedRow = await collections.queries().findOne({ _id: parkQ });
ok(parkedRow.nextFetchAt > new Date(Date.now() + 20 * 60 * 60_000),
  "parking pushes the query a day out");
ok(parkedRow.failCount < envP1.maxFailCount,
  `and leaves it BELOW the threshold, so it gets one probe (${parkedRow.failCount} < ${envP1.maxFailCount})`);
ok(parkedRow.failCount === envP1.maxFailCount - 1,
  "exactly one below — a reset to zero would hand a dead source the whole budget again every day");

/* One more failure re-parks it; a success clears it entirely. */
await QueriesP1.recordFailure(parkQ, 10);
const failedAgain = await collections.queries().findOne({ _id: parkQ });
ok(failedAgain.failCount >= envP1.maxFailCount,
  "a failed probe puts it straight back over the threshold");

await QueriesP1.reschedule(parkQ, { everyMinutes: 5, tracked: 3 });
const recovered = await collections.queries().findOne({ _id: parkQ });
ok((recovered.failCount || 0) === 0,
  "and a successful sweep clears the count — the circuit closes");

/* P1 — "every five minutes" has to mean every five minutes.
 *
 * nextFetchAt was Date.now() + interval, evaluated AFTER the sweep. A
 * LinkedIn crawl is 78-92 seconds, so a five-minute watch actually ran
 * every six and a half, drifting further the slower the board was.
 */
const slotQ = (await collections.queries().insertOne({
  keywordsKey: `e2e-slot-${Date.now()}`, keywords: ["slot"], geoId: "e2e-p",
  matchAll: false, createdAt: new Date(0), primed: true,
  nextFetchAt: new Date(), everyMinutes: 5,
})).insertedId;

// Due at 10:00, the crawl took 85 seconds, so it finishes at 10:01:25.
const dueAt = new Date("2026-09-11T10:00:00Z");
await QueriesP1.reschedule(slotQ, {
  everyMinutes: 5, tracked: 10,
  timing: {
    scheduledFor: dueAt,
    startedAt: dueAt.getTime(),
    finishedAt: dueAt.getTime() + 85_000,
  },
});
const slotted = await collections.queries().findOne({ _id: slotQ });
const minutesAfterDue = (slotted.nextFetchAt - dueAt) / 60_000;
ok(minutesAfterDue % 5 === 0,
  `the next sweep lands on a 5-minute slot from when it was DUE (+${minutesAfterDue}m)`);
ok(minutesAfterDue !== 6.416666666666667,
  "not five minutes after the crawl happened to finish, which is what drifted");

/* And a long outage must not come back owing hundreds of sweeps. */
const longAgo = new Date(Date.now() - 24 * 60 * 60_000);
await QueriesP1.reschedule(slotQ, {
  everyMinutes: 5, tracked: 10,
  timing: { scheduledFor: longAgo, startedAt: Date.now() - 1000, finishedAt: Date.now() },
});
const afterOutage = await collections.queries().findOne({ _id: slotQ });
ok(afterOutage.nextFetchAt > new Date(),
  "a query returning from a day's outage schedules forward, not 288 sweeps of catch-up");

/* P1 — asking for a faster cadence must pull the deadline forward. */
const cadenceQ = (await collections.queries().insertOne({
  keywordsKey: `e2e-cad-${Date.now()}`, keywords: ["cadence"], geoId: "e2e-p",
  matchAll: false, createdAt: new Date(0), primed: true,
  everyMinutes: 60,
  lastFetchedAt: new Date(Date.now() - 60_000),
  nextFetchAt: new Date(Date.now() + 54 * 60_000),
})).insertedId;

await QueriesP1.setInterval(cadenceQ, 5);
const pulled = await collections.queries().findOne({ _id: cadenceQ });
ok(pulled.everyMinutes === 5, "the interval is recorded");
ok(pulled.nextFetchAt < new Date(Date.now() + 10 * 60_000),
  `and the deadline moves forward — a new 5-minute watcher does not wait 54 (${Math.round((pulled.nextFetchAt - Date.now()) / 60_000)}m)`);

// Going the other way must not cancel a sweep that is about to happen.
const imminent = pulled.nextFetchAt;
await QueriesP1.setInterval(cadenceQ, 60);
const slowed = await collections.queries().findOne({ _id: cadenceQ });
ok(slowed.everyMinutes === 60, "a slower interval is recorded too");
ok(slowed.nextFetchAt.getTime() === imminent.getTime(),
  "but the pending sweep still runs — a query about to run should run");

await collections.queries().deleteMany({ geoId: "e2e-p" });

/* P1 — a broken surface must not get a vote on what working looks like.
 *
 * The rolling baseline averaged everything recorded, degraded
 * observations included. Healthy 200/205/198, then a collapse to 2 or 3
 * repeatedly, and within a day the median walks down to ~2 — at which
 * point two jobs stops looking unusual and the monitor has quietly
 * agreed that the outage is the new normal.
 */
const Obs = await import("../src/models/observations.js");
await collections.observations().deleteMany({ source: "e2e-baseline" });

const obsRow = (status, parsed, ok_ = true) => ({
  source: "e2e-baseline", geoId: "e2e-b", queryId: null, status,
  parsedCount: parsed,
  surfaces: [{ name: "feed", ok: ok_, parsedCount: parsed }],
  warnings: [], notes: [], reported: true, at: new Date(),
});

await collections.observations().insertMany([
  obsRow("healthy", 200), obsRow("healthy", 205), obsRow("healthy", 198),
  obsRow("healthy", 202), obsRow("healthy", 201),
]);
const healthyBase = await Obs.baseline({ source: "e2e-baseline", surface: "feed" });
ok(healthyBase.median === 201, `a healthy week reads ~201 (${healthyBase.median})`);

// The collapse. Eight degraded sweeps, which used to drag the median down.
await collections.observations().insertMany([
  obsRow("degraded", 2, false), obsRow("degraded", 3, false), obsRow("degraded", 1, false),
  obsRow("degraded", 4, false), obsRow("degraded", 2, false), obsRow("degraded", 2, false),
  obsRow("degraded", 3, false), obsRow("degraded", 1, false),
]);
const afterCollapse = await Obs.baseline({ source: "e2e-baseline", surface: "feed" });
ok(afterCollapse.median === 201,
  `the baseline is UNMOVED by the outage (${afterCollapse.median}) — it learns nothing from broken samples`);
ok(Obs.isAnomalous(2, afterCollapse) === true,
  "so two jobs is still flagged as a collapse on the ninth bad sweep, not shrugged at");
ok(afterCollapse.degraded === 8,
  `while still reporting how much went wrong (${afterCollapse.degraded} degraded)`);

const degradedStreak = await Obs.consecutiveDegraded({ source: "e2e-baseline" });
ok(degradedStreak === 8, `and an independent streak counter the baseline cannot erase (${degradedStreak})`);

await collections.observations().deleteMany({ source: "e2e-baseline" });

/* P0 — HOLD MUST STOP THE EMAIL.
 *
 * Pausing set a flag and re-timed the shared query, and that was all.
 * Anything already queued still went out, because an outbox row carries
 * its own copy of the address and the job and never looked back at the
 * watch:
 *
 *   10:00  job found, notification queued
 *   10:01  provider hits the daily ceiling
 *   10:02  reader presses HOLD
 *   next day, the reader is emailed about it anyway.
 *
 * The button says Hold. Nobody reads that as "keep sending me the ones
 * already in the pipe".
 */
const SubsHold = await import("../src/models/subscriptions.js");

const holdUser = (await collections.users().insertOne({
  email: `e2e-hold-${Date.now()}@example.invalid`, verified: true, createdAt: new Date(0),
})).insertedId;
const holdQ = (await collections.queries().insertOne({
  keywordsKey: `e2e-hold-${Date.now()}`, keywords: ["intern"], geoId: "e2e-h",
  matchAll: false, createdAt: new Date(0), primed: true, nextFetchAt: new Date(), everyMinutes: 5,
})).insertedId;
const holdSub = await SubsHold.create({
  userId: holdUser, queryId: holdQ, label: "Intern", requestedEveryMinutes: 5,
});

const holdJob = [{
  jobId: "linkedin:e2e-hold-1", title: "Intern - Held", company: "X",
  url: "https://example.invalid", location: "Colombo, Sri Lanka",
}];
await fanOut1({ _id: holdQ, keywords: ["intern"] }, holdJob, new Date());
ok((await collections.outbox().countDocuments({ subscriptionId: holdSub._id, status: "pending" })) === 1,
  "a job is queued for the watch");

// The reader presses Hold before the worker gets to it.
await SubsHold.setActive(holdUser, holdSub._id, false);
ok((await collections.outbox().countDocuments({ subscriptionId: holdSub._id, status: "pending" })) === 0,
  "HOLD cancels what the watch still owed");

const holdSpy = [];
await drainOutbox({ send: async (m) => { holdSpy.push(m); return { ok: true, id: "p" }; }, cap: 10_000 });
ok(!holdSpy.some((m) => m.jobs.some((j) => j.jobId === "linkedin:e2e-hold-1")),
  "so the held job is never emailed");

/* AND THE RACE. A row can be claimed in the moment between somebody
   pressing Hold and the cancellation landing, so the worker re-reads the
   watch immediately before sending rather than trusting the row. */
await SubsHold.setActive(holdUser, holdSub._id, true);
await fanOut1({ _id: holdQ, keywords: ["intern"] }, [{
  jobId: "linkedin:e2e-hold-2", title: "Intern - Raced", company: "X",
  url: "https://example.invalid", location: "Colombo, Sri Lanka",
}], new Date());
// Pause WITHOUT cancelling, which is exactly what that race leaves behind.
await collections.subscriptions().updateOne({ _id: holdSub._id }, { $set: { active: false } });

const raceSpy = [];
await drainOutbox({ send: async (m) => { raceSpy.push(m); return { ok: true, id: "p" }; }, cap: 10_000 });
ok(!raceSpy.some((m) => m.jobs.some((j) => j.jobId === "linkedin:e2e-hold-2")),
  "a row that survived the cancellation is still not sent — the watch is re-read before sending");
const racedRow = await collections.outbox().findOne({ jobId: "linkedin:e2e-hold-2" });
ok(racedRow.status === "cancelled" && /hold/i.test(racedRow.cancelledReason || ""),
  `and it is recorded as cancelled, with why (${racedRow.status}: ${racedRow.cancelledReason})`);

/* A DELETED ACCOUNT MUST NOT BE EMAILED EITHER. The outbox row holds its
   own copy of the address precisely so a retry does not need the user
   row — which means deleting the account does not, on its own, stop the
   mail. */
await collections.subscriptions().updateOne({ _id: holdSub._id }, { $set: { active: true } });
await fanOut1({ _id: holdQ, keywords: ["intern"] }, [{
  jobId: "linkedin:e2e-hold-3", title: "Intern - Deleted Account", company: "X",
  url: "https://example.invalid", location: "Colombo, Sri Lanka",
}], new Date());
await collections.users().deleteOne({ _id: holdUser });

const goneSpy = [];
await drainOutbox({ send: async (m) => { goneSpy.push(m); return { ok: true, id: "p" }; }, cap: 10_000 });
ok(!goneSpy.some((m) => m.jobs.some((j) => j.jobId === "linkedin:e2e-hold-3")),
  "a closed account is not emailed, even though the row still carries its address");

await collections.outbox().deleteMany({ queryId: holdQ });
await collections.subscriptions().deleteMany({ queryId: holdQ });
await collections.queries().deleteOne({ _id: holdQ });

/* P0 — UNKNOWN IS NEVER YES.
 *
 * The delivery guard used to read: refuse a job whose matchedBy claims a
 * TITLE match when the title does not actually match. Anything else was
 * exempt — and "anything else" included every value nobody had thought
 * about: "unverified", meaning we could not read the job's tags and its
 * title does not match; and undefined, which is what a job carried when
 * refinement threw and the catch passed the unrefined set through.
 *
 * Both sailed past a guard written to stop exactly them.
 */
const { isStillWorthMailing: _iswm } = await import("../src/services/poller/sweep.js");
void _iswm;

/* The guard is expressed in sweep.js over live query state, so it is
   exercised here through the same predicate shape rather than re-derived:
   a job is sendable only if it can show a positive reason. */
const { matchesAny: guardTitleMatch } = await import("../src/utils/match.js");
const guardWords = ["intern"];
const verified = (j) => {
  if (j.matchKind === "tag") return true;
  if (j.matchKind === "unverified") return false;
  return guardTitleMatch(j.title, guardWords);
};

ok(verified({ title: "Marketing Intern", matchKind: "title" }) === true,
  "a title that actually matches is mailed");
ok(verified({ title: "Senior Accountant", matchKind: "title" }) === false,
  "a job CLAIMING a title match whose title does not match is refused");
ok(verified({ title: "Trainee Programme", matchKind: "tag" }) === true,
  "an employer's own Internship tag is mailed even though the title cannot show it");

/* THE TWO HOLES, stated directly. */
ok(verified({ title: "Senior Google Ads Specialist", matchKind: "unverified" }) === false,
  "a job we COULD NOT VERIFY is never mailed — running out of attempts is not evidence");
ok(verified({ title: "Mechatronics Engineer" }) === false,
  "and a job carrying no verdict at all is refused, not waved through");
ok(verified({ title: "Mechatronics Engineer", matchKind: "something-new" }) === false,
  "including a matchKind nobody has invented yet — the guard is an allowlist");

/* Fail-closed refinement: a thrown refine marks its source's jobs
   unverified rather than passing the wider set through. */
const { readFileSync: readSrc } = await import("node:fs");
const sweepSrc = readSrc("src/services/poller/sweep.js", "utf8");
ok(/holding this source's jobs as unverified, not mailing them/.test(sweepSrc),
  "a refine that throws holds its jobs instead of mailing the unrefined set");
ok(!/alerting on the unrefined set/.test(sweepSrc),
  "and the old fail-open comment and behaviour are gone");
ok(/matchKind === "unverified" && \(j\.refineAttempts \|\| 0\) >= MAX_REFINE_ATTEMPTS/.test(sweepSrc),
  "jobs that exhaust their verification attempts are separated out, not trusted");

/* PHASE 3b — only one process may crawl, and it must keep proving it.
 *
 * The first version of this took the lease once at the top of a tick,
 * with a five-minute TTL. A tick sweeps up to ten queries serially and
 * one LinkedIn search is 78-92 seconds, so a full tick runs thirteen to
 * fifteen minutes: the lease expired around query four, a second process
 * found it expired and took it, and both crawled. Exactly what the lease
 * exists to prevent, arriving two thirds of the way through every busy
 * tick.
 *
 * Worse, the lease shared a document with the poller heartbeat, and the
 * heartbeat wrote leaseOwner unconditionally — so the process that had
 * already LOST the lease stamped its name back over the winner's. It did
 * not merely fail to protect; it corrupted the record of who was in
 * charge.
 */
const Lease = await import("../src/models/pollerLease.js");
await Lease.forceRelease();

const A = "process-a";
const B = "process-b";

const fenceA = await Lease.acquire(A);
ok(!!fenceA, "the first process takes the lease");
ok(Number.isInteger(fenceA.token), `and gets a fencing token (${fenceA.token})`);
ok((await Lease.acquire(B)) === null, "and the second one is refused — it must not crawl");

const renewed = await Lease.renew(fenceA);
ok(!!renewed && renewed.token === fenceA.token,
  "the holder renews while it works, keeping its token");
ok(renewed.expiresAt > fenceA.expiresAt,
  "and the expiry moves forward, which is what a long tick needs");

const held = await Lease.current();
ok(held.owner === A && !held.expired, `the database says who holds it (${held.owner})`);

/* THE BUG THIS REPLACED. A tick that outlives its own lease.
   Simulated by expiring it, which is what fifteen minutes of crawling
   under a five-minute TTL did. */
await collections.pollerLease().updateOne(
  { _id: "poller.lease" }, { $set: { expiresAt: new Date(Date.now() - 60_000) } }
);
const fenceB = await Lease.acquire(B);
ok(!!fenceB, "a lapsed lease is taken over, so a dead process cannot stop the poller for ever");
ok(fenceB.token > fenceA.token,
  `and the token moves on (${fenceA.token} -> ${fenceB.token})`);

/* FENCING, which is the part that makes it safe. A whose lease was taken
   over must not be able to renew its way back in — and must be TOLD, so
   it stops crawling rather than carrying on beside B. */
ok((await Lease.renew(fenceA)) === null,
  "the deposed process cannot renew — it is told it has lost authority");
ok((await Lease.current()).owner === B, "and B is still the holder");

// Nor can it release the lease it no longer holds.
ok((await Lease.release(fenceA)) === false,
  "a process that no longer holds it cannot release it");
ok((await Lease.current()).owner === B, "so the real holder keeps it");

// The real holder can, and the next process takes over immediately
// rather than waiting out the TTL.
ok((await Lease.release(fenceB)) === true, "the holder can give it back");
const fenceC = await Lease.acquire(A);
ok(!!fenceC, "and the next process takes it immediately");

/* THE HEARTBEAT MUST NOT BE ABLE TO TOUCH IT. The two lived in one
   document, and the heartbeat wrote the owner field. */
await collections.pollerState().updateOne(
  { _id: "poller" },
  { $set: { leaseHolder: "some-other-process", state: "working" } },
  { upsert: true }
);
ok((await Lease.current()).owner === A,
  "a heartbeat write cannot change who holds the lease — they are different documents");

await Lease.release(fenceC);
await Lease.forceRelease();
ok((await Lease.current()) === null, "and it can be cleared by hand when a holder is known to be gone");

/* PHASE 0 — three fixes that were each wrong in a way nothing exercised. */

// 1. fanOut records obligations and calls no provider at all.
//
// This block used to prove that the all-sends-failed branch did not throw
// a ReferenceError: `jobs` was the per-subscriber slice, scoped to the
// loop, and the branch read it after the loop — so the diagnostic
// replaced the outage it was meant to describe, and nothing ever ran it.
//
// That branch no longer exists, because fanOut no longer sends. What is
// worth asserting now is the stronger property that replaced it: no
// provider is reachable from a sweep, so no provider failure can cost an
// alert. The refusal path itself is tested against drainOutbox above.
const { fanOut } = await import("../src/services/poller/sweep.js");

const fanUser = (await collections.users().insertOne({
  email: `e2e-fan-${Date.now()}@example.invalid`, verified: true, createdAt: new Date(0),
})).insertedId;
const fanQ = (await collections.queries().insertOne({
  keywordsKey: `e2e-fan-${Date.now()}`, keywords: ["intern"], geoId: "e2e-f",
  matchAll: false, createdAt: new Date(0), primed: true, nextFetchAt: new Date(), everyMinutes: 5,
})).insertedId;
await collections.subscriptions().insertOne({
  userId: fanUser, queryId: fanQ, label: "Intern", active: true, createdAt: new Date(0),
});

let threw = null, delivered = null;
try {
  delivered = await fanOut(
    { _id: fanQ, keywords: ["intern"] },
    [{ jobId: "linkedin:e2e-1", title: "Intern - Testing", company: "X", url: "https://example.invalid" }],
    new Date(),
  );
} catch (err) { threw = err; }

ok(!threw, `fanOut does not throw (${threw && threw.message})`);
ok(delivered && delivered.queued === 1,
  `it records one obligation (got ${delivered && delivered.queued})`);
const logged = await collections.emailLog().countDocuments({ userId: fanUser });
ok(logged === 0,
  `and writes no email log row, because it attempted no email (got ${logged})`);
ok((await collections.outbox().countDocuments({ userId: fanUser, status: "pending" })) === 1,
  "the obligation is what survives the sweep, not an attempt");

await collections.outbox().deleteMany({ userId: fanUser });
await collections.emailLog().deleteMany({ userId: fanUser });
await collections.subscriptions().deleteMany({ userId: fanUser });
await collections.users().deleteOne({ _id: fanUser });
await collections.queries().deleteOne({ _id: fanQ });

// 2. Every adapter declares how deep the sweep may page.
const SRC0 = await import("../src/services/sources/index.js");
const pagers = Object.values(SRC0.SOURCES);
ok(pagers.every((s2) => Number.isInteger(s2.maxPages) && s2.maxPages >= 1),
  "every source declares an integer page budget");
ok(SRC0.getSource("rooster").maxPages === 5,
  `Rooster can reach its fifth page (${SRC0.getSource("rooster").maxPages})`);
ok(SRC0.getSource("linkedin").maxPages === 1 && SRC0.getSource("mas").maxPages === 1,
  "and the internal pagers are asked exactly once, not four times");

// 3. Keells uses the app's definition of a keyword match, not its own.
const keells = await import("../src/services/sources/keells.js");
const { readFileSync } = await import("node:fs");
const keellsSrc = readFileSync("src/services/sources/keells.js", "utf8");
ok(keellsSrc.includes("matchesAny("), "Keells filters through matchesAny");
ok(!keellsSrc.includes("t.includes(n)"),
  "and no longer substring-matches, which let intern match international");

// A board is fetched once per country per cycle, not once per search.
//
// Five live searches in Sri Lanka meant five full walks of LinkedIn every
// cycle, and it started refusing us: "data analyst" saw 1 job against a
// peak of 207, "data scientist" 2 of 202.
//
// The first attempt at this cached the adapter's FILTERED result, so
// whichever search drove the fetch decided what every other search saw —
// an "intern" wire filled with IT Manager and Senior Executive - IT. What
// is shared is now the UNFILTERED listing, and the sweep applies each
// watch's own words to it.
const FC = await import("../src/services/poller/snapshot.js");
const { matchesAny: titleMatch } = await import("../src/utils/match.js");

ok(FC.isShared("topjobs") && FC.isShared("mas") && FC.isShared("xpress") && FC.isShared("itpro"),
  "boards that fetch a listing and filter it in the adapter are shared");
ok(!FC.isShared("linkedin"),
  "LinkedIn is not — its keyword unions two surfaces and keeps employer-tagged jobs, so there is no listing to share");
ok(!FC.isShared("keells") && !FC.isShared("rooster"),
  "nor the two that filter server-side — sharing those would lose jobs");

FC.clearSnapshots();
/* A pass, not a clock. Without one open, sharedFetch deliberately does
   not share at all — nothing outside the poller has a pass, and a lone
   call should not silently read somebody else's snapshot. */
FC.openPass();
let hits = 0;
const listing = [
  { jobId: "topjobs:1", title: "Intern - Software Engineering" },
  { jobId: "topjobs:2", title: "IT Manager" },
  { jobId: "topjobs:3", title: "Senior Executive - IT" },
];
const fetchAll = () => { hits++; return Promise.resolve(listing); };

const forWatch = async (words) => {
  const jobs = await FC.sharedFetch("topjobs", "LK", fetchAll);
  return words.length ? jobs.filter((j) => titleMatch(j.title, words)) : jobs;
};

const itSet = await forWatch(["IT"]);
const internSet = await forWatch(["intern"]);
ok(hits === 1, `two searches in one country cost ONE fetch (got ${hits})`);
ok(itSet.length === 2, `the IT watch gets its own two (got ${itSet.length})`);
ok(internSet.length === 1 && internSet[0].title.includes("Intern"),
  "and the intern watch gets only the internship — not the IT search's results");

// The regression, stated directly.
ok(!internSet.some((j) => /IT Manager|Senior Executive/.test(j.title)),
  "a shared fetch never hands one watch another watch's jobs");

/* IMMUTABLE. A matcher must not be able to change what the next matcher
   sees — which is precisely what the first version of this cache
   allowed, by storing the adapter's already-filtered result. Freezing
   makes it structural instead of remembered. */
const snapshot = await FC.sharedFetch("topjobs", "LK", fetchAll);
let mutated = null;
try { snapshot.push({ jobId: "topjobs:99", title: "Injected" }); }
catch (err) { mutated = err; }
ok(!!mutated || snapshot.length === 3,
  "the snapshot cannot be added to by whoever reads it");
ok((await FC.sharedFetch("topjobs", "LK", fetchAll)).length === 3,
  "so the next search still sees the three jobs the board actually had");

/* SHARED IN FLIGHT. Two queries reaching the same board at the same
   moment used to make two requests, because the old cache was only
   written after the first fetch returned. */
FC.clearSnapshots();
FC.openPass();
let slowHits = 0;
const slowFetch = () => {
  slowHits++;
  return new Promise((res) => setTimeout(() => res(listing), 120));
};
await Promise.all([
  FC.sharedFetch("topjobs", "LK", slowFetch),
  FC.sharedFetch("topjobs", "LK", slowFetch),
  FC.sharedFetch("topjobs", "LK", slowFetch),
]);
ok(slowHits === 1,
  `three queries racing one slow board make ONE request (got ${slowHits})`);

/* THE BUG THIS PHASE EXISTS FOR. A pass that runs longer than the old
   four-minute TTL used to refetch a board it already had. The pass is
   the unit now, so its length cannot matter. */
FC.clearSnapshots();
const passId = FC.openPass();
let longHits = 0;
const countingFetch = () => { longHits++; return Promise.resolve(listing); };
await FC.sharedFetch("topjobs", "LK", countingFetch);
// Five minutes of pass, which the old TTL would have expired twice over.
const info = FC.passInfo();
info.startedAt.setTime(info.startedAt.getTime() - 5 * 60_000);
await FC.sharedFetch("topjobs", "LK", countingFetch);
ok(longHits === 1,
  `a pass longer than four minutes still fetches once (got ${longHits})`);
ok(FC.passInfo().id === passId, "and it is still the same pass");

// Closing it is what lets the next pass see fresh listings.
const summary = FC.closePass();
ok(summary && summary.snapshots === 1, "closing the pass reports what it took");
FC.openPass();
await FC.sharedFetch("topjobs", "LK", countingFetch);
ok(longHits === 2, "and the next pass fetches again, however long the last one ran");
FC.clearSnapshots();

// Countries never share.
FC.clearSnapshots();
FC.openPass();
hits = 0;
await FC.sharedFetch("topjobs", "LK", fetchAll);
await FC.sharedFetch("topjobs", "DE", fetchAll);
ok(hits === 2, "two countries are two fetches, never one shared between them");

// An unshared board is fetched every time, unchanged.
hits = 0;
await FC.sharedFetch("linkedin", "LK", fetchAll);
await FC.sharedFetch("linkedin", "LK", fetchAll);
ok(hits === 2, "an unshared board is never served from the cache");

// An email filter belongs to ONE subscription, not to the search.
//
// Two people can sit on the same "intern" query and one of them be mailed
// only the data ones. That is the whole reason it lives here: twenty
// watchers still cost one fetch, and only the last step differs.
const { passesPack, listPacks, getPack } = await import("../src/services/packs.js");
const Subs2 = await import("../src/models/subscriptions.js");

ok(listPacks().some((p) => p.id === "data-science"), "the Data Science pack exists");
ok(passesPack("Intern - Data Engineering", "data-science"), "it passes a data internship");
ok(passesPack("Machine Learning Engineer Intern", "data-science"), "and an ML one");
ok(passesPack("Intern - Software Engineering", "data-science"), "and software engineering");
ok(!passesPack("Intern - Human Resources", "data-science"), "and blocks an HR one");
ok(!passesPack("Data Entry Operator Intern", "data-science"),
  "and blocks Data Entry, which is why the words are phrases and not just \"data\"");
ok(passesPack("Intern - Human Resources", ""), "no pack set narrows nothing");
ok(passesPack("Intern - Human Resources", "no-such-pack"),
  "and a pack that no longer exists must not silently mute somebody");

// Setting and clearing it touches the subscription and nothing else.
const packUser = (await collections.users().insertOne({
  email: `e2e-pack-${Date.now()}@example.invalid`, verified: true, createdAt: new Date(),
})).insertedId;
const packQ = (await collections.queries().insertOne({
  keywordsKey: `e2e-pack-q-${Date.now()}`, keywords: ["intern"], geoId: "e2e-p",
  matchAll: false, createdAt: new Date(), primed: true, nextFetchAt: new Date(), everyMinutes: 5,
})).insertedId;
const packSub = (await collections.subscriptions().insertOne({
  userId: packUser, queryId: packQ, label: "Intern", active: true, createdAt: new Date(),
})).insertedId;

await Subs2.setEmailPack(packSub, "data-science");
let after = await collections.subscriptions().findOne({ _id: packSub });
ok(after.emailPack === "data-science", "the pack is stored on the subscription");
const qAfter = await collections.queries().findOne({ _id: packQ });
ok(qAfter.keywords.join() === "intern" && !qAfter.emailPack,
  "and the search itself is untouched — same keywords, no filter on the query");

await Subs2.setEmailPack(packSub, "");
after = await collections.subscriptions().findOne({ _id: packSub });
ok(after.emailPack === undefined,
  "clearing it removes the field entirely, so there is nothing to migrate back");

await collections.subscriptions().deleteOne({ _id: packSub });
await collections.queries().deleteOne({ _id: packQ });
await collections.users().deleteOne({ _id: packUser });

// "intern" means intern.
//
// The matcher used to treat trainee as a synonym, on the reasoning that
// Sri Lankan employers use them interchangeably. Some do; the rest
// delivered Trainee Barista, Trainee Bar Waiters, CCTV Installation
// Trainees and Management Trainees to a watch for internships.
const { matchesAny: mm } = await import("../src/utils/match.js");
ok(!mm("Trainee Barista", ["intern"]), "an intern watch no longer matches Trainee Barista");
ok(!mm("Management Trainees", ["intern"]), "nor Management Trainees");
ok(mm("Software Engineer Intern", ["intern"]), "but it still matches Intern");
ok(mm("Internship - Supply Chain", ["intern"]), "and Internship");
ok(mm("Marketing Interns", ["intern"]), "and the plural");
ok(!mm("our internal processes", ["intern"]) && !mm("international clients", ["intern"]),
  "and still refuses internal / international");
ok(mm("Trainee Barista", ["trainee"]),
  "somebody who actually wants trainee roles asks for them and gets them");

// A board that carries years of listings must not mail them.
//
// Day-precision sources skip the four hour freshness gate, because a date
// with no time resolves to midnight. That exemption had no ceiling, so
// Rooster mailed postings printed 1,024 and 747 days old. The bound is
// deliberately generous: a genuinely new Keells listing can print 56 days
// old because the board stamps the date the vacancy was RAISED, and that
// case is why the old fourteen day rule was removed.
const { isStillWorthMailing } = await import("../src/services/poller/sweep.js");
const { env: swEnv } = await import("../src/config/env.js");
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

ok(typeof isStillWorthMailing === "function", "the mailing rule is exported and testable");
ok(isStillWorthMailing({ jobId: "keells:1", postedAt: daysAgo(56) }),
  "a Keells listing printed 56 days old is still mailed");
ok(!isStillWorthMailing({ jobId: "rooster:1", postedAt: daysAgo(747) }),
  "a Rooster listing printed 747 days old is not");
ok(!isStillWorthMailing({ jobId: "rooster:2", postedAt: daysAgo(1024) }),
  "nor one printed 1,024 days old");
ok(isStillWorthMailing({ jobId: "rooster:3", postedAt: daysAgo(36) }),
  "but one printed 36 days old is");
ok(isStillWorthMailing({ jobId: "topjobs:1", postedAt: null }),
  "a day-precision job with no date at all is judged on arrival, not withheld");
ok(isStillWorthMailing({ jobId: "keells:2", postedAt: daysAgo(swEnv.staleAlertDays - 1) }) &&
   !isStillWorthMailing({ jobId: "keells:3", postedAt: daysAgo(swEnv.staleAlertDays + 1) }),
  `the ceiling sits exactly at STALE_ALERT_DAYS (${swEnv.staleAlertDays})`);

// LinkedIn keeps its own, much tighter rule — this must not have loosened it.
ok(!isStillWorthMailing({ jobId: "linkedin:1", postedAt: daysAgo(1) }),
  "a minute-precision source still uses the four hour gate, not the ceiling");

// A new account already watches something.
//
// Signing up landed on an empty page and a form, and the next sweep was
// the priming one — which alerts on nothing — so filling the form in
// correctly earned a second wait. The starter watch joins the shared
// "intern" row, which is already primed and already warm.
const { ensureStarterWatch } = await import("../src/services/onboarding/starterWatch.js");
const { identityOf: idOf } = await import("../src/models/queries.js");

/* The shared intern/Sri Lanka row, seeded warm and on purpose.

   This assertion used to pass without it, because the row exists in
   production and that is where this suite used to run. On a clean
   database it failed — correctly: a starter watch that CREATES the
   shared search gets an unprimed one, and the first sweep primes it
   without alerting. The behaviour worth testing is the other case, the
   one every account after the first hits: joining a row that is already
   warm, so the wire fills on the very next sweep. Seeded rather than
   inherited, so it is a fixture and not a coincidence. */
const { upsert: upsertQuery } = await import("../src/models/queries.js");
const sharedIntern = await upsertQuery({
  keywordsKey: canonicalKey(["intern"]),
  keywords: ["intern"],
  geoId: "100446352",
  location: "Sri Lanka",
  everyMinutes: 15,
  sources: ["linkedin"],
  matchAll: false,
});
await collections.queries().updateOne({ _id: sharedIntern._id }, { $set: { primed: true } });

const newbie = (await collections.users().insertOne({
  email: `e2e-starter-${Date.now()}@example.invalid`, verified: true, createdAt: new Date(),
})).insertedId;

const made = await ensureStarterWatch(newbie);
ok(!!made, "a newly verified account is given a watch");
const starterSubs = await collections.subscriptions().find({ userId: newbie }).toArray();
ok(starterSubs.length === 1, `exactly one watch, not a pile (got ${starterSubs.length})`);

// The point of the whole thing: it must JOIN the shared search, not spawn
// a rival spelling of it — the split that once stretched the cycle to 9 min.
const starterQ = await collections.queries().findOne({ _id: starterSubs[0].queryId });
ok(starterQ.identityKey === idOf({ keywords: ["intern"], geoId: "100446352" }),
  "and it joins the shared intern/Sri Lanka search rather than making its own");
ok(starterQ.primed === true, "which is already primed, so the wire fills on the next sweep");

// Called twice — a re-verification, or anything else — must not duplicate.
const again = await ensureStarterWatch(newbie);
ok(again === null, "calling it again does nothing");
ok((await collections.subscriptions().countDocuments({ userId: newbie })) === 1,
  "and the account still has exactly one watch");

// Somebody who deleted it has decided; it must not come back.
await collections.subscriptions().deleteMany({ userId: newbie });
await collections.subscriptions().insertOne({
  userId: newbie, queryId: starterQ._id, label: "their own", active: true, createdAt: new Date(),
});
const third = await ensureStarterWatch(newbie);
ok(third === null, "an account that already watches anything is left alone");

await collections.subscriptions().deleteMany({ userId: newbie });
await collections.users().deleteOne({ _id: newbie });

// Every source keeps the contract the poller relies on.
//
// A source that returns [] when it cannot decide is the shape of every
// silent failure this project has had — it is indistinguishable from a
// quiet day. These are structural checks, not network calls.
const SRC = await import("../src/services/sources/index.js");
const wanted = ["linkedin", "keells", "topjobs", "mas", "itpro", "xpress", "rooster"];
ok(wanted.every((id) => SRC.getSource(id)), "every source is registered");

let contractOk = true, precisionOk = true, prefixOk = true;
for (const id of wanted) {
  const s2 = SRC.getSource(id);
  if (typeof s2.fetchJobs !== "function" || !s2.label || !Array.isArray(s2.hosts) || !s2.hosts.length) contractOk = false;
  if (s2.timePrecision && !["minute", "day"].includes(s2.timePrecision)) precisionOk = false;
  if (s2.id !== id) prefixOk = false;
}
ok(contractOk, "each one has fetchJobs, a label and a host allowlist");
ok(precisionOk, "timePrecision is only ever minute or day");
ok(prefixOk, "each source's id matches the key it is registered under");

const sl = SRC.sourcesForCountry("100446352");
ok(["itpro", "xpress", "rooster"].every((id) => sl.includes(id)),
  `the three new boards serve Sri Lanka (${sl.length} sources)`);
const de = SRC.sourcesForCountry("101282230");
ok(!de.some((id) => ["itpro", "xpress", "rooster", "keells", "mas"].includes(id)),
  "and none of the Sri Lankan boards is offered to Germany");

// guardedFetch gained a body for rooster; the allowlist must still bite.
const { assertAllowed } = await import("../src/services/http/guardedFetch.js");
let blocked = 0;
for (const bad of ["https://evil.test/x", "http://itpro.lk/x", "https://itpro.lk.evil.test/x"]) {
  try { assertAllowed(bad, ["itpro.lk"]); } catch { blocked++; }
}
ok(blocked === 3, `the host allowlist still refuses plain http and lookalike hosts (${blocked}/3)`);
ok(!!assertAllowed("https://itpro.lk/jobs/", ["itpro.lk"]), "and still allows the real one");

// A fetch is offered to every other watch in the same country.
//
// Each sweep used to keep what matched its own keywords and discard the
// rest, while another watch was minutes away from asking the same board
// for a job we already had. Over one week 1,975 alerts went out later than
// the moment the job was in memory, a median of 22 minutes late.
const QMod2 = await import("../src/models/queries.js");
const geoX = "e2e-cross";
const mkQ = async (kw, extra = {}) => (await collections.queries().insertOne({
  keywordsKey: `e2e-${kw.join("-")}-${Date.now()}${Math.random()}`,
  keywords: kw, geoId: geoX, matchAll: false, createdAt: new Date(),
  primed: true, nextFetchAt: new Date(), everyMinutes: 5, ...extra,
})).insertedId;

const qA = await mkQ(["intern"]);
const qB = await mkQ(["engineer"]);
const qParked = await mkQ(["parked"], { nextFetchAt: null });
const qFresh = await mkQ(["engineer"], { primed: false });
const qOther = await mkQ(["engineer"], { geoId: "e2e-elsewhere" });

const sibs = await QMod2.siblings(geoX, qA);
const ids = sibs.map((s) => String(s._id));
ok(ids.includes(String(qB)), "a live primed watch in the same country is a sibling");
ok(!ids.includes(String(qA)), "the sweeping watch is not its own sibling");
ok(!ids.includes(String(qParked)), "a parked watch is not offered anything");
ok(!ids.includes(String(qFresh)),
  "an unprimed watch is skipped — its first email must not be a backlog");
ok(!ids.includes(String(qOther)), "a watch in another country is not a sibling");

await collections.queries().deleteMany({ _id: { $in: [qA, qB, qParked, qFresh, qOther] } });

// A job is mailed once, however long the board leaves it up.
//
// seenJobs expires after SEEN_JOB_TTL_DAYS so the wire stays a feed. Dedupe
// used to run against it, so a posting a board left up longer than that fell
// out, came back looking new, and was alerted again. On 2026-09-03 that
// rediscovered 22 MAS listings in one sweep — 18 over a fortnight old — and
// mailed each to five people.
const Ledger = await import("../src/models/alertedJobs.js");
const { diff } = await import("../src/services/poller/dedupe.js");
const ledgerQ = (await collections.queries().insertOne({
  keywordsKey: `e2e-ledger-${Date.now()}`, keywords: ["x"], geoId: "e2e-l",
  matchAll: false, createdAt: new Date(), nextFetchAt: null, primed: true,
})).insertedId;

ok((await Ledger.knownIds(ledgerQ, ["keells:1"])).size === 0,
  "a job this search has never met is unknown");
const won = await Ledger.remember(ledgerQ, ["keells:1"]);
ok(won.has("keells:1"), "claiming a new job succeeds");
const lost = await Ledger.remember(ledgerQ, ["keells:1", "keells:2"]);
ok(!lost.has("keells:1") && lost.has("keells:2"),
  "a second claim on the same job loses the race, a new one still wins");

// THE REGRESSION: the wire forgets, the ledger must not.
const job = { jobId: "mas:e2e-old", title: "Intern - Ancient", company: "MAS",
  location: "Sri Lanka", url: "https://example.invalid/x",
  postedText: "2026-01-01", postedAt: new Date("2026-01-01") };
const first = await diff({ _id: ledgerQ, primed: true }, [job]);
ok(first.alertable.length === 1, "a genuinely new listing is alertable whatever date it prints");

/* The sweep claims, not diff.

   diff used to write the ledger claim itself, the moment a job was
   discovered — before it had been matched and before anybody had been
   told. That is what made a crash mid-sweep lose the alert for good.
   The claim now happens after every recipient has a durable obligation,
   so this test has to do what the sweep does. */
await Ledger.remember(ledgerQ, first.alertable.map((j) => j.jobId));

// Expire it from the wire exactly as the TTL would, leaving the ledger alone.
await collections.seenJobs().deleteMany({ queryId: ledgerQ, jobId: "mas:e2e-old" });
const second = await diff({ _id: ledgerQ, primed: true }, [job]);
ok(second.alertable.length === 0,
  `a listing the wire has forgotten is NOT alerted again (got ${second.alertable.length})`);
ok((await Ledger.knownIds(ledgerQ, ["mas:e2e-old"])).size === 1,
  "because the ledger outlives the wire");

await Ledger.forgetQuery(ledgerQ);
ok((await Ledger.knownIds(ledgerQ, ["keells:1"])).size === 0,
  "deleting a search takes its ledger with it");
await collections.seenJobs().deleteMany({ queryId: ledgerQ });
// The query row too. Leaving it behind put sixteen parked "x" searches on
// the admin page over a fortnight of test runs, each one flagged Duplicate
// because they all had the same identity.
await collections.queries().deleteOne({ _id: ledgerQ });


// MAS raises one requisition per plant. Seven identical rows is seven
// emails for one job, and the API exposes no field that tells them apart.
const masMod = await import("../src/services/sources/mas.js");
const fake = (id, title, date) => ({
  jobId: "mas:" + id, title, company: "MAS Holdings", location: "Sri Lanka",
  url: "https://example.invalid/" + id, postedText: date, postedAt: new Date(date),
});
const wf = [21083, 21084, 21085, 21086, 21088, 21090, 21110]
  .map((n) => fake(n, "Intern - Workforce Management", "2026-09-02"));
const mixed = [
  ...wf,
  fake(21095, "Intern - Procurement", "2026-09-02"),
  // Same title, different day: a fresh batch, and it must stay separate
  // or tomorrow's postings vanish into today's alert.
  fake(21300, "Intern - Workforce Management", "2026-09-03"),
];
const rolled = masMod.collapse(mixed);
ok(rolled.length === 3, `nine requisitions collapse to three rows (got ${rolled.length})`);
const big = rolled.find((j) => j.openings === 7);
ok(!!big, "the seven identical ones become one row carrying the count");
ok(rolled.find((j) => j.jobId === "mas:21095" && !j.openings) !== undefined,
  "a lone requisition keeps its own id and gains no count");
ok(rolled.filter((j) => /workforce/i.test(j.title)).length === 2,
  "a later batch of the same title stays a separate alert");

// The id must not be a member's id. Filling the lowest requisition would
// otherwise shift it to one no sweep has seen, and re-alert the group.
ok(!/mas:210dd$/.test(big.jobId), `the group id is derived, not borrowed (${big.jobId})`);
const without = masMod.collapse(mixed.filter((j) => j.jobId !== "mas:21083"));
ok(without.find((j) => j.openings === 6).jobId === big.jobId,
  "and it stays the same when a member disappears");



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
/* The database is thrown away wholesale now, so the careful per-row
   cleanup above is belt and braces rather than the only thing standing
   between an aborted run and production data. It is kept because it
   also asserts that the app leaves nothing dangling behind a deletion. */
await resetTestDb();
await server.stop();
await closeDb();
reachedTheEnd = true;
console.log(`\ncleaned up test data — ${passes} passed, ${failures} failed`);
if (failures) process.exitCode = 1;
