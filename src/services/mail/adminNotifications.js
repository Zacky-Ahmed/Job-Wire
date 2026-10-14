// adminNotifications.js
// Durable, best-effort operational emails. Never block the user action on SMTP.
// Exactly one queue document per event + recipient; retries preserve provider.
import { collections } from "../../config/db.js";
import { env } from "../../config/env.js";
import { log } from "../../utils/logger.js";
import { sendMail, chooseProvider, dailyCap } from "./transport.js";
import * as EmailLog from "../../models/emailLog.js";
import { buildAdminNotification, shouldNotifyManualWatch } from "./adminNotificationTemplates.js";

const coll = () => collections.adminNotifications();
const MAX_ATTEMPTS = 5;
const RETRY_MS = [60_000, 5 * 60_000, 20 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const recipients = () => [...new Set(env.adminNotificationEmails)];

export async function queueVerifiedUser({ userId, email }) {
  return enqueue("verified_user", String(userId), { email });
}

export async function queueManualWatch({ subscriptionId, email, label, keywords, location, everyMinutes }) {
  if (!shouldNotifyManualWatch(email, env.adminEmails)) return;
  return enqueue("manual_watch", String(subscriptionId), {
    email, label, keywords, location, everyMinutes,
  });
}

async function enqueue(kind, eventId, details) {
  const admins = recipients();
  if (!admins.length) return;
  try {
    await Promise.all(admins.map((to) => coll().updateOne(
      { _id: kind + ":" + eventId + ":" + to },
      { $setOnInsert: {
        kind, to, ...details, status: "pending", attempts: 0,
        provider: null, createdAt: new Date(), nextAttemptAt: new Date(),
      } },
      { upsert: true }
    )));
  } catch (error) {
    // This is monitoring only. A mail queue write must NEVER undo a signup
    // verification or watch that has already been stored.
    log.error("admin notification enqueue failed", { kind, message: error.message });
  }
}

let timer;
let draining = false;
export function startAdminNotifications() {
  if (timer) return;
  timer = setInterval(() => { void drainAdminNotifications(); }, 60_000);
  timer.unref?.();
  void drainAdminNotifications();
}

export async function stopAdminNotifications() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function drainAdminNotifications() {
  if (draining) return;
  draining = true;
  try {
    for (let i = 0; i < 5; i++) {
      const now = new Date();
      const row = await coll().findOneAndUpdate(
        { attempts: { $lt: MAX_ATTEMPTS }, $or: [
          { status: { $in: ["pending", "failed"] }, nextAttemptAt: { $lte: now } },
          { status: "sending", claimedAt: { $lte: new Date(Date.now() - 5 * 60_000) } },
        ] },
        { $set: { status: "sending", claimedAt: now }, $inc: { attempts: 1 } },
        { sort: { createdAt: 1 }, returnDocument: "after" }
      );
      const notification = row?.value ?? row;
      if (!notification) break;

      const total = await EmailLog.countToday();
      if (total >= dailyCap()) {
        await coll().updateOne({ _id: notification._id, status: "sending" }, {
          $set: { status: "failed", nextAttemptAt: new Date(Date.now() + 60 * 60_000) },
          $inc: { attempts: -1 },
        });
        break;
      }

      try {
        const provider = notification.provider || await chooseProvider();
        if (!notification.provider) {
          await coll().updateOne({ _id: notification._id, status: "sending" },
            { $set: { provider } });
        }
        const message = buildAdminNotification(notification, env.appUrl);
        const result = await sendMail({
          to: notification.to, ...message,
          provider,
          idempotencyKey: "admin-" + notification._id,
        });
        await EmailLog.recordSystem({
          kind: "admin_" + notification.kind, ok: result.ok,
          providerId: result.id, error: result.error,
        });
        await coll().updateOne({ _id: notification._id, status: "sending" }, {
          $set: result.ok
            ? { status: "sent", sentAt: new Date(), error: null }
            : { status: "failed", error: result.error,
                nextAttemptAt: new Date(Date.now() + RETRY_MS[Math.min(notification.attempts - 1, RETRY_MS.length - 1)]) },
        });
      } catch (err) {
        log.error("admin notification delivery failed", { kind: notification.kind, message: err.message });
        await coll().updateOne({ _id: notification._id, status: "sending" }, {
          $set: { status: "failed", error: String(err.message).slice(0, 300),
            nextAttemptAt: new Date(Date.now() + RETRY_MS[Math.min(notification.attempts - 1, RETRY_MS.length - 1)]) },
        });
      }
    }
  } catch (err) {
    log.error("admin notification worker failed", { message: err.message });
  } finally {
    draining = false;
  }
}
