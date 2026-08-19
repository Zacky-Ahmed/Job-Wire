// set-password.js
//
//   npm run set-password -- you@example.com
//
// Prompts for a new password with the echo turned off, hashes it, and
// writes only the hash. Nothing is printed, logged, or stored in shell
// history — the password never leaves this process.

import readline from "node:readline";
import { connectDb, collections, closeDb } from "../src/config/db.js";
import { hash } from "../src/services/auth/password.js";

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.error("Usage: npm run set-password -- you@example.com");
  process.exit(1);
}

/** Read a line without echoing it back to the terminal. */
function secret(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      // Re-print the prompt with nothing after it, so keystrokes vanish.
      if (["\n", "\r", "\u0004"].includes(char.toString())) return;
      process.stdout.write("\x1b[2K\x1b[G" + prompt);
    };
    process.stdin.on("data", onData);
    rl.question(prompt, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

await connectDb();
const user = await collections.users().findOne({ email }, { projection: { _id: 1, email: 1 } });
if (!user) {
  console.error(`No account with that address: ${email}`);
  await closeDb();
  process.exit(1);
}

const pw = await secret("New password (min 8 chars, not shown): ");
const again = await secret("Confirm: ");

if (pw.length < 8) {
  console.error("Too short — at least 8 characters.");
} else if (pw !== again) {
  console.error("Those did not match. Nothing was changed.");
} else {
  await collections.users().updateOne({ _id: user._id }, { $set: { passHash: await hash(pw) } });
  console.log(`Password updated for ${user.email}.`);
}
await closeDb();
