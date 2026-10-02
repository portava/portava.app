/**
 * Unit tests for excludePrivateAuthorPosts (src/lib/privacyFilter.ts)
 *
 * Verifies that:
 *   1. Empty rows → empty result (fast-path)
 *   2. All public authors → all rows returned unchanged
 *   3. Private author post hidden from non-follower
 *   4. Private author post visible to approved follower
 *   5. Viewer's own posts always pass (self-exempt)
 *   6. Mix of public + private + followed-private + own → correct subset
 *   7. profilesKey path (inline is_private from joined profile) behaves identically
 *   8. Profiles query failure → FAIL-CLOSED (only the viewer's own rows pass)
 *   9. Follows query failure → fail-closed (private author excluded)
 *  10. Profiles query rejection (thrown, not resolved) → also fail-closed
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { excludePrivateAuthorPosts } from "../lib/privacyFilter.js";

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeFakeClient(opts: {
  privateAuthorIds?: string[];
  viewerFollowedIds?: string[];
  profilesError?: boolean;
  /** Transport-level rejection (the `catch` path) rather than a resolved error. */
  profilesThrows?: boolean;
  followsError?: boolean;
} = {}) {
  const {
    privateAuthorIds = [],
    viewerFollowedIds = [],
    profilesError = false,
    profilesThrows = false,
    followsError = false,
  } = opts;

  return {
    from(table: string) {
      return {
        select(_col: string) {
          const filters: Record<string, any> = {};
          const builder: any = {
            in(key: string, ids: string[]) { filters[key] = ids; return builder; },
            eq(key: string, val: any)    { filters[key] = val;  return builder; },
            then(resolve: (v: any) => any) {
              if (table === "profiles") {
                if (profilesThrows) throw new Error("connection reset");
                if (profilesError) return resolve({ data: null, error: new Error("DB error") });
                const ids: string[] = filters["id"] ?? [];
                return resolve({
                  data: privateAuthorIds.filter((id) => ids.includes(id)).map((id) => ({ id })),
                  error: null,
                });
              }
              if (table === "user_follows") {
                if (followsError) return resolve({ data: null, error: new Error("DB error") });
                const ids: string[] = filters["following_id"] ?? [];
                return resolve({
                  data: viewerFollowedIds
                    .filter((id) => ids.includes(id))
                    .map((id) => ({ following_id: id })),
                  error: null,
                });
              }
              return resolve({ data: [], error: null });
            },
          };
          return builder;
        },
      };
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePost(authorId: string, id = authorId + "-post") {
  return { id, author_id: authorId };
}

function makePostWithProfile(authorId: string, isPrivate: boolean) {
  return {
    id: authorId + "-post",
    author_id: authorId,
    profiles: { id: authorId, is_private: isPrivate },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const VIEWER = "viewer-uuid";
const PUB    = "public-author";
const PRIV   = "private-author";
const FOLLOWED_PRIV = "private-followed-author";

describe("excludePrivateAuthorPosts", () => {
  test("empty rows → returns empty immediately", async () => {
    const sc = makeFakeClient();
    const result = await excludePrivateAuthorPosts([], VIEWER, sc);
    assert.deepEqual(result, []);
  });

  test("all public authors → all rows pass through", async () => {
    const rows = [makePost(PUB), makePost("another-pub")];
    const sc = makeFakeClient({ privateAuthorIds: [] });
    const result = await excludePrivateAuthorPosts(rows, VIEWER, sc);
    assert.equal(result.length, 2);
  });

  test("private author post hidden from non-follower", async () => {
    const rows = [makePost(PUB), makePost(PRIV)];
    const sc = makeFakeClient({ privateAuthorIds: [PRIV], viewerFollowedIds: [] });
    const result = await excludePrivateAuthorPosts(rows, VIEWER, sc);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.author_id, PUB);
  });

  test("private author post visible to approved follower", async () => {
    const rows = [makePost(FOLLOWED_PRIV)];
    const sc = makeFakeClient({
      privateAuthorIds: [FOLLOWED_PRIV],
      viewerFollowedIds: [FOLLOWED_PRIV],
    });
    const result = await excludePrivateAuthorPosts(rows, VIEWER, sc);
    assert.equal(result.length, 1);
  });

  test("viewer's own posts always pass regardless of account privacy", async () => {
    const rows = [makePost(VIEWER)];
    // Even if VIEWER were listed as a private author (edge case), own posts pass
    const sc = makeFakeClient({ privateAuthorIds: [VIEWER] });
    const result = await excludePrivateAuthorPosts(rows, VIEWER, sc);
    assert.equal(result.length, 1);
  });

  test("mix: own + public + private non-followed + private followed", async () => {
    const rows = [
      makePost(VIEWER),
      makePost(PUB),
      makePost(PRIV),
      makePost(FOLLOWED_PRIV),
    ];
    const sc = makeFakeClient({
      privateAuthorIds: [PRIV, FOLLOWED_PRIV],
      viewerFollowedIds: [FOLLOWED_PRIV],
    });
    const result = await excludePrivateAuthorPosts(rows, VIEWER, sc);
    const ids = result.map((r) => r.author_id);
    assert.ok(ids.includes(VIEWER), "own post must pass");
    assert.ok(ids.includes(PUB), "public post must pass");
    assert.ok(ids.includes(FOLLOWED_PRIV), "followed-private post must pass");
    assert.ok(!ids.includes(PRIV), "non-followed private post must be excluded");
    assert.equal(result.length, 3);
  });

  test("profilesKey path: reads is_private from joined profile data", async () => {
    const rows = [
      makePostWithProfile(PUB,  false),
      makePostWithProfile(PRIV, true),
      makePostWithProfile(FOLLOWED_PRIV, true),
    ];
    // No profiles DB query when profilesKey is provided; only follows query
    const sc = makeFakeClient({
      privateAuthorIds: [], // won't be used
      viewerFollowedIds: [FOLLOWED_PRIV],
    });
    const result = await excludePrivateAuthorPosts(rows, VIEWER, sc, {
      profilesKey: "profiles",
    });
    const ids = result.map((r) => r.author_id);
    assert.ok(ids.includes(PUB));
    assert.ok(ids.includes(FOLLOWED_PRIV));
    assert.ok(!ids.includes(PRIV));
    assert.equal(result.length, 2);
  });

  /**
   * ASSERTION DELIBERATELY STRENGTHENED (2026-09-06). This test previously
   * asserted `result.length === 2` — "profiles query failure → fail-open (all
   * rows pass)" — and so CODIFIED the defect it was meant to guard.
   *
   * The standing rule is never to weaken an assertion; this is the rare inverse.
   * The old expectation was not a deliberate availability trade-off that a
   * reviewer could weigh: supabase-js RESOLVES `{data: null, error}` instead of
   * throwing, so `data ?? []` produced an EMPTY private-author list and the
   * filter returned every row unfiltered — publishing private accounts' posts
   * to mediaFeed, pulse, placeRecaps, placeDays, sharedMoments and
   * MediaProjection. The documented `catch` "fail-open" never even ran.
   *
   * Fail-closed is the only defensible reading of an unreadable privacy input:
   * we cannot prove ANY other author is public, so only the viewer's own rows
   * survive. A degraded feed is recoverable; a leaked private post is not.
   */
  test("profiles query failure → FAIL-CLOSED (only the viewer's own rows pass)", async () => {
    const rows = [makePost(PUB), makePost(PRIV), makePost(VIEWER)];
    const sc = makeFakeClient({ profilesError: true });
    const result = await excludePrivateAuthorPosts(rows, VIEWER, sc);
    const ids = result.map((r) => r.author_id);
    assert.deepEqual(ids, [VIEWER], "an unreadable is_private must withhold every other author");
    assert.ok(!ids.includes(PUB), "a public author cannot be PROVEN public when the read failed");
    assert.ok(!ids.includes(PRIV), "the private author's post must never survive the failure");
  });

  test("profiles query REJECTION (throws) → fail-closed on the same terms", async () => {
    const rows = [makePost(PUB), makePost(PRIV), makePost(VIEWER)];
    const sc = makeFakeClient({ profilesThrows: true });
    const result = await excludePrivateAuthorPosts(rows, VIEWER, sc);
    assert.deepEqual(result.map((r) => r.author_id), [VIEWER]);
  });

  test("follows query failure → fail-closed (private author excluded)", async () => {
    const rows = [makePost(PUB), makePost(PRIV)];
    const sc = makeFakeClient({
      privateAuthorIds: [PRIV],
      followsError: true,
    });
    const result = await excludePrivateAuthorPosts(rows, VIEWER, sc);
    // Fail-closed: cannot verify follow → exclude private author
    assert.equal(result.length, 1);
    assert.equal(result[0]!.author_id, PUB);
  });
});
