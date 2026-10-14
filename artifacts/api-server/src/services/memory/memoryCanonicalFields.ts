/**
 * memoryCanonicalFields — two canonical Memory fields the spec names and
 * `memories` did not have. Census-highlights-memories H40 and H71.
 *
 *   memory_type                       §4 `MemoryType` (migration 3803)
 *   place_display_name_at_occurrence  §9 `display_name_at_occurrence` (3804):
 *                                     "Entity merges may repoint canonical
 *                                     identity while preserving occurrence-time
 *                                     display text"
 *
 * ── THE GATES, AND WHY "OFF" STILL WRITES ──────────────────────────────────
 * Each migration seeds its own flag (memory_type_enabled,
 * memory_place_occurrence_name_enabled) FALSE in the same transaction that
 * adds the column, and no other file seeds them. So the flag ROW exists exactly
 * where the column does, and `readFlagState` tells the four cases apart:
 *
 *   on          the column exists; the API serves the field and accepts an
 *               owner's choice
 *   off         the column exists; the API does NOT serve it or accept an
 *               owner's choice, but still WRITES what the server knows (TRIP for
 *               create-from-trip, EPISODE for a kept candidate, a provider
 *               pick's name), so a Memory's record is right from the moment the
 *               migration is applied and nothing has to be guessed later
 *   absent      the migration is not applied: the column may not exist, and in
 *               PostgREST one unknown column fails the WHOLE statement
 *               (PGRST204 / PGRST100). Nothing names it.
 *   unreadable  nobody knows whether the column exists. Nothing names it, and an
 *               owner's explicit choice is REFUSED retryably rather than dropped
 *               (the posture lib/memoryPrecisionGate.ts takes for the §10 rung).
 *
 * ── THE KERNEL ─────────────────────────────────────────────────────────────
 * 2711's memory_kernel_execute names a fixed column list and is owned by
 * another lane, so it is not changed. With the kernel on, its INSERT takes the
 * column DEFAULT (MOMENT) and its UPDATE leaves the type alone; the occurrence
 * name is kept true by 3804's trigger whoever writes. `reconcileCanonicalFields`
 * runs after every route write, reads the row back and writes the intended
 * value when the kernel path left a different one. On the legacy path the
 * direct write already carried it, so the read-back finds nothing to do.
 *
 * ── WHO SEES THE OCCURRENCE NAME (lead rulings H-16 / H-17) ─────────────────
 * The OWNER sees the stored text: it is their history (H-16: "The owner's own
 * detail may show the stored row"). Anyone else sees it only while the row they
 * are served still carries the SAME non-empty stored place reference. A place
 * the owner rejected (3673 — placesForViewer drops or replaces the reference),
 * one their §10 rung withholds, or one a protected Hidden Gem hides
 * (protectMemoryRow) takes its NAME with it, because a name identifies a place
 * exactly as its id does. `occurrenceNameFor` is that rule, and it is the only
 * door the routes use.
 *
 * ── WHAT IS NEVER DONE ─────────────────────────────────────────────────────
 *  - No legacy row is typed or named. A row that existed before 3803/3804 reads
 *    NULL — unknown — and is never inferred or backfilled from today's catalog
 *    name, which may already be the name after a rename.
 *  - A catalog place's name is the catalog's at the moment of the write (the
 *    trigger reads it); the client's text is sent only for a place that is NOT
 *    a catalog id (a provider pick), so the legacy and kernel paths record the
 *    same thing.
 */
import { readFlagState } from "../../lib/capability/schemaCapability.js";

/** Spec §4 `MemoryType`, in the spec's order. 3803's CHECK holds the same thirteen. */
export const MEMORY_TYPES = [
  "PLACE", "PERSON", "MOMENT", "EPISODE", "TRIP", "EVENT", "MILESTONE",
  "CREW", "DISCOVERY", "ROUTE", "EXPERIENCE", "FIRST", "REUNION",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * A new Memory nobody typed. 3803's column DEFAULT; open owner question Q-H40
 * (MOMENT vs no type at all). The fail-closed choice the plan made, stated and
 * not approved. Rows that existed before 3803 are NULL, never this.
 */
export const DEFAULT_MEMORY_TYPE: MemoryType = "MOMENT";

/** The type the server itself knows for a Memory created from a whole trip. */
export const TRIP_MEMORY_TYPE: MemoryType = "TRIP";
/** The type the server itself knows for a Memory kept from a detected episode (§7). */
export const CANDIDATE_MEMORY_TYPE: MemoryType = "EPISODE";

/** The API's bound on a provider pick's name. 3804's CHECK allows 300; the trigger truncates there. */
export const OCCURRENCE_NAME_MAX = 200;

export function isMemoryType(v: unknown): v is MemoryType {
  return typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);
}

export type CanonicalGate = "on" | "off" | "absent" | "unreadable";
export interface CanonicalGates { memoryType: CanonicalGate; occurrenceName: CanonicalGate }

/** Both gates. Never throws: readFlagState answers `unreadable` on any failure. */
export async function readCanonicalGates(sc: unknown): Promise<CanonicalGates> {
  const [memoryType, occurrenceName] = await Promise.all([
    readFlagState(sc, "memory_type_enabled"),
    readFlagState(sc, "memory_place_occurrence_name_enabled"),
  ]);
  return { memoryType, occurrenceName };
}

/** May a write NAME the column? Only where the flag row proves the migration ran. */
export function columnWritable(g: CanonicalGate): boolean {
  return g === "on" || g === "off";
}

/** May a read SERVE the field? Only when the owner turned it on. */
export function fieldServed(g: CanonicalGate): boolean {
  return g === "on";
}

export type ChoiceRefusal = { code: "feature_disabled" | "degraded_unavailable"; message: string };

/**
 * An OWNER'S explicit type, refused rather than dropped when it cannot be
 * honoured: dropping it would leave the DEFAULT standing in for their choice.
 * null = accept.
 */
export function ownerTypeChoiceRefusal(g: CanonicalGate, chosen: unknown): ChoiceRefusal | null {
  if (chosen === undefined) return null;
  if (g === "on") return null;
  if (g === "unreadable") return { code: "degraded_unavailable", message: "Your Memory's type could not be saved right now. Please try again." };
  return { code: "feature_disabled", message: "Memory types are not available yet." };
}

/** A catalog place id (`places.id`). Anything else is a provider pick. */
const CATALOG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isCatalogPlaceId(placeId: unknown): boolean {
  return typeof placeId === "string" && CATALOG_ID_RE.test(placeId.trim());
}

/** The trimmed, bounded text, or null for nothing. */
export function normalizeOccurrenceName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, OCCURRENCE_NAME_MAX).trim();
}

/**
 * The occurrence name a WRITE may name for this place, or undefined (the column
 * is not named). Only a provider pick carries the client's text: a catalog place
 * gets the catalog's name from 3804's trigger, on every path alike.
 */
export function occurrenceNameForWrite(g: CanonicalGate, placeId: string | null | undefined, given: unknown): string | undefined {
  if (!columnWritable(g)) return undefined;
  if (typeof placeId !== "string" || placeId.trim().length === 0) return undefined;
  if (isCatalogPlaceId(placeId)) return undefined;
  const name = normalizeOccurrenceName(given);
  return name ?? undefined;
}

/** The type a write names, or undefined (the column keeps its DEFAULT / its value). */
export function memoryTypeForWrite(g: CanonicalGate, type: MemoryType | null | undefined): MemoryType | null | undefined {
  return columnWritable(g) ? type : undefined;
}

/** The two fields as stored, for one Memory. A key is absent when its column was not read. */
export interface StoredCanonicalFields {
  id: string;
  place_id: string | null;
  memory_type?: string | null;
  place_display_name_at_occurrence?: string | null;
}

// Four literal select lists, so check:write-path-columns and
// check:schema-references resolve every one (a list assembled at the call site
// is a blind spot). Which one runs is decided by the gates.
const CANON_SELECT_BOTH = "id, place_id, memory_type, place_display_name_at_occurrence";
const CANON_SELECT_TYPE = "id, place_id, memory_type";
const CANON_SELECT_NAME = "id, place_id, place_display_name_at_occurrence";

function canonicalRead(sc: any, which: { type: boolean; name: boolean }) {
  if (which.type && which.name) return sc.from("memories").select(CANON_SELECT_BOTH);
  if (which.type) return sc.from("memories").select(CANON_SELECT_TYPE);
  return sc.from("memories").select(CANON_SELECT_NAME);
}

export type CanonicalRead =
  | { ok: true; byId: ReadonlyMap<string, StoredCanonicalFields> }
  | { ok: false; detail: string };

const NOTHING_READ: CanonicalRead = { ok: true, byId: new Map() };

/**
 * The stored fields of these Memories, naming only columns the gates prove
 * exist. `serve` picks which gate decides: a read for a RESPONSE asks
 * `fieldServed`; the read-back after a write asks `columnWritable`. A failed
 * read is ok:false — never "no type", which would be a claim.
 */
export async function readStoredCanonicalFields(
  sc: any,
  memoryIds: readonly string[],
  gates: CanonicalGates,
  mode: "serve" | "write",
): Promise<CanonicalRead> {
  const has = mode === "serve" ? fieldServed : columnWritable;
  const which = { type: has(gates.memoryType), name: has(gates.occurrenceName) };
  const ids = [...new Set(memoryIds.filter((id) => typeof id === "string" && id.length > 0))];
  if ((!which.type && !which.name) || ids.length === 0) return NOTHING_READ;
  const byId = new Map<string, StoredCanonicalFields>();
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const { data, error } = await canonicalRead(sc, which).in("id", ids.slice(i, i + 100));
      if (error) return { ok: false, detail: `memories canonical fields unreadable: ${String((error as { message?: unknown }).message ?? "read failed")}` };
      if (!Array.isArray(data)) return { ok: false, detail: "memories canonical fields read returned no row array" };
      for (const r of data as StoredCanonicalFields[]) byId.set(String(r.id), r);
    } catch (err) {
      return { ok: false, detail: `memories canonical fields read threw: ${String((err as { message?: unknown })?.message ?? err)}` };
    }
  }
  return { ok: true, byId };
}

const sameRef = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * THE H71 / H-16 / H-17 rule. The occurrence name this viewer may be shown.
 *
 *   stored  the Memory row as read from the database, BEFORE any viewer
 *           protection (its place_id / canonical_location_id are the stored
 *           reference)
 *   served  the row this viewer is actually being served, AFTER
 *           placesForViewer (the owner's corrections) and protectMemoryRow (the
 *           §10 rung, the Hidden-Gem ceiling)
 *   fields  the stored canonical fields of the same Memory
 *
 * The owner gets the stored text. Anyone else gets it only when the served
 * reference is the stored one, unchanged and non-empty, AND the canonical read
 * saw the same place_id the row did (a write racing between the two reads must
 * not pair one place's id with another's name). Otherwise null.
 */
export function occurrenceNameFor(
  viewerId: string,
  stored: { owner_id: unknown; place_id?: unknown; canonical_location_id?: unknown },
  served: { place_id?: unknown; canonical_location_id?: unknown },
  fields: StoredCanonicalFields | undefined,
): string | null {
  const name = fields?.place_display_name_at_occurrence;
  if (!nonEmpty(name)) return null;
  if (!fields || !sameRef(fields.place_id, stored.place_id)) return null;
  if (stored.owner_id === viewerId) return name;
  if (!nonEmpty(stored.place_id)) return null;
  if (!sameRef(served.place_id, stored.place_id)) return null;
  if (!sameRef(served.canonical_location_id, stored.canonical_location_id)) return null;
  return name;
}

/**
 * The registry's half of the same rule (services/memoryProjections/
 * derivativeRegistry.ts correctSourcePlaces): a row whose place reference the
 * owner's corrections CHANGED (an assertion replaced it, a rejection removed it)
 * no longer carries the stored occurrence name, which names the OLD place. Rows
 * without the key are returned untouched.
 */
export function occurrenceNameKeptWithRef<T extends object>(stored: T, corrected: T): T {
  const s = stored as { place_id?: unknown; canonical_location_id?: unknown };
  const c = corrected as { place_id?: unknown; canonical_location_id?: unknown; place_display_name_at_occurrence?: unknown };
  if (!("place_display_name_at_occurrence" in c)) return corrected;
  if (sameRef(s.place_id, c.place_id) && sameRef(s.canonical_location_id, c.canonical_location_id)) return corrected;
  return { ...corrected, place_display_name_at_occurrence: null };
}

/** The type as served: a §4 value, or null (unknown — a legacy row). */
export function memoryTypeFor(fields: StoredCanonicalFields | undefined): MemoryType | null {
  const t = fields?.memory_type;
  return isMemoryType(t) ? t : null;
}

/**
 * The serialized fields, attached to a row under a private key so that
 * routes/memories.ts mapMemory serializes ONLY what this module decided. A raw
 * `memory_type` column on a row (the kernel returns the whole row) is never
 * read by the serializer, so a gate that is off cannot leak through it.
 */
export const CANONICAL_PAYLOAD = Symbol("memoryCanonicalPayload");
export interface CanonicalPayload { memoryType?: MemoryType | null; placeDisplayNameAtOccurrence?: string | null }

export function withCanonicalPayload<T extends object>(row: T, payload: CanonicalPayload): T {
  return Object.assign({ ...row }, { [CANONICAL_PAYLOAD]: payload });
}

/** For mapMemory: the attached fields, or nothing. */
export function canonicalPayloadOf(row: unknown): CanonicalPayload {
  const p = (row as { [CANONICAL_PAYLOAD]?: CanonicalPayload } | null | undefined)?.[CANONICAL_PAYLOAD];
  if (!p) return {};
  const out: CanonicalPayload = {};
  if (p.memoryType !== undefined) out.memoryType = p.memoryType;
  if (p.placeDisplayNameAtOccurrence !== undefined) out.placeDisplayNameAtOccurrence = p.placeDisplayNameAtOccurrence;
  return out;
}

/**
 * The payload for ONE Memory and ONE viewer, from the gates and the stored
 * fields. A field whose gate is not on is absent (not null): the client is told
 * nothing rather than "unknown".
 */
export function canonicalPayloadFor(
  viewerId: string,
  gates: CanonicalGates,
  stored: { id: string; owner_id: unknown; place_id?: unknown; canonical_location_id?: unknown },
  served: { place_id?: unknown; canonical_location_id?: unknown },
  read: CanonicalRead,
): CanonicalPayload {
  if (!read.ok) return {};
  const fields = read.byId.get(stored.id);
  const out: CanonicalPayload = {};
  if (fieldServed(gates.memoryType)) out.memoryType = memoryTypeFor(fields);
  if (fieldServed(gates.occurrenceName)) out.placeDisplayNameAtOccurrence = occurrenceNameFor(viewerId, stored, served, fields);
  return out;
}

/**
 * After a route's write: make the stored row carry what the route meant, and
 * return the payload for the OWNER's response.
 *
 *   intended.memoryType       the type the route meant (the owner's choice,
 *                             TRIP, EPISODE), or undefined (leave it)
 *   intended.occurrenceName   a provider pick's text the route meant, or
 *                             undefined
 *
 * Read back by id; where the kernel path left a different type (its INSERT
 * takes the DEFAULT, its UPDATE ignores the key) or no name for the place it
 * wrote, write the intended value. The name is only ever a FIRST capture — 3804's
 * trigger refuses to rewrite a recorded one — so this can never overwrite
 * history. Idempotent: a replay finds nothing to do. Any failed read or write
 * is ok:false, and the route REFUSES (503) rather than answering as if the
 * owner's choice had been kept.
 */
export async function reconcileCanonicalFields(
  sc: any,
  input: {
    memoryId: string;
    ownerId: string;
    gates: CanonicalGates;
    intended: { memoryType?: MemoryType | null; occurrenceName?: string | null };
  },
): Promise<{ ok: true; payload: CanonicalPayload } | { ok: false; detail: string }> {
  const { memoryId, ownerId, gates } = input;
  const read = await readStoredCanonicalFields(sc, [memoryId], gates, "write");
  if (!read.ok) return read;
  let fields = read.byId.get(memoryId);
  const wantType = columnWritable(gates.memoryType) && input.intended.memoryType !== undefined
    && fields !== undefined && (fields.memory_type ?? null) !== input.intended.memoryType;
  const wantName = columnWritable(gates.occurrenceName) && nonEmpty(input.intended.occurrenceName)
    && fields !== undefined && nonEmpty(fields.place_id) && !nonEmpty(fields.place_display_name_at_occurrence);
  if (wantType || wantName) {
    const { data, error } = await sc
      .from("memories")
      .update({
        memory_type: wantType ? input.intended.memoryType : undefined,
        place_display_name_at_occurrence: wantName ? input.intended.occurrenceName : undefined,
      })
      .eq("id", memoryId)
      .eq("owner_id", ownerId)
      .select("id");
    if (error) return { ok: false, detail: `memories canonical fields write failed: ${String((error as { message?: unknown }).message ?? "write failed")}` };
    if (!Array.isArray(data) || data.length !== 1) return { ok: false, detail: "memories canonical fields write matched no row" };
    const again = await readStoredCanonicalFields(sc, [memoryId], gates, "write");
    if (!again.ok) return again;
    fields = again.byId.get(memoryId);
    if (wantType && (fields?.memory_type ?? null) !== input.intended.memoryType) return { ok: false, detail: "memories canonical fields: the type did not hold" };
  }
  if (fields === undefined && (columnWritable(gates.memoryType) || columnWritable(gates.occurrenceName))) {
    return { ok: false, detail: "memories canonical fields: the Memory was not found on read-back" };
  }
  const stored = { id: memoryId, owner_id: ownerId, place_id: fields?.place_id ?? null };
  return { ok: true, payload: canonicalPayloadFor(ownerId, gates, stored, stored, { ok: true, byId: new Map(fields ? [[memoryId, fields]] : []) }) };
}
