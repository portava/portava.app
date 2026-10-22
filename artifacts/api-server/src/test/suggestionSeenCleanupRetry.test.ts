/**
 * purgeExpiredSuggestionSeen — a transport failure is retried once; a database error is not.
 *
 * Production, 2026-10-22: GET /api/healthz/schedulers read `suggestionSeenCleanup: failing` for a day. Every DELETE the
 * edge log holds answered 204; the failing pass's DELETE is not in it at all — the request got no HTTP answer
 * (supabase-js: `TypeError: fetch failed`, status 0), consistent with a pooled socket that died while the Autoscale
 * container was frozen. That pass overwrote a successful one from 27 s earlier. The DELETE is idempotent, so a
 * status-0 failure is retried once.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/suggestionSeenCleanupRetry.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { purgeExpiredSuggestionSeen, getSuggestionSeenStatus } from "../lib/suggestionSeenCleanup.js";

type Answer = { error: unknown; count: number | null; status: number };
const DROPPED: Answer = { error: { message: "TypeError: fetch failed", code: "" }, count: null, status: 0 };

/** A client whose DELETEs answer `answers` in order; records each call's table and filter. */
function client(answers: Answer[]) {
  const calls: Array<{ table: string; col: string }> = [];
  return {
    calls,
    from(table: string) {
      return {
        delete(opts: unknown) {
          assert.deepEqual(opts, { count: "exact" });
          return {
            lt(col: string) {
              calls.push({ table, col });
              const a = answers[calls.length - 1];
              assert.ok(a, `unexpected DELETE #${calls.length}`);
              return Promise.resolve(a);
            },
          };
        },
      };
    },
  };
}

describe("purgeExpiredSuggestionSeen — transport retry", () => {
  it("a dropped socket (status 0) is retried once, and the retry's success is the outcome", async () => {
    const c = client([DROPPED, { error: null, count: 3, status: 204 }]);
    const r = await purgeExpiredSuggestionSeen({ client: c });
    assert.equal(c.calls.length, 2);
    assert.deepEqual(c.calls.map((x) => `${x.table}.${x.col}`), ["user_suggestion_seen.expires_at", "user_suggestion_seen.expires_at"]);
    assert.deepEqual(r, { deleted: 3, error: null });
    assert.equal(getSuggestionSeenStatus().lastOutcome, "success");
  });

  it("a database error (an HTTP answer) is NOT retried — it is a real failure", async () => {
    const pg: Answer = { error: { message: "permission denied", code: "42501" }, count: null, status: 403 };
    const c = client([pg]);
    const r = await purgeExpiredSuggestionSeen({ client: c });
    assert.equal(c.calls.length, 1);
    assert.equal(r.deleted, null);
    assert.equal(getSuggestionSeenStatus().lastOutcome, "error");
  });

  it("the retry is bounded: two dropped sockets is an error after exactly two attempts", async () => {
    const c = client([DROPPED, DROPPED]);
    const r = await purgeExpiredSuggestionSeen({ client: c });
    assert.equal(c.calls.length, 2);
    assert.equal(r.deleted, null);
    assert.equal(getSuggestionSeenStatus().lastOutcome, "error");
  });

  it("a first-try success makes one call", async () => {
    const c = client([{ error: null, count: 0, status: 204 }]);
    const r = await purgeExpiredSuggestionSeen({ client: c });
    assert.equal(c.calls.length, 1);
    assert.deepEqual(r, { deleted: 0, error: null });
    assert.equal(getSuggestionSeenStatus().lastOutcome, "success");
  });
});
