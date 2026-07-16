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

router.get("/admin/geocode-cache", async (req, res) => {
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
});

// ── DELETE /admin/geocode-cache/:city_key ─────────────────────────────────────

router.delete("/admin/geocode-cache/:city_key", async (req, res) => {
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
});

// ── PUT /admin/geocode-cache/:city_key ────────────────────────────────────────

const PutBodySchema = z.object({
  country_code: z
    .string()
    .refine((v) => COUNTRY_CODE_RE.test(v), { message: "country_code must be two letters (ISO 3166-1 alpha-2)" }),
  country: z.string().min(1),
  repair_catalog: z.boolean().optional(),
});

router.put("/admin/geocode-cache/:city_key", async (req, res) => {
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
  }

  res.json({
    updated: true,
    city_key: cityKey,
    country_code: normalised_code,
    country,
    ...(repairStats !== undefined ? { repair: repairStats } : {}),
  });
});

export default router;
