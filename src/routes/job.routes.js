// A public, read-only detail page for every emailed job.
// Read the durable outbox snapshot, not the 14-day dedupe cache. Do not
// expose the recipient, their email, subscription, or delivery status.

import { Router } from "express";
import { ObjectId } from "mongodb";
import { collections } from "../config/db.js";
import { getSource } from "../services/sources/index.js";
import { safeApplyUrl } from "../utils/jobLinks.js";

export const jobRoutes = Router();

jobRoutes.get("/job/:id", async (req, res, next) => {
  const id = String(req.params.id || "");
  if (!/^[\da-f]{24}$/i.test(id)) {
    return res.status(404).type("text/plain").send("Job not found.");
  }

  try {
    // The _id lookup is indexed. Only the job copy is read; no personal
    // information is retrieved, even though outbox holds recipient data.
    const row = await collections.outbox().findOne(
      { _id: new ObjectId(id) },
      { projection: { job: 1 } }
    );
    if (!row?.job) {
      return res.status(404).type("text/plain").send("Job not found.");
    }

    const job = row.job;
    const sourceId = String(job.jobId || "").split(":")[0];
    const postedAt = job.postedAt ? new Date(job.postedAt) : null;
    const postedDate = postedAt && !Number.isNaN(postedAt.getTime())
      ? postedAt.toLocaleDateString("en-GB", {
          day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
        })
      : null;

    // The response contains only public job metadata and is safe to
    // share; its random outbox id is never a login or access token.
    res.set("Cache-Control", "public, max-age=60");
    return res.render("pages/job", {
      title: job.title || "Job details",
      job,
      postedDate,
      sourceLabel: getSource(sourceId)?.label || "Job board",
      applyUrl: safeApplyUrl(job.url),
    });
  } catch (err) {
    return next(err);
  }
});
