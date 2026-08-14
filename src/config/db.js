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
  sessions: () => getDb().collection("sessions"),
};
