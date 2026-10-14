/**
 * Management API 429 retry (src/scripts/lib/managementApiThrottle.ts) — the
 * bounded retry every Management API caller of certify:migrations shares
 * (certify itself, check:migration-ledger, audit:schema,
 * check:missing-live-columns), and so live-db.yml and beta-db.yml too.
 *
 * Why: beta-db run 38071891814 recorded 51 of 70 stage-4 postconditions as
 * "POSTCONDITION FAILED — Management API 429: ThrottlerException" — the
 * platform refused to answer, which is not a fact about the database.
 *
 * Pinned here: only 429 is retried; Retry-After (seconds or HTTP-date) is a
 * floor the wait honours, clamped; otherwise exponential backoff; jitter is
 * always ADDED; attempts and total wait are bounded and the last 429 is
 * returned (the caller fails exactly as before); every other status and a
 * transport error reach the caller on the first attempt; each caller is wired.
 *
 * Run: node --import tsx/esm --test src/test/managementApiThrottle.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MANAGEMENT_API_THROTTLE_RETRY,
  fetchWithThrottleRetry,
  parseRetryAfterMs,
  throttleDelayMs,
  type ThrottleRetryPolicy,
} from "../scripts/lib/managementApiThrottle.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, "..", "scripts");
const THROTTLED_BODY = JSON.stringify({ message: "ThrottlerException: Too Many Requests" });

function harness(responses: Array<() => Response>, policy?: Partial<ThrottleRetryPolicy>, random = () => 0.5) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  let i = 0;
  const now = 1_700_000_000_000;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return next();
  }) as unknown as typeof fetch;
  const deps = {
    fetchImpl,
    sleep: async (ms: number) => { sleeps.push(ms); },
    random,
    now: () => now,
    log: (l: string) => logs.push(l),
    policy: { ...MANAGEMENT_API_THROTTLE_RETRY, ...policy },
  };
  return { calls, sleeps, logs, deps, now };
}
const r429 = (headers: Record<string, string> = {}) => () => new Response(THROTTLED_BODY, { status: 429, headers });
const ok = (body = "[]") => () => new Response(body, { status: 201 });
const INIT: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "select 1" }) };

describe("only 429 is retried; the result is the first non-429 response", () => {
  it("429, 429, then 201: three requests, two waits, the 201 is returned and its body intact", async () => {
    const h = harness([r429(), r429(), ok('[{"x":1}]')]);
    const res = await fetchWithThrottleRetry("https://api.supabase.com/v1/projects/p/database/query", INIT, h.deps);
    assert.equal(res.status, 201);
    assert.equal(await res.text(), '[{"x":1}]');
    assert.equal(h.calls.length, 3);
    assert.equal(h.sleeps.length, 2);
    assert.equal(h.logs.filter((l) => /retry \d+\/7/.test(l)).length, 2);
  });

  it("the identical request is resent: same URL, same method, same body, every attempt", async () => {
    const h = harness([r429(), r429(), ok()]);
    await fetchWithThrottleRetry("https://x/q", INIT, h.deps);
    for (const c of h.calls) {
      assert.equal(c.url, "https://x/q");
      assert.equal(c.init.method, "POST");
      assert.equal(c.init.body, INIT.body);
    }
  });

  for (const status of [200, 201, 400, 401, 403, 404, 500, 502, 503, 504]) {
    it(`status ${status} reaches the caller on the first attempt, unretried and unread`, async () => {
      const resp = new Response("body", { status });
      const h = harness([() => resp, ok()]);
      const res = await fetchWithThrottleRetry("https://x/q", INIT, h.deps);
      assert.equal(res, resp, "the very same Response object");
      assert.equal(h.calls.length, 1);
      assert.equal(h.sleeps.length, 0);
      assert.equal(await res.text(), "body");
    });
  }

  it("a transport error (fetch throws) propagates on the first attempt — whether it ran is unknown, so it is not resent", async () => {
    let n = 0;
    const deps = { ...harness([ok()]).deps, fetchImpl: (async () => { n++; throw new TypeError("fetch failed"); }) as unknown as typeof fetch };
    await assert.rejects(fetchWithThrottleRetry("https://x/q", INIT, deps), /fetch failed/);
    assert.equal(n, 1);
  });

  it("a non-string body is refused before anything is sent", async () => {
    const h = harness([ok()]);
    await assert.rejects(
      fetchWithThrottleRetry("https://x/q", { method: "POST", body: new Uint8Array([1]) as unknown as BodyInit }, h.deps),
      /body must be a string/,
    );
    assert.equal(h.calls.length, 0);
  });
});

describe("bounded: attempts and total wait", () => {
  it("always 429: exactly maxAttempts requests, maxAttempts-1 waits, and the LAST 429 is returned for the caller to fail on", async () => {
    const h = harness([r429()]);
    const res = await fetchWithThrottleRetry("https://x/q", INIT, h.deps);
    assert.equal(res.status, 429);
    assert.equal(await res.text(), THROTTLED_BODY, "the caller's error text is the platform's, as before");
    assert.equal(h.calls.length, MANAGEMENT_API_THROTTLE_RETRY.maxAttempts);
    assert.equal(h.sleeps.length, MANAGEMENT_API_THROTTLE_RETRY.maxAttempts - 1);
    assert.ok(h.logs.some((l) => /giving up after 8 attempt/.test(l)), h.logs.join("\n"));
  });

  it("the waits of one call never sum past maxTotalWaitMs (Retry-After 60 s, total 180 s: three waits, then give up)", async () => {
    const h = harness([r429({ "retry-after": "60" })], {}, () => 0);
    const res = await fetchWithThrottleRetry("https://x/q", INIT, h.deps);
    assert.equal(res.status, 429);
    assert.deepEqual(h.sleeps, [60_000, 60_000, 60_000]);
    assert.ok(h.sleeps.reduce((a, b) => a + b, 0) <= MANAGEMENT_API_THROTTLE_RETRY.maxTotalWaitMs);
    assert.equal(h.calls.length, 4);
  });

  it("the default policy is bounded in both dimensions", () => {
    assert.ok(MANAGEMENT_API_THROTTLE_RETRY.maxAttempts >= 2 && MANAGEMENT_API_THROTTLE_RETRY.maxAttempts <= 10);
    assert.ok(MANAGEMENT_API_THROTTLE_RETRY.maxTotalWaitMs <= 5 * 60_000);
    assert.ok(Object.isFrozen(MANAGEMENT_API_THROTTLE_RETRY));
  });
});

describe("the wait: Retry-After honoured, otherwise exponential backoff; jitter always added", () => {
  const P = MANAGEMENT_API_THROTTLE_RETRY;

  it("Retry-After in seconds is a floor (plus jitter), whatever the attempt", async () => {
    const h = harness([r429({ "retry-after": "3" }), r429({ "retry-after": "3" }), ok()], {}, () => 0.25);
    await fetchWithThrottleRetry("https://x/q", INIT, h.deps);
    assert.deepEqual(h.sleeps, [3_000 + 250, 3_000 + 250]);
    assert.ok(h.logs[0]!.includes("Retry-After 3.0s"), h.logs[0]);
  });

  it("Retry-After as an HTTP-date is the time until then", async () => {
    const h = harness([], {}, () => 0);
    const at = new Date(h.now + 5_000).toUTCString();
    const h2 = harness([r429({ "retry-after": at }), ok()], {}, () => 0);
    await fetchWithThrottleRetry("https://x/q", INIT, h2.deps);
    assert.ok(h2.sleeps[0]! >= 4_000 && h2.sleeps[0]! <= 5_000, String(h2.sleeps[0]));
  });

  it("a Retry-After above the cap is clamped to maxRetryAfterMs, not obeyed and not refused", async () => {
    const h = harness([r429({ "retry-after": "3600" }), ok()], {}, () => 0);
    await fetchWithThrottleRetry("https://x/q", INIT, h.deps);
    assert.deepEqual(h.sleeps, [P.maxRetryAfterMs]);
  });

  it("no Retry-After: 1 s, 2 s, 4 s, 8 s, 16 s, then capped at 30 s (each plus jitter)", () => {
    const zero = () => 0;
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => throttleDelayMs(n, null, P, zero)), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    const max = () => 0.999;
    for (const n of [1, 3, 7]) {
      const d = throttleDelayMs(n, null, P, max);
      const base = Math.min(P.maxDelayMs, P.baseDelayMs * 2 ** (n - 1));
      assert.ok(d >= base && d < base + P.maxJitterMs, `${n}: ${d}`);
    }
  });

  it("jitter is added on top of Retry-After, never subtracted (a Retry-After is never undercut)", () => {
    for (const r of [0, 0.3, 0.999]) assert.ok(throttleDelayMs(1, 2_000, P, () => r) >= 2_000);
  });

  it("parseRetryAfterMs: seconds, fractional seconds, dates, junk", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    assert.equal(parseRetryAfterMs("0", now), 0);
    assert.equal(parseRetryAfterMs("7", now), 7_000);
    assert.equal(parseRetryAfterMs(" 2 ", now), 2_000);
    assert.equal(parseRetryAfterMs("1.5", now), 1_500);
    assert.equal(parseRetryAfterMs("Wed, 14 Oct 2026 12:00:09 GMT", now), 9_000);
    assert.equal(parseRetryAfterMs("Wed, 14 Oct 2026 11:59:00 GMT", now), 0, "a past date is now");
    for (const junk of [null, undefined, "", "soon", "-5", "12abc"]) assert.equal(parseRetryAfterMs(junk as string | null, now), null, String(junk));
  });
});

describe("every Management API caller certify:migrations runs is wired through it", () => {
  // certify:migrations itself (stages 2-4), stage 1's check:migration-ledger, stage 5's audit:schema and
  // check:missing-live-columns; beta-db.yml also runs audit:schema as its own step.
  for (const f of ["certifyMigrations.ts", "checkMigrationLedger.ts", "auditMigrationsVsLive.ts", "checkMissingLiveColumns.ts"]) {
    it(`${f}: its Management API request goes through fetchWithThrottleRetry, and no bare fetch() is left`, () => {
      const src = readFileSync(join(SCRIPTS, f), "utf8");
      assert.match(src, /^import \{ fetchWithThrottleRetry \} from "\.\/lib\/managementApiThrottle\.js";$/m);
      const calls = [...src.matchAll(/\bfetchWithThrottleRetry\(/g)].length;
      assert.equal(calls, 1, "exactly one Management API request site");
      assert.doesNotMatch(src.replace(/^\s*(?:\/\/|\*).*$/gm, ""), /(?<![A-Za-z])await fetch\(/, "a bare fetch() would bypass the retry");
      assert.match(src, /api\.supabase\.com\/v1\/projects\/|ENDPOINT/, "it is the Management API caller");
    });
  }
});
