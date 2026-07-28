/**
 * Sentry pre-load bootstrap — loaded via `node --import ./dist/sentry-preload.mjs`
 * BEFORE the main application bundle.
 *
 * Calling Sentry.init() here ensures that Express (and other packages) are
 * instrumented by the OpenTelemetry hooks before those packages are first
 * require()'d by the application bundle.  When the main bundle's lib/sentry.ts
 * module later runs, it detects that the SDK is already initialised and skips
 * a second init() call.
 *
 * Keeping this file as a separate esbuild entry point (with @sentry/node
 * externalised) ensures the same runtime module instance is shared with the
 * main bundle and both benefit from the single Sentry.init() call made here.
 */

import * as Sentry from "@sentry/node";

const dsn = process.env["SENTRY_DSN"];

if (dsn) {
  Sentry.init({
    dsn,
    // Include the environment so events are bucketed correctly in the Sentry UI.
    environment: process.env["NODE_ENV"] ?? "development",
    // Attach server-name to every event for multi-instance disambiguation.
    serverName: process.env["HOSTNAME"] ?? "api-server",
    // Capture 100 % of traces in development; tighten in production via env var.
    tracesSampleRate: process.env["NODE_ENV"] === "production" ? 0.1 : 1.0,
    // In an esbuild ESM bundle, OTel's shimmer cannot intercept static CJS
    // module imports (express, etc.) because the ESM module loader resolves
    // them before any user code runs — even with --import preload timing.
    // Express errors ARE still captured via Sentry.setupExpressErrorHandler()
    // in app.ts; this flag suppresses the misleading "not instrumented" warning
    // that fires when OTel's isWrapped() check finds unshimmed CJS modules.
    disableInstrumentationWarnings: true,
  });
}
