/**
 * mediaCanonicalStore — the canonical §6 media store, write side and read side.
 *
 * THE DEFECT THESE TESTS PIN
 * ==========================
 * `media_assets` is the spec's single source of truth for an uploaded file, and
 * in practice it was neither written nor read on the projection path:
 *
 *   • WRITE. `recordMediaAsset` sends `captured_at`, `provenance` and
 *     `intelligence_eligibility` in every upsert. Production's `media_assets`
 *     has none of those columns (migration 2250 was never applied there — 23
 *     columns vs CI's 27, and no 2250 row in supabase_migrations). PostgREST
 *     rejects the whole statement, the old code did `if (error) return null`,
 *     and every call site is `void recordMediaAsset(...)`. A silent total loss.
 *     The flag was NOT the reason: `media_canonical_enabled` is TRUE in
 *     production.
 *
 *   • READ. `lib/media/mediaProjection.firstReadyMedia` read `post_media` and
 *     fell back to `posts.media_urls`. It never looked at `media_assets`.
 *
 * WHAT IS ASSERTED, AND WHY EACH ASSERTION EARNS ITS PLACE
 * =======================================================
 * Both repairs are inert by default, so most of these tests are proofs of
 * INERTNESS as much as of capability:
 *
 *   - with `media_canonical_schema_fallback_enabled` off, a missing-column
 *     rejection still writes nothing and still returns null — exactly one
 *     upsert attempt, no silent retry;
 *   - with no canonical data on the row, the projection is byte-identical to
 *     the post_media / media_urls behaviour it always had;
 *   - with the read flag off, the loader performs NO query at all.
 *
 * And the two failure modes that would lose user media are pinned directly:
 * a canonical row that is not servable must FALL BACK rather than blank the
 * card, and a canonical row must never relax the moderation gate.
 *
 * Run: node --import tsx/esm --test src/test/mediaCanonicalStore.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  recordMediaAsset,
  recordMediaAssetDetailed,
  isMissingColumnError,
  CANONICAL_ASSET_COLUMNS_ADDED_BY_2250,
  type RecordAssetInput,
} from "../lib/mediaAssets.js";
import {
  toMediaProjection,
  MEDIA_PROJECTION_MEDIA_ASSET_COLUMNS,
  type MediaCandidateRow,
} from "../lib/media/mediaProjection.js";
import { attachCanonicalMedia, MEDIA_CANONICAL_READ_FLAG } from "../lib/media/mediaCanonicalRead.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

interface UpsertAttempt {
  row: Record<string, unknown>;
}

/** A PostgREST "column not in the schema cache" rejection, as production emits it. */
function pgrstMissingColumn(column: string) {
  return {
    code: "PGRST204",
    message: `Could not find the '${column}' column of 'media_assets' in the schema cache`,
  };
}

/**
 * Fake client for the WRITE side.
 *
 * `upsertResults` is consumed one entry per attempt, so a test can say
 * "reject the first attempt, accept the second" and then assert on exactly how
 * many attempts happened — which is how the no-silent-retry guarantee is
 * checked rather than assumed.
 */
function makeWriteClient(opts: {
  flags: Record<string, boolean>;
  upsertResults: Array<{ id?: string; error?: unknown }>;
}) {
  const attempts: UpsertAttempt[] = [];
  const flagReads: string[] = [];
  let next = 0;
  const client = {
    from(table: string) {
      return {
        select(_c: string) {
          return {
            eq(_col: string, val: string) {
              return {
                maybeSingle() {
                  if (table === "feature_flags") {
                    flagReads.push(val);
                    const on = opts.flags[val] === true;
                    return Promise.resolve({ data: on ? { enabled: true } : null, error: null });
                  }
                  return Promise.resolve({ data: null, error: null });
                },
              };
            },
          };
        },
        upsert(row: Record<string, unknown>, _o: unknown) {
          attempts.push({ row: { ...row } });
          const r = opts.upsertResults[next++] ?? { error: { code: "EXHAUSTED" } };
          return {
            select(_c: string) {
              return {
                single() {
                  return r.error
                    ? Promise.resolve({ data: null, error: r.error })
                    : Promise.resolve({ data: { id: r.id ?? "asset-1" }, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
  return { client: client as any, attempts, flagReads };
}

/** Fake client for the READ side (media_attachments -> media_assets). */
function makeReadClient(opts: {
  flags: Record<string, boolean>;
  attachments?: any[];
  attachmentsError?: unknown;
}) {
  const queried: string[] = [];
  let selectedColumns: string | null = null;
  const client = {
    from(table: string) {
      queried.push(table);
      if (table === "feature_flags") {
        return {
          select() {
            return {
              eq(_c: string, val: string) {
                return {
                  maybeSingle() {
                    const on = opts.flags[val] === true;
                    return Promise.resolve({ data: on ? { enabled: true } : null, error: null });
                  },
                };
              },
            };
          },
        };
      }
      return {
        select(cols: string) {
          selectedColumns = cols;
          return {
            eq() {
              return {
                in() {
                  return {
                    limit() {
                      return Promise.resolve(
                        opts.attachmentsError
                          ? { data: null, error: opts.attachmentsError }
                          : { data: opts.attachments ?? [], error: null },
                      );
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  return {
    client: client as any,
    queried,
    selectedColumns: () => selectedColumns,
  };
}

const INPUT: RecordAssetInput = {
  ownerUserId: "user-1",
  storageBucket: "post-media",
  storagePath: "user-1/1700000000.jpg",
  publicUrl: "post-media/user-1/1700000000.jpg",
  mediaType: "image",
  mimeType: "image/jpeg",
  sizeBytes: 4096,
  width: 1200,
  height: 800,
  capturedAt: "2026-08-01T10:00:00.000Z",
};

// ── isMissingColumnError ─────────────────────────────────────────────────────

describe("isMissingColumnError — tells a schema skew from every other failure", () => {
  it("recognises the PostgREST schema-cache rejection", () => {
    assert.equal(isMissingColumnError(pgrstMissingColumn("captured_at")), true);
  });

  it("recognises the raw PostgreSQL 42703", () => {
    assert.equal(
      isMissingColumnError({
        code: "42703",
        message: 'column "provenance" of relation "media_assets" does not exist',
      }),
      true,
    );
  });

  it("recognises the message shape even with no code", () => {
    assert.equal(
      isMissingColumnError({ message: "column \"provenance\" does not exist" }),
      true,
    );
  });

  it("does NOT claim a unique violation is a missing column", () => {
    assert.equal(
      isMissingColumnError({ code: "23505", message: "duplicate key value violates unique constraint" }),
      false,
    );
  });

  it("does NOT claim a CHECK violation is a missing column", () => {
    assert.equal(
      isMissingColumnError({
        code: "23514",
        message: 'new row violates check constraint "media_assets_moderation_status_check"',
      }),
      false,
    );
  });

  it("survives a null / non-object / empty error without throwing", () => {
    assert.equal(isMissingColumnError(null), false);
    assert.equal(isMissingColumnError(undefined), false);
    assert.equal(isMissingColumnError("boom"), false);
    assert.equal(isMissingColumnError({}), false);
  });
});

// ── Write side ───────────────────────────────────────────────────────────────

describe("recordMediaAssetDetailed — the write is legible, and still gated", () => {
  it("flag off: no upsert at all, outcome skipped_flag_off", async () => {
    const { client, attempts } = makeWriteClient({ flags: {}, upsertResults: [] });
    const r = await recordMediaAssetDetailed(client, INPUT);
    assert.equal(r.outcome, "skipped_flag_off");
    assert.equal(r.assetId, null);
    assert.equal(attempts.length, 0, "flag off must not touch media_assets");
  });

  it("flag on, accepted: the FULL §6 payload is sent and the outcome is 'written'", async () => {
    const { client, attempts } = makeWriteClient({
      flags: { media_canonical_enabled: true },
      upsertResults: [{ id: "asset-9" }],
    });
    const r = await recordMediaAssetDetailed(client, INPUT);
    assert.equal(r.outcome, "written");
    assert.equal(r.assetId, "asset-9");
    assert.deepEqual(r.droppedColumns, []);
    assert.equal(attempts.length, 1);
    for (const col of CANONICAL_ASSET_COLUMNS_ADDED_BY_2250) {
      if (col === "location_visibility") continue; // never sent by this writer
      assert.ok(col in attempts[0].row, `${col} must be in the full payload`);
    }
    assert.equal(attempts[0].row.captured_at, "2026-08-01T10:00:00.000Z");
  });

  it(
    "missing column + fallback flag OFF: writes NOTHING, returns null, and makes " +
      "exactly ONE attempt — the pre-existing behaviour, unchanged",
    async () => {
      const { client, attempts } = makeWriteClient({
        flags: { media_canonical_enabled: true },
        upsertResults: [{ error: pgrstMissingColumn("captured_at") }],
      });
      const r = await recordMediaAssetDetailed(client, INPUT);
      assert.equal(r.outcome, "failed");
      assert.equal(r.assetId, null);
      assert.deepEqual(r.droppedColumns, []);
      assert.equal(r.errorCode, "PGRST204");
      assert.equal(attempts.length, 1, "no retry may happen without the fallback flag");
    },
  );

  it("missing column + fallback flag ON: retries once without the 2250 columns", async () => {
    const { client, attempts } = makeWriteClient({
      flags: { media_canonical_enabled: true, media_canonical_schema_fallback_enabled: true },
      upsertResults: [{ error: pgrstMissingColumn("captured_at") }, { id: "asset-degraded" }],
    });
    const r = await recordMediaAssetDetailed(client, INPUT);
    assert.equal(r.outcome, "written_degraded");
    assert.equal(r.assetId, "asset-degraded");
    assert.equal(attempts.length, 2, "exactly one retry, not a loop per column");

    // Every 2250 column the writer sends is gone from the retry...
    for (const col of CANONICAL_ASSET_COLUMNS_ADDED_BY_2250) {
      assert.equal(col in attempts[1].row, false, `${col} must be dropped from the retry`);
    }
    assert.deepEqual(
      [...r.droppedColumns].sort(),
      ["captured_at", "intelligence_eligibility", "provenance"].sort(),
      "the result must name exactly what was lost",
    );

    // ...and the identifying/base columns survive, or the row would be useless.
    assert.equal(attempts[1].row.storage_bucket, "post-media");
    assert.equal(attempts[1].row.storage_path, "user-1/1700000000.jpg");
    assert.equal(attempts[1].row.owner_user_id, "user-1");
    assert.equal(attempts[1].row.processing_status, "ready");
  });

  it("a NON-schema error is never retried, even with the fallback flag on", async () => {
    const { client, attempts } = makeWriteClient({
      flags: { media_canonical_enabled: true, media_canonical_schema_fallback_enabled: true },
      upsertResults: [{ error: { code: "23505", message: "duplicate key" } }],
    });
    const r = await recordMediaAssetDetailed(client, INPUT);
    assert.equal(r.outcome, "failed");
    assert.equal(r.errorCode, "23505");
    assert.equal(attempts.length, 1, "dropping §6 columns cannot fix a constraint violation");
  });

  it("a degraded retry that ALSO fails reports failure, not a phantom id", async () => {
    const { client, attempts } = makeWriteClient({
      flags: { media_canonical_enabled: true, media_canonical_schema_fallback_enabled: true },
      upsertResults: [
        { error: pgrstMissingColumn("provenance") },
        { error: { code: "23514", message: "check constraint" } },
      ],
    });
    const r = await recordMediaAssetDetailed(client, INPUT);
    assert.equal(r.outcome, "failed");
    assert.equal(r.assetId, null);
    assert.deepEqual(r.droppedColumns, [], "nothing was recorded, so nothing was 'dropped'");
    assert.equal(attempts.length, 2);
  });

  it("recordMediaAsset keeps its old contract: the id, or null", async () => {
    const ok = makeWriteClient({
      flags: { media_canonical_enabled: true },
      upsertResults: [{ id: "asset-back-compat" }],
    });
    assert.equal(await recordMediaAsset(ok.client, INPUT), "asset-back-compat");

    const off = makeWriteClient({ flags: {}, upsertResults: [] });
    assert.equal(await recordMediaAsset(off.client, INPUT), null);

    const rejected = makeWriteClient({
      flags: { media_canonical_enabled: true },
      upsertResults: [{ error: pgrstMissingColumn("captured_at") }],
    });
    assert.equal(await recordMediaAsset(rejected.client, INPUT), null);
  });
});

// ── Read side: the projector ─────────────────────────────────────────────────

const READY_POST_MEDIA = {
  id: "pm-1",
  media_type: "image",
  public_url: "https://cdn.example.com/legacy.jpg",
  thumbnail_url: "https://cdn.example.com/legacy-thumb.jpg",
  duration_seconds: null,
  width: 800,
  height: 600,
  sort_order: 0,
  processing_status: "ready",
  moderation_status: "approved",
};

function canonicalAsset(over: Record<string, unknown> = {}) {
  return {
    id: "ma-1",
    media_type: "image",
    public_url: "https://cdn.example.com/canonical.jpg",
    thumbnail_url: "https://cdn.example.com/canonical-thumb.jpg",
    width: 4032,
    height: 3024,
    duration_ms: null,
    captured_at: "2026-08-01T09:00:00.000Z",
    processing_status: "ready",
    moderation_status: "active",
    position: 0,
    ...over,
  };
}

const BASE_ROW: MediaCandidateRow = {
  id: "post-1",
  author_id: "user-1",
  created_at: "2026-08-02T12:00:00.000Z",
  post_media: [READY_POST_MEDIA],
};

const NOW = Date.parse("2026-08-02T18:00:00.000Z");

describe("mediaProjection — canonical preferred, legacy still served", () => {
  it("INERT: a row with no canonical data projects from post_media exactly as before", () => {
    const p = toMediaProjection({ ...BASE_ROW }, NOW);
    assert.ok(p);
    assert.equal(p.id, "post-1");
    assert.equal(p.url, "https://cdn.example.com/legacy.jpg");
    assert.equal(p.width, 800);
    assert.equal(p.capturedAt, "2026-08-02T12:00:00.000Z", "publish clock, as before");
  });

  it("INERT: media_urls fallback is untouched when there is no post_media", () => {
    const p = toMediaProjection(
      { id: "post-2", created_at: "2026-08-02T12:00:00.000Z", media_urls: ["https://ext.example/x.jpg"] },
      NOW,
    );
    assert.ok(p);
    assert.equal(p.url, "https://ext.example/x.jpg");
    assert.equal(p.mediaType, "image");
  });

  it("canonical wins over post_media when both are present and servable", () => {
    const p = toMediaProjection({ ...BASE_ROW, canonical_media: [canonicalAsset()] }, NOW);
    assert.ok(p);
    assert.equal(p.url, "https://cdn.example.com/canonical.jpg");
    assert.equal(p.width, 4032);
    assert.equal(p.height, 3024);
  });

  it("canonical supplies the §6 CAPTURE clock, not the post's publish clock", () => {
    const p = toMediaProjection({ ...BASE_ROW, canonical_media: [canonicalAsset()] }, NOW);
    assert.ok(p);
    assert.equal(
      p.capturedAt,
      "2026-08-01T09:00:00.000Z",
      "captured_at is the whole point of preferring media_assets",
    );
  });

  it("a canonical row with a null captured_at still falls back to created_at", () => {
    const p = toMediaProjection(
      { ...BASE_ROW, canonical_media: [canonicalAsset({ captured_at: null })] },
      NOW,
    );
    assert.ok(p);
    assert.equal(p.capturedAt, "2026-08-02T12:00:00.000Z");
  });

  it("duration is converted from media_assets' duration_ms into seconds", () => {
    const p = toMediaProjection(
      {
        ...BASE_ROW,
        canonical_media: [canonicalAsset({ media_type: "video", duration_ms: 12500 })],
      },
      NOW,
    );
    assert.ok(p);
    assert.equal(p.mediaType, "video");
    assert.equal(p.durationSeconds, 12.5);
  });

  it("canonical ordering follows the ATTACHMENT position, not array order", () => {
    const p = toMediaProjection(
      {
        ...BASE_ROW,
        canonical_media: [
          canonicalAsset({ id: "ma-late", public_url: "https://cdn.example.com/second.jpg", position: 5 }),
          canonicalAsset({ id: "ma-first", public_url: "https://cdn.example.com/first.jpg", position: 0 }),
        ],
      },
      NOW,
    );
    assert.ok(p);
    assert.equal(p.url, "https://cdn.example.com/first.jpg");
  });

  it("NO MEDIA IS LOST: an unready canonical row falls back to post_media", () => {
    const p = toMediaProjection(
      { ...BASE_ROW, canonical_media: [canonicalAsset({ processing_status: "processing" })] },
      NOW,
    );
    assert.ok(p, "the card must not go blank");
    assert.equal(p.url, "https://cdn.example.com/legacy.jpg");
  });

  it("NO MEDIA IS LOST: a canonical row with an empty public_url falls back", () => {
    const p = toMediaProjection({ ...BASE_ROW, canonical_media: [canonicalAsset({ public_url: "  " })] }, NOW);
    assert.ok(p);
    assert.equal(p.url, "https://cdn.example.com/legacy.jpg");
  });

  it("the moderation gate is not relaxed for the canonical store", () => {
    for (const bad of ["rejected", "flagged", "limited", "removed", "owner_deleted"]) {
      const p = toMediaProjection(
        { ...BASE_ROW, canonical_media: [canonicalAsset({ moderation_status: bad })] },
        NOW,
      );
      assert.ok(p, `${bad}: must fall back, not blank`);
      assert.equal(p.url, "https://cdn.example.com/legacy.jpg", `${bad} must never be served`);
    }
  });

  it("a canonical-only row (no post_media, no media_urls) still projects", () => {
    const p = toMediaProjection(
      { id: "post-3", created_at: "2026-08-02T12:00:00.000Z", canonical_media: [canonicalAsset()] },
      NOW,
    );
    assert.ok(p);
    assert.equal(p.url, "https://cdn.example.com/canonical.jpg");
  });

  it("nothing servable anywhere still yields null, not a half-built projection", () => {
    const p = toMediaProjection(
      {
        id: "post-4",
        created_at: "2026-08-02T12:00:00.000Z",
        canonical_media: [canonicalAsset({ moderation_status: "rejected" })],
        post_media: [{ ...READY_POST_MEDIA, processing_status: "processing" }],
        media_urls: [],
      },
      NOW,
    );
    assert.equal(p, null);
  });

  it("the canonical branch stays COARSE — no coordinate can ride in on an asset", () => {
    const p = toMediaProjection(
      {
        ...BASE_ROW,
        location_lat: 48.8584,
        location_lng: 2.2945,
        canonical_media: [canonicalAsset({ location_lat: 48.8584, location_lng: 2.2945 } as any)],
      },
      NOW,
    );
    assert.ok(p);
    const serialized = JSON.stringify(p);
    assert.equal(serialized.includes("48.8584"), false, "no latitude may reach a projection");
    assert.equal(serialized.includes("2.2945"), false, "no longitude may reach a projection");
    assert.equal("location_lat" in (p as any), false);
  });

  it("the media_assets column whitelist names no coordinate column", () => {
    assert.equal(MEDIA_PROJECTION_MEDIA_ASSET_COLUMNS.includes("lat"), false);
    assert.equal(MEDIA_PROJECTION_MEDIA_ASSET_COLUMNS.includes("lng"), false);
    assert.ok(MEDIA_PROJECTION_MEDIA_ASSET_COLUMNS.includes("captured_at"));
  });
});

// ── Read side: the gated loader ──────────────────────────────────────────────

describe("attachCanonicalMedia — off by default, fail-soft when on", () => {
  it("flag off: NO query is made and the rows are untouched", async () => {
    const { client, queried } = makeReadClient({ flags: {}, attachments: [{ entity_id: "post-1" }] });
    const rows: MediaCandidateRow[] = [{ ...BASE_ROW }];
    const n = await attachCanonicalMedia(client, rows);
    assert.equal(n, 0);
    assert.equal(queried.includes("media_attachments"), false, "the gate must precede the query");
    assert.equal(rows[0].canonical_media, undefined);
  });

  it("empty input: returns 0 without even reading the flag", async () => {
    const { client, queried } = makeReadClient({ flags: { [MEDIA_CANONICAL_READ_FLAG]: true } });
    assert.equal(await attachCanonicalMedia(client, []), 0);
    assert.deepEqual(queried, []);
  });

  it("flag on: attaches the asset with its attachment position folded in", async () => {
    const { client, selectedColumns } = makeReadClient({
      flags: { [MEDIA_CANONICAL_READ_FLAG]: true },
      attachments: [
        { entity_id: "post-1", position: 3, is_cover: true, media_assets: canonicalAsset() },
      ],
    });
    const rows: MediaCandidateRow[] = [{ ...BASE_ROW }];
    const n = await attachCanonicalMedia(client, rows);
    assert.equal(n, 1);
    const attached = rows[0].canonical_media as any[];
    assert.equal(attached.length, 1);
    assert.equal(attached[0].position, 3, "position comes from the ATTACHMENT, not the asset");
    assert.equal(attached[0].is_cover, true);
    assert.equal(attached[0].public_url, "https://cdn.example.com/canonical.jpg");
    assert.ok(selectedColumns()?.includes("media_assets("), "the asset must be embedded");
  });

  it("handles PostgREST returning the embedded asset as a one-element array", async () => {
    const { client } = makeReadClient({
      flags: { [MEDIA_CANONICAL_READ_FLAG]: true },
      attachments: [{ entity_id: "post-1", position: 0, media_assets: [canonicalAsset()] }],
    });
    const rows: MediaCandidateRow[] = [{ ...BASE_ROW }];
    assert.equal(await attachCanonicalMedia(client, rows), 1);
    assert.equal((rows[0].canonical_media as any[])[0].id, "ma-1");
  });

  it("a read error attaches nothing — the projection keeps its legacy media", async () => {
    const { client } = makeReadClient({
      flags: { [MEDIA_CANONICAL_READ_FLAG]: true },
      attachmentsError: { code: "42P01", message: "relation does not exist" },
    });
    const rows: MediaCandidateRow[] = [{ ...BASE_ROW }];
    assert.equal(await attachCanonicalMedia(client, rows), 0);
    assert.equal(rows[0].canonical_media, undefined);
    const p = toMediaProjection(rows[0], NOW);
    assert.ok(p);
    assert.equal(p.url, "https://cdn.example.com/legacy.jpg", "degrades to today's behaviour");
  });

  it("rows with no attachment are left alone; only matching rows gain data", async () => {
    const { client } = makeReadClient({
      flags: { [MEDIA_CANONICAL_READ_FLAG]: true },
      attachments: [{ entity_id: "post-1", position: 0, media_assets: canonicalAsset() }],
    });
    const rows: MediaCandidateRow[] = [{ ...BASE_ROW }, { ...BASE_ROW, id: "post-uncovered" }];
    assert.equal(await attachCanonicalMedia(client, rows), 1);
    assert.ok(rows[0].canonical_media);
    assert.equal(rows[1].canonical_media, undefined);

    // The uncovered row is exactly the production majority (5 of 6 ready
    // post_media rows have no canonical counterpart) — it must still project.
    const p = toMediaProjection(rows[1], NOW);
    assert.ok(p);
    assert.equal(p.url, "https://cdn.example.com/legacy.jpg");
  });

  it("an attachment whose embedded asset is null is skipped, not attached as junk", async () => {
    const { client } = makeReadClient({
      flags: { [MEDIA_CANONICAL_READ_FLAG]: true },
      attachments: [{ entity_id: "post-1", position: 0, media_assets: null }],
    });
    const rows: MediaCandidateRow[] = [{ ...BASE_ROW }];
    assert.equal(await attachCanonicalMedia(client, rows), 0);
    assert.equal(rows[0].canonical_media, undefined);
  });
});
