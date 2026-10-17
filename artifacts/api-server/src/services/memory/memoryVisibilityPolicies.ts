/**
 * memoryVisibilityPolicies — §3.6 `memory_visibility_policies`, "Audience and
 * location precision policy" (migration 3997, census H33).
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §3.6  memory_visibility_policies — Audience and location precision policy.
 *   §10   "Publishing location must never exceed the owner's selected precision."
 *   §25   "Public location precision cannot exceed owner policy."
 *   §28.7 "Never allow public location precision above the owner's publication
 *         policy."
 *
 * WHAT THE TABLE HOLDS. One row per (owner, audience): the finest location
 * precision ANY Memory of that owner may be served at to that audience — the
 * owner's publication policy. The audience is the Memory's own audience class,
 * so a Memory published to everyone answers to the owner's `public` rung and a
 * crew Memory to the `trip_crew` rung.
 *
 * HOW IT COMPOSES. It is a CEILING, never a floor. A non-owner read takes the
 * STRICTER of three rungs: this policy's, the Memory's own
 * `memories.location_precision` (2338, §3.1's per-Memory field), and the
 * Hidden-Gem ceiling. `stricterPrecision` only ever moves toward `hidden`, so no
 * one of them can widen another (routes/memories.ts protectMemoryRow).
 *
 * THE GATE HAS THREE STATES, and they fail toward showing LESS:
 *   off / absent  the policy is not consulted — today's behaviour exactly. On
 *                 production the table does not exist (3997 is unapplied) and
 *                 the flag row is absent.
 *   on            the policies of the owners on the page are read; an owner
 *                 with no row has no ceiling; a read that FAILS clamps every
 *                 row to `hidden`, because "I could not read the owner's
 *                 policy" must not be served as "the owner set none".
 *   unreadable    the flag itself could not be read, so whether a policy
 *                 applies is unknown: clamp to `hidden`, as
 *                 lib/memoryPrecisionGate.ts does for its own gate.
 *
 * Owner reads are never clamped (protectMemoryRow returns the owner's row
 * untouched before it asks this module anything).
 */
import { readFlagState } from "../../lib/capability/schemaCapability.js";
import {
  isMemoryLocationPrecision,
  stricterPrecision,
  type MemoryLocationPrecision,
} from "../../lib/memoryLocationPrecision.js";

export const MEMORY_VISIBILITY_POLICIES_TABLE = "memory_visibility_policies";
export const MEMORY_VISIBILITY_POLICIES_FLAG = "memory_visibility_policies_enabled";

/** §4 VisibilityClass, less PRIVATE (an owner-only Memory has no other viewer). */
export const MEMORY_POLICY_AUDIENCES = ["public", "followers", "trip_crew", "selected_people"] as const;
export type MemoryPolicyAudience = (typeof MEMORY_POLICY_AUDIENCES)[number];

export function isMemoryPolicyAudience(v: unknown): v is MemoryPolicyAudience {
  return typeof v === "string" && (MEMORY_POLICY_AUDIENCES as readonly string[]).includes(v);
}

/**
 * The stored `memories.visibility` → the policy audience it is published to.
 * `only_me` has none (null). A value this module does not know is `undefined`,
 * which the reader treats as fail-closed.
 */
export function audienceOfVisibility(visibility: unknown): MemoryPolicyAudience | null | undefined {
  switch (visibility) {
    case "public": return "public";
    case "friends_only": return "followers";
    case "trip_crew": return "trip_crew";
    case "circle_only":
    case "custom": return "selected_people";
    case "only_me": return null;
    default: return undefined;
  }
}

export type PolicyGate = "on" | "off" | "unreadable";

export async function readVisibilityPolicyGate(sc: unknown): Promise<PolicyGate> {
  const s = await readFlagState(sc, MEMORY_VISIBILITY_POLICIES_FLAG);
  if (s === "on") return "on";
  if (s === "unreadable") return "unreadable";
  return "off";
}

export type OwnerPolicy = Partial<Record<MemoryPolicyAudience, MemoryLocationPrecision>>;

/** What a non-owner read consults. Built once per request by `loadAudienceCeilings`. */
export type AudienceCeilings =
  | { state: "off" }
  | { state: "unreadable" }
  | { state: "on"; byOwner: ReadonlyMap<string, OwnerPolicy> };

/** A stored rung, normalized: off-ladder (corruption) is `hidden`, never `exact`. */
function storedRung(v: unknown): MemoryLocationPrecision {
  return isMemoryLocationPrecision(v) ? v : "hidden";
}

/**
 * Read the publication policies of the owners of `rows`. NEVER throws: a thrown
 * client and a resolved error are both `unreadable`, which clamps.
 */
export async function loadAudienceCeilings(
  sc: any,
  rows: ReadonlyArray<{ owner_id?: unknown } | null | undefined>,
): Promise<AudienceCeilings> {
  const gate = await readVisibilityPolicyGate(sc);
  if (gate === "off") return { state: "off" };
  if (gate === "unreadable") return { state: "unreadable" };
  const owners = [...new Set(rows.map((r) => r?.owner_id).filter((o): o is string => typeof o === "string" && o.length > 0))];
  const byOwner = new Map<string, OwnerPolicy>();
  if (owners.length === 0) return { state: "on", byOwner };
  try {
    const { data, error } = await sc
      .from(MEMORY_VISIBILITY_POLICIES_TABLE)
      .select("owner_id, audience, location_precision")
      .in("owner_id", owners);
    if (error || !Array.isArray(data)) return { state: "unreadable" };
    for (const r of data as Array<{ owner_id?: unknown; audience?: unknown; location_precision?: unknown }>) {
      if (typeof r?.owner_id !== "string" || !isMemoryPolicyAudience(r.audience)) continue;
      const p = byOwner.get(r.owner_id) ?? {};
      p[r.audience] = storedRung(r.location_precision);
      byOwner.set(r.owner_id, p);
    }
    return { state: "on", byOwner };
  } catch {
    return { state: "unreadable" };
  }
}

/**
 * The owner-policy rung for one Memory row served to a non-owner. `exact` means
 * "no constraint from the policy" (the other ceilings still apply).
 */
export function audienceCeilingFor(
  ceilings: AudienceCeilings | undefined,
  row: { owner_id?: unknown; visibility?: unknown } | null | undefined,
): MemoryLocationPrecision {
  if (!ceilings || ceilings.state === "off") return "exact";
  if (ceilings.state === "unreadable") return "hidden";
  const audience = audienceOfVisibility(row?.visibility);
  if (audience === undefined) return "hidden"; // an audience this module cannot name is not served finely
  if (audience === null) return "exact"; // only_me: no non-owner audience exists to have a policy for
  const owner = typeof row?.owner_id === "string" ? row.owner_id : null;
  if (!owner) return "hidden";
  return ceilings.byOwner.get(owner)?.[audience] ?? "exact";
}

/** The rung a non-owner read applies: the stricter of the Memory's own rung and the owner's policy. */
export function withAudienceCeiling(
  memoryRung: MemoryLocationPrecision,
  ceilings: AudienceCeilings | undefined,
  row: { owner_id?: unknown; visibility?: unknown } | null | undefined,
): MemoryLocationPrecision {
  return stricterPrecision(memoryRung, audienceCeilingFor(ceilings, row));
}

// ── The owner's own reads and writes (routes/memoryVisibilityPolicies.ts) ────

export type PolicyResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "disabled" | "unavailable" | "invalid"; detail: string };

/** The owner's policy, every audience named (null = no ceiling for that audience). */
export async function readOwnerPolicy(
  sc: any,
  ownerId: string,
): Promise<PolicyResult<Record<MemoryPolicyAudience, MemoryLocationPrecision | null>>> {
  const gate = await readVisibilityPolicyGate(sc);
  if (gate === "off") return { ok: false, reason: "disabled", detail: "memory_visibility_policies_enabled is off" };
  if (gate === "unreadable") return { ok: false, reason: "unavailable", detail: "the flag could not be read" };
  const { data, error } = await sc
    .from(MEMORY_VISIBILITY_POLICIES_TABLE)
    .select("audience, location_precision")
    .eq("owner_id", ownerId);
  if (error || !Array.isArray(data)) {
    return { ok: false, reason: "unavailable", detail: error?.message ?? "policy read returned no row array" };
  }
  const out: Record<MemoryPolicyAudience, MemoryLocationPrecision | null> = {
    public: null, followers: null, trip_crew: null, selected_people: null,
  };
  for (const r of data as Array<{ audience?: unknown; location_precision?: unknown }>) {
    if (isMemoryPolicyAudience(r?.audience)) out[r.audience] = storedRung(r.location_precision);
  }
  return { ok: true, value: out };
}

/**
 * Set one audience's ceiling. The write binds `.select()` so an upsert that
 * wrote nothing is a refusal, not a success.
 */
export async function setOwnerPolicy(
  sc: any,
  ownerId: string,
  audience: unknown,
  precision: unknown,
  now: Date,
): Promise<PolicyResult<{ audience: MemoryPolicyAudience; locationPrecision: MemoryLocationPrecision }>> {
  if (!isMemoryPolicyAudience(audience)) return { ok: false, reason: "invalid", detail: "unknown audience" };
  if (!isMemoryLocationPrecision(precision)) return { ok: false, reason: "invalid", detail: "unknown location precision" };
  const gate = await readVisibilityPolicyGate(sc);
  if (gate === "off") return { ok: false, reason: "disabled", detail: "memory_visibility_policies_enabled is off" };
  if (gate === "unreadable") return { ok: false, reason: "unavailable", detail: "the flag could not be read" };
  const { data, error } = await sc
    .from(MEMORY_VISIBILITY_POLICIES_TABLE)
    .upsert({ owner_id: ownerId, audience, location_precision: precision, updated_at: now.toISOString() }, { onConflict: "owner_id,audience" })
    .select("owner_id, audience, location_precision");
  const written = Array.isArray(data) ? data.find((r: any) => r?.owner_id === ownerId && r?.audience === audience) : null;
  if (error || !written || written.location_precision !== precision) {
    return { ok: false, reason: "unavailable", detail: error?.message ?? "the policy write was not confirmed" };
  }
  return { ok: true, value: { audience, locationPrecision: precision } };
}

/** Remove one audience's ceiling (back to "no ceiling"). Idempotent. */
export async function clearOwnerPolicy(
  sc: any,
  ownerId: string,
  audience: unknown,
): Promise<PolicyResult<{ audience: MemoryPolicyAudience; cleared: boolean }>> {
  if (!isMemoryPolicyAudience(audience)) return { ok: false, reason: "invalid", detail: "unknown audience" };
  const gate = await readVisibilityPolicyGate(sc);
  if (gate === "off") return { ok: false, reason: "disabled", detail: "memory_visibility_policies_enabled is off" };
  if (gate === "unreadable") return { ok: false, reason: "unavailable", detail: "the flag could not be read" };
  const { data, error } = await sc
    .from(MEMORY_VISIBILITY_POLICIES_TABLE)
    .delete()
    .eq("owner_id", ownerId)
    .eq("audience", audience)
    .select("owner_id");
  if (error) return { ok: false, reason: "unavailable", detail: error.message ?? "the policy delete failed" };
  return { ok: true, value: { audience, cleared: Array.isArray(data) && data.length > 0 } };
}
