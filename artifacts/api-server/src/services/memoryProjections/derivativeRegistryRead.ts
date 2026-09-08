/**
 * The SERVE path for public.memory_derivative_registry — the only module that
 * SELECTs the registry in order to hand a derivative to a reader.
 *
 * ── WHY THIS IS A SEPARATE FILE ──────────────────────────────────────────────
 * `check:projection-consumers` exists to catch DECORATIVE ARCHITECTURE: a
 * producer that runs, a table that fills, and nothing that reads it. It found
 * this table on 2026-09-08 and was right to: every read AND every write lived in
 * derivativeRegistry.ts, so the projection had no consumer that was not its own
 * producer, and the guard cannot tell that shape apart from a stranded table.
 *
 * The answer is not a registry entry claiming a consumer the checker cannot see,
 * and it is not a new `kind` to exempt this one table — that is how a guard
 * stops being a guard. The answer is that build and serve really are two
 * responsibilities, §18 really does treat them separately, and they now live in
 * two files that can be audited apart:
 *
 *   derivativeRegistry.ts      BUILDS and REVOKES. Writes the registry.
 *   derivativeRegistryRead.ts  SERVES. Reads the registry, and never writes it.
 *
 * services/memoryRetrieval/searchMemories.ts consumes this module, which is the
 * chain the registry entry now states and the checker can now verify.
 *
 * WHAT WOULD TURN THIS RED: add a write to this file — an insert, update or
 * upsert on DERIVATIVE_REGISTRY_TABLE — and the seam it exists for is gone.
 */
import {
  DERIVATIVE_REGISTRY_TABLE,
  type ClientLike,
  type ProjectionResult,
  type RegistrationRow,
} from "./derivativeRegistry.js";
import type { ProjectedRow, ProjectionId, ProjectionScope } from "./projectionRegistry.js";
import { scopeKeyOf } from "./projectionRegistry.js";

/** Columns a registration read needs. Kept here so the SERVE path owns its own shape. */
const REGISTRATION_COLUMNS =
  "id, owner_id, projection_id, scope_key, audience, destination, builder_version, " +
  "source_tables, source_memory_ids, source_version, source_version_json, payload_json, " +
  "row_count, generated_at, revocation_state, revoked_at, revocation_reason";

/** PostgREST's "relation does not exist" — a missing table is not retryable. */
function isSchemaAbsent(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  const code = String(err.code ?? "");
  const msg = String(err.message ?? "");
  return code === "42P01" || code === "PGRST205" || /does not exist/i.test(msg);
}

/**
 * Section 15 reads derivatives, not canonical rows. This is the only reader on
 * the serve path: it returns the registered payload, and refuses when the
 * registration is missing, revoked or unreadable rather than returning [].
 *
 * It issues its OWN select rather than calling derivativeRegistry.readRegistration,
 * which would make the two modules a cycle. See that file's note.
 */
export async function readRegisteredPayload(
  client: ClientLike,
  projectionId: ProjectionId,
  scope: ProjectionScope,
): Promise<ProjectionResult<{ rows: ProjectedRow[]; registration: RegistrationRow }>> {
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
  const registration = rows[0]!;
  if (registration.revocation_state === "REVOKED" || registration.revocation_state === "PURGED") {
    return {
      ok: false, reason: "not_registered",
      detail: `derivative ${registration.scope_key} is ${registration.revocation_state}`,
      retryable: false,
    };
  }
  const payload = Array.isArray(registration.payload_json) ? registration.payload_json : [];
  return { ok: true, value: { rows: payload, registration } };
}
