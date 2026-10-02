/**
 * entryRequirements.ts — passport-aware entry intelligence (curated corridors).
 *
 * HONESTY CONTRACT:
 *   • Corridor data comes ONLY from the admin-curated entry_requirements table
 *     (every row carries an official_source_url + last_verified_at).
 *   • Unknown corridors are explicit unknowns — never guessed, never defaulted.
 *   • The DISCLAIMER ships with every assessment response.
 *
 * Data model (migration 0169):
 *   traveler_passports       — user's saved passports (issuing country only)
 *   trip_traveler_passports  — one passport selection per (trip, user)
 *   entry_requirements       — (passport_country, destination_country) → status
 */

import { toCountryCode } from "./countryCodes.js";

export const ENTRY_FLAG = "passport_entry_intelligence_enabled";

export const DISCLAIMER =
  "Entry and visa rules change without notice. Portava shows curated data with a " +
  "last-verified date — always confirm with the official government source before you travel.";

export type UnknownReason =
  | "no_passport_selected"
  | "no_data_for_corridor"
  | "destination_not_recognized";

export interface TravelerAssessment {
  userId: string;
  passportSelected: boolean;
  /** ISO2 issuing country of the selected passport (caller-visible for self only). */
  passportCountry: string | null;
  /** Curated corridor row, or null when unknown. */
  requirement: Record<string, unknown> | null;
  unknownReason?: UnknownReason;
}

/**
 * What a corridor read actually found. THREE states, not two.
 *
 *   found       a curated row exists and is returned.
 *   absent      the read SUCCEEDED and there is no row for this corridor. This
 *               is the honesty contract working: nobody has curated it.
 *   unreadable  the read FAILED. We know nothing about this corridor, which is
 *               a different fact from knowing nobody curated it, and a caller
 *               that needs to tell a traveller why must be able to.
 *
 * `lookupRequirement` collapses `absent` and `unreadable` into null and is kept
 * for the callers that genuinely only need the row. Nothing about their
 * behaviour changes — it delegates to this function.
 */
export type CorridorRead =
  | { state: "found"; row: Record<string, unknown> }
  | { state: "absent"; row: null }
  | { state: "unreadable"; row: null; message: string };

const CORRIDOR_COLUMNS =
  "id, passport_country, destination_country, status, allowed_stay_days, " +
  "passport_validity_rule, fee_text, processing_time_text, official_source_url, " +
  "notes, confidence, last_verified_at";

/**
 * Fetch one curated corridor row and SAY WHICH of the three outcomes happened.
 *
 * supabase-js RESOLVES on a database error — `{ data: null, error }` — so an
 * unreadable table and an uncurated corridor arrive here in almost the same
 * shape. `error` is the only thing that separates them, and it is read.
 */
export async function readCorridor(
  sc: any,
  passportCountry: string,
  destinationCountry: string,
): Promise<CorridorRead> {
  try {
    const { data, error } = await sc
      .from("entry_requirements")
      .select(CORRIDOR_COLUMNS)
      .eq("passport_country", passportCountry)
      .eq("destination_country", destinationCountry)
      .maybeSingle();
    if (error) return { state: "unreadable", row: null, message: String((error as any)?.message ?? error) };
    if (!data) return { state: "absent", row: null };
    return { state: "found", row: data as Record<string, unknown> };
  } catch (err) {
    // A thrown error is the same fact as a returned one: we could not read.
    return { state: "unreadable", row: null, message: String((err as any)?.message ?? err) };
  }
}

/**
 * Fetch one curated corridor row, or null. Fail-soft on db errors.
 *
 * Kept for callers that only need the row. It cannot tell "no such corridor"
 * from "could not read" — use `readCorridor` when that difference matters.
 */
export async function lookupRequirement(
  sc: any,
  passportCountry: string,
  destinationCountry: string,
): Promise<Record<string, unknown> | null> {
  return (await readCorridor(sc, passportCountry, destinationCountry)).row;
}

/**
 * Assess entry requirements for every accepted traveler on a trip.
 *
 * Returns { destinationCountry, travelers } where destinationCountry is the
 * resolved ISO2 (or null when the trip's free-text country is unrecognized —
 * in which case every traveler carries unknownReason "destination_not_recognized").
 *
 * Throws { code: "not_found" } when the trip doesn't exist.
 */
export async function assessTripEntry(
  sc: any,
  tripId: string,
): Promise<{ destinationCountry: string | null; travelers: TravelerAssessment[] }> {
  const { data: trip, error: tripErr } = await sc
    .from("trips")
    .select("id, owner_id, destination_country")
    .eq("id", tripId)
    .maybeSingle();
  if (tripErr || !trip) {
    const err: any = new Error("Trip not found");
    err.code = "not_found";
    throw err;
  }

  const destinationCountry = toCountryCode((trip as any).destination_country ?? null);

  // Accepted travelers = owner + accepted trip_members (roles owner/co_host/member/viewer).
  const travelerIds = new Set<string>([(trip as any).owner_id]);
  try {
    const { data: members } = await sc
      .from("trip_members")
      .select("user_id, role, status")
      .eq("trip_id", tripId);
    for (const m of (members as any[]) ?? []) {
      const role = (m as any).role;
      const status = (m as any).status;
      const acceptedRole = ["owner", "co_host", "member", "viewer"].includes(role);
      const acceptedStatus = status == null || status === "accepted";
      if (acceptedRole && acceptedStatus) travelerIds.add((m as any).user_id);
    }
  } catch {
    /* fail-soft: owner-only assessment */
  }

  // Passport selections for this trip.
  const selections = new Map<string, string>(); // userId → passport_id
  try {
    const { data: sel } = await sc
      .from("trip_traveler_passports")
      .select("user_id, passport_id")
      .eq("trip_id", tripId);
    for (const s of (sel as any[]) ?? []) {
      selections.set((s as any).user_id, (s as any).passport_id);
    }
  } catch {
    /* fail-soft: everyone reads as no_passport_selected */
  }

  // Resolve selected passports → issuing countries.
  const passportCountryById = new Map<string, string>();
  const passportIds = Array.from(selections.values());
  if (passportIds.length > 0) {
    try {
      const { data: rows } = await sc
        .from("traveler_passports")
        .select("id, issuing_country")
        .in("id", passportIds);
      for (const p of (rows as any[]) ?? []) {
        passportCountryById.set((p as any).id, (p as any).issuing_country);
      }
    } catch {
      /* fail-soft */
    }
  }

  // Corridor rows for every distinct passport country (one query).
  const corridorByPassport = new Map<string, Record<string, unknown>>();
  const distinctCountries = Array.from(new Set(passportCountryById.values()));
  if (destinationCountry && distinctCountries.length > 0) {
    try {
      const { data: rows } = await sc
        .from("entry_requirements")
        .select(
          "id, passport_country, destination_country, status, allowed_stay_days, " +
            "passport_validity_rule, fee_text, processing_time_text, official_source_url, " +
            "notes, confidence, last_verified_at",
        )
        .in("passport_country", distinctCountries)
        .eq("destination_country", destinationCountry);
      for (const r of (rows as any[]) ?? []) {
        corridorByPassport.set((r as any).passport_country, r as Record<string, unknown>);
      }
    } catch {
      /* fail-soft: corridors read as unknown */
    }
  }

  const travelers: TravelerAssessment[] = [];
  for (const userId of travelerIds) {
    const passportId = selections.get(userId) ?? null;
    const passportCountry = passportId
      ? (passportCountryById.get(passportId) ?? null)
      : null;

    if (!passportId || !passportCountry) {
      travelers.push({
        userId,
        passportSelected: false,
        passportCountry: null,
        requirement: null,
        unknownReason: "no_passport_selected",
      });
      continue;
    }
    if (!destinationCountry) {
      travelers.push({
        userId,
        passportSelected: true,
        passportCountry,
        requirement: null,
        unknownReason: "destination_not_recognized",
      });
      continue;
    }
    const requirement = corridorByPassport.get(passportCountry) ?? null;
    travelers.push({
      userId,
      passportSelected: true,
      passportCountry,
      requirement,
      ...(requirement ? {} : { unknownReason: "no_data_for_corridor" as UnknownReason }),
    });
  }

  return { destinationCountry, travelers };
}
