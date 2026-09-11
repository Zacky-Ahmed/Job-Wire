// db.js
//
// One MongoClient for the whole process, connected at boot and reused.
// A single pool is the main reason this app is not serverless — every
// cold start would otherwise open new connections and exhaust the
// Atlas free tier's limit.

import { MongoClient } from "mongodb";
import { env } from "./env.js";
import { log } from "../utils/logger.js";

let client = null;
let db = null;

export async function connectDb() {
  if (db) return db;

  client = new MongoClient(env.mongoUri, {
    // Small pool: the poller is the only heavy user and it runs
    // sequentially. Atlas M0 caps at 500 connections across everything.
    maxPoolSize: 10,
    minPoolSize: 1,
    // Fail fast at boot rather than hanging on a bad URI or blocked IP.
    serverSelectionTimeoutMS: 8000,
    retryWrites: true,
  });

  await client.connect();
  db = client.db(env.mongoDb);

  // Prove the connection rather than trusting that connect() resolved.
  await db.command({ ping: 1 });
  log.info("mongo connected", { database: env.mongoDb });

  return db;
}

/**
 * The live MongoClient, for anything that would otherwise open its own
 * connection — connect-mongo in particular. A second client means a
 * second full Atlas handshake at boot and twice the connections against
 * the free tier's limit, for no benefit.
 */
export function getClient() {
  if (!client) throw new Error("getClient() called before connectDb()");
  return client;
}

export function getDb() {
  if (!db) throw new Error("getDb() called before connectDb() — check server boot order.");
  return db;
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

// Collection accessors. Named in one place so a typo is a crash at
// startup, not a silently empty query six weeks from now.
export const collections = {
  users: () => getDb().collection("users"),
  queries: () => getDb().collection("queries"),
  subscriptions: () => getDb().collection("subscriptions"),
  seenJobs: () => getDb().collection("seenJobs"),
  emailLog: () => getDb().collection("emailLog"),
  // What has ever been EMAILED, as opposed to what the wire has shown.
  // Outlives seenJobs on purpose; see models/alertedJobs.js.
  alertedJobs: () => getDb().collection("alertedJobs"),
  /* Durable promises to tell one person about one job.

     Separate from emailLog, which records ATTEMPTS. An obligation
     outlives its attempts: it is created before the first provider call
     and removed only by being delivered or by the watch disappearing.
     See models/outbox.js for why the two cannot be the same table. */
  outbox: () => getDb().collection("outbox"),
  /* What each source and surface DID on each sweep. Small rows, short
     TTL: enough history to tell a quiet fortnight from a broken parser,
     which one aggregate count never could. */
  observations: () => getDb().collection("observations"),
  // One document. The poller's own heartbeat, so "is it running?" is a
  // measurement rather than a restatement of POLLER_ENABLED.
  pollerState: () => getDb().collection("pollerState"),
  /* WHO MAY CRAWL. Its own collection, deliberately not the poller
     heartbeat row it used to share.

     The heartbeat wrote leaseOwner on every tick, so a process that had
     already lost the lease stamped its name back over the winner's.
     Telemetry must not be able to write a field that decides authority. */
  pollerLease: () => getDb().collection("pollerLease"),
  sessions: () => getDb().collection("sessions"),
};
