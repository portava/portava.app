/**
 * Sentry initialization for the API server.
 *
 * Must be imported BEFORE any other application modules so that Sentry can
 * instrument the process from the earliest possible moment.
 *
 * DSN is read from the SENTRY_DSN environment variable.  When SENTRY_DSN is
 * not set the call is a no-op: all Sentry SDK functions remain callable but
 * nothing is sent to the Sentry project.
 */

import * as Sentry from "@sentry/node";

const dsn = process.env["SENTRY_DSN"];

if (dsn) {
  // When the server is started with `node --import ./dist/sentry-preload.mjs`,
  // Sentry.init() has already been called in the preload before Express loaded.
  // Detect that case and skip a second init so the instrumentation hooks are
  // not double-registered; just emit the startup log confirming it is active.
  if (!Sentry.getClient()) {
    Sentry.init({
      dsn,
      // Include the environment so events are bucketed correctly in the Sentry UI.
      environment: process.env["NODE_ENV"] ?? "development",
      // Attach server-name to every event for multi-instance disambiguation.
      serverName: process.env["HOSTNAME"] ?? "api-server",
      // Capture 100 % of traces in development; tighten in production via env var.
      tracesSampleRate: process.env["NODE_ENV"] === "production" ? 0.1 : 1.0,
    });
  }
  // Deliberately avoid logging the DSN value.
  console.info("[sentry] Initialized — errors will be reported to Sentry");
} else {
  console.info("[sentry] SENTRY_DSN not set — Sentry reporting is disabled");
}

export { Sentry };
