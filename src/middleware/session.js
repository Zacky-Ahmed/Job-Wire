// session.js
//
// Cookie sessions stored in Mongo. Cookie flags are the CSRF and
// session-theft defence, so none of these are optional:
//
//   httpOnly  document.cookie cannot read it, so XSS cannot steal it
//   secure    never sent over plain HTTP in production
//   sameSite  the browser refuses to attach it to cross-site POSTs,
//             which blocks the classic CSRF shape on its own

import session from "express-session";
import MongoStore from "connect-mongo";
import { env } from "../config/env.js";
import { getClient } from "../config/db.js";

export function buildSession() {
  return session({
    name: "jw.sid", // not "connect.sid" — do not advertise the stack
    secret: env.sessionSecret,
    resave: false,
    saveUninitialized: false, // no cookie until there is something to store
    rolling: true, // sliding expiry: active users are not logged out mid-session
    store: MongoStore.create({
      // Reuse the app's client instead of mongoUrl, which would open a
      // second MongoClient: that cost ~9s of extra Atlas handshake at
      // boot and doubled the connection count against the free tier.
      client: getClient(),
      dbName: env.mongoDb,
      collectionName: "sessions",
      ttl: 60 * 60 * 24 * 14, // 14 days
      touchAfter: 3600, // only rewrite the session doc hourly, not per request
      // NOTE: connect-mongo's `crypto` option is deliberately NOT used.
      // In 5.1.0 it writes successfully but throws on read
      // ("[object Object]" is not valid JSON), which breaks every request
      // that touches an existing session. Sessions hold only a user id,
      // the collection needs Atlas credentials to reach, and the cookie
      // itself is signed — so this costs defence-in-depth, not security.
    }),
    cookie: {
      httpOnly: true,
      secure: env.isProd, // requires trust proxy on Render, set in server.js
      sameSite: "lax", // blocks cross-site POST; "strict" would break email links
      maxAge: 1000 * 60 * 60 * 24 * 14,
      path: "/",
    },
  });
}
