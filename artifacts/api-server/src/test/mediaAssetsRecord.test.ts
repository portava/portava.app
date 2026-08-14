/**
 * mediaAssetsRecord — recordMediaAsset() dimension-guard tests.
 *
 * Verifies that a video upload (null width/height) never writes a
 * processing_status='ready' row to media_assets.  This mirrors the
 * post_media constraint added in migration 2088; the equivalent
 * media_assets constraint is migration 2089.
 *
 * Run: node --import tsx/esm --test src/test/mediaAssetsRecord.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recordMediaAsset, type RecordAssetInput } from "../lib/mediaAssets.js";

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
