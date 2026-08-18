/**
 * apiKeyEmptyVsAbsent — an empty secret must not look like a missing one.
 *
 * WHY THESE EXIST
 * ===============
 * `GOOGLE_PLACES_API_KEY` was reported present in the deployment environment
 * with a value of length 0, while `GOOGLE_MAPS_API_KEY` carried a real key. The
 * old guard on both photo routes was `if (!key)`, which collapses:
 *
 *   ABSENT           nobody set it — the secret needs creating
 *   PRESENT, EMPTY   somebody set it TO NOTHING — the secret exists, appears
 *                    configured in any list showing names rather than values,
 *                    and authenticates nothing
 *
 * into a single `no_*_key` reason, which the client then rendered as category
 * artwork like every other photo miss. So the state that most looks like
 * "configured" produced the evidence of "never configured", and an operator who
 * had just added the secret was told the one thing they knew was false.
 *
 * That is this workstream's governing invariant inside configuration: the
 * difference between two causes destroyed at the check rather than at the
 * source.
 *
 * HOW THESE TESTS ARE WRITTEN, AND WHY THAT MATTERS
 * =================================================
 * Every assertion goes THROUGH THE SANCTIONED SERVER PATH — a real request to
 * `/api/places/photo` and `/api/places/fsq-photo` on an ephemeral instance of
 * the actual app. No route internals are reached into, and no provider is
 * called directly with a key.
 *
 * No test here reads, logs, echoes or asserts on a key VALUE. They set env vars
 * to a fixed dummy and assert on the STATE the server reports. A test that
 * printed a key to prove it was set would be a worse defect than the one being
 * fixed.
 *
 * WHAT THESE TESTS CANNOT ESTABLISH
 * =================================
 * That a present, non-empty key is VALID. A wrong key is indistinguishable from
 * a right one until the upstream rejects it, and nothing local can close that
 * gap. These tests prove the three LOCAL states are told apart; the upstream's
 * own 401/403 carries the fourth.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { classifyApiKey, apiKeyFailureReason } from "../lib/apiKeyState.js";
import { readFileSync } from "node:fs";
import { FOURSQUARE_KEY_VARS, snapshotKeyEnv, restoreKeyEnv, clearKeyEnv, setKeyEnv } from "./helpers/apiKeyEnv.js";

function makeFakeClient(): any {
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
}

function startServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port as number;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

/** Hit a photo route through HTTP, exactly as the client does. */
async function get(baseUrl: string, route: string, name: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${route}?${new URLSearchParams({ name })}`);
  return { status: res.status, body: await res.json() };
}

const originalGoogleKey = process.env.GOOGLE_MAPS_API_KEY;
const originalFsqEnv = snapshotKeyEnv(FOURSQUARE_KEY_VARS);
const originalFetch = globalThis.fetch;

/** Restore an env var, distinguishing "was absent" from "was set". */
function restoreEnv(name: string, saved: string | undefined): void {
  if (saved === undefined) delete process.env[name];
  else process.env[name] = saved;
}

// ── The pure classifier ───────────────────────────────────────────────────────

describe("classifyApiKey — three local states, never collapsed", () => {
  it("distinguishes absent from empty from present", () => {
    assert.equal(classifyApiKey(undefined), "absent");
    assert.equal(classifyApiKey(""), "empty");
    assert.equal(classifyApiKey("a-real-looking-key"), "present");
  });

  it("treats whitespace-only as EMPTY, not present", () => {
    // A value of " " is a paste accident. Calling it present would send a blank
    // credential upstream and convert a local misconfiguration into a remote
    // auth error, which is a worse and more confusing report.
    assert.equal(classifyApiKey("   "), "empty");
    assert.equal(classifyApiKey("\n"), "empty");
  });

  it("emits different reasons for the two faults", () => {
    // ABSENT keeps its pre-existing wire string; only EMPTY needed a new name.
    assert.equal(apiKeyFailureReason("absent", "google"), "no_google_maps_key");
    assert.equal(apiKeyFailureReason("empty", "google"), "google_key_present_but_empty");
    assert.notEqual(
      apiKeyFailureReason("absent", "google"),
      apiKeyFailureReason("empty", "google"),
      "the whole point: these are different faults needing different fixes",
    );
  });
});

// ── GET /api/places/photo — the Google fallback ───────────────────────────────

describe("GET /api/places/photo — key absent vs present-but-empty", () => {
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await closeServer(server);
    restoreEnv("GOOGLE_MAPS_API_KEY", originalGoogleKey);
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    // Fail loudly if any test in this block reaches a provider: with no usable
    // key, nothing should be sent upstream at all.
    // Loopback passes through — that is the test's own request to the app under
    // test. Anything else is an OUTBOUND provider call, which must not happen
    // when the key is unusable; making it throw turns "we quietly called anyway"
    // into a visible failure instead of a silent pass.
    globalThis.fetch = (async (input: any, init?: any) => {
      const target = String(typeof input === "string" ? input : input?.url ?? input);
      if (target.includes("127.0.0.1") || target.includes("localhost")) {
        return originalFetch(input, init);
      }
      throw new Error(`no upstream request may be made when the key is unusable: ${target}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv("GOOGLE_MAPS_API_KEY", originalGoogleKey);
  });

  it("reports the existing 'no_google_maps_key' when the variable is not set at all", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const { status, body } = await get(url, "/api/places/photo", "Cebu Zoo");

    assert.equal(status, 200, "still degrades gracefully rather than throwing");
    assert.equal(body.photoUrl, null);
    assert.equal(body.reason, "no_google_maps_key", `got '${body.reason as string}'`);
  });

  it("reports 'google_key_present_but_empty' when the value is empty", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "";
    const { status, body } = await get(url, "/api/places/photo", "Cebu Zoo");

    assert.equal(status, 200);
    assert.equal(body.photoUrl, null);
    assert.equal(
      body.reason,
      "google_key_present_but_empty",
      `an empty-but-present key must not report as absent; got '${body.reason as string}'`,
    );
  });

  it("reports the empty case for a whitespace-only value too", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "   ";
    const { body } = await get(url, "/api/places/photo", "Cebu Zoo");
    assert.equal(body.reason, "google_key_present_but_empty");
  });

  it("NEVER returns the same reason for the two states", async () => {
    // The regression this file exists to prevent, stated as one assertion.
    delete process.env.GOOGLE_MAPS_API_KEY;
    const absent = (await get(url, "/api/places/photo", "Cebu Zoo")).body.reason;

    process.env.GOOGLE_MAPS_API_KEY = "";
    const empty = (await get(url, "/api/places/photo", "Cebu Zoo")).body.reason;

    assert.notEqual(absent, empty, "collapsing these back into one reason is the bug");
  });

  it("never leaks a key value into the response", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "super-secret-value-do-not-echo";
    // A present key means the route proceeds to the upstream call, which the
    // stubbed fetch rejects — the point is only that the body carries no value.
    const { body } = await get(url, "/api/places/photo", "Cebu Zoo");
    assert.ok(
      !JSON.stringify(body).includes("super-secret-value-do-not-echo"),
      "a key value must never appear in a response body",
    );
  });
});

// ── GET /api/places/fsq-photo — same distinction, same reason ────────────────

describe("GET /api/places/fsq-photo — key absent vs present-but-empty", () => {
  let server: Server;
  let url: string;

  before(async () => {
    ({ server, url } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });

  after(async () => {
    _setTestClient(null, false);
    await closeServer(server);
    restoreKeyEnv(originalFsqEnv);
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    // Loopback passes through — that is the test's own request to the app under
    // test. Anything else is an OUTBOUND provider call, which must not happen
    // when the key is unusable; making it throw turns "we quietly called anyway"
    // into a visible failure instead of a silent pass.
    globalThis.fetch = (async (input: any, init?: any) => {
      const target = String(typeof input === "string" ? input : input?.url ?? input);
      if (target.includes("127.0.0.1") || target.includes("localhost")) {
        return originalFetch(input, init);
      }
      throw new Error(`no upstream request may be made when the key is unusable: ${target}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreKeyEnv(originalFsqEnv);
  });

  it("reports the existing 'no_foursquare_key' when the variable is not set", async () => {
    clearKeyEnv(FOURSQUARE_KEY_VARS);
    const { status, body } = await get(url, "/api/places/fsq-photo", "Cebu Zoo");
    assert.equal(status, 200);
    assert.equal(body.photoUrl, null);
    assert.equal(body.reason, "no_foursquare_key", `got '${body.reason as string}'`);
  });

  it("reports 'foursquare_key_present_but_empty' when the value is empty", async () => {
    setKeyEnv(FOURSQUARE_KEY_VARS, "");
    const { body } = await get(url, "/api/places/fsq-photo", "Cebu Zoo");
    assert.equal(
      body.reason,
      "foursquare_key_present_but_empty",
      `got '${body.reason as string}'`,
    );
  });

  it("does not cache an unusable-key answer", async () => {
    // A key fault is not a fact about the place. Caching it would keep serving
    // "no photo" for this place after the secret is corrected — a stale answer
    // outliving the fix, which is how the original silence worked.
    setKeyEnv(FOURSQUARE_KEY_VARS, "");
    const first = (await get(url, "/api/places/fsq-photo", "Cache Probe Venue")).body;
    assert.equal(first.reason, "foursquare_key_present_but_empty");

    restoreKeyEnv(originalFsqEnv);
    setKeyEnv(FOURSQUARE_KEY_VARS, "now-a-real-looking-key");
    const second = (await get(url, "/api/places/fsq-photo", "Cache Probe Venue")).body;

    assert.notEqual(
      second.reason,
      "foursquare_key_present_but_empty",
      "the key fault was cached and survived the fix",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drift guard: the neutralise-list must track the resolver
// ─────────────────────────────────────────────────────────────────────────────
//
// This exists because the failure it prevents already happened. When the
// Foursquare key gained a dev/prod split, resolveFoursquareApiKey started
// preferring FSQ_API_KEY_DEV, and six tests across three files kept clearing
// only FOURSQUARE_API_KEY. They read as absent-key tests and were not: the key
// still resolved, the route called Foursquare, and the tests failed for a
// reason unrelated to what they assert. Two further tests INJECTED a fake key
// that the code never saw and passed anyway — green for the wrong reason, one
// failed fetch stub away from spending live quota.
//
// Nothing in the type system connects a resolver's env reads to the list a test
// must neutralise, so this asserts it by reading the resolver's own source. If
// someone adds FSQ_API_KEY_STAGING to the resolver, this fails until
// FOURSQUARE_KEY_VARS is updated — which is what makes the next split announce
// itself instead of silently rotting the suite.
describe("api key env: the neutralise-list tracks the resolver", () => {
  it("FOURSQUARE_KEY_VARS names exactly the variables resolveFoursquareApiKey reads", () => {
    const src = readFileSync(
      new URL("../lib/foursquareApiKey.ts", import.meta.url),
      "utf8",
    );

    // Strip block and line comments: the module documents the variables in
    // prose, and matching prose would make this pass for the wrong reason.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    const referenced = new Set(code.match(/\b(?:FSQ_API_KEY_[A-Z]+|FOURSQUARE_API_KEY)\b/g) ?? []);

    assert.deepEqual(
      [...referenced].sort(),
      [...FOURSQUARE_KEY_VARS].sort(),
      "resolveFoursquareApiKey reads a set of env vars that FOURSQUARE_KEY_VARS does not match — " +
      "update src/test/helpers/apiKeyEnv.ts, or every absent-key test for this provider is now lying",
    );
  });
});
