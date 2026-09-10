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

/* PHASE 0 — three fixes that were each wrong in a way nothing exercised. */

// 1. The all-sends-failed branch used to throw ReferenceError.
//
// `jobs` is the per-subscriber slice and is scoped to the loop; the branch
// read it after the loop. It fired only when every send had already failed,
// so the diagnostic replaced the outage it was meant to describe. Nothing
// ran this path, which is exactly why it shipped broken.
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
    { send: async () => ({ ok: false, error: "provider refused" }) },
  );
} catch (err) { threw = err; }

ok(!threw, `the all-sends-failed path does not throw (${threw && threw.message})`);
ok(delivered === 0, `and reports nothing delivered (got ${delivered})`);
const logged = await collections.emailLog().countDocuments({ userId: fanUser });
ok(logged === 1, "a row is left behind for the retry queue to find");

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
const FC = await import("../src/services/poller/fetchCache.js");
const { matchesAny: titleMatch } = await import("../src/utils/match.js");

ok(FC.isShared("topjobs") && FC.isShared("mas") && FC.isShared("xpress") && FC.isShared("itpro"),
  "boards that fetch a listing and filter it in the adapter are shared");
ok(!FC.isShared("linkedin"),
  "LinkedIn is not — its keyword unions two surfaces and keeps employer-tagged jobs, so there is no listing to share");
ok(!FC.isShared("keells") && !FC.isShared("rooster"),
  "nor the two that filter server-side — sharing those would lose jobs");

FC.clearFetchCache();
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

// Countries never share.
FC.clearFetchCache();
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
await closeDb();
console.log("\ncleaned up test data");
