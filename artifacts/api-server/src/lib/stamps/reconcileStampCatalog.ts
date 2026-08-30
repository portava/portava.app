/**
 * Stamp Catalog Reconciliation — shared logic
 *
 * Called by:
 *   - src/scripts/reconcileStampCatalog.ts  (CLI / CI; re-exports this module)
 *   - POST /admin/stamps/reconcile          (on-demand via API)
 *
 * Idempotent — safe to re-run.
 *
 * Auditability: every execution writes exactly ONE run-summary row to
 * `stamp_reconciliation_log` (source_table = "reconciliation_run",
 * needs_admin_review = false, counts JSON in review_reason) — including
 * zero-work runs, and best-effort on fatal errors — so "did it run" is
 * answerable from the table. Admin-review queries filter
 * needs_admin_review = true and are unaffected.
 */

import { randomUUID } from "node:crypto";
import { canonicalLocationKeyFromStrings } from "./locationKey.js";
import { resolveOrEnqueueForDefinition } from "./StampCatalogService.js";
import { resolveCountry } from "./countryLookup.js";
import { STYLE_VERSION } from "./artDirection.js";

export interface LocationCombo {
  stamp_type:            string;
  country:               string | null;
  city:                  string | null;
  neighborhood?:         string | null;
  // definition IDs collected from user_stamps rows — used for the write-side
  // update because user_stamps has no stamp_type column; we filter by definition.
  userStampDefIds:       string[];
}

export interface ReconcileStats {
  resolved:  number;
  flagged:   number;
  skipped:   number;
  enqueued:  number;
  combos:    number;
}

/** Marker value used in stamp_reconciliation_log.source_table for run summaries. */
export const RUN_SUMMARY_SOURCE_TABLE = "reconciliation_run";

/**
 * Writes the single run-summary row for a reconciliation execution.
 * Best-effort: failures are logged but never thrown.
 */
async function writeRunSummary(
  sc: any,
  runId: string,
  stats: ReconcileStats,
  fatalError: string | null,
): Promise<void> {
  try {
    const { error } = await sc.from("stamp_reconciliation_log").insert({
      source_table:       RUN_SUMMARY_SOURCE_TABLE,
      source_id:          runId,
      raw_country:        null,
      raw_city:           null,
      stamp_type:         null,
      canonical_key:      null,
      needs_admin_review: false,
      review_reason:      JSON.stringify({
        resolved: stats.resolved,
        flagged:  stats.flagged,
        skipped:  stats.skipped,
        enqueued: stats.enqueued,
        combos:   stats.combos,
        ...(fatalError ? { fatal_error: fatalError } : {}),
      }),
    });
    if (error) console.warn("[reconcile] Failed to write run summary:", error.message);
  } catch (e: any) {
    console.warn("[reconcile] Failed to write run summary:", e?.message);
  }
}

/**
 * Runs the full reconciliation against the given supabase client (must be a
 * service-role client — reads and writes across all users).
 * Always attempts to write exactly one run-summary row: on completion for
 * successful runs (including zero-work runs), and best-effort before
 * rethrowing on fatal errors.
 *
 * Returns a stats object: { resolved, flagged, skipped, enqueued, combos }.
 */

/**
 * Build the distinct location combos contributed by user_stamps rows, keyed by
 * `${stampType}|${country}|${city}`. user_stamps has no stamp_type column — the
 * type lives on the joined stamp_definitions row — so we also collect each
 * stamp_definition_id for the write-side filter. Rows for an existing key
 * accumulate their definition id; the first row seeds the combo. Exported (pure)
 * so the reconciliation contract test binds to this exact logic rather than a
 * hand-copied mirror.
 */
export function buildCombosFromUserStampRows(
  rows: any[],
  combos: Map<string, LocationCombo> = new Map(),
): Map<string, LocationCombo> {
  for (const row of rows) {
    const stampType: string = (row.stamp_definitions as any)?.stamp_type ?? "city";
    const key = `${stampType}|${row.country ?? ""}|${row.city ?? ""}`;
    const existing = combos.get(key);
    if (existing) {
      // Accumulate additional definition IDs for this combo
      if (row.stamp_definition_id && !existing.userStampDefIds.includes(row.stamp_definition_id)) {
        existing.userStampDefIds.push(row.stamp_definition_id);
      }
    } else {
      combos.set(key, {
        stamp_type:       stampType,
        country:          row.country ?? null,
        city:             row.city ?? null,
        userStampDefIds:  row.stamp_definition_id ? [row.stamp_definition_id] : [],
      });
    }
  }
  return combos;
}

export async function runReconciliation(sc: any): Promise<ReconcileStats> {
  const runId = randomUUID();
  const stats: ReconcileStats = { resolved: 0, flagged: 0, skipped: 0, enqueued: 0, combos: 0 };

  try {
    await reconcile(sc, stats);
  } catch (e: any) {
    await writeRunSummary(sc, runId, stats, e?.message ?? String(e));
    throw e;
  }

  await writeRunSummary(sc, runId, stats, null);
  return stats;
}

async function reconcile(sc: any, stats: ReconcileStats): Promise<void> {
  console.log("[reconcile] Starting stamp catalog reconciliation…");

  // Collect distinct combos from both tables
  const combos = new Map<string, LocationCombo>();

  // From user_stamps — join stamp_definitions to get the canonical stamp_type.
  // user_stamps has NO stamp_type column; the type lives on the definition row.
  // We also collect stamp_definition_id so the write-side update can filter by
  // definition rather than the nonexistent stamp_type column.
  const { data: userStamps, error: usErr } = await sc
    .from("user_stamps")
    .select("stamp_definition_id, country, city, stamp_definitions!stamp_definition_id(stamp_type)")
    .or("country.not.is.null,city.not.is.null");

  if (usErr) throw new Error(`Failed to read user_stamps: ${usErr.message}`);

  buildCombosFromUserStampRows((userStamps ?? []) as any[], combos);

  // From passport_stamps (v1) — uses country/city columns (not location_country/location_city)
  const { data: passportStamps, error: psErr } = await sc
    .from("passport_stamps")
    .select("stamp_type, country, city")
    .or("country.not.is.null,city.not.is.null");

  if (psErr) {
    console.warn("[reconcile] passport_stamps read failed (may not exist):", psErr.message);
  } else {
    for (const row of (passportStamps ?? []) as any[]) {
      const stampType = row.stamp_type ?? "city";
      const key = `${stampType}|${row.country ?? ""}|${row.city ?? ""}`;
      if (!combos.has(key)) {
        combos.set(key, {
          stamp_type:       stampType,
          country:          row.country ?? null,
          city:             row.city ?? null,
          userStampDefIds:  [], // passport_stamps-only combo; no user_stamps definitions
        });
      }
    }
  }

  console.log(`[reconcile] Found ${combos.size} distinct location combinations`);
  stats.combos = combos.size;

  const newCatalogIds: string[] = [];

  for (const [_key, combo] of combos) {
    // Skip combos without enough data to build a canonical key
    if (!combo.country && !combo.city) {
      stats.skipped++;
      continue;
    }

    let canonKey: string;
    let displayName: string;
    let countryCode: string;

    let resolvedCountryName: string | null;

    try {
      // Resolve a *real* country code — from the country name or a
      // well-known-city lookup. Never abbreviated from the country's spelling.
      const resolved = resolveCountry({ country: combo.country, city: combo.city });
      countryCode         = resolved.countryCode;
      resolvedCountryName = resolved.country;

      canonKey = canonicalLocationKeyFromStrings({
        stampType:    combo.stamp_type ?? "city",
        country:      resolvedCountryName ?? combo.country,
        city:         combo.city,
        neighborhood: combo.neighborhood ?? null,
      });

      displayName = combo.city ?? resolvedCountryName ?? "Unknown";
    } catch (e: any) {
      console.warn("[reconcile] Failed to build key:", combo, e?.message);
      stats.flagged++;
      continue;
    }

    // Upsert catalog entry
    const { data: existingEntry } = await sc
      .from("universal_stamp_catalog")
      .select("id")
      .eq("canonical_location_key", canonKey)
      .eq("stamp_type", combo.stamp_type ?? "city")
      .maybeSingle();

    let catalogId: string;

    if (existingEntry) {
      catalogId = (existingEntry as any).id;
    } else {
      const { data: newEntry, error: insertErr } = await sc
        .from("universal_stamp_catalog")
        .insert({
          canonical_location_key:  canonKey,
          stamp_type:              combo.stamp_type ?? "city",
          display_name:            displayName,
          country:                 resolvedCountryName ?? combo.country ?? "Unknown",
          country_code:            countryCode,
          city:                    combo.city ?? null,
          status:                  "pending_artwork",
          prompt_template_version: STYLE_VERSION,
        })
        .select("id")
        .single();

      if (insertErr) {
        // Unique constraint race
        if ((insertErr as any).code === "23505") {
          const { data: retry } = await sc
            .from("universal_stamp_catalog")
            .select("id")
            .eq("canonical_location_key", canonKey)
            .eq("stamp_type", combo.stamp_type ?? "city")
            .maybeSingle();
          if (!retry) { stats.flagged++; continue; }
          catalogId = (retry as any).id;
        } else {
          console.warn("[reconcile] Catalog insert failed:", insertErr.message, combo);
          stats.flagged++;

          // Log for admin review
          void sc.from("stamp_reconciliation_log").insert({
            source_table:       "universal_stamp_catalog",
            source_id:          "00000000-0000-0000-0000-000000000000",
            raw_country:        combo.country,
            raw_city:           combo.city,
            stamp_type:         combo.stamp_type,
            canonical_key:      canonKey,
            needs_admin_review: true,
            review_reason:      insertErr.message,
          });

          continue;
        }
      } else {
        catalogId = (newEntry as any).id;
        newCatalogIds.push(catalogId);
      }
    }

    // Update user_stamps.catalog_id.
    // user_stamps has NO stamp_type column, so we filter by stamp_definition_id
    // (collected during the read phase) plus country/city for safety.
    // If no definition IDs were collected (passport_stamps-only combos), skip.
    if (combo.userStampDefIds.length > 0) {
      let usQuery = sc
        .from("user_stamps")
        .update({ catalog_id: catalogId })
        .is("catalog_id", null)
        .in("stamp_definition_id", combo.userStampDefIds);
      if (combo.country != null && combo.country !== "") {
        usQuery = usQuery.eq("country", combo.country) as typeof usQuery;
      } else {
        usQuery = usQuery.is("country", null) as typeof usQuery;
      }
      if (combo.city != null && combo.city !== "") {
        usQuery = usQuery.eq("city", combo.city) as typeof usQuery;
      } else {
        usQuery = usQuery.is("city", null) as typeof usQuery;
      }
      const { error: usUpdateErr } = await usQuery;
      if (usUpdateErr) {
        console.warn("[reconcile] user_stamps update failed:", usUpdateErr.message);
      }
    }

    // Update passport_stamps.catalog_id (v1 path) — match on stamp_type + country + city.
    let psQuery = sc
      .from("passport_stamps")
      .update({ catalog_id: catalogId })
      .is("catalog_id", null)
      .eq("stamp_type", combo.stamp_type ?? "city");
    if (combo.country != null && combo.country !== "") {
      psQuery = psQuery.eq("country", combo.country) as typeof psQuery;
    } else {
      psQuery = psQuery.is("country", null) as typeof psQuery;
    }
    if (combo.city != null && combo.city !== "") {
      psQuery = psQuery.eq("city", combo.city) as typeof psQuery;
    } else {
      psQuery = psQuery.is("city", null) as typeof psQuery;
    }
    const { error: psUpdateErr } = await psQuery;

    if (psUpdateErr && psUpdateErr.message !== "relation does not exist") {
      console.warn("[reconcile] passport_stamps update failed:", psUpdateErr.message);
    }

    stats.resolved++;
  }

  // ── Location-less user_stamps (no country AND no city) ──────────────────
  // Badges / social / safety / trip achievements have no geography. Map them
  // to definition-scoped catalog entries ("definition:{slug}") so each
  // definition shares one catalog entry and one piece of artwork. Rows whose
  // definition can't be resolved are logged for admin review — never silently
  // excluded.
  const { data: noLocRows, error: nlErr } = await sc
    .from("user_stamps")
    .select("id, stamp_definition_id, stamp_definitions!stamp_definition_id(slug, name, stamp_type)")
    .is("catalog_id", null)
    .is("country", null)
    .is("city", null);

  if (nlErr) {
    console.error("[reconcile] Failed to read location-less user_stamps:", nlErr.message);
  } else if ((noLocRows ?? []).length > 0) {
    console.log(`[reconcile] Found ${noLocRows!.length} location-less user_stamps rows`);

    // Group rows by definition
    const byDef = new Map<string, { rows: any[]; def: any }>();
    for (const row of noLocRows as any[]) {
      const defId = row.stamp_definition_id as string | null;
      const def = row.stamp_definitions as any;
      if (!defId || !def?.slug) {
        // Unresolvable — log for admin review
        stats.flagged++;
        await sc.from("stamp_reconciliation_log").insert({
          source_table:       "user_stamps",
          source_id:          row.id,
          raw_country:        null,
          raw_city:           null,
          stamp_type:         def?.stamp_type ?? null,
          canonical_key:      null,
          needs_admin_review: true,
          review_reason:      defId
            ? "location-less stamp: definition has no slug"
            : "location-less stamp: missing stamp_definition_id",
        });
        continue;
      }
      const bucket = byDef.get(defId);
      if (bucket) bucket.rows.push(row);
      else byDef.set(defId, { rows: [row], def });
    }

    for (const [defId, { rows, def }] of byDef) {
      const stampType = def.stamp_type ?? "social";

      // Find or create the definition-scoped catalog entry and enqueue artwork
      // generation, via the same shared helper the award paths use.
      let catalogId: string;
      try {
        const { catalogEntry, wasEnqueued } = await resolveOrEnqueueForDefinition(
          sc,
          { slug: def.slug, name: def.name ?? null, stamp_type: def.stamp_type ?? null },
          "reconciliation_script",
        );
        catalogId = catalogEntry.id;
        if (wasEnqueued) stats.enqueued++;
      } catch (e: any) {
        console.warn("[reconcile] Definition catalog resolve failed:", def.slug, e?.message);
        stats.flagged++;
        for (const row of rows) {
          await sc.from("stamp_reconciliation_log").insert({
            source_table:       "user_stamps",
            source_id:          row.id,
            raw_country:        null,
            raw_city:           null,
            stamp_type:         stampType,
            canonical_key:      null,
            needs_admin_review: true,
            review_reason:      `location-less stamp: catalog resolve failed (${e?.message ?? "unknown"})`,
          });
        }
        continue;
      }

      const { error: updErr } = await sc
        .from("user_stamps")
        .update({ catalog_id: catalogId })
        .is("catalog_id", null)
        .is("country", null)
        .is("city", null)
        .eq("stamp_definition_id", defId);

      if (updErr) {
        console.warn("[reconcile] location-less user_stamps update failed:", updErr.message);
        stats.flagged++;
      } else {
        stats.resolved++;
      }
    }
  }

  // Enqueue generation jobs for all new catalog entries
  console.log(`[reconcile] Enqueueing generation jobs for ${newCatalogIds.length} new catalog entries…`);

  for (const catalogId of newCatalogIds) {
    const { error: queueErr } = await sc
      .from("stamp_generation_queue")
      .insert({
        catalog_id:          catalogId,
        status:              "queued",
        priority:            5,
        triggered_by_action: "reconciliation_script",
      });

    if (!queueErr) {
      stats.enqueued++;
    }
    // Unique constraint fires if a job already exists — ok
  }
}
