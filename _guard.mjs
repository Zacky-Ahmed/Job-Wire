import fs from "node:fs";
const p = "scripts/e2e.js";
let s = fs.readFileSync(p, "utf8");
const must = (o, n, l) => { if (!s.includes(o)) { console.error("MISS " + l); process.exit(1); } s = s.replace(o, n); };

must(
`const ok = (c, m) => console.log(\`  \${c ? "PASS" : "FAIL"}  \${m}\`);`,
`let passes = 0;
let failures = 0;
const ok = (c, m) => {
  if (c) passes++; else failures++;
  console.log(\`  \${c ? "PASS" : "FAIL"}  \${m}\`);
};

/* A suite that DIES is not a suite that passed.

   This has to be counted rather than eyeballed. A stale call left after
   a rename threw a TypeError two thirds of the way down, node exited,
   and the output ended in a wall of PASS with no FAIL anywhere — the run
   looked fine and had skipped sixty-five assertions. Grepping for FAIL
   is the obvious way to read this file and it would have said nothing
   was wrong.

   So the run announces how far it got, and the exit code says whether it
   got to the end at all. */
let reachedTheEnd = false;
process.on("exit", (code) => {
  if (reachedTheEnd) return;
  console.error(
    \`\nSUITE DID NOT FINISH — \${passes} passed, \${failures} failed, and then it stopped.\n\` +
    \`Everything after that point was never run. Do not read the passes above as a green run.\`
  );
  if (code === 0) process.exitCode = 1;
});`, "counter");

must(
`await resetTestDb();
await server.stop();
await closeDb();
console.log("\ncleaned up test data");`,
`await resetTestDb();
await server.stop();
await closeDb();
reachedTheEnd = true;
console.log(\`\ncleaned up test data — \${passes} passed, \${failures} failed\`);
if (failures) process.exitCode = 1;`, "end");

fs.writeFileSync(p, s);
console.log("ok");
