// Mounted before sessions and rate limits. A source outage is not a web outage.
export function mountHealth(app, { ping }) {
  app.locals.ready = false;
  app.locals.shuttingDown = false;
  app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));
  app.get("/readyz", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    if (!app.locals.ready || app.locals.shuttingDown) {
      return res.status(503).type("text/plain").send("not ready");
    }
    try {
      await ping();
      res.type("text/plain").send("ready");
    } catch {
      res.status(503).type("text/plain").send("not ready");
    }
  });
}
