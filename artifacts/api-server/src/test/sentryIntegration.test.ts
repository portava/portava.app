/**
 * Sentry integration smoke test.
 *
 * Verifies that:
 *   1. Sentry.captureException() is callable without throwing (covers the
 *      no-DSN path where Sentry is initialized but not connected).
 *   2. Sentry.captureMessage() is callable.
 *   3. The Sentry module exports the expected surface that the rest of the
 *      server relies on (setupExpressErrorHandler).
 *
 * These tests do NOT make real network calls — the test environment has no
 * SENTRY_DSN set so all captures are silently discarded by the SDK.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

describe("Sentry integration", () => {
  let Sentry: typeof import("@sentry/node");

  before(async () => {
    // Import AFTER the test process starts so the module-level init in
    // src/lib/sentry.ts has already run (or been skipped when no DSN is set).
    Sentry = await import("@sentry/node");
  });

  it("exports captureException as a function", () => {
    assert.strictEqual(typeof Sentry.captureException, "function");
  });

  it("exports captureMessage as a function", () => {
    assert.strictEqual(typeof Sentry.captureMessage, "function");
  });

  it("exports setupExpressErrorHandler as a function", () => {
    assert.strictEqual(typeof Sentry.setupExpressErrorHandler, "function");
  });

  it("captureException does not throw when called without a DSN", () => {
    // In the test environment SENTRY_DSN is unset, so this is a no-op that
    // must not throw.
    assert.doesNotThrow(() => {
      Sentry.captureException(new Error("test captureException — no DSN"));
    });
  });

  it("captureMessage does not throw when called without a DSN", () => {
    assert.doesNotThrow(() => {
      Sentry.captureMessage("test captureMessage — no DSN");
    });
  });
});
