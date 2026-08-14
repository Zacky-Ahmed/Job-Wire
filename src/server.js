// server.js
//
// Builds the Express app and starts the poller in the SAME process.
// Splitting them onto two hosts loses the shared Mongo pool and the
// in-memory schedule, which is the whole reason this is not serverless.

import dns from "dns";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Resolve IPv4 before IPv6, process-wide, before anything opens a socket.
//
// Railway's containers get an IPv6 address with no working route out. Node
// 18+ defaults to "verbatim" DNS ordering, so smtp.gmail.com's AAAA record
// wins and every send dies with ENETUNREACH 2607:f8b0:... — Google's IPv6.
//
// nodemailer's own `family: 4` option did NOT prevent this in production
// (43 consecutive failures on a deploy that already had it), so the
// ordering has to be forced here, where it applies to every lookup the
// process makes rather than one library's socket options.
dns.setDefaultResultOrder("ipv4first");

import { env } from "./config/env.js";
import { connectDb, closeDb } from "./config/db.js";
import { ensureIndexes } from "./models/indexes.js";
import { buildSession } from "./middleware/session.js";
import { csrf } from "./middleware/csrf.js";
import { theme } from "./middleware/theme.js";
import { assets } from "./utils/assets.js";
import { generalLimiter } from "./middleware/rateLimit.js";
import { rejectOperators } from "./utils/sanitize.js";
import { log } from "./utils/logger.js";
import { authRoutes } from "./routes/auth.routes.js";
import { wireRoutes } from "./routes/wire.routes.js";
import { watchesRoutes } from "./routes/watches.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = express();

  // Render terminates TLS at its proxy. Without this, req.ip is the
  // proxy for everyone (so IP rate limits protect nobody) and `secure`
  // cookies are never set. 1 = trust exactly one hop, not "true",
  // which would let a client forge X-Forwarded-For.
  app.set("trust proxy", 1);

  app.disable("x-powered-by"); // stop advertising the stack

  // Security headers. Written by hand rather than pulling in helmet —
  // this app serves its own HTML and nothing else, so the policy is short.
  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy":
        "default-src 'self'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " + // inline styles in email previews
        "img-src 'self' data:; " +
        "connect-src 'self'; " +
        "frame-ancestors 'none'; " + // clickjacking
        "base-uri 'self'; " +
        "form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
    });
    if (env.isProd) {
      res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
    next();
  });

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  const publicDir = path.join(__dirname, "..", "public");
  // Long cache is safe because every URL carries a content hash; see
  // utils/assets.js. immutable tells the browser not to revalidate at all.
  app.use(express.static(publicDir, { maxAge: env.isProd ? "365d" : 0, immutable: env.isProd }));
  app.use(assets(publicDir, { cache: env.isProd }));

  // Body limits: nothing this app accepts is large, and an unbounded
  // parser is a trivial memory-exhaustion vector.
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use(express.json({ limit: "32kb" }));

  app.use(rejectOperators); // NoSQL operator injection, before anything queries
  app.use(generalLimiter);
  app.use(buildSession());
  app.use(theme); // resolves data-theme before any HTML is written
  app.use(csrf);

  app.get("/healthz", (req, res) => res.type("text/plain").send("ok"));

  app.use(authRoutes);
  app.use(wireRoutes);
  app.use(watchesRoutes);

  app.use((req, res) => res.status(404).type("text/html").send("Not found."));

  // Error handler. Never leak a stack trace or a driver message to the
  // browser — those contain connection strings and collection names.
  app.use((err, req, res, _next) => {
    log.error("unhandled", { path: req.path, message: err.message });
    res.status(500).type("text/html").send("Something went wrong.");
  });

  return app;
}

async function main() {
  await connectDb();
  await ensureIndexes();

  const app = await buildApp();

  // Bind the port FIRST. Everything below is useful but not required to
  // serve a request, and blocking the listen on an SMTP handshake meant
  // ~12s before /healthz answered — a platform with a tighter healthcheck
  // than Railway's would call that a failed deploy.
  const server = app.listen(env.port, () => {
    log.info("listening", { port: env.port, env: env.nodeEnv });
  });

  // Prove the mail credentials, but in the background. The classic failure
  // is GMAIL_USER not matching the account the app password was created
  // on: it authenticates locally and fails in production, silently, until
  // a stranger tries to sign up and sees "we could not send the code".
  //
  // Not fatal — the wire is still readable without mail, and a transient
  // SMTP blip should not stop a deploy.
  import("./services/mail/transport.js")
    .then((m) => m.verifyTransport())
    .then(() => log.info("smtp verified", { user: env.gmailUser }))
    .catch((err) =>
      log.error("SMTP AUTH FAILED — no verification codes or alerts will send", {
        user: env.gmailUser,
        message: err.message.split("\n")[0],
        hint: "GMAIL_USER must be the account the app password was created on",
      })
    );

  if (env.pollerEnabled) {
    const { startPoller } = await import("./services/poller/loop.js");
    startPoller();
  } else {
    log.info("poller disabled by POLLER_ENABLED");
  }

  const shutdown = async (signal) => {
    log.info("shutting down", { signal });
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("boot failed", { message: err.message });
  process.exit(1);
});
