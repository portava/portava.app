/**
 * memoryCorrections — §3 `memory_corrections` (migration 3673): the owner's
 * authoritative statements about where a Memory was. Census H28, H48, H49, H73
 * and H242.
 *
 * §4's precedence is "explicit user correction > explicit user assertion >
 * mutually confirmed > strong system observation > inference > unknown", and
 * "Negative constraints from corrections must be durable so the system does not
 * repeatedly 'correct' the user back to a prior inference". §9 adds "User
 * correction beats automatic entity resolution".
 *
 * THE AUTOMATIC RESOLUTION THIS BEATS. A Memory names its place by `place_id`
 * and `canonical_location_id`. `lib/placeIdBridge.ts resolveMemoryPlaceRef`
 * turns that into ONE catalog row. When `place_id` is not a catalog row, it
 * matches `canonical_location_id` to the catalog, and the caller then follows
 * the catalog's merges. Both of those are inferences, not the owner's word.
 *
 * WHAT A CORRECTION DOES (memoryActionService.resolveCurrentPlace):
 *   - assert: the owner's stated reference REPLACES the stored one, through
 *     evidence.ts `mergeByPrecedence` with the stored reference as the Memory's
 *     own assertion (EXPLICIT_REMEMBER) and the correction as USER_CORRECTION.
 *     That is the one implementation of §4's ordering, now with a production
 *     caller.
 *   - reject: a value the owner rejected is removed from the reference before
 *     resolution. A rejected stored `place_id` takes the canonical location
 *     resolved from it along. Resolution then refuses (`PLACE_REJECTED_BY_OWNER`) if the
 *     catalog row it reaches, the row it started from, or any row it followed
 *     a merge through is a rejected place. A rejected place is never used.
 *
 * THE FOLD. Rows are read oldest first. The latest assert is the owner's
 * current word. An assert of a value lifts an earlier rejection of that same
 * value, and a later rejection of a value clears it from the assertion. Rows
 * with the same `created_at` apply asserts before rejects, so on a tie the
 * REJECTION wins: fail closed.
 *
 * READS FAIL CLOSED. `readPlaceCorrections` answers in two states:
 *   ok         the corrections; `absent` is true when 3673 is not applied
 *              (42P01 / PGRST205 only), where "no correction" is TRUE
 *   unreadable anything else, including a full page that may be truncated.
 *              The place is then unreadable, never "uncorrected": a missed
 *              rejection would put the owner back at the wrong place.
 *
 * WRITES. Two writers, both owner-only and both through the server:
 *   - PATCH /memories/:id records the change of place as an assert of the new
 *     reference plus a rejection of each value it replaced
 *     (`placeCorrectionsForPatch`). It records BEFORE it writes the Memory, and
 *     an unrecordable correction refuses the edit.
 *   - POST /memories/:id/corrections records a rejection on its own
 *     (routes/memoryCorrections.ts).
 * The table is append-only: there is no update and no delete here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";
import { mergeByPrecedence, normalizeEvidence } from "../memoryProjections/evidence.js";

/** PostgREST's max-rows on Supabase. A corrections read that returns this many may be truncated. */
export const CORRECTIONS_PAGE = 1000;

/** A Memory's place reference, as stored on `memories` and as stated in a correction. */
export interface PlaceRef {
  place_id: string | null;
  canonical_location_id: string | null;
}

export interface PlaceCorrections {
  /** The owner's current statement of the reference, or null when they made none. */
  asserted: PlaceRef | null;
  rejectedPlaceIds: ReadonlySet<string>;
  rejectedCanonicalIds: ReadonlySet<string>;
}

export const NO_PLACE_CORRECTIONS: PlaceCorrections = Object.freeze({
  asserted: null,
  rejectedPlaceIds: new Set<string>(),
  rejectedCanonicalIds: new Set<string>(),
});

export type CorrectionKind = "assert" | "reject";
export type CorrectionSource = "memory_edit" | "correction_route";

export interface CorrectionRow {
  id: string;
  kind: string;
  place_id: string | null;
  canonical_location_id: string | null;
  created_at: string;
}

export type PlaceCorrectionsRead =
  | { state: "ok"; corrections: PlaceCorrections; absent: boolean }
  | { state: "unreadable"; detail: string };

const KIND_ORDER: Readonly<Record<string, number>> = { assert: 0, reject: 1 };

/** Pure. The owner's corrections, folded oldest first. Unknown kinds are ignored. */
export function foldPlaceCorrections(rows: readonly CorrectionRow[]): PlaceCorrections {
  const ordered = [...rows]
    .filter((r) => r.kind === "assert" || r.kind === "reject")
    .sort((a, b) =>
      String(a.created_at).localeCompare(String(b.created_at))
      || (KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]!)
      || String(a.id).localeCompare(String(b.id)));
  let asserted: PlaceRef | null = null;
  const rejectedPlaceIds = new Set<string>();
  const rejectedCanonicalIds = new Set<string>();
  for (const r of ordered) {
    const placeId = r.place_id ?? null;
    const canonicalId = r.canonical_location_id ?? null;
    if (r.kind === "assert") {
      asserted = { place_id: placeId, canonical_location_id: canonicalId };
      if (placeId) rejectedPlaceIds.delete(placeId);
      if (canonicalId) rejectedCanonicalIds.delete(canonicalId);
      continue;
    }
    if (placeId) {
      rejectedPlaceIds.add(placeId);
      if (asserted && asserted.place_id === placeId) asserted = { ...asserted, place_id: null };
    }
    if (canonicalId) {
      rejectedCanonicalIds.add(canonicalId);
      if (asserted && asserted.canonical_location_id === canonicalId) asserted = { ...asserted, canonical_location_id: null };
    }
  }
  return { asserted, rejectedPlaceIds, rejectedCanonicalIds };
}

/** The owner's place corrections on this Memory. Never throws. */
export async function readPlaceCorrections(
  sc: SupabaseClient,
  memory: { id: string; owner_id: string },
): Promise<PlaceCorrectionsRead> {
  try {
    const { data, error } = await sc
      .from("memory_corrections")
      .select("id, kind, place_id, canonical_location_id, created_at")
      .eq("memory_id", memory.id)
      .eq("owner_id", memory.owner_id)
      .eq("field", "place")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(CORRECTIONS_PAGE);
    if (error) {
      if (isTableAbsentError(error)) return { state: "ok", corrections: NO_PLACE_CORRECTIONS, absent: true };
      return { state: "unreadable", detail: String(error.message ?? "read failed") };
    }
    if (!Array.isArray(data)) return { state: "unreadable", detail: "corrections read returned no row array" };
    if (data.length >= CORRECTIONS_PAGE) {
      return { state: "unreadable", detail: `corrections page full (${data.length} rows): refusing rather than missing a rejection past it` };
    }
    return { state: "ok", corrections: foldPlaceCorrections(data as CorrectionRow[]), absent: false };
  } catch (err) {
    return { state: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

export type CorrectedRef =
  | {
      ok: true;
      ref: PlaceRef;
      /** A value of the reference was removed because the owner rejected it. */
      stripped: boolean;
      /** Fields where the stored reference was NOT overwritten (mergeByPrecedence's `refused`). */
      refused: string[];
    }
  | { ok: false; detail: string };

/**
 * The reference resolution must use: the owner's assertion merged over the
 * stored reference by §4 precedence, then every rejected value removed.
 */
export function correctedPlaceRef(stored: PlaceRef, corrections: PlaceCorrections, ownerId: string, now: Date): CorrectedRef {
  let ref: PlaceRef = { place_id: stored.place_id ?? null, canonical_location_id: stored.canonical_location_id ?? null };
  let refused: string[] = [];
  if (corrections.asserted) {
    // The Memory's stored reference is the owner's own capture-time assertion;
    // the correction is the owner's later explicit correction. Both are read as
    // of now: precedence, not time, decides (§4).
    const base = normalizeEvidence({
      owner_id: ownerId, source_type: "EXPLICIT_REMEMBER", source_id: "memories.place_ref",
      assertion_type: "OCCURRED", observed_at: now, assertion_json: { subject_ref: "place" },
    }, now);
    const incoming = normalizeEvidence({
      owner_id: ownerId, source_type: "USER_CORRECTION", source_id: "memory_corrections.assert",
      assertion_type: "CORRECTION", observed_at: now, assertion_json: { subject_ref: "place" },
    }, now);
    if (!base.ok || !incoming.ok) {
      return { ok: false, detail: `correction evidence did not normalize: ${!base.ok ? base.reason : ""} ${!incoming.ok ? incoming.reason : ""}`.trim() };
    }
    const out = mergeByPrecedence(
      { place_id: ref.place_id, canonical_location_id: ref.canonical_location_id },
      { place_id: corrections.asserted.place_id, canonical_location_id: corrections.asserted.canonical_location_id },
      { base: base.evidence, incoming: incoming.evidence },
    );
    ref = {
      place_id: typeof out.merged.place_id === "string" ? out.merged.place_id : null,
      canonical_location_id: typeof out.merged.canonical_location_id === "string" ? out.merged.canonical_location_id : null,
    };
    refused = out.refused;
  }
  let stripped = false;
  if (ref.place_id && corrections.rejectedPlaceIds.has(ref.place_id)) {
    // The canonical location was resolved FROM that pick (POST /locations/resolve),
    // so it goes with it. Otherwise a rejected provider id would come straight
    // back as its catalog twin. Only the STORED reference reaches here: an
    // asserted place is never a rejected one (the fold clears it), so a canonical
    // location the owner asserted is never dropped by this line.
    ref = { place_id: null, canonical_location_id: null };
    stripped = true;
  }
  if (ref.canonical_location_id && corrections.rejectedCanonicalIds.has(ref.canonical_location_id)) {
    ref = { ...ref, canonical_location_id: null };
    stripped = true;
  }
  return { ok: true, ref, stripped, refused };
}

/** Is any of these catalog ids a place the owner rejected? */
export function rejectsAnyPlace(corrections: PlaceCorrections, placeIds: readonly (string | null | undefined)[]): boolean {
  return placeIds.some((id) => typeof id === "string" && corrections.rejectedPlaceIds.has(id));
}

export interface CorrectionInsert {
  kind: CorrectionKind;
  place_id: string | null;
  canonical_location_id: string | null;
}

/**
 * The corrections a PATCH /memories/:id records: nothing when the place
 * reference does not change; otherwise a rejection of each value it replaces
 * and an assertion of the new reference. A new `placeId` sent WITHOUT a
 * `canonicalLocationId` asserts no canonical location: the old one was resolved
 * from the old place, and keeping it is how the system "corrects the user
 * back" (H49). The route clears it on the row too (`clearsCanonicalOnPatch`).
 */
export function placeCorrectionsForPatch(
  existing: { place_id?: unknown; canonical_location_id?: unknown },
  patch: { placeId?: string | null; canonicalLocationId?: string | null },
): CorrectionInsert[] {
  const placeGiven = patch.placeId !== undefined;
  const canonicalGiven = patch.canonicalLocationId !== undefined;
  if (!placeGiven && !canonicalGiven) return [];
  const oldPlace = typeof existing.place_id === "string" && existing.place_id ? existing.place_id : null;
  const oldCanonical = typeof existing.canonical_location_id === "string" && existing.canonical_location_id ? existing.canonical_location_id : null;
  const newPlace = placeGiven ? (patch.placeId || null) : oldPlace;
  const newCanonical = canonicalGiven ? (patch.canonicalLocationId || null) : (clearsCanonicalOnPatch(existing, patch) ? null : oldCanonical);
  if (newPlace === oldPlace && newCanonical === oldCanonical) return [];
  const rows: CorrectionInsert[] = [];
  if (oldPlace && oldPlace !== newPlace) rows.push({ kind: "reject", place_id: oldPlace, canonical_location_id: null });
  if (oldCanonical && oldCanonical !== newCanonical) rows.push({ kind: "reject", place_id: null, canonical_location_id: oldCanonical });
  rows.push({ kind: "assert", place_id: newPlace, canonical_location_id: newCanonical });
  return rows;
}

/** A PATCH that picks a new place and names no canonical location clears the old place's one. */
export function clearsCanonicalOnPatch(
  existing: { place_id?: unknown },
  patch: { placeId?: string | null; canonicalLocationId?: string | null },
): boolean {
  if (patch.placeId === undefined || patch.canonicalLocationId !== undefined) return false;
  const oldPlace = typeof existing.place_id === "string" && existing.place_id ? existing.place_id : null;
  return (patch.placeId || null) !== oldPlace;
}

export type CorrectionWrite =
  | { ok: true; recorded: number }
  | { ok: false; reason: "not_deployed" | "unavailable"; detail: string };

/** Append the owner's corrections. Confirms the rows came back; anything else is `unavailable`. */
export async function recordPlaceCorrections(
  sc: SupabaseClient,
  input: { memoryId: string; ownerId: string; source: CorrectionSource; rows: readonly CorrectionInsert[] },
): Promise<CorrectionWrite> {
  if (input.rows.length === 0) return { ok: true, recorded: 0 };
  const payload = input.rows.map((r) => ({
    memory_id: input.memoryId,
    owner_id: input.ownerId,
    field: "place",
    kind: r.kind,
    place_id: r.place_id,
    canonical_location_id: r.canonical_location_id,
    source: input.source,
  }));
  try {
    const { data, error } = await sc.from("memory_corrections").insert(payload).select("id");
    if (error) {
      if (isTableAbsentError(error)) return { ok: false, reason: "not_deployed", detail: String(error.message ?? "absent") };
      return { ok: false, reason: "unavailable", detail: String(error.message ?? "insert failed") };
    }
    if (!Array.isArray(data) || data.length !== payload.length) {
      return { ok: false, reason: "unavailable", detail: `correction insert unconfirmed (${Array.isArray(data) ? data.length : "no"} of ${payload.length} rows returned)` };
    }
    return { ok: true, recorded: data.length };
  } catch (err) {
    return { ok: false, reason: "unavailable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}
