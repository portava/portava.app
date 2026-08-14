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
    assert.equal(row.duration_seconds, 42.5);
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
