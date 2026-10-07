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
 * canonical rows as they are NOW — after the narrowing committed. A projection
 * builder admits a Memory only for an audience allowed to see it, so the
 * public derivative is rebuilt without it while the owner's timeline is rebuilt
 * with it: the Memory is retained, the public derivative no longer carries it.
 * The read happens after the write committed, so it cannot see the old audience.
 *
 * FAIL CLOSED. A registration that cannot be re-derived — the builder refuses,
 * the write fails, the scope key cannot be parsed — is REVOKED instead, payload
 * emptied, which is the deletion path's answer. A registration that could not
 * be re-derived AND could not be revoked is reported, never hidden.
 */
import {
  DERIVATIVE_REGISTRY_TABLE,
  rebuildProjection,
  type ClientLike,
} from "./derivativeRegistry.js";
import { listProjectionIds, type ProjectionId, type ProjectionScope } from "./projectionRegistry.js";

export interface NarrowingReport {
  /** Every step ran and nothing that should have changed was left unchanged. */
  ok: boolean;
  /** ACTIVE registrations that carried the Memory when the narrowing committed. */
  carried: number;
  /** Re-derived, and no longer carry it: the audience lost the Memory. */
  reprojected: number;
  /** Re-derived, and still carry it: that audience still sees the Memory (the owner's own, for one). */
  retained: number;
  /** Could not be re-derived, so revoked (payload emptied) instead. */
  revokedInstead: number;
  /** Neither re-derived nor revoked — the derivative may still carry the Memory. */
  unresolved: string[];
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
  input: { memoryId: string; now: Date; reason: string },
): Promise<NarrowingReport> {
  const report: NarrowingReport = { ok: true, carried: 0, reprojected: 0, retained: 0, revokedInstead: 0, unresolved: [] };
  const found = await client
    .from(DERIVATIVE_REGISTRY_TABLE)
    .select("id, scope_key, source_memory_ids, revocation_state")
    .contains("source_memory_ids", [input.memoryId])
    .eq("revocation_state", "ACTIVE");
  if (found.error) {
    report.ok = false;
    report.unresolved.push(`registry unreadable: ${found.error.message ?? "unknown error"}`);
    return report;
  }
  const rows = (Array.isArray(found.data) ? found.data : []) as Array<{ id: string; scope_key: string; source_memory_ids: string[] | null }>;
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
      if ((rebuilt.value.registration.source_memory_ids ?? []).includes(input.memoryId)) report.retained += 1;
      else report.reprojected += 1;
      continue;
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
