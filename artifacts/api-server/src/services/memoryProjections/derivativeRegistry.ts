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
 *         "`memory_derivative_registry` absent; nothing records where a
 *         derivative went."
 *
 * THE CLIENT FACT THIS FILE IS BUILT AROUND. supabase-js RESOLVES on a database
 * error. `const { data } = await sc.from("memories").select(...)` with `.error`
 * unbound therefore renders an unreadable table as an empty array, and for a
 * projection that is fatal: a failed derivation becomes the sentence "you have
 * no memories". Every read below binds `error` and every failure returns a
 * structured refusal. There is no try/catch around a supabase read in this file
 * because such a catch is dead code - the promise resolves, it does not throw.
 *
 * Writes bind `.select()` for the same reason in reverse: an UPDATE that matched
 * zero rows errors nothing, so without the select this module could report a
 * revocation that revoked nothing.
 */

import type {
  MemoryItemRow,
  MemorySourceRow,
  MemoryTagRow,
  ProjectedRow,
  ProjectionId,
  ProjectionScope,
} from "./projectionRegistry.js";
import {
  getProjectionDefinition,
  scopeKeyOf,
  sourceVersionOf,
} from "./projectionRegistry.js";
import type { SignificanceExplanation } from "./significance.js";

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

/** A relation or column that is not there. A retry will not conjure it. */
function isSchemaAbsent(err: MinimalPostgrestError | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  if (code === "42P01" || code === "42703" || code === "PGRST205" || code === "PGRST204") return true;
  return /does not exist|could not find the table|schema cache/i.test(String(err.message ?? ""));
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
  neq: (column: string, value: unknown) => QueryLike;
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
  tags: MemoryTagRow[];
}

/**
 * Read everything a projection derives from, for one owner.
 *
 * Deleted rows are read too: a projection must be able to tell "this Memory is
 * gone" from "this Memory was never read", and the second is a refusal.
 */
export async function readProjectionSources(
  client: ClientLike,
  scope: ProjectionScope,
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

  return { ok: true, value: { memories, items, tags } };
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

  const sources = await readProjectionSources(client, scope);
  if (!sources.ok) return sources;

  const rows = def.build({
    scope,
    memories: sources.value.memories,
    items: sources.value.items,
    tags: sources.value.tags,
    significance: opts.significance,
  });

  // The source version covers the rows the builder could see, not only the rows
  // it emitted: a Memory that was filtered OUT is still an input, and if it
  // changes so that it now qualifies, the projection is stale.
  const version = sourceVersionOf(sources.value.memories);

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
  opts: { significance?: ReadonlyMap<string, SignificanceExplanation> } = {},
): Promise<ProjectionResult<{ registration: RegistrationRow; rows: ProjectedRow[]; was_revoked: boolean }>> {
  const derived = await deriveProjection(client, projectionId, scope, opts);
  if (!derived.ok) return derived;

  const existing = await readRegistration(client, projectionId, scope);
  if (!existing.ok && existing.reason !== "not_registered") return existing;
  if (existing.ok && existing.value.revocation_state === "REVOKED") {
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
  const sources = await readProjectionSources(client, scope);
  if (!sources.ok) return sources;
  const current = sourceVersionOf(sources.value.memories);

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
  const found = await client
    .from(DERIVATIVE_REGISTRY_TABLE)
    .select("id, scope_key, source_memory_ids, revocation_state")
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

