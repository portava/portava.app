/**
 * highlightSources — the first TypeScript writer for `public.highlight_sources`.
 *
 * Highlights/Memories Development Architecture Spec v1:
 *   §12  "Highlights are disposable, audience-specific projections over one or
 *         more Memories or Episodes. They are not the source of historical
 *         truth."
 *   §3.5 a Highlight carries `source_memory_ids: uuid[]`
 *   §3.6 `highlight_sources` — "Links Highlights to Memories/Episodes"
 *   §21  a Memory deletion must reach the `profile_highlight` destination
 *   §28.12 "Always make derived projections rebuildable"
 *   §28.13 "Always store provenance and engine/reason-code versions"
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * Migration 2722 created this table and it was applied to production on
 * 2026-09-15 (`lib/capability/production-applied-migrations.json`, snapshot
 * `20260915-production-schema.json`). The census then recorded, at §O.3 of
 * docs/architecture/census-highlights-memories.md, exactly what was still
 * missing and would keep H32 out of BUILT-AND-CORRECT:
 *
 *     H32 | N → W | `highlight_sources` is deployed. Not `C` on the row's own
 *     second clause, which survives: "with no TypeScript writer". `POST
 *     /highlights` still inserts a client-supplied `mediaUrl` and no Highlight
 *     has a source Memory.
 *
 * `check:all`'s memory-certification run says the same thing from the other
 * side — H237's report reads "no candidate-to-Highlight path exists to assert
 * the second half against: highlight_sources is migration 2722, unapplied, with
 * no TypeScript writer". Half of that sentence (unapplied) was already false;
 * this module falsifies the other half.
 *
 * ── THE FIVE RULES THIS MODULE ENFORCES, AND WHY EACH IS HERE ───────────────
 *
 * 1. A SOURCE MUST BE THE CALLER'S OWN MEMORY, CHECKED APP-SIDE. Routes hold
 *    the SERVICE client, which bypasses RLS, so 2722's owner-scoped policies
 *    are not what protects this table on this path. Without the check below,
 *    any authenticated user could assert that their public Highlight projects
 *    somebody else's private Memory — and because `highlightIdsProjecting` is
 *    the reverse index §21 revocation walks, that row would make a STRANGER'S
 *    Memory deletion reach into this user's Highlight. A provenance claim
 *    about a record you cannot read is not provenance.
 *
 * 2. A SOURCE THAT CANNOT BE VERIFIED IS REFUSED, NEVER DROPPED. supabase-js
 *    RESOLVES on a database error, so `(data ?? []).map(...)` over an
 *    unreadable `memories` yields "none of your sources exist" — which, if it
 *    were silently treated as "link nothing", would store a Highlight the user
 *    was told had provenance and which has none. Every read binds `.error`,
 *    and an unreadable source table is `sources_unreadable`, not an empty set.
 *
 * 3. AN ABSENT TABLE IS NOT A FAILED WRITE. `probeHighlightObject` answers in
 *    three states and this module keeps all three apart, for the reason
 *    `highlightControlWrites.ts` states in its rule 3: a 200 for a link that
 *    was never stored tells the user their Highlight is rebuildable when it is
 *    not. `absent` is `not_deployed`; `unreadable` is `unavailable`.
 *
 * 4. A WRITE THAT AFFECTS NO ROW IS NOT A SUCCESS. Every write `.select()`s
 *    and an empty result is `write_unconfirmed`. This is the same rule
 *    `rebuildProjection` and `setResurfacingControl` already apply.
 *
 * 5. THE LINK IS IDEMPOTENT, BECAUSE THE DATABASE SAYS SO. 2722 carries
 *    `UNIQUE (highlight_id, source_type, source_id)`, so the write is an upsert
 *    naming THAT index — not the primary key, which is a generated UUID and
 *    would insert a duplicate on every call. §28.15: "make merge/split and
 *    publication changes auditable and idempotent."
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ──────────────────────────────
 * It does not invent an EPISODE source. `source_type` admits 'EPISODE' because
 * 2722's CHECK does and §12 names both, but `memory_episodes` (census H23) has
 * no CREATE TABLE anywhere in this tree, so there is no episode id space to
 * verify against. Accepting one would be storing a foreign key into a table
 * that does not exist — precisely the "fabricated link" 2722's own header says
 * the missing FK is there to avoid. `verifyMemorySources` therefore verifies
 * MEMORY sources only, and `linkHighlightSources` refuses any other type by
 * name rather than writing it unchecked.
 *
 * It also does not REBUILD a Highlight from its sources. Knowing what a
 * Highlight was built from is the precondition for §28.12's rebuild, not the
 * rebuild itself; census H93 stays BUILT-BUT-WRONG on that and this header is
 * the evidence for the grade rather than an argument against it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { probeHighlightObject, type ObjectAvailability } from "./highlightSchemaAvailability.js";

/** 2722: `source_type TEXT NOT NULL CHECK (source_type IN ('MEMORY','EPISODE'))`. */
export const HIGHLIGHT_SOURCE_TYPES = ["MEMORY", "EPISODE"] as const;
export type HighlightSourceType = (typeof HIGHLIGHT_SOURCE_TYPES)[number];

/**
 * 2722's `provenance` CHECK, which is §4's TruthLevel verbatim.
 *
 * A link a person asserted is not the same claim as one an engine proposed,
 * and §4's truth precedence cannot be honoured by a projection that cannot tell
 * them apart.
 */
export const HIGHLIGHT_SOURCE_PROVENANCE = [
  "USER_ASSERTED",
  "SYSTEM_OBSERVED",
  "MUTUALLY_CONFIRMED",
  "INFERRED",
  "UNKNOWN",
] as const;
export type HighlightSourceProvenance = (typeof HIGHLIGHT_SOURCE_PROVENANCE)[number];

export const HIGHLIGHT_SOURCES_TABLE = "highlight_sources";

/** The columns `probeHighlightObject` must find before any write is attempted. */
export const HIGHLIGHT_SOURCES_COLUMNS = [
  "highlight_id",
  "source_type",
  "source_id",
  "provenance",
] as const;

/**
 * The ceiling on how many sources one Highlight may claim in a single request.
 *
 * It is a bound on the OWNERSHIP READ below, not a product opinion: that read
 * is one `.in()` over the caller's ids, and an unbounded list would let one
 * request ask the database to verify an arbitrary number of UUIDs before the
 * Highlight is even written.
 */
export const MAX_HIGHLIGHT_SOURCES = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isHighlightSourceType(v: unknown): v is HighlightSourceType {
  return typeof v === "string" && (HIGHLIGHT_SOURCE_TYPES as readonly string[]).includes(v);
}

export function isHighlightSourceProvenance(v: unknown): v is HighlightSourceProvenance {
  return typeof v === "string" && (HIGHLIGHT_SOURCE_PROVENANCE as readonly string[]).includes(v);
}

/* ============================================================================
 * The result shape — a discriminated refusal, for the reason
 * highlightControlWrites.ts gives: the route has to map five outcomes to five
 * different statuses, and collapsing any pair makes one of them silently
 * retryable or silently permanent.
 * ==========================================================================*/

export type SourceLinkFailure =
  /** 2722 is not applied on this database. */
  | "not_deployed"
  /** The table or a source table could not be read. Retryable. */
  | "unavailable"
  /** The request itself is malformed — bad id, unknown type, too many. */
  | "invalid"
  /** A named source is not a live Memory belonging to the caller. */
  | "source_not_owned"
  /** The write reported no error and changed no row. */
  | "write_unconfirmed";

export type SourceLinkResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SourceLinkFailure; readonly detail: string };

function fail(reason: SourceLinkFailure, detail: string): SourceLinkResult<never> {
  return { ok: false, reason, detail };
}

/** `absent` and `unreadable` are different refusals. Mapped once, here. */
function refusalFor(table: string, availability: ObjectAvailability): SourceLinkResult<never> | null {
  if (availability.state === "ready") return null;
  if (availability.state === "absent") {
    return fail("not_deployed", `${table} is not deployed on this database: ${availability.reason}`);
  }
  return fail("unavailable", availability.reason);
}

export interface StoredHighlightSource {
  readonly sourceType: HighlightSourceType;
  readonly sourceId: string;
  readonly provenance: HighlightSourceProvenance;
  readonly createdAt: string | null;
}

/**
 * Is the link store usable, asked BEFORE anything is written.
 *
 * `linkHighlightSources` probes too, and this is not redundant: the link write
 * can only happen AFTER the Highlight row exists (2722's `highlight_id` is a
 * foreign key), so a probe that only ran there would let an undeployed table
 * create a Highlight and then compensate it away. Asking here means the two
 * failures a deployment can have — 2722 absent, 2722 unreadable — are decided
 * while there is still nothing to undo.
 */
export async function sourceStoreReady(
  sc: SupabaseClient | any,
): Promise<SourceLinkResult<true>> {
  const availability = await probeHighlightObject(sc, HIGHLIGHT_SOURCES_TABLE, HIGHLIGHT_SOURCES_COLUMNS);
  const refused = refusalFor(HIGHLIGHT_SOURCES_TABLE, availability);
  return refused ?? { ok: true, value: true };
}

/* ============================================================================
 * §12 / §28.13 — verifying a source before it is asserted
 * ==========================================================================*/

/**
 * Which of `memoryIds` are live Memories owned by `ownerId`.
 *
 * ALL OR NOTHING, and that is the decision worth reading twice. A partial link
 * would store a Highlight whose provenance is a SUBSET of what the person said
 * it was built from, and nothing downstream could tell that subset from a
 * complete one — §21's revocation would then miss the Memory that was dropped,
 * which is the failure mode this table exists to close. So one unverifiable id
 * refuses the whole request by name.
 *
 * `state = 'deleted'` does not count. A Highlight cannot be a projection over a
 * Memory the owner has deleted, and admitting one would re-introduce the
 * deleted row into a public surface through its provenance.
 */
export async function verifyMemorySources(
  sc: SupabaseClient | any,
  ownerId: string,
  memoryIds: readonly unknown[],
): Promise<SourceLinkResult<readonly string[]>> {
  if (!Array.isArray(memoryIds) || memoryIds.length === 0) {
    return { ok: true, value: [] };
  }
  if (memoryIds.length > MAX_HIGHLIGHT_SOURCES) {
    return fail("invalid", `a Highlight may name at most ${MAX_HIGHLIGHT_SOURCES} sources`);
  }
  const ids: string[] = [];
  for (const raw of memoryIds) {
    if (typeof raw !== "string" || !UUID_RE.test(raw)) {
      return fail("invalid", `source memory id must be a UUID, got ${JSON.stringify(raw)}`);
    }
    if (!ids.includes(raw)) ids.push(raw);
  }

  try {
    const { data, error } = await sc
      .from("memories")
      .select("id, owner_id, state")
      .in("id", ids);
    if (error) {
      // Rule 2. An unreadable source table is NOT "none of these are yours".
      return fail("unavailable", `memories read failed: ${String((error as any)?.message ?? error)}`);
    }
    if (!Array.isArray(data)) {
      return fail("unavailable", "memories read returned no row array");
    }
    const owned = new Set(
      (data as Array<Record<string, unknown>>)
        .filter((r) => r.owner_id === ownerId && r.state !== "deleted")
        .map((r) => String(r.id)),
    );
    const missing = ids.filter((id) => !owned.has(id));
    if (missing.length > 0) {
      // "Not yours" and "not there" are the SAME answer, for the reason
      // `ownsHighlight` gives one file over: distinguishing them turns this
      // into an oracle for whether an arbitrary UUID is somebody's Memory.
      return fail("source_not_owned", `${missing.length} source memory id(s) are not live memories you own`);
    }
    return { ok: true, value: ids };
  } catch (err) {
    return fail("unavailable", `memories read threw: ${String((err as any)?.message ?? err)}`);
  }
}

/* ============================================================================
 * §3.6 — the writer
 * ==========================================================================*/

/**
 * Link a Highlight to the Memories it projects.
 *
 * The caller is responsible for having verified ownership of BOTH ends — the
 * Highlight and every source — before calling this. It is not re-checked here
 * because the two checks answer to different tables and folding them together
 * would hide which one refused; `POST /highlights` owns the Highlight it just
 * created and calls `verifyMemorySources` for the other end.
 */
export async function linkHighlightSources(
  sc: SupabaseClient | any,
  input: {
    readonly highlightId: string;
    readonly sourceIds: readonly string[];
    readonly sourceType?: unknown;
    readonly provenance?: unknown;
  },
): Promise<SourceLinkResult<readonly StoredHighlightSource[]>> {
  if (typeof input.highlightId !== "string" || !UUID_RE.test(input.highlightId)) {
    return fail("invalid", "highlightId must be a UUID");
  }
  const sourceType = input.sourceType ?? "MEMORY";
  if (!isHighlightSourceType(sourceType)) {
    return fail("invalid", `unknown source type ${JSON.stringify(input.sourceType)}`);
  }
  if (sourceType !== "MEMORY") {
    // See the header. There is no episode id space in this tree to verify an
    // EPISODE source against, so writing one would be an unverified link.
    return fail(
      "invalid",
      "EPISODE sources are declared by 2722 and cannot be verified: no memory_episodes table exists in this tree (census H23)",
    );
  }
  const provenance = input.provenance ?? "USER_ASSERTED";
  if (!isHighlightSourceProvenance(provenance)) {
    return fail("invalid", `unknown provenance ${JSON.stringify(input.provenance)}`);
  }
  if (input.sourceIds.length === 0) return { ok: true, value: [] };
  if (input.sourceIds.length > MAX_HIGHLIGHT_SOURCES) {
    return fail("invalid", `a Highlight may name at most ${MAX_HIGHLIGHT_SOURCES} sources`);
  }

  const availability = await probeHighlightObject(sc, HIGHLIGHT_SOURCES_TABLE, HIGHLIGHT_SOURCES_COLUMNS);
  const refused = refusalFor(HIGHLIGHT_SOURCES_TABLE, availability);
  if (refused) return refused;

  const rows = input.sourceIds.map((id) => ({
    highlight_id: input.highlightId,
    source_type: sourceType,
    source_id: id,
    provenance,
  }));

  try {
    const { data, error } = await sc
      .from(HIGHLIGHT_SOURCES_TABLE)
      .upsert(rows, { onConflict: "highlight_id,source_type,source_id" })
      .select([...HIGHLIGHT_SOURCES_COLUMNS, "created_at"].join(", "));
    if (error) {
      return fail("unavailable", `${HIGHLIGHT_SOURCES_TABLE} write failed: ${String((error as any)?.message ?? error)}`);
    }
    const written = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
    if (written.length !== rows.length) {
      // Rule 4. Fewer rows back than sent is a partial link, which is the one
      // outcome this module must never report as success — see
      // `verifyMemorySources`' all-or-nothing note for why a subset is worse
      // than a refusal.
      return fail(
        "write_unconfirmed",
        `${HIGHLIGHT_SOURCES_TABLE} upsert returned ${written.length} row(s) for ${rows.length} source(s)`,
      );
    }
    return { ok: true, value: written.map(toStored) };
  } catch (err) {
    return fail("unavailable", `${HIGHLIGHT_SOURCES_TABLE} write threw: ${String((err as any)?.message ?? err)}`);
  }
}

function toStored(r: Record<string, unknown>): StoredHighlightSource {
  return {
    sourceType: (isHighlightSourceType(r.source_type) ? r.source_type : "MEMORY") as HighlightSourceType,
    sourceId: String(r.source_id),
    provenance: (isHighlightSourceProvenance(r.provenance) ? r.provenance : "UNKNOWN") as HighlightSourceProvenance,
    createdAt: typeof r.created_at === "string" ? r.created_at : null,
  };
}

/* ============================================================================
 * §3.6 — the two reads
 * ==========================================================================*/

/**
 * What a Highlight was built from.
 *
 * OWNER-ONLY is 2722's own decision, quoted from its RLS block: "knowing WHICH
 * Memory a Highlight projects is provenance about the owner's private history
 * … A viewer who may see the Highlight still sees the Highlight; they do not
 * learn what it was built from." The route enforces that; this function does
 * the read.
 *
 * An empty list from a DEPLOYED table is a real answer — every Highlight on
 * production predates this writer and is genuinely sourceless (2722's header:
 * "the read code reports them as sourceless rather than inventing a provenance
 * for them"). An empty list from an ABSENT table is not, and is refused.
 */
export async function readHighlightSources(
  sc: SupabaseClient | any,
  highlightId: string,
): Promise<SourceLinkResult<readonly StoredHighlightSource[]>> {
  if (typeof highlightId !== "string" || !UUID_RE.test(highlightId)) {
    return fail("invalid", "highlightId must be a UUID");
  }
  const availability = await probeHighlightObject(sc, HIGHLIGHT_SOURCES_TABLE, HIGHLIGHT_SOURCES_COLUMNS);
  const refused = refusalFor(HIGHLIGHT_SOURCES_TABLE, availability);
  if (refused) return refused;

  try {
    const { data, error } = await sc
      .from(HIGHLIGHT_SOURCES_TABLE)
      .select([...HIGHLIGHT_SOURCES_COLUMNS, "created_at"].join(", "))
      .eq("highlight_id", highlightId);
    if (error) {
      return fail("unavailable", `${HIGHLIGHT_SOURCES_TABLE} read failed: ${String((error as any)?.message ?? error)}`);
    }
    if (!Array.isArray(data)) {
      return fail("unavailable", `${HIGHLIGHT_SOURCES_TABLE} read returned no row array`);
    }
    return { ok: true, value: (data as Array<Record<string, unknown>>).map(toStored) };
  } catch (err) {
    return fail("unavailable", `${HIGHLIGHT_SOURCES_TABLE} read threw: ${String((err as any)?.message ?? err)}`);
  }
}

/**
 * Which Highlights project this Memory — the reverse index §21 needs.
 *
 * 2722's header names this as the whole point of the second index: "'which
 * Highlights project this Memory' is the question a Memory deletion has to
 * answer before it can claim the profile-Highlight destination was reached."
 *
 * A refusal here must NEVER read as "no Highlight projects it": that is the
 * answer that would let a deletion report `profile_highlight` reached while the
 * Highlight went on serving. Hence the discriminated result rather than an
 * array, and hence `.error` bound.
 */
export async function highlightIdsProjecting(
  sc: SupabaseClient | any,
  memoryId: string,
): Promise<SourceLinkResult<readonly string[]>> {
  if (typeof memoryId !== "string" || !UUID_RE.test(memoryId)) {
    return fail("invalid", "memoryId must be a UUID");
  }
  const availability = await probeHighlightObject(sc, HIGHLIGHT_SOURCES_TABLE, HIGHLIGHT_SOURCES_COLUMNS);
  const refused = refusalFor(HIGHLIGHT_SOURCES_TABLE, availability);
  if (refused) return refused;

  try {
    const { data, error } = await sc
      .from(HIGHLIGHT_SOURCES_TABLE)
      .select("highlight_id, source_type, source_id")
      .eq("source_type", "MEMORY")
      .eq("source_id", memoryId);
    if (error) {
      return fail("unavailable", `${HIGHLIGHT_SOURCES_TABLE} read failed: ${String((error as any)?.message ?? error)}`);
    }
    if (!Array.isArray(data)) {
      return fail("unavailable", `${HIGHLIGHT_SOURCES_TABLE} read returned no row array`);
    }
    const ids: string[] = [];
    for (const r of data as Array<Record<string, unknown>>) {
      const id = String((r as any).highlight_id);
      if (!ids.includes(id)) ids.push(id);
    }
    return { ok: true, value: ids };
  } catch (err) {
    return fail("unavailable", `${HIGHLIGHT_SOURCES_TABLE} read threw: ${String((err as any)?.message ?? err)}`);
  }
}
