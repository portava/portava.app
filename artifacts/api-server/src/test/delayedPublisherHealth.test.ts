/**
 * delayedPostPublisher health — a tick that could not read posts is a RUN, not a SUCCESS.
 *
 * Production job_health, 2026-10-23: `delayed_post_publisher` had a last_run_at and a NULL last_success_at. The
 * publisher wrote the same row whether its selection query answered or failed, so /api/healthz/delayed-publish
 * (judged on last_run_at) read "ok" for a publisher that could not read a single post, and last_success_at was never
 * written. Now: every tick writes last_run_at, only a tick whose query answered writes last_success_at, and the health
 * read is judged on last_success_at.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/delayedPublisherHealth.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runDelayedPostPublisher, queryPublisherHealth, _setTestClient } from "../lib/delayedPostPublisher.js";

/** A client whose posts read answers `postsAnswer`; records every job_health upsert. */
function client(postsAnswer: { data: unknown; error: unknown }, jobHealthRow: Record<string, unknown> | null = null) {
  const upserts: Array<Record<string, unknown>> = [];
  return {
    upserts,
    from(table: string) {
      const b: any = {
        select: () => b, in: () => b, lte: () => b, eq: () => b,
        maybeSingle: () => Promise.resolve({ data: table === "job_health" ? jobHealthRow : null, error: null }),
        upsert: (row: Record<string, unknown>) => { if (table === "job_health") upserts.push(row); return Promise.resolve({ data: null, error: null }); },
        then: (f: any, r: any) => Promise.resolve(table === "posts" ? postsAnswer : { data: [], error: null }).then(f, r),
      };
      return b;
    },
  };
}

afterEach(() => _setTestClient(null));

describe("delayedPostPublisher — job health", () => {
  it("a tick whose query FAILED writes last_run_at and NOT last_success_at", async () => {
    const c = client({ data: null, error: { message: "permission denied", code: "42501" } });
    const r = await runDelayedPostPublisher({ client: c });
    assert.equal(r.errors, 1);
    assert.equal(c.upserts.length, 1);
    assert.equal(typeof c.upserts[0]!.last_run_at, "string");
    assert.equal("last_success_at" in c.upserts[0]!, false, `a failed tick must not record a success: ${JSON.stringify(c.upserts[0])}`);
  });

  it("a tick whose query answered writes last_success_at equal to last_run_at", async () => {
    const c = client({ data: [], error: null });
    const r = await runDelayedPostPublisher({ client: c });
    assert.deepEqual(r, { published: 0, skipped: 0, errors: 0 });
    assert.equal(c.upserts.length, 1);
    assert.equal(c.upserts[0]!.last_success_at, c.upserts[0]!.last_run_at);
  });

  it("health is judged on the last SUCCESS: a recent run with no success is critical", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    _setTestClient(client({ data: [], error: null }, { last_run_at: recent, last_success_at: null }));
    const h = await queryPublisherHealth();
    assert.equal(h.publisherStatus, "critical");
    assert.equal(h.lastRunAt, recent);
    assert.equal(h.lastSuccessAt, null);
  });

  it("a recent success is ok, and both times are reported", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    _setTestClient(client({ data: [], error: null }, { last_run_at: recent, last_success_at: recent }));
    assert.deepEqual(await queryPublisherHealth(), { publisherStatus: "ok", lastRunAt: recent, lastSuccessAt: recent });
  });
});
