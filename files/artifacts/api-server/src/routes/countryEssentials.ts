/**
 * Country essentials routes — travel-readiness reference data.
 *
 *   GET /api/countries/:code/essentials   — one country (ISO2 or a name)
 *   GET /api/trips/:tripId/essentials      — essentials for the trip's
 *                                            destination country(ies)
 *
 * Flag-gated by country_essentials_enabled. Reads the DB table first (so admin
 * edits win), falls back to the in-code curated dataset when the row/table is
 * absent, so it works even before 0182 runs. Every response carries the
 * confirm-on-arrival disclaimer (emergency numbers are safety-relevant).
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { toCountryCode } from "../lib/countryCodes.js";
import {
  essentialsFor,
  CONFIRM_DISCLAIMER,
  ESSENTIALS_SOURCE,
  ESSENTIALS_DATASET_DATE,
} from "../lib/countryEssentials.js";

const FLAG = "country_essentials_enabled";
const router = Router();

interface EssentialsPayload {
  code: string;
  plugTypes: string[];
  voltage: number | null;
  frequency: number | null;
  driveSide: string | null;
  emergency: Record<string, string>;
  confidence: string;
  source: string;
  lastVerifiedAt: string;
  disclaimer: string;
}

/** Resolve essentials for an ISO2 code — DB row first, curated lib fallback. */
async function resolveEssentials(sc: any, code: string): Promise<EssentialsPayload | null> {
  const iso = code.toUpperCase();
  // 1. DB (admin edits win).
  try {
    const { data, error } = await sc
      .from("country_essentials")
      .select("code, plug_types, voltage, frequency, drive_side, emergency, confidence, source, last_verified_at")
      .eq("code", iso)
      .maybeSingle();
    if (!error && data) {
      const d = data as any;
      return {
        code: d.code,
        plugTypes: d.plug_types ?? [],
        voltage: d.voltage ?? null,
        frequency: d.frequency ?? null,
        driveSide: d.drive_side ?? null,
        emergency: d.emergency ?? {},
        confidence: d.confidence ?? "curated",
        source: d.source ?? ESSENTIALS_SOURCE,
        lastVerifiedAt: String(d.last_verified_at ?? ESSENTIALS_DATASET_DATE),
        disclaimer: CONFIRM_DISCLAIMER,
      };
    }
  } catch {
    // fall through to curated lib
  }
  // 2. Curated in-code dataset.
  const lib = essentialsFor(iso);
  if (!lib) return null;
  return {
    code: lib.code,
    plugTypes: lib.plugTypes,
    voltage: lib.voltage,
    frequency: lib.frequency,
    driveSide: lib.driveSide,
    emergency: lib.emergency as Record<string, string>,
    confidence: "curated",
    source: ESSENTIALS_SOURCE,
    lastVerifiedAt: ESSENTIALS_DATASET_DATE,
    disclaimer: CONFIRM_DISCLAIMER,
  };
}

// ── GET /api/countries/:code/essentials ──────────────────────────────────────

router.get("/countries/:code/essentials", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!(await isFlagEnabled(sc, FLAG))) {
    res.json({ essentials: null, enabled: false });
    return;
  }

  const raw = String(req.params.code ?? "").trim();
  const iso = /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : toCountryCode(raw);
  if (!iso) { sendError(res, "invalid_payload", "Unrecognized country"); return; }

  const essentials = await resolveEssentials(sc, iso);
  res.json({ essentials, enabled: true }); // essentials null when country not covered (honest unknown)
}));

// ── GET /api/trips/:tripId/essentials ────────────────────────────────────────

router.get("/trips/:tripId/essentials", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!(await isFlagEnabled(sc, FLAG))) {
    res.json({ items: [], enabled: false });
    return;
  }

  const tripId = String(req.params.tripId ?? "");
  const membership = await requireTripMember(sc, tripId, user.id);
  if (!membership) { sendError(res, "forbidden", "Not a member of this trip"); return; }

  // Collect destination countries: trip_destinations first, then the trip's
  // primary destination_country. Deduped, order-preserving.
  const countries: string[] = [];
  const pushCountry = (raw: string | null | undefined) => {
    if (!raw) return;
    const iso = /^[A-Za-z]{2}$/.test(String(raw).trim()) ? String(raw).trim().toUpperCase() : toCountryCode(String(raw));
    if (iso && !countries.includes(iso)) countries.push(iso);
  };

  try {
    const { data: dests } = await sc
      .from("trip_destinations")
      .select("country, position")
      .eq("trip_id", tripId)
      .order("position", { ascending: true });
    for (const d of (dests ?? []) as any[]) pushCountry(d.country);
  } catch { /* table optional */ }

  if (countries.length === 0) {
    const { data: trip } = await sc
      .from("trips")
      .select("destination_country")
      .eq("id", tripId)
      .maybeSingle();
    pushCountry((trip as any)?.destination_country);
  }

  const items = [];
  for (const iso of countries) {
    const essentials = await resolveEssentials(sc, iso);
    items.push({ country: iso, essentials }); // essentials null = not covered
  }

  res.json({ items, enabled: true, disclaimer: CONFIRM_DISCLAIMER });
}));

export default router;
