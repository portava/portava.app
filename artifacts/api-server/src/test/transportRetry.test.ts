/**
 * onceMoreOnTransportFailure — an idempotent PostgREST call that got no HTTP answer is tried once more; a database
 * error is not. See lib/transportRetry.ts for the production failure (2026-10-22) this exists for.
 *
 * Run: node --import tsx/esm --test src/test/transportRetry.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { onceMoreOnTransportFailure } from "../lib/transportRetry.js";

type Answer = { data: unknown; error: unknown; count: number | null; status: number };
const DROPPED: Answer = { data: null, error: { message: "TypeError: fetch failed", code: "" }, count: null, status: 0 };
const OK: Answer = { data: null, error: null, count: 4, status: 204 };

function calls(answers: Answer[]) {
  let n = 0;
  const call = () => { const a = answers[n]; n += 1; assert.ok(a, `unexpected call #${n}`); return Promise.resolve(a); };
  return { call, count: () => n };
}

describe("onceMoreOnTransportFailure", () => {
  it("status 0 (no HTTP answer) is tried once more, and the second answer is the result", async () => {
    const c = calls([DROPPED, OK]);
    assert.deepEqual(await onceMoreOnTransportFailure(c.call), OK);
    assert.equal(c.count(), 2);
  });

  it("a database error is an HTTP answer: returned as it is, not repeated", async () => {
    const denied: Answer = { data: null, error: { message: "permission denied", code: "42501" }, count: null, status: 403 };
    const c = calls([denied]);
    assert.deepEqual(await onceMoreOnTransportFailure(c.call), denied);
    assert.equal(c.count(), 1);
  });

  it("bounded: two dropped sockets return the second failure after exactly two calls", async () => {
    const c = calls([DROPPED, DROPPED]);
    assert.deepEqual(await onceMoreOnTransportFailure(c.call), DROPPED);
    assert.equal(c.count(), 2);
  });

  it("a success is not repeated", async () => {
    const c = calls([OK]);
    assert.deepEqual(await onceMoreOnTransportFailure(c.call), OK);
    assert.equal(c.count(), 1);
  });
});
