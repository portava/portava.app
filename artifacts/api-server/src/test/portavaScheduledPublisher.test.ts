/**
 * portavaScheduledPublisher.test.ts
 *
 * Confirms that the runDelayedPostPublisher worker correctly transitions
 * @Portava scheduled posts (post_status='pending_delay') to 'published'
 * when their publish_eligible_at time has passed — and leaves future-scheduled
 * posts untouched.
 *
 * Runtime: node:test  (no vitest / no supertest)
 * Run via: pnpm --filter @workspace/api-server test (api-test workflow)
 *
 * Covers:
 *   A. A pending_delay post whose publish_eligible_at is in the past is
 *      published (post_status set to 'published', published_at set).
 *   B. A pending_delay post whose publish_eligible_at is in the future is
 *      NOT published in the same worker tick.
 *   C. When the post store contains one past-eligible and one future-eligible
 *      post, only the eligible one is published — the other is untouched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runDelayedPostPublisher } from "../lib/delayedPostPublisher.js";

// ── Fake client ───────────────────────────────────────────────────────────────

/**
 * Builds a fake Supabase client whose posts query honours the `lte` filter on
 * `publish_eligible_at` so that future-eligible posts are excluded just as the
 * real PostgREST query would exclude them.
 */
function makeFakeClient(posts: any[]) {
  const updates: Array<{ table: string; patch: any; id: string }> = [];
  const inserts: Array<{ table: string; row: any }> = [];

  const client: any = {
    _updates: updates,
    _inserts: inserts,
    from(table: string) {
      if (table === "posts") {
        return {
          select: (_cols: string) => ({
            in: (_col: string, _vals: string[]) => ({
              /**
               * Honour the lte filter: only return posts whose
               * publish_eligible_at <= nowIso (the value passed by the worker).
               */
              lte: (_col2: string, nowIso: string) =>
                Promise.resolve({
                  data: posts.filter(
                    (p) => p.publish_eligible_at <= nowIso,
                  ),
                  error: null,
                }),
            }),
          }),
          update: (patch: any) => ({
            eq: (_col: string, id: string) => {
              updates.push({ table, patch, id });
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }

      // safe_return_sessions — no active sessions for any test case here
      if (table === "safe_return_sessions") {
        return {
          select: (_cols: string) => ({
            eq: (_col: string, _val: any) => ({
              eq: (_c2: string, _v2: any) => ({
                limit: (_n: number) => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }

      // delayed_post_location_events — accept inserts silently
      if (table === "delayed_post_location_events") {
        return {
          insert: (row: any) => {
            inserts.push({ table, row });
            return Promise.resolve({ data: null, error: null });
          },
        };
      }

      // job_health — accept upserts silently
      if (table === "job_health") {
        return {
          upsert: (_row: any, _opts?: any) =>
            Promise.resolve({ data: null, error: null }),
        };
      }

      // profiles (push token lookup) — no token
      return {
        select: (_cols: string) => ({
          eq: (_col: string, _val: any) => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
        insert: (row: any) => {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        upsert: (_row: any, _opts?: any) =>
          Promise.resolve({ data: null, error: null }),
      };
    },
  };

  return client;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PAST_ISO   = new Date(Date.now() - 60_000).toISOString();  // 1 min ago
const FUTURE_ISO = new Date(Date.now() + 60_000).toISOString();  // 1 min from now

const PORTAVA_AUTHOR_ID = "portava-uid-0000-0000-000000000001";

function makePendingDelayPost(overrides: Record<string, unknown> = {}) {
  return {
    id: "post-portava-pending-" + Math.random().toString(36).slice(2, 8),
    author_id: PORTAVA_AUTHOR_ID,
    post_status: "pending_delay",
    location_privacy_mode: "city_only",
    original_lat: null,
    original_lng: null,
    public_location_label: "Paris, France",
    publish_eligible_at: PAST_ISO,
    ...overrides,
  };
}

// ── A: past-eligible @Portava post is published ───────────────────────────────

describe("A: past-eligible @Portava pending_delay post is published", () => {
  it("transitions post_status to 'published' and records published_at", async () => {
    const post = makePendingDelayPost();
    const client = makeFakeClient([post]);

    const result = await runDelayedPostPublisher({ client });

    assert.equal(result.published, 1, "expected 1 published");
    assert.equal(result.skipped, 0,   "expected 0 skipped");
    assert.equal(result.errors, 0,    "expected 0 errors");

    const postUpdates = client._updates.filter((u: any) => u.table === "posts");
    assert.ok(postUpdates.length > 0, "should have issued a DB update for the post");

    const publishPatch = postUpdates.find(
      (u: any) => u.patch.post_status === "published",
    );
    assert.ok(publishPatch, "update must set post_status='published'");
    assert.ok(
      typeof publishPatch.patch.published_at === "string" &&
        publishPatch.patch.published_at.length > 0,
      "update must include a non-empty published_at timestamp",
    );
  });

  it("appends a 'published' event to delayed_post_location_events", async () => {
    const post = makePendingDelayPost({ id: "post-portava-event-test" });
    const client = makeFakeClient([post]);

    await runDelayedPostPublisher({ client });

    const evtInsert = client._inserts.find(
      (i: any) =>
        i.table === "delayed_post_location_events" &&
        i.row.event_type === "published" &&
        i.row.post_id === post.id,
    );
    assert.ok(
      evtInsert,
      "should have inserted a 'published' event row for the post",
    );
  });

  it("does NOT copy coordinates to public_lat/lng when mode is city_only", async () => {
    const post = makePendingDelayPost({
      location_privacy_mode: "city_only",
      original_lat: 48.86,
      original_lng: 2.35,
    });
    const client = makeFakeClient([post]);

    await runDelayedPostPublisher({ client });

    const publishPatch = client._updates.find(
      (u: any) => u.table === "posts" && u.patch.post_status === "published",
    );
    assert.ok(publishPatch, "post should be published");
    assert.equal(
      publishPatch.patch.public_lat,
      undefined,
      "city_only mode must not reveal public_lat",
    );
    assert.equal(
      publishPatch.patch.public_lng,
      undefined,
      "city_only mode must not reveal public_lng",
    );
  });
});

// ── B: future-eligible @Portava post is NOT published ────────────────────────

describe("B: future-eligible @Portava pending_delay post is NOT published", () => {
  it("returns published=0 and issues no post update when publish_eligible_at is in the future", async () => {
    const post = makePendingDelayPost({ publish_eligible_at: FUTURE_ISO });
    const client = makeFakeClient([post]);

    const result = await runDelayedPostPublisher({ client });

    assert.equal(result.published, 0, "future post must not be published yet");
    assert.equal(result.skipped, 0,   "future post is not skipped — it is simply not queried");
    assert.equal(result.errors, 0,    "no errors expected");

    const publishUpdates = client._updates.filter(
      (u: any) => u.table === "posts" && u.patch.post_status === "published",
    );
    assert.equal(
      publishUpdates.length,
      0,
      "no post update must be issued for a future-eligible post",
    );
  });
});

// ── C: mixed batch — only the past-eligible post is published ─────────────────

describe("C: mixed batch — past-eligible published, future-eligible held", () => {
  it("publishes only the post whose publish_eligible_at has passed", async () => {
    const pastPost = makePendingDelayPost({
      id: "post-portava-past",
      publish_eligible_at: PAST_ISO,
    });
    const futurePost = makePendingDelayPost({
      id: "post-portava-future",
      publish_eligible_at: FUTURE_ISO,
    });
    const client = makeFakeClient([pastPost, futurePost]);

    const result = await runDelayedPostPublisher({ client });

    assert.equal(result.published, 1, "exactly one post should be published");
    assert.equal(result.errors, 0,    "no errors expected");

    const publishedIds = client._updates
      .filter((u: any) => u.table === "posts" && u.patch.post_status === "published")
      .map((u: any) => u.id);

    assert.ok(
      publishedIds.includes(pastPost.id),
      "the past-eligible post must be published",
    );
    assert.ok(
      !publishedIds.includes(futurePost.id),
      "the future-eligible post must NOT be published",
    );
  });
});
