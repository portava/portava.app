/**
 * foursquarePlaces.test.ts
 *
 * Unit tests for searchFoursquare() — verifies that Sentry is notified when
 * the Foursquare API key is rejected (401/403), and that the once-only guard
 * prevents the alert from firing more than once per process.
 *
 * Run:
 *   node --import tsx/esm --test \
 *     src/lib/foursquarePlaces.test.ts
 *
 * IMPORTANT — test ordering:
 *   foursquarePlaces.ts keeps a module-level `authFailedLogged` boolean.
 *   The tests in the "Sentry auth reporting" describe MUST run in declaration
 *   order: test 1 fires Sentry (guard was false → true); test 2 confirms the
 *   guard suppresses subsequent calls (guard stays true). node:test runs tests
 *   in declaration order, so this is safe as long as this file is the first
 *   test to call searchFoursquare with a 401 response.
 *
 *   That invariant holds because other test files in the suite do not set
 *   FOURSQUARE_API_KEY, so searchFoursquare returns early before reaching
 *   the auth-failure branch in every other test file.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── Module under test ─────────────────────────────────────────────────────────
// Static imports so both modules share a single instance; Sentry exported from
// sentry.ts is a plain mutable object, which lets us replace captureMessage.
import { searchFoursquare } from "./foursquarePlaces.js";
import { Sentry } from "./sentry.js";

// ── Sentry spy ────────────────────────────────────────────────────────────────
// sentry.ts re-exports Sentry as a plain mutable object (not the frozen ESM
// namespace), so we can safely replace individual methods here.  Both this
// file and foursquarePlaces.ts reference the same exported object, so the spy
// fires whenever foursquarePlaces.ts calls Sentry.captureMessage(…).

type CaptureCall = { message: string; opts: Record<string, unknown> };
let captureMessageCalls: CaptureCall[] = [];

const originalCaptureMessage = (Sentry as Record<string, unknown>)[
  "captureMessage"
] as (...args: unknown[]) => unknown;

// ── Setup ─────────────────────────────────────────────────────────────────────

const FAKE_KEY = "test-fsq-api-key-xyz987";
const originalFetch = globalThis.fetch;
const originalEnv = process.env["FOURSQUARE_API_KEY"];

beforeEach(() => {
  process.env["FOURSQUARE_API_KEY"] = FAKE_KEY;
  captureMessageCalls = [];
  (Sentry as Record<string, unknown>)["captureMessage"] = (
    message: unknown,
    opts: unknown,
  ): void => {
    captureMessageCalls.push({
      message: message as string,
      opts: (opts ?? {}) as Record<string, unknown>,
    });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env["FOURSQUARE_API_KEY"] = originalEnv;
  (Sentry as Record<string, unknown>)["captureMessage"] =
    originalCaptureMessage;
});

// ── helpers ───────────────────────────────────────────────────────────────────

function stubFetch(status: number): void {
  globalThis.fetch = async (): Promise<Response> =>
    ({
      ok: false,
      status,
      json: async () => ({ message: "stub" }),
    }) as Response;
}

// ── searchFoursquare — Sentry auth reporting ──────────────────────────────────
//
// Tests run in declaration order (node:test guarantee).
// Test 1: first 401 seen by the module → authFailedLogged is false →
//         captureMessage fires → authFailedLogged becomes true.
// Test 2: subsequent 401 → authFailedLogged is true → captureMessage must
//         NOT fire again (once-only guard verified).

describe("searchFoursquare — Sentry auth reporting", () => {
  it(
    "calls Sentry.captureMessage with level 'error' on the first 401 response",
    async () => {
      stubFetch(401);

      const result = await searchFoursquare("hotel");

      assert.deepEqual(result, [], "must return empty array on auth failure");
      assert.equal(
        captureMessageCalls.length,
        1,
        "captureMessage must be called exactly once for the first 401",
      );
      assert.equal(
        captureMessageCalls[0].opts["level"],
        "error",
        "captureMessage must be called with level 'error'",
      );
    },
  );

  it(
    "once-only guard: a second 401 does NOT call captureMessage again",
    async () => {
      // authFailedLogged is now true from the previous test — Sentry must stay silent.
      stubFetch(401);

      const result = await searchFoursquare("airport");

      assert.deepEqual(result, [], "must still return empty array");
      assert.equal(
        captureMessageCalls.length,
        0,
        "captureMessage must NOT fire again when authFailedLogged is already true",
      );
    },
  );
});
