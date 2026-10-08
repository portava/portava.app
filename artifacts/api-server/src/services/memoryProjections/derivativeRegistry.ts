/**
 * Projections and the derived-artifact registry: the database half.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       Section 18 "Projections and Derived Artifact Registry" (:512) -
 *       "Every derivative is registered with source Memory version, type,
 *       destination, generatedAt, and revocation state. This gives deletion and
 *       privacy changes an explicit cleanup graph."
 *       Section 21 "Deletion, Forgetting, and Revocation" (:566)
 *       Section 28.11 "Never swallow projection/schema failures into
 *       plausible-looking empty history without structured error state."
 *       Section 28.12 "Always make derived projections rebuildable."
 *
 * CENSUS: section 18 row 12, "Derivative registration (source Memory version,
 *         type, destination, generatedAt, revocation state)" - NOT-BUILT:
 *         "`memory_derivative_registry` absent; nothing records where it went."
 *
 * THE CLIENT FACT THIS FILE IS BUILT AROUND. supabase-js RESOLVES on a database
 * error. `const { data } = await sc.from("memories").select(...)` with `.error`
 * unbound therefore renders an unreadable table as an empty array, and for a
 * projection that is fatal: a failed derivation becomes the sentence "you have no
 * memories". Every read below binds `error` and every failure returns a structured
 * refusal. There is no try/catch around a supabase read here: such a catch is dead
 * code - the promise resolves, it does not throw.
 *
 * Writes bind `.select()` for the same reason in reverse: an UPDATE that matched
 * zero rows errors nothing, so without it this module could report a revocation
 * that revoked nothing.
 */

import type {
  HighlightPolicyRow, HighlightSourceRow, MemoryItemRow,
  MemorySourceRow,
  MemoryTagRow,
  ProjectedRow,
  ProjectionId,
  ProjectionScope, SourceControls,
} from "./projectionRegistry.js";
import {
  getProjectionDefinition,
  scopeKeyOf,
  sourceVersionOf, recapExcludedOf,
} from "./projectionRegistry.js";
import type { SignificanceExplanation } from "./significance.js"; import { isTableAbsentError } from "../../lib/tableAbsence.js"; import { hiddenItemKeys } from "../memory/memoryItemVisibility.js"; import { memoriesAssertedAtPlace, placesThroughCorrections } from "../memory/memoryCorrections.js"; // one line: cited by line

export const DERIVATIVE_REGISTRY_TABLE = "memory_derivative_registry";

/** Section 18 revocation state. */
export type RevocationState = "ACTIVE" | "STALE" | "REVOKED" | "PURGED";

export type ProjectionFailureReason =
  | "unknown_projection"
  | "projection_not_configured"
  | "source_unavailable"
  | "registry_unavailable"
  | "registry_write_unconfirmed"
  | "not_registered";

export type ProjectionResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: ProjectionFailureReason;
      detail: string;
      /** True when a retry could plausibly succeed; false for a missing table. */
      retryable: boolean;
      table?: string;
    };

interface MinimalPostgrestError {
  message?: string;
  code?: string;
  details?: string;
}

/** The TABLE is not there (lib/tableAbsence) — `retryable: false` is documented as "a missing table". */
function isSchemaAbsent(err: MinimalPostgrestError | null | undefined): boolean {
  // Not a column / function / operator: memoryDeletionLifecycle reads a
  // non-retryable revocation as `not_applicable`, so counting those here made a
  // FAILED derivative revocation read as "no derivatives to purge". A code decides.
  return isTableAbsentError(err);
}

/**
 * The narrow slice of a supabase client this module uses. Typing it here rather
 * than importing SupabaseClient keeps the module testable with a fake that
 * models the ONE behaviour that matters: resolving with an error.
 */
export interface QueryLike {
  select: (columns?: string, options?: { head?: boolean; count?: string }) => QueryLike;
  eq: (column: string, value: unknown) => QueryLike;
  in: (column: string, values: readonly unknown[]) => QueryLike;
  neq: (column: string, value: unknown) => QueryLike; contains: (column: string, values: readonly unknown[]) => QueryLike; // one line: lines below are cited
  upsert: (values: unknown, options?: { onConflict?: string }) => QueryLike;
  update: (values: unknown) => QueryLike;
  then: <R1, R2>(
    onfulfilled?: ((value: { data: any; error: MinimalPostgrestError | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ) => Promise<R1 | R2>;
}

export interface ClientLike {
  from: (table: string) => QueryLike;
}

const MEMORY_COLUMNS =
  "id, owner_id, title, caption, visibility, state, trip_id, event_id, place_id, starts_at, ends_at, " +
  "created_at, updated_at, location_city, location_country, location_lat, location_lng, " +
  "canonical_location_id, allowed_user_ids, hidden_user_ids";

export interface ProjectionSources {
  memories: MemorySourceRow[];
  items: MemoryItemRow[];
  tags: MemoryTagRow[]; /** §AK (3671): the owner's per-Memory controls. */ memoryControls?: SourceControls; /** §AN (3672): hidden photos; null = unreadable. */ hiddenItems?: ReadonlySet<string> | null; /** §AP (3673, H-13 wave): the place corrections applied to `memories`, as version entries; absent when not read. */ placeCorrections?: Readonly<Record<string, string>>;
  /** Empty unless asked for; a FAILED read is a refusal, never an empty array. */
  highlights: HighlightSourceRow[]; highlight_policies: HighlightPolicyRow[];
}

/**
 * Read everything a projection derives from, for one owner. Deleted rows are read
 * too: a projection must tell "this Memory is gone" from "this was never read".
 */
export async function readProjectionSources(
  client: ClientLike,
  scope: ProjectionScope, opts: { includeHighlights?: boolean; placeCorrections?: boolean } = {},
): Promise<ProjectionResult<ProjectionSources>> {
  const memRes = await client.from("memories").select(MEMORY_COLUMNS).eq("owner_id", scope.owner_id);
  if (memRes.error) {
    return {
      ok: false, reason: "source_unavailable", table: "memories",
      detail: `memories unreadable: ${memRes.error.message ?? "unknown error"}`,
      retryable: !isSchemaAbsent(memRes.error),
    };
  }
  const memories = (memRes.data ?? []) as MemorySourceRow[];
  if (!Array.isArray(memRes.data)) {
    return {
      ok: false, reason: "source_unavailable", table: "memories",
      detail: "memories read returned no row array", retryable: true,
    };
  }

  const ids = memories.map((m) => m.id);
  let items: MemoryItemRow[] = [];
  let tags: MemoryTagRow[] = [];
  if (ids.length > 0) {
    const itemRes = await client.from("memory_items").select("memory_id, media_url, media_type, position").in("memory_id", ids);
    if (itemRes.error) {
      return {
        ok: false, reason: "source_unavailable", table: "memory_items",
        detail: `memory_items unreadable: ${itemRes.error.message ?? "unknown error"}`,
        retryable: !isSchemaAbsent(itemRes.error),
      };
    }
    items = (itemRes.data ?? []) as MemoryItemRow[];

    const tagRes = await client.from("memory_tags").select("memory_id, tagged_user_id, status").in("memory_id", ids);
    if (tagRes.error) {
      return {
        ok: false, reason: "source_unavailable", table: "memory_tags",
        detail: `memory_tags unreadable: ${tagRes.error.message ?? "unknown error"}`,
        retryable: !isSchemaAbsent(tagRes.error),
      };
    }
    tags = (tagRes.data ?? []) as MemoryTagRow[];
  }

  const hl = opts.includeHighlights ? await readHighlightSources(client, scope) : NO_HIGHLIGHT_SOURCES;
  if (!hl.ok) return hl; const pc = opts.placeCorrections ? await correctSourcePlaces(client, scope, memories) : null; if (pc && !pc.ok) return pc; return { ok: true, value: { memories: pc ? pc.memories : memories, items, tags, ...hl.value, memoryControls: await readSourceControls(client, scope.owner_id), hiddenItems: await readSourceHiddenItems(client, ids), ...(pc ? { placeCorrections: pc.entries } : {}) } }; // §AK: controls read; §AP: a place reader resolves each Memory's place through the owner's corrections (3673) last, never a refusal (unreadable is itself a state)
}

export interface DerivedProjection {
  projection_id: ProjectionId;
  scope_key: string;
  audience: string;
  destination: string;
  builder_version: string;
  source_tables: readonly string[];
  rows: ProjectedRow[];
  source_version: string;
  /** Every row the builder READ, with its version. Drives staleness. */
  source_version_per_memory: Record<string, string>;
  /**
   * The memories that actually CONTRIBUTED to the payload. Drives the cleanup
   * graph. Deliberately narrower than the version vector above: a private
   * Memory the public builder filtered out is an input (so a change to it makes
   * the projection stale) but not a contributor (so deleting it must not revoke
   * a derivative that never carried it).
   */
  source_memory_ids: string[];
}

/**
 * Section 28.12. Derive a projection from canonical rows. Pure once the read has
 * happened, so `deriveProjection` twice over an unchanged database returns
 * identical rows - the property the rebuild test asserts.
 */
export async function deriveProjection(
  client: ClientLike,
  projectionId: ProjectionId,
  scope: ProjectionScope,
  opts: { significance?: ReadonlyMap<string, SignificanceExplanation> } = {},
): Promise<ProjectionResult<DerivedProjection>> {
  const def = getProjectionDefinition(projectionId);
  if (!def) {
    return { ok: false, reason: "unknown_projection", detail: `no definition for ${projectionId}`, retryable: false };
  }
  if (def.availability === "NOT_CONFIGURED") {
    return { ok: false, reason: "projection_not_configured", detail: def.unavailable_reason, retryable: false };
  }

  const sources = await readProjectionSources(client, scope, { includeHighlights: readsHighlights(def), placeCorrections: readsPlaceCorrections(def) });
  if (!sources.ok) return sources; if (def.id === "TripMemoryProjection" && sources.value.memoryControls?.state === "unreadable") return { ok: false, reason: "source_unavailable", table: "memory_resurfacing_preferences", detail: "the owner's recap controls are unreadable, so no recap is derived (§AK, fail closed)", retryable: true }; if (sources.value.hiddenItems === null && (scope.viewer_id ?? null) !== scope.owner_id) return { ok: false, reason: "source_unavailable", table: "memory_items", detail: "photo audiences (3672) are unreadable, so no non-owner projection is derived (§AN, fail closed)", retryable: true };

  const rows = def.build({
    scope,
    memories: sources.value.memories,
    items: sources.value.items, recapExcluded: recapExcludedOf(sources.value.memoryControls), hiddenItems: sources.value.hiddenItems,
    tags: sources.value.tags,
    significance: opts.significance, highlights: { rows: sources.value.highlights, policies: sources.value.highlight_policies },
  });

  // The source version covers the rows the builder could see, not only the rows
  // it emitted: a Memory that was filtered OUT is still an input, and if it
  // changes so that it now qualifies, the projection is stale.
  const version = sourceVersionOf(sources.value.memories, sources.value.highlights, sources.value.highlight_policies, sources.value.memoryControls, sources.value.hiddenItems, sources.value.placeCorrections);

  // Contribution is the narrower relation, and it is what the cleanup graph
  // walks. A projection with no memory_id in its whitelist contributes nothing
  // addressable, and is therefore revoked only by an explicit sweep.
  const contributing = [...new Set(
    rows.map((r) => (typeof r.memory_id === "string" ? r.memory_id : null)).filter((id): id is string => id !== null),
  )].sort();

  return {
    ok: true,
    value: {
      projection_id: def.id,
      scope_key: scopeKeyOf(def.id, scope),
      audience: def.audience,
      destination: def.destination,
      builder_version: def.builder_version,
      source_tables: def.source_tables,
      rows,
      source_version: version.digest,
      source_version_per_memory: version.per_memory,
      source_memory_ids: contributing,
    },
  };
}

export interface RegistrationRow {
  id?: string;
  owner_id: string;
  projection_id: string;
  scope_key: string;
  audience: string;
  destination: string;
  builder_version: string;
  source_tables: string[];
  source_memory_ids: string[];
  source_version: string;
  source_version_json: Record<string, string>;
  payload_json: ProjectedRow[];
  row_count: number;
  generated_at: string;
  revocation_state: RevocationState;
  revoked_at: string | null;
  revocation_reason: string | null;
}

const REGISTRATION_COLUMNS =
  "id, owner_id, projection_id, scope_key, audience, destination, builder_version, source_tables, " +
  "source_memory_ids, source_version, source_version_json, payload_json, row_count, generated_at, " +
  "revocation_state, revoked_at, revocation_reason";

/**
 * Section 18. Derive, then register: type, destination, source Memory version,
 * generatedAt and revocation state, so deletion and privacy changes have an
 * explicit cleanup graph to walk.
 *
 * A rebuild REPLACES the registration for the same (projection, scope) and
 * clears STALE. It does not clear REVOKED: a derivative revoked by a privacy
 * decision must not be resurrected by a routine rebuild, so a revoked
 * registration is reported back rather than overwritten.
 */
export async function rebuildProjection(
  client: ClientLike,
  projectionId: ProjectionId,
  scope: ProjectionScope,
  now: Date,
  opts: { significance?: ReadonlyMap<string, SignificanceExplanation>; /** Lead ruling H-5: rebuild a registration revoked ONLY because a Memory was deleted. */ reviveDeletionRevoked?: boolean } = {},
): Promise<ProjectionResult<{ registration: RegistrationRow; rows: ProjectedRow[]; was_revoked: boolean }>> {
  const derived = await deriveProjection(client, projectionId, scope, opts);
  if (!derived.ok) return derived;

  const existing = await readRegistration(client, projectionId, scope);
  if (!existing.ok && existing.reason !== "not_registered") return existing;
  if (existing.ok && existing.value.revocation_state === "REVOKED" && !(opts.reviveDeletionRevoked === true && isDeletionRevocation(existing.value.revocation_reason))) { // H-5: only a deletion's revocation may be rebuilt, and only when asked
    return {
      ok: true,
      value: { registration: existing.value, rows: [], was_revoked: true },
    };
  }

  const row: RegistrationRow = {
    owner_id: scope.owner_id,
    projection_id: derived.value.projection_id,
    scope_key: derived.value.scope_key,
    audience: derived.value.audience,
    destination: derived.value.destination,
    builder_version: derived.value.builder_version,
    source_tables: [...derived.value.source_tables],
    source_memory_ids: derived.value.source_memory_ids,
    source_version: derived.value.source_version,
    source_version_json: derived.value.source_version_per_memory,
    payload_json: derived.value.rows,
    row_count: derived.value.rows.length,
    generated_at: now.toISOString(),
    revocation_state: "ACTIVE",
    revoked_at: null,
    revocation_reason: null,
  };

  const write = await client
    .from(DERIVATIVE_REGISTRY_TABLE)
    .upsert(row, { onConflict: "projection_id,scope_key" })
    .select(REGISTRATION_COLUMNS);
  if (write.error) {
    return {
      ok: false, reason: "registry_unavailable", table: DERIVATIVE_REGISTRY_TABLE,
      detail: `registration write failed: ${write.error.message ?? "unknown error"}`,
      retryable: !isSchemaAbsent(write.error),
    };
  }
  const written = Array.isArray(write.data) ? (write.data as RegistrationRow[]) : [];
  if (written.length === 0) {
    // The write reported no error and no row. That is not success: an upsert
    // filtered by RLS looks exactly like this, and reporting it as a completed
    // rebuild would leave a projection nobody can find in the cleanup graph.
    return {
      ok: false, reason: "registry_write_unconfirmed", table: DERIVATIVE_REGISTRY_TABLE,
      detail: "registration upsert affected no rows", retryable: true,
    };
  }

  return { ok: true, value: { registration: written[0], rows: derived.value.rows, was_revoked: false } };
}

export async function readRegistration(
  client: ClientLike,
  projectionId: ProjectionId,
  scope: ProjectionScope,
): Promise<ProjectionResult<RegistrationRow>> {
  const key = scopeKeyOf(projectionId, scope);
  const res = await client
    .from(DERIVATIVE_REGISTRY_TABLE)
    .select(REGISTRATION_COLUMNS)
    .eq("projection_id", projectionId)
    .eq("scope_key", key);
  if (res.error) {
    return {
      ok: false, reason: "registry_unavailable", table: DERIVATIVE_REGISTRY_TABLE,
      detail: `registry unreadable: ${res.error.message ?? "unknown error"}`,
      retryable: !isSchemaAbsent(res.error),
    };
  }
  const rows = Array.isArray(res.data) ? (res.data as RegistrationRow[]) : [];
  if (rows.length === 0) {
    return { ok: false, reason: "not_registered", detail: `no registration for ${key}`, retryable: false };
  }
  return { ok: true, value: rows[0] };
}

// readRegisteredPayload MOVED to derivativeRegistryRead.ts.
// This module BUILDS and REVOKES; that one SERVES. They were one file, which
// made public.memory_derivative_registry a projection whose only consumer was
// its own producer -- the exact shape check:projection-consumers exists to
// catch, and it did.
//
// readRegistration stays HERE, and the serve path issues its own SELECT rather
// than calling it. That is not duplication for its own sake: importing it back
// would make these two modules a CYCLE (this file imports the reader, the
// reader imports this file's table constant), and a value read across an ESM
// cycle at module-evaluation time is how a constant arrives `undefined`. The
// seam only holds if it points one way.


export type StalenessState = "FRESH" | "STALE" | "REVOKED" | "NOT_REGISTERED";

export interface StalenessVerdict {
  state: StalenessState;
  registered_version: string | null;
  current_version: string;
  /** Memory ids whose version moved, plus those added or removed. */
  changed_memory_ids: string[];
  generated_at: string | null;
}

/**
 * Section 18. Can this projection say whether it is stale?
 *
 * It compares the source version recorded at registration against the sources as
 * they are NOW. There is no UNKNOWN state in this type on purpose: when the
 * comparison cannot be made - the sources or the registry are unreadable - the
 * function returns a failure, because "I could not check" reported as FRESH is
 * the defect this whole module exists to prevent.
 */
export async function projectionStaleness(
  client: ClientLike,
  projectionId: ProjectionId,
  scope: ProjectionScope,
): Promise<ProjectionResult<StalenessVerdict>> {
  const sources = await readProjectionSources(client, scope, { includeHighlights: readsHighlights(getProjectionDefinition(projectionId)), placeCorrections: readsPlaceCorrections(getProjectionDefinition(projectionId)) });
  if (!sources.ok) return sources;
  const current = sourceVersionOf(sources.value.memories, sources.value.highlights, sources.value.highlight_policies, sources.value.memoryControls, sources.value.hiddenItems, sources.value.placeCorrections);

  const reg = await readRegistration(client, projectionId, scope);
  if (!reg.ok) {
    if (reg.reason === "not_registered") {
      return {
        ok: true,
        value: {
          state: "NOT_REGISTERED", registered_version: null, current_version: current.digest,
          changed_memory_ids: [], generated_at: null,
        },
      };
    }
    return reg;
  }

  const registered = reg.value;
  const before = registered.source_version_json ?? {};
  const changed = new Set<string>();
  for (const [id, v] of Object.entries(current.per_memory)) if (before[id] !== v) changed.add(id);
  for (const id of Object.keys(before)) if (!(id in current.per_memory)) changed.add(id);

  const state: StalenessState =
    registered.revocation_state === "REVOKED" || registered.revocation_state === "PURGED"
      ? "REVOKED"
      : registered.source_version === current.digest && changed.size === 0
        ? "FRESH"
        : "STALE";

  return {
    ok: true,
    value: {
      state,
      registered_version: registered.source_version,
      current_version: current.digest,
      changed_memory_ids: [...changed].sort(),
      generated_at: registered.generated_at,
    },
  };
}

/**
 * Section 18 / 21 / 28.8. The cleanup graph, walked.
 *
 * Every registration whose `source_memory_ids` contains the memory is revoked -
 * that is the whole point of recording where a derivative went. The count comes
 * from `.select()`, so "revoked 0" is reported as 0 and never as success.
 */
export async function revokeDerivativesForMemory(
  client: ClientLike,
  memoryId: string,
  reason: string,
  now: Date,
): Promise<ProjectionResult<{ revoked: number; scope_keys: string[] }>> {
  // FILTERED IN THE DATABASE, on 2730's GIN index over source_memory_ids. This
  // read used to fetch every non-purged registration of EVERY user and filter
  // here — and PostgREST caps a response at its max-rows (1000 on Supabase), so
  // once the registry outgrew one page a deleted Memory's derivative past the
  // cap was never seen, never revoked, and the step still reported `done`.
  const found = await client
    .from(DERIVATIVE_REGISTRY_TABLE)
    .select("id, scope_key, source_memory_ids, revocation_state")
    .contains("source_memory_ids", [memoryId])
    .neq("revocation_state", "PURGED");
  if (found.error) {
    return {
      ok: false, reason: "registry_unavailable", table: DERIVATIVE_REGISTRY_TABLE,
      detail: `registry unreadable: ${found.error.message ?? "unknown error"}`,
      retryable: !isSchemaAbsent(found.error),
    };
  }
  const candidates = (Array.isArray(found.data) ? found.data : []) as Array<{
    id: string; scope_key: string; source_memory_ids: string[] | null;
  }>;
  const targets = candidates.filter((r) => (r.source_memory_ids ?? []).includes(memoryId));
  if (targets.length === 0) return { ok: true, value: { revoked: 0, scope_keys: [] } };

  const write = await client
    .from(DERIVATIVE_REGISTRY_TABLE)
    .update({
      revocation_state: "REVOKED",
      revoked_at: now.toISOString(),
      revocation_reason: reason,
      // The derivative's content goes with the revocation. Section 28.8: deleted
      // Memories must not survive inside a projection.
      payload_json: [],
      row_count: 0,
    })
    .in("id", targets.map((t) => t.id))
    .select("id, scope_key");
  if (write.error) {
    return {
      ok: false, reason: "registry_unavailable", table: DERIVATIVE_REGISTRY_TABLE,
      detail: `revocation write failed: ${write.error.message ?? "unknown error"}`,
      retryable: !isSchemaAbsent(write.error),
    };
  }
  const updated = (Array.isArray(write.data) ? write.data : []) as Array<{ id: string; scope_key: string }>;
  if (updated.length === 0) {
    return {
      ok: false, reason: "registry_write_unconfirmed", table: DERIVATIVE_REGISTRY_TABLE,
      detail: `${targets.length} registration(s) matched but the revocation affected no rows`,
      retryable: true,
    };
  }
  return { ok: true, value: { revoked: updated.length, scope_keys: updated.map((u) => u.scope_key).sort() } };
}

// ═════════════════════════════════════════════════════════════════════════════
// §12's HIGHLIGHTS, AND §10's POLICY OVER THEM.
//
// Appended rather than placed beside the Memory reads, and that is a deliberate
// cost. This file is cited BY LINE NUMBER from docs/architecture/
// census-highlights-memories.md, which this lane may not edit; declaring these
// where they read best moved `derivativeRegistry.ts:252#RegistrationRow`,
// `:287#rebuildProjection`, `:409#projectionStaleness` and
// `:464#revokeDerivativesForMemory`, and turned `check:doc-citations` from
// green to red. A line-numbered citation makes another document's contract out
// of this file's line count; appending is what avoids paying that twice.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * §12's Highlights, read for the §18 projection whose subject is one.
 *
 * NARROW ON PURPOSE. Every column `public.highlights` carries that this
 * projection must never publish — `caption`, `media_url`, `location_name`, the
 * filter columns — is absent from this list, so it cannot reach a builder at
 * all. The field whitelist is the second line of that defence, not the first.
 */
const HIGHLIGHT_COLUMNS =
  "id, owner_id, visibility, created_at, updated_at, expires_at, deleted_at, archived_at, " +
  "pinned_at, lifetime_class, location_city, location_country";

/**
 * §10's policy, narrowed to the two dimensions a projection acts on. Migration
 * 2721, applied to production at 20260915055812.
 */
const HIGHLIGHT_POLICY_COLUMNS = "highlight_id, location_precision, consent_share";

/** What a projection that does not declare `highlights` gets: nothing, read nowhere. */
const NO_HIGHLIGHT_SOURCES = {
  ok: true as const,
  value: { highlights: [] as HighlightSourceRow[], highlight_policies: [] as HighlightPolicyRow[] },
};

/**
 * THE DECLARATION DECIDES WHAT IS READ. `source_tables` is one of §18's own
 * registration fields, so deriving the read from it keeps the declaration
 * honest rather than letting a second, drifting list decide — and every
 * projection that does NOT declare `highlights` issues exactly the queries it
 * always did.
 */
function readsHighlights(def: { source_tables: readonly string[] } | null): boolean {
  return def !== null && def.source_tables.includes("highlights");
}

/**
 * Read one owner's Highlights AND the §10 policy over them, in ONE step.
 *
 * THE POLICY IS NOT OPTIONAL AND IS NOT READ SEPARATELY. An absent policy set
 * is not "no policy"; it is a read that did not happen, and an audience-specific
 * projection built from one would publish a Highlight whose owner's consent and
 * precision were never consulted. An unreadable policy table is therefore a
 * REFUSAL — §10's ladder is a publication limit, and an unreadable limit must
 * never be served as an absent one (28.11).
 *
 * Deleted and archived rows ARE read, for the reason the memories read gives: a
 * projection must tell "this Highlight is gone" from "this Highlight was never
 * read". The builder filters them; the read does not hide them.
 */
async function readHighlightSources(
  client: ClientLike,
  scope: ProjectionScope,
): Promise<ProjectionResult<{ highlights: HighlightSourceRow[]; highlight_policies: HighlightPolicyRow[] }>> {
  const hlRes = await client.from("highlights").select(HIGHLIGHT_COLUMNS).eq("owner_id", scope.owner_id);
  if (hlRes.error) {
    return {
      ok: false, reason: "source_unavailable", table: "highlights",
      detail: `highlights unreadable: ${hlRes.error.message ?? "unknown error"}`,
      retryable: !isSchemaAbsent(hlRes.error),
    };
  }
  if (!Array.isArray(hlRes.data)) {
    return {
      ok: false, reason: "source_unavailable", table: "highlights",
      detail: "highlights read returned no row array", retryable: true,
    };
  }
  const highlights = hlRes.data as HighlightSourceRow[];
  if (highlights.length === 0) return { ok: true, value: { highlights, highlight_policies: [] } };

  // Scoped by owner_id, not by the ids just read: 2721 carries `owner_id`, one
  // owner's policy set is small, and an owner filter cannot return a policy row
  // for somebody else's Highlight.
  const polRes = await client
    .from("highlight_projection_policies")
    .select(HIGHLIGHT_POLICY_COLUMNS)
    .eq("owner_id", scope.owner_id);
  if (polRes.error) {
    return {
      ok: false, reason: "source_unavailable", table: "highlight_projection_policies",
      detail: `highlight_projection_policies unreadable: ${polRes.error.message ?? "unknown error"}`,
      retryable: !isSchemaAbsent(polRes.error),
    };
  }
  if (!Array.isArray(polRes.data)) {
    return {
      ok: false, reason: "source_unavailable", table: "highlight_projection_policies",
      detail: "highlight_projection_policies read returned no row array", retryable: true,
    };
  }
  return { ok: true, value: { highlights, highlight_policies: polRes.data as HighlightPolicyRow[] } };
}

// ── Lead ruling H-5 (2026-10-07), appended so every cited line above holds ──
/**
 * The `revocation_reason` a Memory DELETION writes, and the prefix of the one
 * its fail-closed fallback writes ("memory_deleted: re-derivation failed").
 * H-5: a registration revoked for this reason — and for no other — may be
 * rebuilt on its owner's next request, excluding every deleted or non-visible
 * Memory, so a deletion never leaves the owner's own search 410 for good.
 */
export const DELETION_REVOCATION_REASON = "memory_deleted";

export function isDeletionRevocation(reason: string | null | undefined): boolean {
  const r = String(reason ?? "");
  return r === DELETION_REVOCATION_REASON || r.startsWith(`${DELETION_REVOCATION_REASON}:`);
}

// ── §AK (lane H, 2026-10-07): the owner's §11 per-Memory controls (3671) ─────
/**
 * Absent table ⇒ `absent` (no control can exist). Any other error, or a
 * non-array answer ⇒ `unreadable`, which the recap builder treats as "carry
 * nothing" and the source version folds in.
 */
async function readSourceControls(client: ClientLike, ownerId: string): Promise<SourceControls> {
  const res = await client.from("memory_resurfacing_preferences").select("memory_id, control").eq("owner_id", ownerId);
  if (res.error) return isTableAbsentError(res.error) ? { state: "absent" } : { state: "unreadable" };
  if (!Array.isArray(res.data)) return { state: "unreadable" };
  if (res.data.length >= 1000) return { state: "unreadable" }; // a full PostgREST page may be truncated — a control past it would not be honoured; fail closed
  const byMemory: Record<string, string[]> = {};
  for (const r of res.data as Array<{ memory_id: string; control: string }>) (byMemory[r.memory_id] ??= []).push(String(r.control));
  return { state: "ok", byMemory };
}

// ── §AN (lane H, 2026-10-07): the owner's hidden photos (3672) ───────────────
/** Absent column (3672 not applied) ⇒ none hidden (true). Any other failure ⇒ null (unreadable). */
async function readSourceHiddenItems(client: ClientLike, memoryIds: readonly string[]): Promise<ReadonlySet<string> | null> {
  if (memoryIds.length === 0) return new Set();
  const r = await hiddenItemKeys(client, memoryIds);
  return r.ok ? r.keys : null;
}

// ── §AP (lane H, 2026-10-07, lead ruling H-13 wave): place corrections (3673) ─
/**
 * Every registry projection that LISTS OR CARRIES a Memory's place reads it
 * through the owner's corrections: PlaceMemoryProjection (which Memories are at
 * the place), and every projection whose field whitelist carries `place_id` or
 * `canonical_location_id` — MapTrailDerivative, TripMemoryProjection (the crew's
 * recap), the Timeline and Compass projections. Lead ruling H-16: a place its
 * owner rejected is never carried to anyone. Both sides of a staleness
 * comparison ask this, so the version they compare folds the same corrections
 * in (the VERIFY-H4 H4-4 class).
 */
function readsPlaceCorrections(def: { id: string; field_whitelist: readonly string[] } | null): boolean {
  return def !== null && (def.id === "PlaceMemoryProjection" || def.field_whitelist.includes("place_id") || def.field_whitelist.includes("canonical_location_id"));
}

/**
 * Corrects `memories`' place references (memoryCorrections.correctPlaceRefs).
 * The corrections read covers EVERY Memory of the owner (VERIFY-H6 H6-4: with or
 * without a stored reference); a place scope also looks up the assertions there. Unreadable ⇒ a
 * refusal (`source_unavailable`, memory_corrections), never an uncorrected
 * build: a missed rejection would list the Memory at the place its owner said
 * was wrong. Absent table ⇒ no corrections (true).
 */
async function correctSourcePlaces(
  client: ClientLike,
  scope: ProjectionScope,
  memories: MemorySourceRow[],
): Promise<{ ok: true; memories: MemorySourceRow[]; entries: Record<string, string> } | { ok: false; reason: "source_unavailable"; table: string; detail: string; retryable: boolean }> {
  const refuse = (detail: string) => ({ ok: false as const, reason: "source_unavailable" as const, table: "memory_corrections", detail, retryable: true });
  const known = new Set(memories.map((m) => m.id));
  const candidates = new Set(memories.map((m) => m.id)); // VERIFY-H6 H6-4: EVERY Memory, not only those with a stored reference — an assertion places a Memory that has none (H-12's window, a first placement), on the trail and every place-carrying projection, not only in a place scope
  if (scope.place_id) {
    const asserted = await memoriesAssertedAtPlace(client, scope.owner_id, scope.place_id);
    if (asserted.state === "unreadable") return refuse(asserted.detail);
    for (const id of asserted.memoryIds) if (known.has(id)) candidates.add(id);
  }
  const through = await placesThroughCorrections(client, memories.filter((m) => candidates.has(m.id)), new Date());
  if (!through.ok) return refuse(through.detail);
  const correctedById = new Map(through.rows.map((m) => [m.id, m] as const));
  return { ok: true, memories: memories.map((m) => correctedById.get(m.id) ?? m), entries: through.versionEntries };
}
