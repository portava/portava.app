/**
 * memoryVisibilityPolicy — §3 `memory_visibility_policies` ("Audience and
 * location precision policy"), migration 3810. Census-highlights-memories H33.
 *
 * ── WHAT THE TABLE HOLDS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────
 * Two of the three §10 policy dimensions already have storage, on the Memory:
 *   audience            memories.visibility / allowed_user_ids / hidden_user_ids (0067)
 *   location precision  memories.location_precision (2338, applied)
 * They stay single-sourced there. Copying them into this table would make a
 * second source of truth whose disagreement with the first nothing could
 * resolve (open owner question Q-H33 asks whether to migrate them; the default
 * built here is "no copy").
 *
 * The one §10 dimension with NO storage was the person ladder: the rung was
 * derived per participant (services/memory/memoryParticipantVisibility.ts) and
 * "a participant cannot pick their own rung here, because there is no column to
 * pick it in". 3810 adds the OWNER's half of that: a per-Memory CEILING on how
 * the people on the Memory are disclosed to anyone else
 *   NAMED -> PROFILE_LINKED -> CREW_ONLY -> ANONYMOUS_COUNT -> HIDDEN
 * and the security_invoker view `memory_visibility_policy_effective` joins the
 * three dimensions into the one relation §3 names, without copying any of them.
 *
 * ── THE CEILING ONLY EVER NARROWS ───────────────────────────────────────────
 * `applyPersonCeiling` returns the stricter of the derived rung and the
 * ceiling, AFTER resolving each for the viewer. That second half matters:
 * CREW_ONLY discloses nothing to a viewer outside the crew, so for that viewer
 * it is stricter than ANONYMOUS_COUNT although its ladder rank is lower. A plain
 * rank-min would turn "hidden from you" into "one person, unnamed" — a widening.
 * `src/test/memoryVisibilityPolicy.test.ts` pins the property over every
 * (derived rung × ceiling × crew/not crew) triple.
 *
 * ── WHO THE CEILING BINDS ───────────────────────────────────────────────────
 * Every viewer except
 *   • the OWNER — they set it; their own view and tag management are unchanged;
 *   • the PARTICIPANT THEMSELF — a person's own tag is not a disclosure about
 *     them to someone else, and the ladder's branch 2 already rules that "a
 *     person must be able to see the tag they are being asked to approve"; an
 *     owner's ceiling must not take away a participant's §5 exit door
 *     (owner question Q-H33-2 records the alternative).
 *
 * ── HOW A READ FAILS (four states, never a boolean) ─────────────────────────
 *   ok          the rows, read; a requested Memory with no row has NO ceiling
 *   absent      3810 is not applied (42P01 / PGRST205 ONLY): no row can exist,
 *               so "no ceiling" is TRUE and every surface behaves exactly as it
 *               did before 3810
 *   unreadable  anything else (an error, a throw, no row array, a page that
 *               could be truncated) — HIDDEN for every non-owner, non-self viewer
 *   not_read    the context never read the table (the owner's own context, or
 *               no Memory id was supplied) — HIDDEN for anyone the ceiling binds,
 *               so a caller that forgot to load the policy cannot disclose
 * A row that is present but MALFORMED (an unknown ceiling, another owner's id)
 * is that Memory's HIDDEN, not a failure of the whole read.
 */
import {
  PERSON_VISIBILITY_LADDER,
  isPersonVisibility,
  strictestPersonVisibility,
  type PersonVisibilityRung,
} from "../highlights/highlightProjectionPolicy.js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";

/** The literal `.from()` names below must equal these (check:write-path-columns reads literals). */
export const MEMORY_VISIBILITY_POLICY_TABLE = "memory_visibility_policies";
export const MEMORY_VISIBILITY_POLICY_VIEW = "memory_visibility_policy_effective";

/** 3810's CHECK, in ladder order. One vocabulary in the repository: the §10 ladder itself. */
export const PERSON_VISIBILITY_CEILINGS: readonly PersonVisibilityRung[] = PERSON_VISIBILITY_LADDER;

/** `.in()` rides in the query string; a few hundred uuids per request is the bound the routes already use. */
export const POLICY_CHUNK = 100;

export type PersonCeilingRead =
  | { readonly state: "ok"; readonly requested: ReadonlySet<string>; readonly byMemory: ReadonlyMap<string, PersonVisibilityRung> }
  | { readonly state: "absent"; readonly detail: string }
  | { readonly state: "unreadable"; readonly detail: string }
  | { readonly state: "not_read"; readonly detail: string };

/** A context that never consulted the table. HIDDEN for anyone the ceiling binds. */
export const CEILING_NOT_READ: PersonCeilingRead = Object.freeze({ state: "not_read", detail: "the policy was not read for this context" });

/**
 * The owner's ceilings on these Memories.
 *
 * Reads by `memory_id`, chunked, and checks `owner_id` on every row rather than
 * filtering by it: a row filed under another owner is malformed, and a filter
 * would make it silently invisible — "no ceiling" — instead of HIDDEN.
 */
export async function readPersonCeilings(
  sc: any,
  ownerId: string,
  memoryIds: readonly string[],
): Promise<PersonCeilingRead> {
  const ids = [...new Set(memoryIds.filter((x) => typeof x === "string" && x.length > 0))];
  if (ids.length === 0) return CEILING_NOT_READ;
  const requested = new Set(ids);
  const byMemory = new Map<string, PersonVisibilityRung>();
  try {
    for (let i = 0; i < ids.length; i += POLICY_CHUNK) {
      const batch = ids.slice(i, i + POLICY_CHUNK);
      const { data, error } = await sc
        .from("memory_visibility_policies")
        .select("memory_id, owner_id, person_visibility_ceiling")
        .in("memory_id", batch);
      if (error) {
        if (isTableAbsentError(error)) return { state: "absent", detail: String(error.message ?? "absent") };
        return { state: "unreadable", detail: String(error.message ?? "read failed") };
      }
      if (!Array.isArray(data)) return { state: "unreadable", detail: "policy read returned no row array" };
      // memory_id is the primary key, so a chunk can never return more rows than
      // it asked for. More means the read is not what this code thinks it is.
      if (data.length > batch.length) return { state: "unreadable", detail: `policy read returned ${data.length} rows for ${batch.length} ids` };
      for (const r of data as Array<Record<string, unknown>>) {
        const memoryId = typeof r.memory_id === "string" ? r.memory_id : "";
        if (!requested.has(memoryId)) return { state: "unreadable", detail: "policy read returned a row that was not asked for" };
        const stored = r.person_visibility_ceiling;
        const rung: PersonVisibilityRung = r.owner_id === ownerId && isPersonVisibility(stored) ? stored : "HIDDEN";
        const had = byMemory.get(memoryId);
        byMemory.set(memoryId, had ? strictestPersonVisibility(had, rung) : rung);
      }
    }
  } catch (err) {
    return { state: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
  return { state: "ok", requested, byMemory };
}

/**
 * The ceiling that binds one Memory, or null for "no ceiling".
 *
 *   absent      → null (3810 not applied: exactly the pre-3810 behaviour)
 *   unreadable  → HIDDEN
 *   not_read    → HIDDEN
 *   ok          → the stored rung; null when the Memory has no row; HIDDEN when
 *                 the Memory was not among those read (a lookup this read
 *                 cannot answer is not "no ceiling")
 */
export function ceilingFor(read: PersonCeilingRead | null | undefined, memoryId: string | null | undefined): PersonVisibilityRung | null {
  // A context built by hand without a policy read is `not_read`, not "no ceiling".
  switch (read?.state) {
    case "absent": return null;
    case "ok": {
      if (typeof memoryId !== "string" || !read.requested.has(memoryId)) return "HIDDEN";
      return read.byMemory.get(memoryId) ?? null;
    }
    case "unreadable":
    case "not_read":
    default:
      return "HIDDEN";
  }
}

/**
 * The rung this viewer may see a person at, for a NON-CREW viewer, before the
 * ceiling compares it: CREW_ONLY outside the crew discloses exactly what HIDDEN
 * does (`discloseParticipant`), so it is compared as HIDDEN.
 */
function forViewer(r: PersonVisibilityRung, viewerIsCrew: boolean): PersonVisibilityRung {
  return r === "CREW_ONLY" && !viewerIsCrew ? "HIDDEN" : r;
}

/**
 * min(derived rung, owner ceiling), resolved for the viewer. A null ceiling
 * returns the derived rung UNCHANGED — the pre-3810 answer, byte for byte.
 */
export function applyPersonCeiling(
  derived: PersonVisibilityRung,
  ceiling: PersonVisibilityRung | null,
  viewerIsCrew: boolean,
): PersonVisibilityRung {
  if (ceiling === null) return derived;
  return strictestPersonVisibility(forViewer(derived, viewerIsCrew), forViewer(ceiling, viewerIsCrew));
}

/** Does the owner's ceiling bind this viewer's view of this participant? */
export function ceilingBinds(viewerId: string, ownerId: string, participantId: string): boolean {
  return viewerId !== ownerId && viewerId !== participantId;
}

/**
 * The people a SHARED (non-owner) derivative may carry by id for one Memory,
 * given its ceiling. §18's TripMemoryProjection is built for the trip's crew,
 * so its audience is crew: NAMED, PROFILE_LINKED and CREW_ONLY keep the ids;
 * ANONYMOUS_COUNT and HIDDEN carry none (the row has no count field, so the
 * stricter answer is the only one available — never a widening).
 */
export function sharedPeopleUnderCeiling(people: readonly string[], ceiling: PersonVisibilityRung | null): string[] {
  if (ceiling === null) return [...people];
  const bound = applyPersonCeiling("NAMED", ceiling, true);
  return bound === "ANONYMOUS_COUNT" || bound === "HIDDEN" ? [] : [...people];
}

// ── The owner's writer ────────────────────────────────────────────────────────

export type CeilingWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_deployed" | "unavailable"; readonly detail: string };

/**
 * Set (or, with `ceiling: null`, clear) the owner's ceiling on one Memory.
 * The caller has already proved `ownerId` owns the live Memory.
 */
export async function writePersonCeiling(
  sc: any,
  input: { readonly memoryId: string; readonly ownerId: string; readonly ceiling: PersonVisibilityRung | null; readonly now: Date },
): Promise<CeilingWrite> {
  try {
    const { error } = input.ceiling === null
      ? await sc
          .from("memory_visibility_policies")
          .delete()
          .eq("memory_id", input.memoryId)
          .eq("owner_id", input.ownerId)
      : await sc
          .from("memory_visibility_policies")
          .upsert(
            { memory_id: input.memoryId, owner_id: input.ownerId, person_visibility_ceiling: input.ceiling, updated_at: input.now.toISOString() },
            { onConflict: "memory_id" },
          );
    if (error) {
      if (isTableAbsentError(error)) return { ok: false, reason: "not_deployed", detail: String(error.message ?? "") };
      return { ok: false, reason: "unavailable", detail: String(error.message ?? "") };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "unavailable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

// ── The owner's status (§12's fourth control, "visibility") ───────────────────

export interface EffectivePolicyRow {
  readonly memoryId: string;
  readonly visibility: string | null;
  readonly allowedUserIds: readonly string[];
  readonly hiddenUserIds: readonly string[];
  readonly locationPrecision: unknown;
  /** The stored value as read, before validation. */
  readonly storedCeiling: unknown;
  readonly ceilingUpdatedAt: string | null;
}

export type EffectivePolicyRead =
  | { readonly state: "ok"; readonly row: EffectivePolicyRow | null }
  | { readonly state: "absent"; readonly detail: string }
  | { readonly state: "unreadable"; readonly detail: string };

/** One Memory's row of `memory_visibility_policy_effective`, for its owner. */
export async function readEffectivePolicy(sc: any, ownerId: string, memoryId: string): Promise<EffectivePolicyRead> {
  try {
    const { data, error } = await sc
      .from("memory_visibility_policy_effective")
      .select("memory_id, owner_id, visibility, allowed_user_ids, hidden_user_ids, location_precision, person_visibility_ceiling, person_visibility_ceiling_updated_at")
      .eq("memory_id", memoryId)
      .maybeSingle();
    if (error) {
      if (isTableAbsentError(error)) return { state: "absent", detail: String(error.message ?? "absent") };
      return { state: "unreadable", detail: String(error.message ?? "read failed") };
    }
    if (data == null) return { state: "ok", row: null };
    const r = data as Record<string, unknown>;
    // The view is over every Memory; the caller proved ownership on `memories`.
    // A row that disagrees about the owner is not this owner's to be shown.
    if (r.owner_id !== ownerId) return { state: "unreadable", detail: "the policy view disagrees with the Memory about its owner" };
    return {
      state: "ok",
      row: {
        memoryId: String(r.memory_id),
        visibility: typeof r.visibility === "string" ? r.visibility : null,
        allowedUserIds: Array.isArray(r.allowed_user_ids) ? (r.allowed_user_ids as string[]) : [],
        hiddenUserIds: Array.isArray(r.hidden_user_ids) ? (r.hidden_user_ids as string[]) : [],
        locationPrecision: r.location_precision,
        storedCeiling: r.person_visibility_ceiling,
        ceilingUpdatedAt: typeof r.person_visibility_ceiling_updated_at === "string" ? r.person_visibility_ceiling_updated_at : null,
      },
    };
  } catch (err) {
    return { state: "unreadable", detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

/**
 * What non-owners actually get from a stored value: null (no row) is "no
 * ceiling"; a value the ladder does not know is HIDDEN, exactly as the reader
 * treats it.
 */
export function effectiveCeilingOf(stored: unknown): PersonVisibilityRung | null {
  if (stored === null || stored === undefined) return null;
  return isPersonVisibility(stored) ? stored : "HIDDEN";
}
