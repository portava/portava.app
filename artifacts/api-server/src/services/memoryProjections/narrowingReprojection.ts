/**
 * narrowingReprojection — §21 "Make private: revoke public derivatives and
 * public indexing, retain the Memory", for the derivatives §18's registry holds.
 *
 * CENSUS: H189 (make private) and H114 ("privacy changes revoke searchable
 * derivatives"). Before this module only DELETE reached the registry
 * (memoryDeletionLifecycle step 3). A visibility PATCH evicted Compass caches
 * and nothing else, so a registered derivative went on carrying a Memory its
 * audience had just lost, at rest, until something next read and rebuilt it.
 *
 * ── WHY RE-DERIVE, AND NOT `revokeDerivativesForMemory` ──────────────────────
 * A REVOKED registration is terminal by design: `rebuildProjection` will not
 * overwrite it and memorySearchService refuses it with `derivative_revoked`
 * (410) for good, so that no rebuild can resurrect what a privacy decision
 * destroyed. That is right for a deleted Memory's content and wrong as the
 * answer to "this one Memory is now private": the public scope is ONE
 * registration per owner (viewer NULL), so revoking it would end everyone's
 * search of that person's public Memories forever because one of them narrowed;
 * and the owner's own timeline, which keeps the Memory, would be revoked too.
 *
 * So each ACTIVE registration that carries the Memory is RE-DERIVED from the
 * canonical rows as they are NOW — after the narrowing committed. The read
 * happens after the write committed, so it cannot see the old audience.
 *
 * WHAT A RE-DERIVATION EXCLUDES IS THE BUILDER'S BUSINESS, AND NOT EVERY
 * BUILDER NARROWED (verifier VERIFY-H2, finding H2-2). The public builder admits
 * only `public` Memories; the owner's timeline admits all of the owner's. But
 * TripMemoryProjection — registered for the crew search with `viewer_id: null` —
 * used to admit every non-deleted Memory of the trip, so after make-private the
 * crew derivative still carried the Memory's title at rest and this module
 * counted it `retained`. Lead ruling (2026-10-07): a derivative built for any
 * non-owner audience excludes, AT BUILD TIME, every Memory whose audience does
 * not admit that audience (projectionRegistry.sharedAudienceAdmits); the §23
 * read-time ladder in runCrewMemorySearch stays as the second layer. So a
 * registration that still carries the Memory after re-derivation is split by
 * audience: the owner's own view (`retained`) is expected; any other
 * (`retainedShared`) is a viewer-specific derivative whose viewer still has
 * access, and it is reported and logged.
 *
 * BOUNDED. PostgREST answers at most 1000 rows. A read that comes back full may
 * have been truncated, so it is reported `ok: false` with the reason; every
 * registration it did return is still re-derived, and re-derived ones no longer
 * match, so the deletion lifecycle's retry (and the redrive) drains the rest.
 *
 * FAIL CLOSED. A registration that cannot be re-derived — the builder refuses,
 * the write fails, the scope key cannot be parsed — is REVOKED instead, payload
 * emptied, which is the deletion path's answer. A registration that could not
 * be re-derived AND could not be revoked is reported, never hidden.
 */
import {
  DERIVATIVE_REGISTRY_TABLE,
  DELETION_REVOCATION_REASON,
  isDeletionRevocation,
  readRegistration,
  rebuildProjection,
  type ClientLike,
} from "./derivativeRegistry.js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";
import { listProjectionIds, type ProjectionId, type ProjectionScope } from "./projectionRegistry.js";

export interface NarrowingReport {
  /** Every step ran and nothing that should have changed was left unchanged. */
  ok: boolean;
  /** ACTIVE registrations that carried the Memory when the narrowing committed. */
  carried: number;
  /** Re-derived, and no longer carry it: the audience lost the Memory. */
  reprojected: number;
  /** Re-derived, and still carry it, in the OWNER's own view (viewer = owner): expected. */
  retained: number;
  /** Re-derived, and still carry it, in a view for someone ELSE: that viewer still has access. Reported and logged. */
  retainedShared: number;
  /** Could not be re-derived, so revoked (payload emptied) instead. */
  revokedInstead: number;
  /** Neither re-derived nor revoked — the derivative may still carry the Memory. */
  unresolved: string[];
  /** The registry table is not deployed (42P01 / PGRST205): there is nothing to re-derive. */
  absent: boolean;
}

/** `scopeKeyOf`'s inverse. Null for anything it did not write. */
export function parseScopeKey(scopeKey: string): { projectionId: ProjectionId; scope: ProjectionScope } | null {
  const [projection, ...parts] = String(scopeKey ?? "").split("|");
  if (!(listProjectionIds() as string[]).includes(projection ?? "")) return null;
  const scope: ProjectionScope = { owner_id: "", viewer_id: null, trip_id: null, place_id: null, person_id: null };
  const keys: Record<string, keyof ProjectionScope> = { owner: "owner_id", viewer: "viewer_id", trip: "trip_id", place: "place_id", person: "person_id" };
  for (const part of parts) {
    const i = part.indexOf(":");
    const k = keys[part.slice(0, i)];
    if (i <= 0 || !k || (scope as any)[k]) return null;
    (scope as any)[k] = part.slice(i + 1);
  }
  if (!scope.owner_id) return null;
  return { projectionId: projection as ProjectionId, scope };
}

async function revokeOne(client: ClientLike, id: string, reason: string, now: Date): Promise<boolean> {
  const { data, error } = await client
    .from(DERIVATIVE_REGISTRY_TABLE)
    .update({ revocation_state: "REVOKED", revoked_at: now.toISOString(), revocation_reason: reason, payload_json: [], row_count: 0 })
    .in("id", [id])
    .select("id");
  return !error && Array.isArray(data) && data.length === 1;
}

/**
 * Re-derive every ACTIVE registration carrying `memoryId`, after its audience
 * narrowed. Never throws for a resolved error.
 */
export async function reprojectDerivativesAfterNarrowing(
  client: ClientLike,
  input: {
    memoryId: string; now: Date; reason: string;
    /**
     * Lead ruling H-5: the Memory was DELETED, so no audience keeps it. A
     * re-derived registration that still carries it is revoked, never counted
     * as `retained`.
     */
    mustExclude?: boolean;
  },
): Promise<NarrowingReport> {
  const report: NarrowingReport = { ok: true, carried: 0, reprojected: 0, retained: 0, retainedShared: 0, revokedInstead: 0, unresolved: [], absent: false };
  // NEVER THROWS. It runs after the owner's decision has committed (PATCH) or
  // inside a lifecycle step; a throw from a client would turn a committed
  // privacy change into a 500. A throw is a failure, reported like one.
  try {
    return await reproject(client, input, report);
  } catch (err) {
    report.ok = false;
    report.unresolved.push(`re-derivation threw: ${String((err as { message?: unknown })?.message ?? err)}`);
    return report;
  }
}

async function reproject(
  client: ClientLike,
  input: { memoryId: string; now: Date; reason: string; mustExclude?: boolean },
  report: NarrowingReport,
): Promise<NarrowingReport> {
  const found = await client
    .from(DERIVATIVE_REGISTRY_TABLE)
    .select("id, scope_key, source_memory_ids, revocation_state")
    .contains("source_memory_ids", [input.memoryId])
    .eq("revocation_state", "ACTIVE");
  if (found.error) {
    if (isTableAbsentError(found.error)) { report.absent = true; return report; }
    report.ok = false;
    report.unresolved.push(`registry unreadable: ${found.error.message ?? "unknown error"}`);
    return report;
  }
  const rows = (Array.isArray(found.data) ? found.data : []) as Array<{ id: string; scope_key: string; source_memory_ids: string[] | null }>;
  if (rows.length >= REGISTRY_PAGE) {
    report.ok = false;
    report.unresolved.push(`registry page full: ${rows.length} registrations returned, more may carry this Memory — re-derived these, the rest on the next run`);
  }
  const carrying = rows.filter((r) => (r.source_memory_ids ?? []).includes(input.memoryId));
  report.carried = carrying.length;

  for (const reg of carrying) {
    const parsed = parseScopeKey(reg.scope_key);
    let rebuilt: Awaited<ReturnType<typeof rebuildProjection>> | null = null;
    if (parsed) {
      try {
        rebuilt = await rebuildProjection(client, parsed.projectionId, parsed.scope, input.now);
      } catch {
        rebuilt = null;
      }
    }
    if (rebuilt && rebuilt.ok && !rebuilt.value.was_revoked) {
      const stillCarries = (rebuilt.value.registration.source_memory_ids ?? []).includes(input.memoryId);
      if (!stillCarries) { report.reprojected += 1; continue; }
      if (!input.mustExclude) { if (parsed!.scope.viewer_id === parsed!.scope.owner_id) report.retained += 1; else report.retainedShared += 1; continue; }
      // A deleted Memory that a rebuild still carries falls through to the revoke.
    }
    // Fail closed: what cannot be re-derived is emptied.
    if (await revokeOne(client, reg.id, `${input.reason}: re-derivation failed`, input.now)) {
      report.revokedInstead += 1;
    } else {
      report.ok = false;
      report.unresolved.push(reg.scope_key);
    }
  }
  return report;
}

/**
 * Lead ruling H-5 — on the OWNER's request, rebuild a registration that was
 * revoked because a Memory was deleted. The builders read the canonical rows
 * as they are now, so every deleted or non-visible Memory is excluded. A
 * registration revoked for any other reason is left REVOKED.
 */
export type ReviveOutcome =
  | { state: "revived"; carried: number }
  | { state: "not_revocable"; detail: string }
  | { state: "failed"; detail: string };

export async function reviveDeletionRevokedDerivative(
  client: ClientLike,
  projectionId: ProjectionId,
  scope: ProjectionScope,
  now: Date,
): Promise<ReviveOutcome> {
  const reg = await readRegistration(client, projectionId, scope);
  if (!reg.ok) return { state: "failed", detail: reg.detail };
  if (reg.value.revocation_state !== "REVOKED") return { state: "not_revocable", detail: `registration is ${reg.value.revocation_state}` };
  if (!isDeletionRevocation(reg.value.revocation_reason)) {
    return { state: "not_revocable", detail: `revoked for '${String(reg.value.revocation_reason ?? "")}', not by a deletion` };
  }
  const rebuilt = await rebuildProjection(client, projectionId, scope, now, { reviveDeletionRevoked: true });
  if (!rebuilt.ok) return { state: "failed", detail: rebuilt.detail };
  if (rebuilt.value.was_revoked) return { state: "failed", detail: "the rebuild declined to overwrite the revoked registration" };
  return { state: "revived", carried: (rebuilt.value.registration.source_memory_ids ?? []).length };
}

export { DELETION_REVOCATION_REASON };

/** PostgREST's max-rows on Supabase: a read that returns this many may be truncated. */
export const REGISTRY_PAGE = 1000;
