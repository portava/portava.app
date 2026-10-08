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
 * THE FOLD (lead ruling H-15). The LATEST assert is the owner's whole current
 * word: rows before it are superseded, so only it and the rejections after it
 * count, and a later rejection of a value clears it from the assertion. Rows
 * with the same `created_at` apply asserts before rejects, so on a tie the
 * REJECTION wins: fail closed. Reads go newest first (see readPlaceCorrections).
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
import { mergeByPrecedence, normalizeEvidence } from "../memoryProjections/evidence.js"; import { resolveMemoryPlaceRef } from "../../lib/placeIdBridge.js"; // lead ruling H-17: the automatic match a reference reaches

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
  created_at: string; source?: string | null; // 3673's `source`: the H-15a cap counts the route's rejections
}

export type PlaceCorrectionsRead =
  | { state: "ok"; corrections: PlaceCorrections; absent: boolean; routeRejectedValues: number } // H-15a: distinct values the ROUTE rejected in the current window (correctionWindow)
  | { state: "unreadable"; detail: string; fullPageWithoutAssert?: { routeRejectedValues: number } }; // H-15a: set ONLY for a full page with no assert in it — a write with an assert may still be made

const KIND_ORDER: Readonly<Record<string, number>> = { assert: 0, reject: 1 };

/** Pure. The owner's corrections from the latest assert on (H-15), oldest first. Unknown kinds are ignored. */
export function foldPlaceCorrections(rows: readonly CorrectionRow[]): PlaceCorrections {
  const ordered = [...rows]
    .filter((r) => r.kind === "assert" || r.kind === "reject")
    .sort(compareCorrections); // VERIFY-H6 H6-6: by INSTANT (correctionInstant: Date.parse plus the microseconds), never by the
  // timestamp's text — Postgres writes a whole second with no fraction, and "…:01+00:00" sorts AFTER "…:01.5+00:00" as text.
  // Then asserts before rejects on a tie (the rejection wins: fail closed), then id. One order, shared with the H-15a cap
  // count (correctionWindow), so the window the fold opens and the window the cap counts are the same window.
  const start = Math.max(0, ordered.map((r) => r.kind).lastIndexOf("assert")); let asserted: PlaceRef | null = null; // H-15: the window opens at the latest assert
  const rejectedPlaceIds = new Set<string>();
  const rejectedCanonicalIds = new Set<string>();
  for (const r of ordered.slice(start)) {
    const placeId = r.place_id ?? null;
    const canonicalId = r.canonical_location_id ?? null;
    if (r.kind === "assert") {
      asserted = { place_id: placeId, canonical_location_id: canonicalId };
      // The window opens here, so no rejection precedes this assert in it:
      // a rejection recorded before the latest assert is superseded (H-15).
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
      .select("id, kind, place_id, canonical_location_id, created_at, source")
      .eq("memory_id", memory.id)
      .eq("owner_id", memory.owner_id)
      .eq("field", "place")
      .order("created_at", { ascending: false }).order("kind", { ascending: false }) // newest first, rejects before asserts on a tie: the fold's own order, reversed
      .order("id", { ascending: false })
      .limit(CORRECTIONS_PAGE); // H-15: a bounded page, NEWEST first — the latest assert and everything after it are what decide
    if (error) {
      if (isTableAbsentError(error)) return { state: "ok", corrections: NO_PLACE_CORRECTIONS, absent: true, routeRejectedValues: 0 };
      return { state: "unreadable", detail: String(error.message ?? "read failed") };
    }
    if (!Array.isArray(data) || !timesReadable(data)) return { state: "unreadable", detail: "corrections read returned no row array, or a row whose time cannot be read" }; // H6-6: the fold orders by instant, so an unreadable instant is an unreadable read
    if (data.length >= CORRECTIONS_PAGE) {
      if (!(data as CorrectionRow[]).some((r) => r.kind === "assert")) return { state: "unreadable", detail: `corrections page full (${data.length} rows) with no assert in it: refusing rather than missing a rejection past it`, fullPageWithoutAssert: { routeRejectedValues: routeRejectedValues(data as CorrectionRow[]) } }; // H-15: with an assert in the page, every older row is superseded; H-15a: a write WITH an assert is still allowed (writeBasis)
    }
    return { state: "ok", corrections: foldPlaceCorrections(data as CorrectionRow[]), absent: false, routeRejectedValues: routeRejectedValues(data as CorrectionRow[]) };
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
  | { ok: false; reason: "not_deployed" | "unavailable" | "limit_reached"; detail: string }; // limit_reached: H-15a's cap on the route's rejections (409, nothing recorded)

/**
 * The state `rows` would leave once appended after `current` (pure). The rows
 * of one write share a `created_at`, so they apply in the fold's own tie order:
 * an assert first — which opens a new window (H-15) — then the rejections.
 */
export function applyCorrections(current: PlaceCorrections, rows: readonly CorrectionInsert[]): PlaceCorrections {
  const asserts = rows.filter((r) => r.kind === "assert");
  const last = asserts[asserts.length - 1];
  let asserted: PlaceRef | null = last ? { place_id: last.place_id ?? null, canonical_location_id: last.canonical_location_id ?? null } : current.asserted;
  const rejectedPlaceIds = new Set<string>(last ? [] : current.rejectedPlaceIds);
  const rejectedCanonicalIds = new Set<string>(last ? [] : current.rejectedCanonicalIds);
  for (const r of rows) {
    if (r.kind !== "reject") continue;
    if (r.place_id) {
      rejectedPlaceIds.add(r.place_id);
      if (asserted && asserted.place_id === r.place_id) asserted = { ...asserted, place_id: null };
    }
    if (r.canonical_location_id) {
      rejectedCanonicalIds.add(r.canonical_location_id);
      if (asserted && asserted.canonical_location_id === r.canonical_location_id) asserted = { ...asserted, canonical_location_id: null };
    }
  }
  return { asserted, rejectedPlaceIds, rejectedCanonicalIds };
}

/** Do two folded states say the same thing? */
export function sameCorrections(a: PlaceCorrections, b: PlaceCorrections): boolean {
  const sameRef = (x: PlaceRef | null, y: PlaceRef | null) =>
    x === null || y === null ? x === y : x.place_id === y.place_id && x.canonical_location_id === y.canonical_location_id;
  const sameSet = (x: ReadonlySet<string>, y: ReadonlySet<string>) => x.size === y.size && [...x].every((v) => y.has(v));
  return sameRef(a.asserted, b.asserted) && sameSet(a.rejectedPlaceIds, b.rejectedPlaceIds) && sameSet(a.rejectedCanonicalIds, b.rejectedCanonicalIds);
}

/**
 * Append the owner's corrections. IDEMPOTENT (lead ruling H-15): the Memory's
 * current corrections are read first, and a write that would leave them
 * exactly as they are appends NOTHING — so a replayed PATCH, a client retry loop
 * against a failing Memory write, or a second identical rejection adds no row.
 * Confirms the rows came back; anything else is `unavailable`. An unreadable current state refuses (a write it cannot
 * judge is not made) — except a write with an ASSERT over a full no-assert page (H-15a, writeBasis); the route's cap: routeCapRefusal.
 */
export async function recordPlaceCorrections(
  sc: SupabaseClient,
  input: { memoryId: string; ownerId: string; source: CorrectionSource; rows: readonly CorrectionInsert[] },
): Promise<CorrectionWrite> {
  if (input.rows.length === 0) return { ok: true, recorded: 0 };
  const read = await readPlaceCorrections(sc, { id: input.memoryId, owner_id: input.ownerId }); const capped = routeCapRefusal(read, input); if (capped) return capped; const current = writeBasis(read, input.rows); // lead ruling H-15a (VERIFY-H6 H6-1): the route's rejections are capped, and a write with an assert is always allowed
  if (current.state === "unreadable") return { ok: false, reason: "unavailable", detail: `current corrections unreadable: ${current.detail}` };
  if (current.absent) return { ok: false, reason: "not_deployed", detail: "memory_corrections is not deployed" };
  if (sameCorrections(applyCorrections(current.corrections, input.rows), current.corrections)) return { ok: true, recorded: 0 };
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

// ── Lead ruling H-13 (2026-10-07): a deleted Memory's corrections are erased ──
// by the §21 lifecycle, and the other Memory-side place readers apply them.
// Appended so every line the census cites above holds.

export type CorrectionsErasure =
  | { state: "done"; purged: number }
  | { state: "absent"; detail: string }
  | { state: "failed"; detail: string };

/**
 * §21 for a deleted Memory's corrections (lead ruling H-13). Called by
 * memoryDeletionLifecycle's RAW_EVIDENCE_PURGED step AFTER the soft delete, and
 * by nothing else: it is the one place this codebase deletes a correction. 3673's
 * memory_corrections_guard() holds the database to the same rule — it refuses a
 * DELETE while the Memory is live and its owner's account exists.
 *
 * Every correction on the Memory goes, whoever's row it is: the Memory is
 * deleted, so no statement about its place survives it. The purge is CONFIRMED
 * by a read that finds none left — a delete that answered without error but left
 * a row is a failure, not a success. Absent table (3673 not applied) ⇒ `absent`:
 * no correction can exist. Never throws.
 */
export async function eraseCorrectionsForDeletedMemory(sc: any, input: { memoryId: string }): Promise<CorrectionsErasure> {
  try {
    const { data, error } = await sc.from("memory_corrections").delete().eq("memory_id", input.memoryId).select("id");
    if (error) {
      if (isTableAbsentError(error)) return { state: "absent", detail: `memory_corrections: ${String(error.message ?? "absent")}` };
      return { state: "failed", detail: `memory_corrections purge: ${String(error.message ?? "delete failed")}` };
    }
    if (!Array.isArray(data)) return { state: "failed", detail: "memory_corrections purge returned no row array" };
    const left = await sc.from("memory_corrections").select("id").eq("memory_id", input.memoryId).limit(1);
    if (left.error) return { state: "failed", detail: `memory_corrections purge unconfirmed: ${String(left.error.message ?? "read failed")}` };
    if (!Array.isArray(left.data) || left.data.length > 0) {
      return { state: "failed", detail: "memory_corrections purge unconfirmed: a correction on the deleted Memory is still readable" };
    }
    return { state: "done", purged: data.length };
  } catch (err) {
    return { state: "failed", detail: `memory_corrections purge threw: ${String((err as { message?: unknown })?.message ?? err)}` };
  }
}

/** `.in()` batch size for the place readers, as memoryItemVisibility's. */
export const CORRECTIONS_ID_CHUNK = 100;

export type PlaceCorrectionsByMemory =
  | { state: "ok"; byMemory: ReadonlyMap<string, PlaceCorrections>; absent: boolean }
  | { state: "unreadable"; detail: string };

/**
 * The owner's place corrections on MANY Memories, folded per Memory (H-15's
 * window). Absent ⇒ no correction (true). A batch whose page comes back FULL is
 * not refused outright: each of its Memories is re-read alone, newest first
 * (readPlaceCorrections), which is decisive for any Memory with an assert in its
 * newest page — so one heavily edited Memory never makes its neighbours, or
 * itself, unreadable (H-15). Any other failure ⇒ unreadable. Never throws.
 */
export async function readPlaceCorrectionsForMemories(sc: any, ownerId: string, memoryIds: readonly string[]): Promise<PlaceCorrectionsByMemory> {
  const ids = [...new Set(memoryIds)].sort();
  const byMemory = new Map<string, PlaceCorrections>();
  for (let i = 0; i < ids.length; i += CORRECTIONS_ID_CHUNK) {
    const batch = ids.slice(i, i + CORRECTIONS_ID_CHUNK);
    try {
      const { data, error } = await sc
        .from("memory_corrections")
        .select("memory_id, id, kind, place_id, canonical_location_id, created_at")
        .eq("owner_id", ownerId)
        .eq("field", "place")
        .in("memory_id", batch);
      if (error) {
        if (isTableAbsentError(error)) return { state: "ok", byMemory: new Map(), absent: true };
        return { state: "unreadable", detail: `memory_corrections unreadable: ${String(error.message ?? "read failed")}` };
      }
      if (!Array.isArray(data) || !timesReadable(data)) return { state: "unreadable", detail: "memory_corrections read returned no row array, or a row whose time cannot be read" }; // H6-6
      if (data.length >= CORRECTIONS_PAGE) {
        // The page may be truncated: decide each Memory from its own newest page.
        for (const id of batch) {
          const one = await readPlaceCorrections(sc, { id, owner_id: ownerId });
          if (one.state === "unreadable") return { state: "unreadable", detail: `memory ${id}: ${one.detail}` };
          if (one.absent) return { state: "ok", byMemory: new Map(), absent: true };
          if (one.corrections.asserted || one.corrections.rejectedPlaceIds.size > 0 || one.corrections.rejectedCanonicalIds.size > 0) byMemory.set(id, one.corrections);
        }
        continue;
      }
      const rowsBy = new Map<string, CorrectionRow[]>();
      for (const r of data as Array<CorrectionRow & { memory_id: string }>) {
        const list = rowsBy.get(r.memory_id) ?? [];
        list.push(r);
        rowsBy.set(r.memory_id, list);
      }
      for (const [id, rows] of rowsBy) byMemory.set(id, foldPlaceCorrections(rows));
    } catch (err) {
      return { state: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
    }
  }
  return { state: "ok", byMemory, absent: false };
}

const PLACE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How many pages of assertions at one place one owner may have before the read refuses (50,000 rows). */
export const ASSERTED_AT_PLACE_MAX_PAGES = 50;

export type AssertedAtPlace = { state: "ok"; memoryIds: string[] } | { state: "unreadable"; detail: string };

/**
 * The owner's Memories that some ASSERTION places at `placeId` (by place id or,
 * for a uuid, by canonical location). A place reader looks these up as well as
 * the Memories whose stored reference names the place, so a Memory the owner put
 * here is listed here even while its row has not caught up (lead ruling H-12:
 * a correction recorded before a write that then failed stays), and so is one
 * with no stored place at all. Whether it STAYS listed is the fold's call: a
 * later assertion elsewhere moves it. A full page is not a refusal: the read
 * pages on (ordered by id) up to ASSERTED_AT_PLACE_MAX_PAGES (H-15: corrections
 * never make a place permanently unreadable). Literal column names only, never
 * a filter string built from input. Never throws.
 */
export async function memoriesAssertedAtPlace(sc: any, ownerId: string, placeId: string): Promise<AssertedAtPlace> {
  const ids = new Set<string>();
  const queries: Array<() => any> = [
    () => sc.from("memory_corrections").select("memory_id").eq("owner_id", ownerId).eq("field", "place").eq("kind", "assert").eq("place_id", placeId),
  ];
  if (PLACE_UUID_RE.test(placeId)) {
    queries.push(() => sc.from("memory_corrections").select("memory_id").eq("owner_id", ownerId).eq("field", "place").eq("kind", "assert").eq("canonical_location_id", placeId));
  }
  const take = (data: unknown): string | null => {
    if (!Array.isArray(data)) return "memory_corrections read returned no row array";
    for (const r of data as Array<{ memory_id: string }>) ids.add(String(r.memory_id));
    return null;
  };
  for (const query of queries) {
    try {
      const { data, error } = await query();
      if (error) {
        if (isTableAbsentError(error)) return { state: "ok", memoryIds: [] };
        return { state: "unreadable", detail: `memory_corrections unreadable: ${String(error.message ?? "read failed")}` };
      }
      const bad = take(data);
      if (bad) return { state: "unreadable", detail: bad };
      if ((data as unknown[]).length < CORRECTIONS_PAGE) continue;
      // A full first page: read the whole set again, in id order, a page at a time.
      let page = 0;
      for (;;) {
        if (page >= ASSERTED_AT_PLACE_MAX_PAGES) return { state: "unreadable", detail: `more than ${ASSERTED_AT_PLACE_MAX_PAGES} pages of assertions at one place` };
        const from = page * CORRECTIONS_PAGE;
        const r = await query().order("id", { ascending: true }).range(from, from + CORRECTIONS_PAGE - 1);
        if (r.error) return { state: "unreadable", detail: `memory_corrections unreadable: ${String(r.error.message ?? "read failed")}` };
        const badPage = take(r.data);
        if (badPage) return { state: "unreadable", detail: badPage };
        if ((r.data as unknown[]).length < CORRECTIONS_PAGE) break;
        page += 1;
      }
    } catch (err) {
      return { state: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
    }
  }
  return { state: "ok", memoryIds: [...ids].sort() };
}

/**
 * A Memory's place as EVERY place reader must hand it over (VERIFY-H5 H5-1,
 * H5-4): which Memory and whose are REQUIRED, so a caller cannot pass a bare
 * reference and silently skip the owner's corrections.
 */
export interface MemoryPlaceRow {
  id: string;
  owner_id: string;
  place_id: string | null;
  canonical_location_id: string | null;
}

/**
 * Each row with its place reference CORRECTED (correctedPlaceRef: the owner's
 * assertion by §4 precedence, then every rejected value removed). Rows without
 * corrections are returned as they are. A correction that cannot be applied is
 * a refusal of the whole read, never a silently uncorrected row. `stripped`
 * names the Memories a rejection removed a value from.
 */
export function correctPlaceRefs<T extends MemoryPlaceRow>(
  rows: readonly T[],
  byMemory: ReadonlyMap<string, PlaceCorrections>,
  now: Date,
): { ok: true; rows: T[]; stripped: ReadonlySet<string> } | { ok: false; detail: string } {
  const out: T[] = [];
  const stripped = new Set<string>();
  for (const row of rows) {
    const c = byMemory.get(row.id);
    if (!c) { out.push(row); continue; }
    const stored: PlaceRef = {
      place_id: typeof row.place_id === "string" && row.place_id ? row.place_id : null,
      canonical_location_id: typeof row.canonical_location_id === "string" && row.canonical_location_id ? row.canonical_location_id : null,
    };
    const corrected = correctedPlaceRef(stored, c, row.owner_id, now);
    if (!corrected.ok) return { ok: false, detail: corrected.detail };
    if (corrected.stripped) stripped.add(row.id);
    out.push({ ...row, place_id: corrected.ref.place_id, canonical_location_id: corrected.ref.canonical_location_id });
  }
  return { ok: true, rows: out, stripped };
}

/**
 * The corrections, BY CONTENT, as source-version entries (projectionRegistry
 * sourceVersionOf's `corrections`): a new rejection or assertion makes every
 * registration that read the Memory STALE. Empty for no corrections, so a
 * digest is byte-identical to before when nothing was corrected.
 */
export function correctionsVersionEntries(byMemory: ReadonlyMap<string, PlaceCorrections>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of [...byMemory.keys()].sort()) {
    const c = byMemory.get(id)!;
    const a = c.asserted ? `${c.asserted.place_id ?? "-"}/${c.asserted.canonical_location_id ?? "-"}` : "none";
    out[`correction:${id}`] = `${a}|r:${[...c.rejectedPlaceIds].sort().join(",")}|c:${[...c.rejectedCanonicalIds].sort().join(",")}`;
  }
  return out;
}

export type PlacesThroughCorrections<T> =
  | { ok: true; rows: T[]; byMemory: ReadonlyMap<string, PlaceCorrections>; stripped: ReadonlySet<string>; versionEntries: Record<string, string> }
  | { ok: false; detail: string };

/**
 * THE ONE WAY a reader turns Memories into places (VERIFY-H5 H5-4): the action
 * resolution (memoryActionService.resolveCurrentPlace), place history and the
 * registry's place readers all call it with MemoryPlaceRow rows, whose `id` and
 * `owner_id` the type requires. It reads each owner's corrections for exactly
 * these Memories (readPlaceCorrectionsForMemories) and corrects every row
 * (correctPlaceRefs), then drops WHOLE any reference whose automatic match reaches a rejected place (lead ruling H-17,
 * dropReferencesReachingRejectedPlaces). Any failed read ⇒ ok:false: a place a reader cannot correct is unreadable.
 */
export async function placesThroughCorrections<T extends MemoryPlaceRow>(sc: any, rows: readonly T[], now: Date): Promise<PlacesThroughCorrections<T>> {
  const owners = new Map<string, string[]>();
  for (const r of rows) {
    if (typeof r.id !== "string" || !r.id || typeof r.owner_id !== "string" || !r.owner_id) return { ok: false, detail: "a place row without its Memory id or owner" };
    owners.set(r.owner_id, [...(owners.get(r.owner_id) ?? []), r.id]);
  }
  const byMemory = new Map<string, PlaceCorrections>();
  for (const [ownerId, ids] of owners) {
    const read = await readPlaceCorrectionsForMemories(sc, ownerId, ids);
    if (read.state === "unreadable") return { ok: false, detail: read.detail };
    for (const [k, v] of read.byMemory) byMemory.set(k, v);
  }
  const corrected = correctPlaceRefs(rows, byMemory, now); if (!corrected.ok) return { ok: false, detail: corrected.detail };
  const reached = await dropReferencesReachingRejectedPlaces(sc, corrected.rows, byMemory, corrected.stripped); if (!reached.ok) return { ok: false, detail: reached.detail }; // lead ruling H-17
  return { ok: true, rows: reached.rows, byMemory, stripped: reached.stripped, versionEntries: { ...correctionsVersionEntries(byMemory), ...reached.versionEntries } };
}

export type PlaceHistoryCorrection =
  | { ok: true; rows: any[]; versionEntries: Record<string, string> }
  | { ok: false; detail: string };

/**
 * GET /memories/places/:placeId's corrections. `rows` are the owner's Memories
 * whose STORED reference names the place; the Memories an assertion places here
 * are fetched as well (`fetchMemories`, the route's own owner-scoped,
 * non-deleted read); then every row goes through placesThroughCorrections, so
 * the builder's own place filter drops a Memory the owner rejected here and keeps
 * one they asserted here. Any failed read ⇒ ok:false (the route answers 503).
 */
export async function correctPlaceHistory(
  sc: any,
  input: {
    ownerId: string;
    placeId: string;
    rows: readonly MemoryPlaceRow[];
    fetchMemories: (ids: string[]) => PromiseLike<{ data: unknown; error: { message?: unknown } | null }>;
    now: Date;
  },
): Promise<PlaceHistoryCorrection> {
  const asserted = await memoriesAssertedAtPlace(sc, input.ownerId, input.placeId);
  if (asserted.state === "unreadable") return { ok: false, detail: asserted.detail };
  const have = new Set(input.rows.map((r) => String(r.id)));
  const missing = asserted.memoryIds.filter((id) => !have.has(id));
  const rows: MemoryPlaceRow[] = [...input.rows];
  for (let i = 0; i < missing.length; i += CORRECTIONS_ID_CHUNK) {
    const { data, error } = await input.fetchMemories(missing.slice(i, i + CORRECTIONS_ID_CHUNK));
    if (error) return { ok: false, detail: `memories unreadable: ${String(error.message ?? "read failed")}` };
    if (!Array.isArray(data)) return { ok: false, detail: "memories read returned no row array" };
    rows.push(...(data as MemoryPlaceRow[]));
  }
  const through = await placesThroughCorrections(sc, rows, input.now);
  if (!through.ok) return { ok: false, detail: through.detail };
  return { ok: true, rows: through.rows, versionEntries: through.versionEntries };
}

// ── Lead ruling H-16 (2026-10-08): every NON-OWNER read of a Memory's place ──
/**
 * Rows as a person who is NOT their owner may be shown them (lead ruling H-16).
 * Every row whose `owner_id` is not `viewerId` goes through
 * placesThroughCorrections, so a place its owner rejected is never shown to
 * anyone else, and an asserted one is. The viewer's OWN rows are returned as
 * stored (H-16: the owner's own detail shows the stored row). Order and every
 * other field are kept. ok:false ⇒ the caller REFUSES (503): a non-owner read
 * whose corrections could not be read is unreadable, never uncorrected.
 * Run it BEFORE the location protection (memories.ts protectMemoryRow), which
 * may then still withhold the corrected id by the owner's rung.
 */
export async function placesForViewer<T extends { id: string; owner_id: string }>(
  sc: any,
  rows: readonly T[],
  viewerId: string,
  now: Date,
): Promise<{ ok: true; rows: T[] } | { ok: false; detail: string }> {
  const others = rows.filter((r) => r.owner_id !== viewerId);
  if (others.length === 0) return { ok: true, rows: [...rows] };
  const asPlaces = others.map((r) => {
    const x = r as T & { place_id?: unknown; canonical_location_id?: unknown };
    return {
      ...r,
      place_id: typeof x.place_id === "string" ? x.place_id : null,
      canonical_location_id: typeof x.canonical_location_id === "string" ? x.canonical_location_id : null,
    } as T & MemoryPlaceRow;
  });
  const through = await placesThroughCorrections(sc, asPlaces, now);
  if (!through.ok) return { ok: false, detail: through.detail };
  const corrected = new Map(through.rows.map((r) => [r.id, r] as const));
  return { ok: true, rows: rows.map((r) => (corrected.get(r.id) as T | undefined) ?? r) }; // the viewer's own rows were never read, so they come back as stored
}

// ── VERIFY-H6 (2026-10-08): lead ruling H-15a and the fold's order ───────────
// Appended so every line the census cites above holds.

/**
 * The instant a correction was recorded, in MICROSECONDS since the epoch (NaN
 * when it cannot be read). Date.parse keeps milliseconds only, so the fourth to
 * sixth fraction digits Postgres keeps are added back: two rows a fraction of a
 * millisecond apart still order as the database ordered them. VERIFY-H6 H6-6:
 * Postgres (and PostgREST after it) writes a whole second with NO fraction, and
 * as text "…:01+00:00" sorts AFTER "…:01.5+00:00" ('+' and '-' against '.'), so
 * the fold must never order by the text.
 */
export function correctionInstant(ts: unknown): number {
  const s = String(ts ?? "");
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return Number.NaN;
  const frac = /:\d{2}\.(\d+)/.exec(s)?.[1] ?? "";
  return ms * 1000 + (frac.length > 3 ? Number(frac.slice(3, 6).padEnd(3, "0")) : 0);
}

/** Does every row carry a readable `created_at`? The fold cannot order a row it cannot place in time. */
function timesReadable(rows: readonly unknown[]): boolean {
  return rows.every((r) => !Number.isNaN(correctionInstant((r as { created_at?: unknown } | null)?.created_at)));
}

/**
 * The fold's order (oldest first): by instant, then asserts before rejects on a
 * tie (so a rejection made in the same instant wins: fail closed), then id. A
 * row with an unreadable instant — which every reader refuses before folding
 * (timesReadable) — sorts first, so the order stays total.
 */
export function compareCorrections(a: CorrectionRow, b: CorrectionRow): number {
  const ta = correctionInstant(a.created_at);
  const tb = correctionInstant(b.created_at);
  const byTime = Number.isNaN(ta) || Number.isNaN(tb) ? Number(!Number.isNaN(ta)) - Number(!Number.isNaN(tb)) : Math.sign(ta - tb);
  return byTime || (KIND_ORDER[a.kind]! - KIND_ORDER[b.kind]!) || String(a.id).localeCompare(String(b.id));
}

/** H-15's window: the rows from the LATEST assert on (all of them when there is none), oldest first. */
export function correctionWindow(rows: readonly CorrectionRow[]): CorrectionRow[] {
  const ordered = [...rows].filter((r) => r.kind === "assert" || r.kind === "reject").sort(compareCorrections);
  return ordered.slice(Math.max(0, ordered.map((r) => r.kind).lastIndexOf("assert")));
}

/**
 * Lead ruling H-15a: how many "not this place" rejections the ROUTE
 * (POST /memories/:id/corrections) may hold on one Memory's place. The cap is
 * on DISTINCT values in the current window (correctionWindow): an assertion —
 * a change of place by PATCH — supersedes every rejection before it (H-15), so
 * it starts the count again. A rejection a PATCH recorded (`memory_edit`) is not
 * the route's and does not count. Within one window recording is idempotent
 * (sameCorrections), so the window after the latest assert holds at most this
 * many route rows plus the two a PATCH writes beside its assert — far inside one
 * read page, which is what keeps a place readable.
 */
export const ROUTE_REJECTION_CAP = 50;

/** Distinct values the route rejected in the current window of these rows. */
export function routeRejectedValues(rows: readonly CorrectionRow[]): number {
  const values = new Set<string>();
  for (const r of correctionWindow(rows)) {
    if (r.kind !== "reject" || r.source !== "correction_route") continue;
    if (r.place_id) values.add(`place:${r.place_id}`);
    if (r.canonical_location_id) values.add(`canonical:${r.canonical_location_id}`);
  }
  return values.size;
}

/**
 * H-15a (a): the route's refusal of a NEW distinct rejection past the cap —
 * nothing is recorded. A rejection already in force is not new: it falls
 * through to recordPlaceCorrections's idempotency check and records nothing
 * (204). A full page with no assert in it (which the cap keeps the route from
 * producing) is refused here when that page alone already holds the cap.
 */
function routeCapRefusal(
  read: PlaceCorrectionsRead,
  input: { source: CorrectionSource; rows: readonly CorrectionInsert[] },
): CorrectionWrite | null {
  if (input.source !== "correction_route" || input.rows.some((r) => r.kind === "assert")) return null;
  const refusal: CorrectionWrite = { ok: false, reason: "limit_reached", detail: `this Memory's place already holds ${ROUTE_REJECTION_CAP} rejections (lead ruling H-15a)` };
  if (read.state === "unreadable") return (read.fullPageWithoutAssert?.routeRejectedValues ?? 0) >= ROUTE_REJECTION_CAP ? refusal : null;
  if (read.absent) return null;
  const notYetRejected = (r: CorrectionInsert) => (r.place_id ? !read.corrections.rejectedPlaceIds.has(r.place_id) : false) || (r.canonical_location_id ? !read.corrections.rejectedCanonicalIds.has(r.canonical_location_id) : false);
  const fresh = new Set(input.rows.filter((r) => r.kind === "reject" && notYetRejected(r)).map((r) => `${r.place_id ?? ""}|${r.canonical_location_id ?? ""}`));
  return fresh.size > 0 && read.routeRejectedValues + fresh.size > ROUTE_REJECTION_CAP ? refusal : null;
}

/**
 * H-15a (b): a write that carries an ASSERT is always made, even when the
 * current read is unreadable solely because its newest page is full and holds
 * no assert. The assert opens a new window (H-15): nothing before it decides the
 * state the write leaves, so it is judged against "no corrections" — which it
 * always changes — and the next read finds it in its newest page. Any other
 * unreadable read is returned as it is, and refuses the write.
 */
function writeBasis(read: PlaceCorrectionsRead, rows: readonly CorrectionInsert[]): PlaceCorrectionsRead {
  if (read.state === "unreadable" && read.fullPageWithoutAssert && rows.some((r) => r.kind === "assert")) {
    return { state: "ok", corrections: NO_PLACE_CORRECTIONS, absent: false, routeRejectedValues: 0 };
  }
  return read;
}

// ── Lead ruling H-17 (2026-10-08): a reference that leads to a rejected place ─
// is no reference. Appended so every line the census cites above holds.

/** As memoryActionService.followMergeChain's MAX_MERGE_HOPS: the same chain, the same bound. */
const H17_MAX_MERGE_HOPS = 3;

/**
 * Does this reference's AUTOMATIC resolution land on, or pass through, a place
 * the owner rejected? The same path resolveCurrentPlace takes: the bridge
 * (placeIdBridge.resolveMemoryPlaceRef — the Memory's own catalog row when it
 * names one, else the ONE row sharing its canonical location), then the
 * catalog's merges, bounded and cycle-safe. A read that fails is `ok:false`:
 * whether the reference identifies a rejected place is then unknown, never "no".
 */
async function reachesRejectedPlace(sc: any, ref: PlaceRef, rejected: ReadonlySet<string>): Promise<{ ok: true; reaches: boolean } | { ok: false; detail: string }> {
  const start = await resolveMemoryPlaceRef<{ id: unknown; merged_into_place_id?: unknown }>(sc, ref);
  if (start.state === "unreadable") return { ok: false, detail: "places unreadable: whether the reference reaches a rejected place is unknown" };
  if (start.state === "ambiguous") return ambiguousMatchIncludesRejected(sc, ref, rejected); // lead ruling H-17a
  if (start.state !== "one") return { ok: true, reaches: false };
  let row = start.row;
  if (rejected.has(String(row.id))) return { ok: true, reaches: true };
  const seen = new Set<string>([String(row.id)]);
  for (let hops = 0; row.merged_into_place_id && hops < H17_MAX_MERGE_HOPS; hops++) {
    const next = String(row.merged_into_place_id);
    if (seen.has(next)) break;
    const { data, error } = await sc.from("places").select("id, merged_into_place_id").eq("id", next).maybeSingle();
    if (error) return { ok: false, detail: `places unreadable: ${String(error.message ?? "merge successor read failed")}` };
    if (!data) break;
    seen.add(next);
    row = data as { id: unknown; merged_into_place_id?: unknown };
    if (rejected.has(String(row.id))) return { ok: true, reaches: true };
  }
  return { ok: true, reaches: false };
}

/**
 * Lead ruling H-17. When the owner rejects the catalog place P that a
 * reference reaches only AUTOMATICALLY — through the canonical match, or through
 * a catalog merge — the reference itself still identifies P: the canonical
 * location C is P's, and the provider pick C was resolved from names the same
 * venue. So the reference is dropped WHOLE (place_id and canonical_location_id),
 * and the Memory reads as one with no place at all, which is what anyone who is
 * not its owner must be unable to tell it apart from (resolveCurrentPlace then
 * tells the owner PLACE_REJECTED_BY_OWNER and everyone else NO_PLACE_REFERENCE,
 * the reason an unplaced Memory gives). Only Memories with a rejected place id are
 * resolved, so a reader with no rejections makes no catalog read. A dropped
 * Memory is named in the version entries, so a catalog change that flips the
 * decision (a merge into a rejected place) makes a derivative stale.
 */
async function dropReferencesReachingRejectedPlaces<T extends MemoryPlaceRow>(
  sc: any,
  rows: readonly T[],
  byMemory: ReadonlyMap<string, PlaceCorrections>,
  stripped: ReadonlySet<string>,
): Promise<{ ok: true; rows: T[]; stripped: ReadonlySet<string>; versionEntries: Record<string, string> } | { ok: false; detail: string }> {
  const out: T[] = [];
  const nowStripped = new Set(stripped);
  const versionEntries: Record<string, string> = {};
  for (const row of rows) {
    const c = byMemory.get(row.id);
    if (!c || c.rejectedPlaceIds.size === 0 || (!row.place_id && !row.canonical_location_id)) { out.push(row); continue; }
    const reach = await reachesRejectedPlace(sc, { place_id: row.place_id ?? null, canonical_location_id: row.canonical_location_id ?? null }, c.rejectedPlaceIds);
    if (!reach.ok) return { ok: false, detail: `memory ${row.id}: ${reach.detail}` };
    if (!reach.reaches) { out.push(row); continue; }
    out.push({ ...row, place_id: null, canonical_location_id: null });
    nowStripped.add(row.id);
    versionEntries[`h17:${row.id}`] = "reference-dropped";
  }
  return { ok: true, rows: out, stripped: nowStripped, versionEntries };
}

/**
 * Lead ruling H-17a. When the canonical location matches SEVERAL catalog rows
 * (no automatic match: the owner is told PLACE_AMBIGUOUS) and ANY of them is a
 * place the owner rejected, C still identifies that place among a few, so the
 * reference is dropped too (dropReferencesReachingRejectedPlaces). The question
 * is asked of the database directly — which of the owner's rejected catalog ids
 * share C — so it is exact however many rows share C. Only uuid-shaped ids are
 * asked about: a rejected provider pick is not a catalog id, and naming one in
 * a uuid filter is an error (22P02). A failed read is `ok:false`, never "no".
 */
async function ambiguousMatchIncludesRejected(sc: any, ref: PlaceRef, rejected: ReadonlySet<string>): Promise<{ ok: true; reaches: boolean } | { ok: false; detail: string }> {
  const ids = [...rejected].filter((id) => PLACE_UUID_RE.test(id)).sort();
  if (!ref.canonical_location_id || ids.length === 0) return { ok: true, reaches: false };
  for (let i = 0; i < ids.length; i += CORRECTIONS_ID_CHUNK) {
    const { data, error } = await sc.from("places").select("id").eq("canonical_location_id", ref.canonical_location_id).in("id", ids.slice(i, i + CORRECTIONS_ID_CHUNK)).limit(1);
    if (error) return { ok: false, detail: `places unreadable: ${String(error.message ?? "ambiguous-match read failed")}` };
    if (!Array.isArray(data)) return { ok: false, detail: "places read returned no row array" };
    if (data.length > 0) return { ok: true, reaches: true };
  }
  return { ok: true, reaches: false };
}
