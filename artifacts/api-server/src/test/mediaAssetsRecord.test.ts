/**
 * mediaAssetsRecord — recordMediaAsset() and completeVideoTranscode() dimension-guard tests.
 *
 * Verifies that:
 *  1. A video upload (null width/height) never writes a processing_status='ready'
 *     row to media_assets.  This mirrors the post_media constraint added in
 *     migration 2088; the equivalent media_assets constraint is migration 2089.
 *  2. completeVideoTranscode() also requires width+height before flipping any
 *     media_assets row to 'ready' — so no background worker can silently
 *     produce a constraint-violating row.
 *
 * Run: node --import tsx/esm --test src/test/mediaAssetsRecord.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordMediaAsset, completeVideoTranscode, type RecordAssetInput } from "../lib/mediaAssets.js";
import {
  claimMediaProcessing,
  completeMediaProcessing,
  failMediaProcessing,
  recoverStaleMediaProcessing,
  softDeleteMediaAsset,
  retryMediaProcessing,
  type ProcessingClaim,
} from "../services/media/MediaLifecycleService.js";

// ── Minimal fake Supabase client ──────────────────────────────────────────────

interface UpsertCall {
  table: string;
  row: Record<string, unknown>;
}

function makeFakeClient(flagEnabled: boolean): { client: any; calls: UpsertCall[] } {
  const calls: UpsertCall[] = [];
  const client = {
    from(table: string) {
      return {
        // isFlagEnabled: .from("feature_flags").select("enabled").eq("flag", flag).maybeSingle()
        select(_col: string) {
          return {
            eq(_col2: string, _val: string) {
              return {
                maybeSingle() {
                  if (table === "feature_flags") {
                    return Promise.resolve({
                      data: flagEnabled ? { enabled: true } : null,
                      error: null,
                    });
                  }
                  return Promise.resolve({ data: null, error: null });
                },
                single() {
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
        // recordMediaAsset: .upsert({...}).select("id").single()
        upsert(row: Record<string, unknown>, _opts: unknown) {
          calls.push({ table, row });
          return {
            select(_col: string) {
              return {
                single() {
                  return Promise.resolve({ data: { id: "fake-asset-id" }, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

// ── Base input shared across tests ───────────────────────────────────────────

const BASE_INPUT: RecordAssetInput = {
  ownerUserId: "user-1",
  storageBucket: "post-media",
  storagePath: "user-1/1234567890.mp4",
  publicUrl: "post-media/user-1/1234567890.mp4",
  mediaType: "video",
  mimeType: "video/mp4",
  sizeBytes: 5_000_000,
  width: null,
  height: null,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("recordMediaAsset — dimension guard", () => {
  it("video with null dims writes processing_status='processing', not 'ready'", async () => {
    const { client, calls } = makeFakeClient(true);
    await recordMediaAsset(client as any, BASE_INPUT);

    assert.equal(calls.length, 1, "exactly one upsert call expected");
    const row = calls[0].row;
    assert.equal(
      row.processing_status,
      "processing",
      "null-dimension video must not be written as 'ready'",
    );
    assert.equal(row.width, null);
    assert.equal(row.height, null);
  });

  it("image with resolved dims writes processing_status='ready'", async () => {
    const { client, calls } = makeFakeClient(true);
    await recordMediaAsset(client as any, {
      ...BASE_INPUT,
      mediaType: "image",
      mimeType: "image/jpeg",
      storagePath: "user-1/1234567890.jpg",
      width: 1280,
      height: 720,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].row.processing_status, "ready");
    assert.equal(calls[0].row.width, 1280);
    assert.equal(calls[0].row.height, 720);
  });

  it("explicit processingStatus overrides the dimension-based default", async () => {
    const { client, calls } = makeFakeClient(true);
    // Caller passes explicit status even though dims are null.
    await recordMediaAsset(client as any, {
      ...BASE_INPUT,
      processingStatus: "pending_transcode",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].row.processing_status, "pending_transcode");
  });

  it("returns null and writes nothing when the flag is off", async () => {
    const { client, calls } = makeFakeClient(false);
    const result = await recordMediaAsset(client as any, BASE_INPUT);

    assert.equal(result, null, "must return null when flag is disabled");
    assert.equal(calls.length, 0, "no upsert must occur when flag is off");
  });
});

// ── completeVideoTranscode tests ──────────────────────────────────────────────
//
// Audit note: completeVideoTranscode() is the canonical path for any background
// worker (transcoder, HEIC converter, etc.) to flip a media_assets row from
// 'processing' → 'ready'.  It is the single choke-point that enforces the
// width+height requirement introduced by migration 2089 for that transition.
//
// Backfill script (backfill-media-assets.ts): legacy rows have no dimension
// data, so the script now stages them as 'processing' (not 'ready').  The
// constraint-simulation tests below verify that this shape is accepted by a
// migration-2089-faithful fake client.

interface UpdateCall {
  table: string;
  row: Record<string, unknown>;
  eqCol: string;
  eqVal: string;
}

function makeUpdateClient(opts: { error?: boolean } = {}): {
  client: any;
  updates: UpdateCall[];
} {
  const updates: UpdateCall[] = [];
  const client = {
    from(table: string) {
      return {
        update(row: Record<string, unknown>) {
          return {
            eq(col: string, val: string) {
              updates.push({ table, row, eqCol: col, eqVal: val });
              return Promise.resolve({ error: opts.error ? { message: "db error" } : null });
            },
          };
        },
      };
    },
  };
  return { client, updates };
}

describe("completeVideoTranscode — transition guard", () => {
  it("writes processing_status='ready' with valid width and height", async () => {
    const { client, updates } = makeUpdateClient();
    const result = await completeVideoTranscode(client as any, "asset-abc", {
      width: 1920,
      height: 1080,
      durationSeconds: 42.5,
    });

    assert.equal(result, true, "must return true on success");
    assert.equal(updates.length, 1, "exactly one update call expected");
    const row = updates[0].row;
    assert.equal(row.processing_status, "ready");
    assert.equal(row.width, 1920);
    assert.equal(row.height, 1080);
    // duration is written to media_assets.duration_ms (INTEGER, migration 0191),
    // not a duration_seconds column — 42.5s must persist as 42500ms. Asserting
    // the wrong column name here is what let the schema mismatch stay dormant.
    assert.equal(row.duration_ms, 42500);
    assert.equal(row.duration_seconds, undefined, "must not write a nonexistent duration_seconds column");
    assert.equal(updates[0].eqCol, "id");
    assert.equal(updates[0].eqVal, "asset-abc");
  });

  it("throws (not returns false) when width is null — programming error, not a DB race", async () => {
    const { client } = makeUpdateClient();
    await assert.rejects(
      () =>
        completeVideoTranscode(client as any, "asset-abc", {
          width: null as unknown as number,
          height: 1080,
        }),
      /width and height are required/,
      "must throw when width is null so callers get a clear stack trace",
    );
  });

  it("throws when height is null", async () => {
    const { client } = makeUpdateClient();
    await assert.rejects(
      () =>
        completeVideoTranscode(client as any, "asset-abc", {
          width: 1920,
          height: null as unknown as number,
        }),
      /width and height are required/,
    );
  });

  it("returns false (fail-soft) when Supabase returns an error", async () => {
    const { client, updates } = makeUpdateClient({ error: true });
    const result = await completeVideoTranscode(client as any, "asset-abc", {
      width: 1920,
      height: 1080,
    });

    assert.equal(result, false, "must return false on DB error so caller can retry");
    // The update was still attempted — the row stays in 'processing'
    assert.equal(updates.length, 1);
    // The row the caller sent still had the correct dimensions
    assert.equal(updates[0].row.processing_status, "ready");
    assert.equal(updates[0].row.width, 1920);
    assert.equal(updates[0].row.height, 1080);
  });
});

// ── Migration-2089 constraint simulation ─────────────────────────────────────
//
// These tests use a constraint-faithful fake client: it rejects any upsert
// where processing_status='ready' AND (width IS NULL OR height IS NULL),
// exactly mirroring the CHECK added in migration 2089.  This verifies that:
//
//   a) The backfill script's new 'processing' payload is accepted (no
//      constraint violation — safe to run after migration 2089 is live).
//   b) A hypothetical caller that still tries to write ready+null-dims is
//      rejected, proving the constraint-simulation is not a no-op.
//
// The client does NOT touch the DB; constraint validation is pure JS logic
// that faithfully reflects the SQL CHECK predicate.

function makeConstraintClient(): {
  client: any;
  calls: Array<{ table: string; row: Record<string, unknown> }>;
} {
  const calls: Array<{ table: string; row: Record<string, unknown> }> = [];

  /** Simulates migration 2089: ready rows must have non-null width AND height. */
  function checkConstraint(row: Record<string, unknown>): { error: { message: string } | null } {
    if (
      row.processing_status === "ready" &&
      (row.width == null || row.height == null)
    ) {
      return {
        error: {
          message:
            "new row violates check constraint \"media_assets_ready_requires_dimensions\"",
        },
      };
    }
    return { error: null };
  }

  const client = {
    from(table: string) {
      return {
        select(_col: string) {
          return {
            eq(_c: string, _v: string) {
              return {
                maybeSingle() {
                  // Feature flag: always enabled for constraint tests.
                  if (table === "feature_flags") {
                    return Promise.resolve({ data: { enabled: true }, error: null });
                  }
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
        upsert(row: Record<string, unknown>, _opts: unknown) {
          calls.push({ table, row });
          const { error } = checkConstraint(row);
          return {
            select(_col: string) {
              return {
                single() {
                  return Promise.resolve(
                    error ? { data: null, error } : { data: { id: "fake-id" }, error: null },
                  );
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

describe("migration-2089 constraint simulation", () => {
  it("backfill shape ('processing', null dims) is accepted by the constraint", async () => {
    // This mirrors the exact payload backfill-media-assets.ts now writes
    // (processing_status: 'processing', width/height absent/null).
    const { client, calls } = makeConstraintClient();
    const result = await recordMediaAsset(client as any, {
      ...BASE_INPUT, // width: null, height: null, mediaType: 'video'
      processingStatus: "processing", // explicit, matching the backfill
    });

    assert.ok(result !== null, "constraint-faithful client must accept a 'processing' row with null dims");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].row.processing_status, "processing");
    assert.equal(calls[0].row.width, null);
    assert.equal(calls[0].row.height, null);
  });

  it("ready+null-dims is rejected by the constraint (simulation is not a no-op)", async () => {
    // Proves the constraint fake actually enforces the rule — if it accepted
    // ready+null-dims the simulation would be meaningless.
    const { client, calls } = makeConstraintClient();
    const result = await recordMediaAsset(client as any, {
      ...BASE_INPUT,
      processingStatus: "ready", // caller explicitly forces ready with null dims
    });

    // recordMediaAsset is fail-soft and returns null on DB error.
    assert.equal(result, null, "constraint-rejected insert must return null (fail-soft)");
    assert.equal(calls.length, 1, "the upsert was attempted");
    // Confirm the attempted row had the constraint-violating shape.
    assert.equal(calls[0].row.processing_status, "ready");
    assert.equal(calls[0].row.width, null);
    assert.equal(calls[0].row.height, null);
  });
});


/**
 * ── MediaLifecycleService ────────────────────────────────────────────────────
 *
 * Every state transition here is a CONDITIONAL update. PostgREST answers an
 * UPDATE that matches ZERO rows with `error: null`, so "no error" is not proof
 * a write happened — each transition selects the row back and checks it. These
 * fakes all answer "no rows matched, no error", which is exactly the lost-race
 * shape, and every assertion below is that the service reports failure.
 */
describe("MediaLifecycleService — lost processing claim", () => {
  it("does not return a claim when the conditional update returns zero rows", async () => {
    const client = {
      from(table: string) {
        if (table !== "media_assets") return {
          upsert: async () => ({ error: null }),
        };
        const builder: any = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({
            data: {
              id: "asset-race",
              processing_status: "processing",
              processing_attempt_count: 0,
              processing_terminal: false,
            },
            error: null,
          }),
          update: () => builder,
          then: (resolve: any) => Promise.resolve({ data: null, error: null }).then(resolve),
        };
        return builder;
      },
    };
    assert.equal(await claimMediaProcessing(client as any, "asset-race"), null);
  });

  it("refuses a terminal asset and one whose retry clock has not come round", async () => {
    const asset = (over: Record<string, unknown>) => ({
      from: () => {
        const b: any = {
          select: () => b,
          eq: () => b,
          update: () => b,
          maybeSingle: async () => ({
            data: {
              id: "a1",
              processing_status: "failed",
              processing_attempt_count: 1,
              processing_terminal: false,
              ...over,
            },
            error: null,
          }),
        };
        return b;
      },
    });
    assert.equal(await claimMediaProcessing(asset({ processing_terminal: true }) as any, "a1"), null);
    assert.equal(
      await claimMediaProcessing(
        asset({ processing_next_retry_at: "2999-01-01T00:00:00.000Z" }) as any,
        "a1",
      ),
      null,
      "an asset whose next retry is in the future is not due",
    );
    assert.equal(
      await claimMediaProcessing(
        asset({ processing_lease_until: "2999-01-01T00:00:00.000Z" }) as any,
        "a1",
      ),
      null,
      "an asset under a live lease belongs to another worker",
    );
  });
});

function makeLifecycleZeroMatchClient(opts: {
  staleRow?: Record<string, unknown>;
  updatedRow?: Record<string, unknown> | null;
} = {}): any {
  const staleRow = opts.staleRow;
  const updatedRow = opts.updatedRow ?? null;
  return {
    from(table: string) {
      let updating = false;
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        lt: () => builder,
        limit: () => builder,
        update: () => {
          updating = true;
          return builder;
        },
        maybeSingle: async () => ({
          data: updating ? updatedRow : staleRow ?? null,
          error: null,
        }),
        then: (resolve: any) => Promise.resolve({
          data: updating ? updatedRow : (table === "media_assets" && staleRow ? [staleRow] : []),
          error: null,
        }).then(resolve),
      };
      return builder;
    },
  };
}

describe("MediaLifecycleService — conditional completion/failure/recovery matches", () => {
  const claim: ProcessingClaim = {
    assetId: "asset-race",
    attemptNumber: 1,
    leaseToken: "lease-old",
    leaseUntil: "2025-01-01T00:00:00.000Z",
  };

  it("does not complete when a stale lease token matches zero asset rows", async () => {
    const result = await completeMediaProcessing(makeLifecycleZeroMatchClient(), claim, {
      width: 100,
      height: 100,
    });
    assert.equal(result, false);
  });

  it("refuses to complete without positive dimensions (migration 2089)", async () => {
    await assert.rejects(
      () => completeMediaProcessing(makeLifecycleZeroMatchClient(), claim, { width: 0, height: 100 }),
      /positive dimensions required/,
    );
    await assert.rejects(
      () => completeMediaProcessing(makeLifecycleZeroMatchClient(), claim, { width: 100, height: -1 }),
      /positive dimensions required/,
    );
  });

  it("does not fail when a stale lease token matches zero asset rows", async () => {
    const result = await failMediaProcessing(makeLifecycleZeroMatchClient(), claim, "transcode failed");
    assert.equal(result.ok, false);
  });

  it("goes terminal only at the attempt cap, and schedules a retry below it", async () => {
    const below = await failMediaProcessing(makeLifecycleZeroMatchClient(), claim, "boom", { maxAttempts: 3 });
    assert.equal(below.terminal, false);
    assert.ok(below.nextRetryAt, "a non-terminal failure must carry a retry time");
    const atCap = await failMediaProcessing(
      makeLifecycleZeroMatchClient(),
      { ...claim, attemptNumber: 3 },
      "boom",
      { maxAttempts: 3 },
    );
    assert.equal(atCap.terminal, true);
    assert.equal(atCap.nextRetryAt, null, "a terminal failure must NOT schedule another retry");
  });

  it("does not count stale recovery when the conditional update matches zero rows", async () => {
    const client = makeLifecycleZeroMatchClient({
      staleRow: {
        id: claim.assetId,
        processing_attempt_count: claim.attemptNumber,
        processing_lease_token: claim.leaseToken,
      },
    });
    assert.equal(await recoverStaleMediaProcessing(client, { now: new Date("2025-01-01T00:00:00.000Z") }), 0);
  });
});

describe("MediaLifecycleService — owner-only deletion and retry", () => {
  const OWNER = "11111111-1111-4111-8111-111111111111";
  const STRANGER = "22222222-2222-4222-8222-222222222222";
  const ASSET = "33333333-3333-4333-8333-333333333333";

  function assetClient(row: Record<string, unknown> | null) {
    const writes: Array<{ table: string; row: any }> = [];
    const client: any = {
      writes,
      from(table: string) {
        const b: any = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: row, error: null }),
          update: (payload: any) => { writes.push({ table, row: payload }); return b; },
          insert: async (payload: any) => { writes.push({ table, row: payload }); return { error: null }; },
          then: (resolve: any) => Promise.resolve({ data: null, error: null }).then(resolve),
        };
        return b;
      },
    };
    return client;
  }

  it("refuses a stranger and a missing asset, and writes nothing in either case", async () => {
    const owned = assetClient({ id: ASSET, owner_user_id: OWNER, purge_status: "not_requested" });
    assert.deepEqual(
      await softDeleteMediaAsset(owned, ASSET, STRANGER),
      { ok: false, alreadyDeleted: false, purgeScheduled: false },
    );
    assert.deepEqual(owned.writes, [], "a refused delete must not write");

    const missing = assetClient(null);
    assert.deepEqual(
      await softDeleteMediaAsset(missing, ASSET, OWNER),
      { ok: false, alreadyDeleted: false, purgeScheduled: false },
    );
    assert.deepEqual(missing.writes, []);

    assert.deepEqual(
      await retryMediaProcessing(assetClient({ id: ASSET, owner_user_id: OWNER }), ASSET, STRANGER),
      { ok: false, alreadyQueued: false },
    );
  });

  it("is idempotent: an already owner_deleted asset reports alreadyDeleted and re-writes nothing", async () => {
    const client = assetClient({
      id: ASSET, owner_user_id: OWNER,
      moderation_status: "owner_deleted", purge_status: "pending",
    });
    assert.deepEqual(
      await softDeleteMediaAsset(client, ASSET, OWNER),
      { ok: true, alreadyDeleted: true, purgeScheduled: false },
    );
    assert.deepEqual(client.writes, []);
  });

  it("does not re-queue an asset already queued or in flight, and never revives a purged one", async () => {
    for (const status of ["queued", "processing"]) {
      const client = assetClient({ id: ASSET, owner_user_id: OWNER, processing_status: status });
      assert.deepEqual(await retryMediaProcessing(client, ASSET, OWNER), { ok: true, alreadyQueued: true });
      assert.deepEqual(client.writes, [], `a ${status} asset must not be re-queued`);
    }
    const purged = assetClient({
      id: ASSET, owner_user_id: OWNER, processing_status: "failed", purge_status: "completed",
    });
    assert.deepEqual(await retryMediaProcessing(purged, ASSET, OWNER), { ok: false, alreadyQueued: false });
    assert.deepEqual(purged.writes, [], "a purged asset has no bytes left to process");
  });

  it("uses only CHECK-legal status values when it does transition", async () => {
    // 0191 processing_status vocabulary + the §36 moderation vocabulary that
    // 2250 lays down (re-asserted by 2470). A value outside either set would be
    // rejected by Postgres at runtime, where no unit test would see it.
    const PROCESSING = new Set([
      "local", "queued", "uploading", "uploaded", "scanning",
      "processing", "moderating", "ready", "failed", "rejected", "removed", "expired",
    ]);
    const MODERATION = new Set([
      "processing", "active", "limited", "rejected", "removed", "owner_deleted",
      "pending", "approved", "flagged",
    ]);
    const client = assetClient({
      id: ASSET, owner_user_id: OWNER, moderation_status: "approved", purge_status: "not_requested",
    });
    const result = await softDeleteMediaAsset(client, ASSET, OWNER);
    assert.equal(result.ok, true);
    await result.purge;
    const retryClient = assetClient({ id: ASSET, owner_user_id: OWNER, processing_status: "failed" });
    await retryMediaProcessing(retryClient, ASSET, OWNER);
    for (const w of [...client.writes, ...retryClient.writes]) {
      if (typeof w.row?.processing_status === "string") {
        assert.ok(PROCESSING.has(w.row.processing_status), `illegal processing_status ${w.row.processing_status}`);
      }
      if (typeof w.row?.moderation_status === "string") {
        assert.ok(MODERATION.has(w.row.moderation_status), `illegal moderation_status ${w.row.moderation_status}`);
      }
    }
  });
});
