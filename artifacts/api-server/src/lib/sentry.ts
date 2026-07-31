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

import * as _Sentry from "@sentry/node";

const dsn = process.env["SENTRY_DSN"];

if (dsn) {
  // When the server is started with `node --import ./dist/sentry-preload.mjs`,
  // Sentry.init() has already been called in the preload before Express loaded.
  // Detect that case and skip a second init so the instrumentation hooks are
  // not double-registered; just emit the startup log confirming it is active.
  if (!_Sentry.getClient()) {
    // Fallback: the --import sentry-preload.mjs did not share the same @sentry/node
    // module instance (e.g. the dist was stale or module resolution diverged).
    // Initialize here so error reporting still works, and suppress the
    // "express is not instrumented" warning — request context IS available via
    // setupExpressErrorHandler() registered in app.ts, just without OTel wrapping.
    _Sentry.init({
      dsn,
      // Include the environment so events are bucketed correctly in the Sentry UI.
      environment: process.env["NODE_ENV"] ?? "development",
      // Attach server-name to every event for multi-instance disambiguation.
      serverName: process.env["HOSTNAME"] ?? "api-server",
      // Capture 100 % of traces in development; tighten in production via env var.
      tracesSampleRate: process.env["NODE_ENV"] === "production" ? 0.1 : 1.0,
      // OTel cannot wrap Express in an esbuild ESM bundle (the ESM loader resolves
      // external CJS imports synchronously before any preload code runs).  Suppress
      // the resulting "express is not instrumented" console warning — errors are
      // still captured with full request context via setupExpressErrorHandler().
      disableInstrumentationWarnings: true,
    });
  }
  // Deliberately avoid logging the DSN value.
  console.info("[sentry] Initialized — errors will be reported to Sentry");
} else {
  console.info("[sentry] SENTRY_DSN not set — Sentry reporting is disabled");
}

// Re-export through a plain mutable object so tests can stub individual
// methods (e.g. captureMessage) without requiring loader-hook infrastructure.
// In production this is functionally identical — all calls delegate to the
// same function references that Sentry.init() bound to the global scope.
export const Sentry: typeof _Sentry = { ..._Sentry } as unknown as typeof _Sentry;
