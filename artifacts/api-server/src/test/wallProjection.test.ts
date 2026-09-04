/**
 * WallProjectionService — the eligibility / block / visibility gate runs BEFORE
 * projection (spec §23/§24). These tests prove nothing that fails a gate ever
 * reaches a Wall shape, and that the gate fails CLOSED on an unreadable blocks
 * table.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectObjects,
  type WallCandidate,
  type ProjectViewerContext,
} from "../services/wall/WallProjectionService.js";

const VIEWER = "viewer-1";

function viewerCtx(over: Partial<ProjectViewerContext> = {}): ProjectViewerContext {
  return {
    viewerId: VIEWER,
    viewerTripIds: new Set<string>(),
    followedCreatorIds: new Set<string>(),
    ...over,
  };
}

/** Fake supabase whose only table is `blocks`. Returns the configured rows for
 *  the .or() query, or an error to exercise the fail-closed path. */
function blocksClient(rows: Array<{ blocker_id: string; blocked_id: string }>, opts: { error?: unknown } = {}) {
  return {
    from(_table: string) {
      const b: any = {
        select() {
          return b;
        },
        or() {
          return b;
        },
        then(onF: any, onR: any) {
          const result = opts.error ? { data: null, error: opts.error } : { data: rows, error: null };
          return Promise.resolve(result).then(onF, onR);
        },
      };
      return b;
    },
  };
}

function post(over: Partial<WallCandidate>): WallCandidate {
  return {
    objectType: "social_post",
    canonicalObjectId: "obj-" + Math.random().toString(36).slice(2),
    authorId: "author-x",
    visibility: "public",
    publishedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

describe("WallProjectionService gate", () => {
  it("projects a public post from a non-blocked author", async () => {
    const c = post({ canonicalObjectId: "p1", authorId: "a1", visibility: "public" });
    const out = await projectObjects(blocksClient([]), [c], viewerCtx());
    assert.equal(out.length, 1);
    assert.equal(out[0].canonicalObjectId, "p1");
    assert.equal(out[0].visibility, "public");
    // Actions are minimal: open + (no place ⇒ no see_place).
    assert.ok(out[0].actions.some((a) => a.type === "open_object"));
  });

  it("drops a private post from another author but keeps the author's own", async () => {
    const other = post({ canonicalObjectId: "priv-other", authorId: "a2", visibility: "private" });
    const own = post({ canonicalObjectId: "priv-own", authorId: VIEWER, visibility: "private" });
    const out = await projectObjects(blocksClient([]), [other, own], viewerCtx());
    const ids = out.map((p) => p.canonicalObjectId);
    assert.deepEqual(ids, ["priv-own"]); // only the author's own private post survives
  });

  it("gates trip_only on accepted trip membership", async () => {
    const c = post({ canonicalObjectId: "trip-post", authorId: "a3", visibility: "trip_only", tripId: "trip-9" });
    const denied = await projectObjects(blocksClient([]), [c], viewerCtx());
    assert.equal(denied.length, 0, "non-member is denied");
    const allowed = await projectObjects(
      blocksClient([]),
      [c],
      viewerCtx({ viewerTripIds: new Set(["trip-9"]) }),
    );
    assert.equal(allowed.length, 1, "accepted trip member is admitted");
  });

  it("excludes a blocked author in EITHER direction", async () => {
    const byViewer = post({ canonicalObjectId: "b1", authorId: "blocked-1", visibility: "public" });
    const blocksViewer = post({ canonicalObjectId: "b2", authorId: "blocker-2", visibility: "public" });
    const ok = post({ canonicalObjectId: "ok", authorId: "friend", visibility: "public" });
    const rows = [
      { blocker_id: VIEWER, blocked_id: "blocked-1" }, // viewer blocked them
      { blocker_id: "blocker-2", blocked_id: VIEWER }, // they blocked viewer
    ];
    const out = await projectObjects(blocksClient(rows), [byViewer, blocksViewer, ok], viewerCtx());
    assert.deepEqual(out.map((p) => p.canonicalObjectId), ["ok"]);
  });

  it("author eligibility is an ALLOWLIST: only account_status 'active' passes (D3)", async () => {
    // The real profiles CHECK constraint allows active / deactivated /
    // pending_deletion / deleted. The old gate was a denylist of 'banned' and
    // 'suspended' — values the constraint FORBIDS — so it could never drop an
    // author and every non-active account's posts flowed onto the Wall.
    const deactivated = post({ canonicalObjectId: "x1", authorId: "a", authorAccountStatus: "deactivated" });
    const pendingDeletion = post({ canonicalObjectId: "x2", authorId: "b", authorAccountStatus: "pending_deletion" });
    const deleted = post({ canonicalObjectId: "x3", authorId: "c", authorAccountStatus: "deleted" });
    // Still dropped: any value that is not 'active', including the legacy denylist words.
    const banned = post({ canonicalObjectId: "x4", authorId: "d", authorAccountStatus: "banned" });
    const suspended = post({ canonicalObjectId: "x5", authorId: "e", authorAccountStatus: "suspended" });
    const tombstoned = post({ canonicalObjectId: "x6", authorId: "f", isDeleted: true });
    const live = post({ canonicalObjectId: "x7", authorId: "g", authorAccountStatus: "active" });
    // Absent reads as 'active' (lib/http requireUser / circleLocationsRead gate 7):
    // the column is NOT NULL, so absence only means the loader's fail-soft default.
    const absent = post({ canonicalObjectId: "x8", authorId: "h" });
    const out = await projectObjects(
      blocksClient([]),
      [deactivated, pendingDeletion, deleted, banned, suspended, tombstoned, live, absent],
      viewerCtx(),
    );
    assert.deepEqual(out.map((p) => p.canonicalObjectId), ["x7", "x8"]);
  });

  it("fails CLOSED: an unreadable blocks table drops every candidate", async () => {
    const c1 = post({ canonicalObjectId: "c1", authorId: "a1" });
    const c2 = post({ canonicalObjectId: "c2", authorId: "a2" });
    const out = await projectObjects(blocksClient([], { error: { message: "boom" } }), [c1, c2], viewerCtx());
    assert.equal(out.length, 0, "block-gate read failure denies rather than leaks");
  });

  it("preserves the distinct object types and attaches see_place only with a place", async () => {
    const video = post({ canonicalObjectId: "v", authorId: "a", objectType: "video" });
    const postcard = post({ canonicalObjectId: "pc", authorId: "a", objectType: "postcard" });
    const withPlace = post({
      canonicalObjectId: "pl",
      authorId: "a",
      place: { placeId: "place-1", name: "An Thuong" },
    });
    const out = await projectObjects(blocksClient([]), [video, postcard, withPlace], viewerCtx());
    const byId = new Map(out.map((p) => [p.canonicalObjectId, p]));
    assert.equal(byId.get("v")!.objectType, "video");
    assert.equal((byId.get("v") as any).inlinePlayback, true);
    assert.equal(byId.get("pc")!.objectType, "postcard");
    assert.equal((byId.get("pc") as any).storyPresentation, true);
    assert.ok(byId.get("pl")!.actions.some((a) => a.type === "see_place"));
    assert.ok(!byId.get("v")!.actions.some((a) => a.type === "see_place"));
  });
});
