// check-shell.js
//
//   npm run check-shell
//
// The persistent workspace shell has one rule and several ways to break
// it quietly: an in-app navigation must send back the contents of <main>
// and nothing else, and every OTHER kind of request must still get a
// whole document.
//
// The failure mode this guards against is not a crash. If the fragment
// path stops triggering, the app still works — it just goes back to
// rebuilding the header on every tab change, and nobody notices until
// somebody measures again. If the fragment path fires too eagerly, a
// first visit or a crawler gets a headless scrap of HTML. Both are silent.
//
// Needs a signed-in account and a server on :3000. It reads pages only.

const BASE = "http://localhost:3000";
const EMAIL = "ui-audit@example.invalid";
const PASSWORD = "uiauditpassword";

const jar = new Map();
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const store = (r) => {
  for (const c of r.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
};

const get = async (path, headers = {}, withCookie = true) => {
  const r = await fetch(BASE + path, {
    headers: { ...(withCookie ? { cookie: cookie() } : {}), ...headers },
    redirect: "manual",
  });
  store(r);
  return r;
};

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

// A boosted navigation, exactly as htmx sends it.
const NAV = { "hx-request": "true", "hx-target": "workspaceMain", "hx-current-url": BASE + "/wire" };

let r = await get("/signin");
let html = await r.text();
const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
r = await fetch(BASE + "/signin", {
  method: "POST",
  redirect: "manual",
  headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ _csrf: csrf, email: EMAIL, password: PASSWORD }),
});
store(r);
if (r.status !== 302) {
  console.error("sign-in failed", r.status, "— run scripts/seed-ui-audit if the account is missing");
  process.exit(1);
}

for (const path of ["/wire", "/watches"]) {
  console.log(`\n=== ${path} ===`);

  const full = await (await get(path)).text();
  const frag = await (await get(path, NAV)).text();

  check("a plain request still gets a whole document",
    full.startsWith("<!doctype html>") && full.includes("<html"));
  check("which carries the shell",
    full.includes('class="topbar"') && full.includes('id="workspaceMain"'));

  check("a boosted navigation gets no document wrapper",
    !frag.includes("<html") && !frag.includes("<body"));
  check("and no second copy of the shell",
    !frag.includes('class="topbar"') && !frag.includes('id="workspaceMain"'),
    "— a nested shell is how you get two sidebars");
  check("but it does carry the page heading",
    frag.includes('class="workspace-heading"'));

  /* htmx only lifts a <title> that is a DIRECT child of the fragment.
     Nested one level deeper it is ignored and the browser tab keeps the
     previous page's name, which is the kind of thing that survives
     review because nobody looks at the tab. */
  check("with the title as the first element, where htmx can find it",
    frag.trimStart().startsWith("<title>"),
    frag.trimStart().slice(0, 40).replace(/\n/g, " "));

  /* No scripts in the fragment.

     A <script> inside the swapped region is re-inserted and re-evaluated
     on every navigation to that page, which is both a request the browser
     did not need and a second chance for a listener to be bound twice.
     Page scripts belong in the shell, loaded once, re-running themselves
     on swap. */
  check("and carries no scripts of its own",
    !/<script/i.test(frag),
    "— a script here is re-evaluated on every navigation");

  /* The topbar readouts come back out of band.

     The shell no longer re-renders on a tab change, so without this the
     sweep countdown would freeze at whatever it said when the tab was
     opened and stay there for the rest of the session. htmx only looks
     for out-of-band markers among the response's OWN children, so this
     also checks it is not buried inside the page. */
  check("the shell readouts ride along out of band",
    /<div class="chips" id="shellReadouts" hx-swap-oob="true">/.test(frag));
  check("at the top level, where htmx looks for them",
    /^<div class="chips" id="shellReadouts"/m.test(frag));

  const saved = Math.round((1 - frag.length / full.length) * 100);
  check("and it is smaller than the full page",
    frag.length < full.length,
    `${Math.round(full.length / 1024)}KB -> ${Math.round(frag.length / 1024)}KB (${saved}% less)`);

  // The header htmx sends when restoring history. It needs the whole
  // page back so it can find [hx-history-elt] inside it; answer with a
  // fragment and the back button restores nothing.
  const restore = await (await get(path, { ...NAV, "hx-history-restore-request": "true" })).text();
  check("a history restore is answered with the full page",
    restore.includes("<html") && restore.includes("hx-history-elt"));
}

console.log("\n=== shell ===");
const shell = await (await get("/wire")).text();
check("only the workspace nav, the dialog and the Watch button are boosted",
  (shell.match(/hx-boost/g) || []).length === 3,
  `found ${(shell.match(/hx-boost/g) || []).length}`);
check("sign-out is NOT boosted — it leaves the shell",
  !/hx-boost[^>]*>\s*<input type="hidden" name="_csrf"/.test(shell));
check("main is the history element",
  /id="workspaceMain"[^>]*hx-history-elt/.test(shell));

const vary = (await get("/wire", NAV)).headers.get("vary") || "";
check("the two answers are not cacheable as one",
  /hx-request/i.test(vary) && /hx-target/i.test(vary), vary);

console.log("\n=== signed out ===");
jar.clear();
const bounced = await get("/wire", NAV, false);
check("a boosted navigation on a dead session redirects the whole browser",
  bounced.status === 204 && bounced.headers.get("hx-redirect") === "/signin",
  `${bounced.status} ${bounced.headers.get("hx-redirect")}`);

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
