/**
 * FSQ Places routes — Compass data.
 *
 *   GET /api/cities/:cityKey/places?category=<cat>&limit=<n>
 *
 * Flag-gated by fsq_places_enabled; returns FSQ attribution alongside the
 * places (the license requires it be displayed). Fail-soft empty when off.
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { fsqEnabled, getCityPlaces, FSQ_ATTRIBUTION } from "../lib/fsq/fsqPlaces.js";
import { FSQ_PLACE_CATEGORIES, type FsqPlaceCategory } from "../lib/fsq/categoryMap.js";

const router = Router();

router.get("/cities/:cityKey/places", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!(await fsqEnabled(sc))) {
    res.json({ places: [], enabled: false, attribution: FSQ_ATTRIBUTION });
    return;
  }

  const cityKey = String(req.params.cityKey ?? "").trim().toLowerCase();
  if (!cityKey) { sendError(res, "invalid_payload", "cityKey required"); return; }

  const catParam = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const category = (FSQ_PLACE_CATEGORIES as readonly string[]).includes(catParam)
    ? (catParam as FsqPlaceCategory)
    : undefined;
  const limit = Number(req.query.limit) || 200;

  const result = await getCityPlaces(sc, { cityKey, category, limit });
  res.json({ ...result, enabled: true });
}));

export default router;
