/**
 * mediaCanonicalRead — the gated read of the CANONICAL media store (spec §6).
 *
 * The Media spec names `media_assets` as the single source of truth for an
 * uploaded file. The serving path does not read it. `lib/media/mediaProjection`
 * resolves a post's media from `post_media`, then falls back to
 * `posts.media_urls`; `media_assets` appears in neither branch. This module is
 * the missing third branch, and it is OFF.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT A CUTOVER, AND MUST NOT BECOME ONE BY ACCIDENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Row counts, read 2026-09-07:
 *
 *   travel-buddy  ajrurzioarfkagpuxfnb  (PRODUCTION)
 *       media_assets           8      (written 2026-07-25 .. 2026-08-16, then none)
 *       media_attachments      0
 *       post_media             6      (all processing_status='ready')
 *       posts                  9      (1 with a non-empty media_urls array)
 *       post_media rows with a media_assets row at the same public_url:  1 of 6
 *
 *   portava-ci    hwokxgbmezheskbzskfr  (CI)
 *       media_assets 0 · media_attachments 0 · post_media 0 · posts 0
 *
 * Two things follow, and they are the whole design of this file.
 *
 * 1. `media_attachments` IS EMPTY. Not sparse — empty, in both databases. The
 *    join this module performs therefore returns nothing today even with the
 *    flag on. Turning the flag on is safe precisely because it is also inert;
 *    it becomes meaningful only after a backfill (see below).
 *
 * 2. A READ PATH THAT PREFERRED `media_assets` WITHOUT FALLING BACK WOULD
 *    DELETE MEDIA. Five of six live post_media rows have no canonical row at
 *    all. `mediaProjection.firstReadyMedia` therefore tries canonical, then
 *    post_media, then media_urls, and a missing canonical row costs nothing.
 *    The two stores coexist for as long as the migration takes. Nothing here
 *    ever replaces a legacy branch; it only gets asked first.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS NEEDS A SECOND QUERY (AND IS NOT ONE EXTRA COLUMN IN THE SELECT)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `media_attachments.entity_id` is a bare `uuid` with NO foreign key to
 * `posts` — it is polymorphic over `entity_type` ('post' | 'postcard' |
 * 'memory' | 'trip' | 'place' | 'event' | 'hidden_gem' | 'shared_moment' |
 * 'observation'). Its only FK is `media_asset_id -> media_assets(id)`
 * (`media_attachments_media_asset_id_fkey`, read from information_schema
 * 2026-09-07). PostgREST resolves an embed only across a declared FK, so
 * `posts` cannot embed `media_attachments`, and the canonical store cannot be
 * added to `MediaProjectionService.SELECT` as another parenthesised child.
 *
 * Hence a keyed second round trip, exactly as
 * `services/wall/WallCandidateLoaders.ts:212` already does for `captured_at`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT A BACKFILL WOULD REQUIRE — WRITTEN DOWN, DELIBERATELY NOT RUN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/scripts/backfill-media-assets.ts` exists and is idempotent (upsert on
 * `(storage_bucket, storage_path)`, upsert on
 * `(media_asset_id, entity_type, entity_id)`). It has NOT been run against
 * production, and it must not be run until all five of these hold:
 *
 *   B1. MIGRATION 2250 IS APPLIED TO THE TARGET DATABASE.
 *       Production does not have it. `media_assets` there has 23 columns;
 *       CI has 27. The four missing are `captured_at`, `location_visibility`,
 *       `provenance`, `intelligence_eligibility`, and
 *       `supabase_migrations.schema_migrations` has no 2250 row. The backfill
 *       writes `moderation_status='active'`, which 2250's widened CHECK admits
 *       and the pre-2250 CHECK (`pending|approved|flagged|rejected`) REJECTS —
 *       so against production today the backfill would fail on every row.
 *       Verify with:
 *         SELECT count(*) FROM information_schema.columns
 *          WHERE table_schema='public' AND table_name='media_assets'
 *            AND column_name IN ('captured_at','location_visibility',
 *                                'provenance','intelligence_eligibility');
 *       -- must return 4.
 *
 *   B2. THE WRITER IS PROVEN TO LAND A ROW IN THAT DATABASE FIRST.
 *       Backfilling into a store that new uploads still cannot write produces a
 *       snapshot that goes stale from the moment it finishes. `recordMediaAsset`
 *       must be observed writing (its warn log is now the evidence; see
 *       `lib/mediaAssets.recordMediaAssetDetailed`).
 *
 *   B3. A DIMENSION SWEEP EXISTS FOR THE ROWS IT CREATES.
 *       The backfill stages every legacy row as `processing_status='processing'`
 *       — it has no width/height, and migration 2089 forbids `ready` without
 *       them. `servableMediaRow` in mediaProjection requires `ready`, so a
 *       backfilled row is INVISIBLE to the canonical branch until something
 *       measures the file. Without B3 the backfill raises coverage on paper and
 *       not at all in the projection.
 *
 *   B4. COVERAGE IS MEASURED AFTER, AND BEFORE THE FLAG MOVES.
 *       The number that matters is how many servable post_media rows have a
 *       servable canonical counterpart:
 *
 *         SELECT count(*) FILTER (WHERE ma.id IS NOT NULL) AS covered,
 *                count(*)                                  AS total
 *           FROM public.post_media pm
 *           LEFT JOIN public.media_assets ma
 *             ON ma.public_url = pm.public_url
 *            AND ma.processing_status = 'ready'
 *          WHERE pm.processing_status = 'ready';
 *
 *       It is 1 / 6 in production right now. Because the read path falls back,
 *       partial coverage is not a correctness risk — it is a MIXED-SOURCE risk:
 *       covered posts start reporting a real `captured_at` while uncovered ones
 *       keep reporting `created_at`, so a timeline can reorder. Decide whether
 *       that is acceptable at the coverage you actually have, per surface.
 *
 *   B5. THE ROLLBACK IS THE FLAG, NOT A DELETE.
 *       `media_canonical_read_enabled = false` returns every surface to the
 *       legacy branches with no data change. Never unwind a backfill by
 *       deleting `media_assets` rows: `lib/mediaAccess.ts:238` uses that table
 *       for OWNER ATTRIBUTION when deciding who may fetch bytes, and
 *       `services/wall/WallCandidateLoaders.loadQuickMediaItems` serves the §18
 *       Quick Media row from it. Deleting rows there is an authorization change,
 *       not a cleanup.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WIRING — THE ONE LINE THAT IS DELIBERATELY NOT WRITTEN HERE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `attachCanonicalMedia` is called from nowhere, and that is a real gap, not a
 * neutral fact: a reader nothing calls is the same shape of dead thing as the
 * writer nothing could reach. It is recorded here rather than hidden.
 *
 * Its intended caller is
 * `services/media/MediaProjectionService.projectCandidatesProtected`, the single
 * funnel every World-shell builder passes through:
 *
 *     await attachCanonicalMedia(sc, rows);      // no-op while the flag is off
 *     const p = toMediaProjection(row, nowMs);   // unchanged
 *
 * That file is outside this change's ownership boundary, so the line is not
 * added here. Adding it is safe — the flag reads false in both databases (FALSE
 * in portava-ci, no row at all in production), so `attachCanonicalMedia` returns
 * before it issues any query — but it should be added by whoever owns that
 * service, in a diff that says so.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../featureFlags.js";
import { logger } from "../logger.js";
import {
  MEDIA_PROJECTION_MEDIA_ASSET_COLUMNS,
  type MediaCandidateRow,
} from "./mediaProjection.js";

/**
 * The gate. Seeded FALSE by migration 2336 (applied to portava-ci 2026-09-07;
 * NOT applied to production, where the row does not exist). `isFlagEnabled`
 * returns false for a missing row as well as for a FALSE one, so the canonical
 * read is off in both databases and off by construction anywhere the row has
 * not been created.
 *
 * DISTINCT FROM `media_canonical_enabled`, which gates the WRITE side and is
 * TRUE in production. Reusing that flag would have flipped the read path in
 * production the moment this shipped, against a store holding one sixth of the
 * media — which is the failure this whole file is arranged to prevent.
 */
export const MEDIA_CANONICAL_READ_FLAG = "media_canonical_read_enabled";

/** Cap on ids per query — the projection page is 200 candidates by default. */
const MAX_ENTITY_IDS = 500;

/** How many attachments to pull. A post rarely has more than a handful. */
const MAX_ATTACHMENT_ROWS = 1000;

export interface AttachCanonicalMediaOptions {
  /** The §6.1 entityType these rows are. Defaults to 'post'. */
  entityType?: string;
}

/**
 * Attach each row's canonical `media_assets` rows as `row.canonical_media`,
 * so `mediaProjection.firstReadyMedia` can prefer them.
 *
 * Returns the number of rows that gained canonical data — 0 whenever the flag
 * is off, the input is empty, or the read fails.
 *
 * FAIL-SOFT AND NON-DESTRUCTIVE. Every failure mode leaves `rows` exactly as it
 * found them, which means the projection falls back to `post_media` /
 * `media_urls`: an unreachable canonical store degrades to today's behaviour
 * rather than to blank cards. It never deletes or overwrites `post_media`.
 *
 * MUTATES `rows` in place — they are already-fetched candidate rows owned by
 * the caller, and copying a 200-row page to add one field is waste.
 *
 * ON A DATABASE WITHOUT MIGRATION 2250 (production, today) the embed selects
 * `captured_at`, which does not exist there, and PostgREST rejects the whole
 * query. That lands in the error branch: nothing is attached, nothing is
 * logged as data loss, and every projection takes the legacy path — i.e.
 * enabling the flag against such a database is a no-op rather than an outage.
 * That is the correct failure, but it is not a substitute for B1: a read that
 * silently returns nothing is exactly the shape of the bug this module exists
 * to answer for, which is why the warn log above is unconditional.
 */
export async function attachCanonicalMedia(
  sc: SupabaseClient,
  rows: MediaCandidateRow[],
  opts: AttachCanonicalMediaOptions = {},
): Promise<number> {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  // One flag read gates everything. Off ⇒ no query, no mutation, no cost.
  if (!(await isFlagEnabled(sc, MEDIA_CANONICAL_READ_FLAG))) return 0;

  const entityType = opts.entityType ?? "post";
  const ids = [...new Set(rows.map((r) => String(r.id)).filter((id) => id.length > 0))].slice(
    0,
    MAX_ENTITY_IDS,
  );
  if (ids.length === 0) return 0;

  let attachments: any[] = [];
  try {
    const { data, error } = await sc
      .from("media_attachments")
      .select(`entity_id, position, is_cover, media_assets(${MEDIA_PROJECTION_MEDIA_ASSET_COLUMNS})`)
      .eq("entity_type", entityType)
      .in("entity_id", ids)
      .limit(MAX_ATTACHMENT_ROWS);
    if (error) {
      logger.warn(
        { err: error, entityType, ids: ids.length },
        "canonical media read failed — projection falls back to post_media/media_urls",
      );
      return 0;
    }
    attachments = (data as any[]) ?? [];
  } catch (err) {
    logger.warn(
      { err, entityType },
      "canonical media read threw — projection falls back to post_media/media_urls",
    );
    return 0;
  }
  if (attachments.length === 0) return 0;

  const byEntity = new Map<string, any[]>();
  for (const a of attachments) {
    // PostgREST returns an embedded to-one either as an object or, depending on
    // how it resolves the relationship, as a one-element array. Handle both.
    const asset = Array.isArray(a?.media_assets) ? a.media_assets[0] : a?.media_assets;
    if (!asset || !asset.id) continue;
    const entityId = String(a.entity_id ?? "");
    if (!entityId) continue;
    // The attachment's `position` is what orders the entity's media (§6.1);
    // it is folded onto the asset so the pure projector needs only one object.
    // `is_cover` is carried for a future cover-first rule and is inert today.
    const merged = { ...asset, position: a.position ?? 0, is_cover: a.is_cover === true };
    const list = byEntity.get(entityId);
    if (list) list.push(merged);
    else byEntity.set(entityId, [merged]);
  }
  if (byEntity.size === 0) return 0;

  let attached = 0;
  for (const row of rows) {
    const list = byEntity.get(String(row.id));
    if (!list || list.length === 0) continue;
    row.canonical_media = list;
    attached++;
  }
  return attached;
}
