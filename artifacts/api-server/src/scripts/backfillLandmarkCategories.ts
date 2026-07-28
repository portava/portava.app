/**
 * backfillLandmarkCategories — one-time re-classification of `places` rows
 * that were ingested before the landmark category expansion.
 *
 * Before the expansion, `categoryFamily()` mapped raw categories like
 * "viewpoint" and "park" to the generic "attraction" bucket.  Rows created
 * at that time therefore have `primary_category = 'attraction'` in the DB
 * even though their raw category (stored in `external_place_references
 * .raw_category`) unambiguously maps to a natural-landmark sub-family.
 *
 * The `landmarkDedupSweep` queries `primary_category IN ('waterfall',
 * 'mountain', 'beach', 'viewpoint', 'park', …)` and therefore silently skips
 * all such rows.  This script fixes that gap.
 *
 * Strategy:
 *   1. Page through all active `places` rows with `primary_category =
 *      'attraction'`.
 *   2. For each place, collect all `external_place_references.raw_category`
 *      values and run `categoryFamily()` on each one.
 *   3. If ANY reference resolves to a `LANDMARK_CATEGORY_FAMILIES` member,
 *      update `places.primary_category` to that value.
 *   4. When multiple references resolve to different landmark sub-families
 *      (unusual but possible), pick the sub-family with the most votes; ties
 *      are broken by the lexicographically first sub-family so the outcome is
 *      deterministic.
 *   5. Places with no raw_category link, or whose raw categories all still
 *      resolve to "attraction" / "other", are left unchanged.
 *
 * Usage (dry-run — default, no writes):
 *   node --import tsx/esm src/scripts/backfillLandmarkCategories.ts
 *
 * Usage (apply updates):
 *   node --import tsx/esm src/scripts/backfillLandmarkCategories.ts --apply
 *
 * Output is newline-delimited JSON so it can be piped to jq for inspection.
 * Each reclassified-place line looks like:
 *   {"action":"reclassify","placeId":"<uuid>","name":"...","oldCategory":"attraction","newCategory":"viewpoint","rawCategories":["viewpoint"]}
 *
 * Safety guarantees:
 *   • Dry-run is the default — pass --apply explicitly to commit.
 *   • Already-merged rows (merged_into_place_id IS NOT NULL) are skipped.
 *   • Rows with no external reference pointing at a landmark are left as "attraction".
 *   • Each update is logged before execution.
 */

import { getServiceClient } from "../lib/supabase.js";
import {
  LANDMARK_CATEGORY_FAMILIES,
  categoryFamily,
  type PlaceCategory,
} from "../lib/places/placeResolve.js";

// ── Config ────────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes("--apply");
const PAGE = 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function logErr(msg: string, detail?: unknown): void {
  process.stderr.write(JSON.stringify({ error: msg, detail }) + "\n");
}

/**
 * Given an array of raw_category strings from external_place_references,
 * returns the landmark PlaceCategory that has the most votes, or null when
 * none of the raw categories resolve to a landmark sub-family.
 *
 * Tie-breaking: lexicographically first sub-family (deterministic).
 */
function pickLandmarkCategory(rawCategories: (string | null)[]): PlaceCategory | null {
  const votes = new Map<PlaceCategory, number>();

  for (const raw of rawCategories) {
    const fam = categoryFamily(raw);
    if (LANDMARK_CATEGORY_FAMILIES.has(fam)) {
      votes.set(fam, (votes.get(fam) ?? 0) + 1);
    }
  }

  if (votes.size === 0) return null;

  // Sort by votes desc, then by name asc for deterministic tie-breaking.
  const sorted = Array.from(votes.entries()).sort(([aFam, aVotes], [bFam, bVotes]) => {
    if (bVotes !== aVotes) return bVotes - aVotes;
    return aFam < bFam ? -1 : 1;
  });

  return sorted[0][0];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log({ stage: "start", apply: APPLY });

  const sc = getServiceClient();
  if (!sc) {
    logErr("Service client unavailable — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  // Page through all active "attraction" places using keyset pagination on `id`
  // (ordered ascending).  Keyset pagination is mutation-safe: updating a row's
  // primary_category drops it from future pages but does NOT shift the cursor,
  // so every row is visited exactly once regardless of whether --apply is set.
  const stats = { scanned: 0, reclassified: 0, noRef: 0, unchanged: 0, errors: 0 };
  let cursor: string | null = null; // last id seen; null = start of table

  while (true) {
    // Fetch a page of attraction places with their external reference raw categories.
    // We select raw_category via a join (Supabase PostgREST nested select).
    let query = sc
      .from("places")
      .select("id, name, external_place_references(raw_category)")
      .eq("primary_category", "attraction")
      .is("merged_into_place_id", null)
      .order("id", { ascending: true })
      .limit(PAGE);

    if (cursor !== null) {
      query = query.gt("id", cursor);
    }

    const { data, error } = await query;

    if (error) {
      logErr("fetch failed", error.message);
      process.exit(1);
    }

    const rows = (data as any[]) ?? [];
    if (rows.length === 0) break;

    // Advance cursor to the last id in this page before processing, so the
    // cursor is always valid even if we hit an error mid-page.
    cursor = rows[rows.length - 1].id;

    for (const place of rows) {
      stats.scanned++;

      const refs: { raw_category: string | null }[] =
        Array.isArray(place.external_place_references) ? place.external_place_references : [];

      if (refs.length === 0) {
        stats.noRef++;
        continue;
      }

      const rawCategories = refs.map((r) => r.raw_category);
      const newCategory = pickLandmarkCategory(rawCategories);

      if (!newCategory) {
        stats.unchanged++;
        continue;
      }

      const reclassifyEntry = {
        action: "reclassify",
        placeId: place.id,
        name: place.name,
        oldCategory: "attraction",
        newCategory,
        rawCategories: rawCategories.filter(Boolean),
      };

      log(reclassifyEntry);

      if (APPLY) {
        const { error: updateError } = await sc
          .from("places")
          .update({ primary_category: newCategory })
          .eq("id", place.id);

        if (updateError) {
          logErr("update failed", { placeId: place.id, error: updateError.message });
          stats.errors++;
        } else {
          stats.reclassified++;
        }
      } else {
        stats.reclassified++;
      }
    }

    if (rows.length < PAGE) break;
  }

  log({ stage: "scan_complete", ...stats, apply: APPLY });

  if (!APPLY) {
    log({
      stage: "dry_run_done",
      note: "Pass --apply to commit the reclassifications above",
    });
  } else {
    log({ stage: "done", ...stats });
  }
}

// Only run when invoked directly, not when imported in tests.
if (
  process.argv[1]?.endsWith("backfillLandmarkCategories.ts") ||
  process.argv[1]?.endsWith("backfillLandmarkCategories.js")
) {
  main().catch((err) => {
    logErr("unhandled error", String(err));
    process.exit(1);
  });
}
