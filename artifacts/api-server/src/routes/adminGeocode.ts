/**
 * Admin geocode-cache management
 *
 * Mounted at /api (full paths: /api/admin/geocode-cache/...)
 * All routes require admin role.
 *
 * GET    /admin/geocode-cache            — list/search rows (optional ?q= filter)
 * DELETE /admin/geocode-cache/:city_key  — purge a row; next lookup re-resolves
 * PUT    /admin/geocode-cache/:city_key  — overwrite with a corrected result
 *
 * When a row is deleted or overwritten the corresponding in-memory cache entry
 * is also evicted so the correction takes effect immediately without a restart.
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { evictGeocodeCacheKey } from "../lib/stamps/countryGeocoder.js";
import { repairXXCatalogEntries, makeGeocodingResolver, countXXEntriesForCityKey } from "../lib/stamps/xxCatalogRepair.js";

const router = Router();

const DB_CACHE_TABLE = "city_country_geocode_cache";
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

// ── Admin guard ───────────────────────────────────────────────────────────────

async function requireAdmin(
  req: any,
  res: any,
): Promise<{ userId: string; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  const { data } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (!data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }

  const sc = getServiceClient() ?? client;
  return { userId: user.id, sc };
}

// ── GET /admin/geocode-cache ──────────────────────────────────────────────────

router.get("/admin/geocode-cache", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const limitRaw = parseInt(String(req.query.limit ?? "100"), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;

  let query = sc
    .from(DB_CACHE_TABLE)
    .select("city_key, country, country_code, resolved_at, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (q) {
    query = query.ilike("city_key", `%${q}%`);
  }

  const { data, error } = await query;
  if (error) return sendError(res, "db_error", error.message);

  res.json({ rows: data ?? [] });
}));

// ── DELETE /admin/geocode-cache/:city_key ─────────────────────────────────────

router.delete("/admin/geocode-cache/:city_key", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const cityKey = req.params.city_key;
  if (!cityKey || cityKey.trim() === "") {
    return sendError(res, "invalid_payload", "city_key is required");
  }

  // repair_catalog may be passed as a JSON body field or as a query-string flag.
  const repairCatalog =
    req.body?.repair_catalog === true ||
    req.query.repair_catalog === "true" ||
    req.query.repair_catalog === "1";

  // Soft-delete: write a tombstone so the background correction sweep can
  // propagate this deletion to other instances within the next sweep cycle
  // (≤ 5 minutes).  The sweep evicts in-memory entries for tombstoned rows,
  // then hard-deletes the tombstone itself.  A hard delete here would make
  // the row invisible to the sweep (deleted rows have no deleted_at to query).
  const { error } = await sc
    .from(DB_CACHE_TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq("city_key", cityKey);

  if (error) return sendError(res, "db_error", error.message);

  evictGeocodeCacheKey(cityKey);

  let repairStats: import("../lib/stamps/xxCatalogRepair.js").RepairStats | undefined;
  let xxEntriesPending: number | undefined;

  if (repairCatalog) {
    // After purging the wrong row the next geocodeCityCountry call will
    // re-resolve via Nominatim and re-populate the DB cache.  Running
    // repairXXCatalogEntries now triggers that re-resolution immediately
    // so affected catalog entries are re-keyed without waiting for the
    // periodic sweep.
    repairStats = await repairXXCatalogEntries(
      sc,
      makeGeocodingResolver(),
      { info: console.log, warn: console.warn },
      { cityKeyFilter: cityKey },
    );
  } else {
    // Repair did not run — count how many XX catalog entries are still
    // pending for this city so the caller can decide whether to re-issue
    // the request with repair_catalog=true.
    xxEntriesPending = await countXXEntriesForCityKey(sc, cityKey);
  }

  res.json({
    deleted: true,
    city_key: cityKey,
    ...(repairStats !== undefined ? { repair: repairStats } : {}),
    ...(xxEntriesPending !== undefined ? { xx_entries_pending: xxEntriesPending } : {}),
  });
}));

// ── PUT /admin/geocode-cache/:city_key ────────────────────────────────────────

const PutBodySchema = z.object({
  country_code: z
    .string()
    .refine((v) => COUNTRY_CODE_RE.test(v), { message: "country_code must be two letters (ISO 3166-1 alpha-2)" }),
  country: z.string().min(1),
  repair_catalog: z.boolean().optional(),
});

router.put("/admin/geocode-cache/:city_key", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const cityKey = req.params.city_key;
  if (!cityKey || cityKey.trim() === "") {
    return sendError(res, "invalid_payload", "city_key is required");
  }

  const parsed = PutBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, "invalid_payload", parsed.error.issues.map((i) => i.message).join("; "));
  }

  const { country_code, country, repair_catalog } = parsed.data;
  const normalised_code = country_code.toUpperCase();

  const now = new Date().toISOString();
  const { error } = await sc.from(DB_CACHE_TABLE).upsert(
    {
      city_key: cityKey,
      country,
      country_code: normalised_code,
      updated_at: now,
      corrected_at: now,
      // Revive any soft-deleted (tombstoned) row so the sweep doesn't
      // treat this correction as a deletion and hard-delete it next cycle.
      deleted_at: null,
    },
    { onConflict: "city_key" },
  );

  if (error) return sendError(res, "db_error", error.message);

  // Evict the in-memory geocode cache so the next resolution uses the
  // corrected DB row immediately (no server restart required).
  evictGeocodeCacheKey(cityKey);

  let repairStats: import("../lib/stamps/xxCatalogRepair.js").RepairStats | undefined;
  let xxEntriesPending: number | undefined;

  if (repair_catalog) {
    // Re-key catalog entries for this city using the corrected geocode.
    // The geocoder will now read the just-written DB cache row, so no
    // external network call is needed.
    repairStats = await repairXXCatalogEntries(
      sc,
      makeGeocodingResolver(),
      { info: console.log, warn: console.warn },
      { cityKeyFilter: cityKey },
    );
  } else {
    // Repair did not run — count how many XX catalog entries are still
    // pending for this city so the caller can decide whether to re-issue
    // the request with repair_catalog=true.
    xxEntriesPending = await countXXEntriesForCityKey(sc, cityKey);
  }

  res.json({
    updated: true,
    city_key: cityKey,
    country_code: normalised_code,
    country,
    ...(repairStats !== undefined ? { repair: repairStats } : {}),
    ...(xxEntriesPending !== undefined ? { xx_entries_pending: xxEntriesPending } : {}),
  });
}));

// ── PUT /admin/repair_catalog ─────────────────────────────────────────────────

/**
 * Transliterate stroked letters (Ł→l, Ø→o, Đ→d) and apply the same
 * normalisation used when geocode cache keys are written:
 * lowercase, NFD, strip combining diacritics, collapse whitespace.
 *
 * Mirrors normCity in countryGeocoder.ts and normCityKey in xxCatalogRepair.ts.
 */
function transliterateStrokedKey(raw: string): string {
  return raw
    .replace(/[Łł]/g, "l")
    .replace(/[Øø]/g, "o")
    .replace(/[Đđ]/g, "d")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * PUT /admin/repair_catalog
 *
 * One-shot sweep: find every geocode-cache row whose city_key still carries a
 * stroked letter (Ł, Ø, Đ) OR any ordinary decomposable accent (é, á, ü, ã,
 * etc.) that survives the old NFD normalisation, upsert a new row under the
 * fully-transliterated/normalised key, and soft-delete the old row so the
 * periodic tombstone sweep removes it. This mirrors DELETE's re-keying
 * behaviour (repairXXCatalogEntries / normCityKey) — accented-city entries
 * must be re-keyed on PUT too, not only on DELETE.
 *
 * Returns { rekeyed: number, entries: [{ old_key, new_key }] }.
 */
router.put("/admin/repair_catalog", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data, error } = await sc
    .from(DB_CACHE_TABLE)
    .select("city_key, country, country_code, resolved_at, updated_at");
  if (error) return sendError(res, "db_error", error.message);

  const rows = (data ?? []) as Array<{
    city_key: string;
    country: string | null;
    country_code: string | null;
    resolved_at: string | null;
    updated_at: string | null;
  }>;

  const rekeyed: Array<{ old_key: string; new_key: string }> = [];

  for (const row of rows) {
    // Compute the fully-normalised key directly rather than pre-filtering on
    // STROKED_LETTER_RE — that regex only catches Ł/Ø/Đ and would silently
    // skip ordinary accented cities (São Paulo, München, etc.) that still
    // need re-keying.
    const newKey = transliterateStrokedKey(row.city_key);
    if (newKey === row.city_key) continue;

    const now = new Date().toISOString();

    const { error: upsertErr } = await sc.from(DB_CACHE_TABLE).upsert(
      {
        city_key:    newKey,
        country:     row.country,
        country_code: row.country_code,
        resolved_at: row.resolved_at,
        updated_at:  now,
        // Ensure any prior tombstone on the new key is cleared.
        deleted_at:  null,
      },
      { onConflict: "city_key" },
    );
    if (upsertErr) {
      console.warn(`[repair_catalog] upsert failed for "${newKey}":`, upsertErr.message);
      continue;
    }

    // Soft-delete the stroked-letter key; the periodic sweep will hard-delete it.
    await sc
      .from(DB_CACHE_TABLE)
      .update({ deleted_at: now })
      .eq("city_key", row.city_key);

    evictGeocodeCacheKey(row.city_key);

    rekeyed.push({ old_key: row.city_key, new_key: newKey });
  }

  res.json({ rekeyed: rekeyed.length, entries: rekeyed });
}));

export default router;
