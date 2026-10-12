/**
 * The I/O half of §6.3's SELECTED_PARTICIPANTS (census-trips §94, owner ruling OD-1012-PRIV-5:
 * "Private access is limited to its author and explicitly selected people").
 *
 * The selection lives in `trip_plan_item_audience` (migration 3727). No client role holds any privilege on it;
 * the one writer is the SQL function `trip_plan_item_audience_replace`, which the API calls as service_role for
 * the plan's AUTHOR and which re-checks, inside one transaction with the item row locked, that the actor is the
 * creator, the item is live and already scoped `selected_participants`, and every selected person is an accepted
 * member of the trip and not the author. The checks here run first so a caller gets a precise 422 before
 * anything is written; the function is what holds if they race.
 *
 * WRITE ORDER (why there is no window wider than both ends). A scope that CHANGES clears the selection (3727's
 * trip_plan_items_clear_audience), so a plan entering `selected_participants` starts with an EMPTY selection —
 * its creator's alone — and the author's list is written after. Every intermediate state is no wider than the
 * state before and the state after. A failed selection write leaves the plan its creator's alone (fail closed),
 * and the route says so.
 *
 * An absent table (3727 unapplied) is not a failure for a READER: no selection can exist, and "none" is exact.
 * For a WRITER it means the scope cannot be honoured, and the door keeps §90's 422.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isAbsentTableError } from "../../lib/absentTableError.js";

export const PLAN_ITEM_AUDIENCE_TABLE = "trip_plan_item_audience";
export const PLAN_ITEM_AUDIENCE_MAX = 50;

export type SelectionStore = "available" | "absent" | "unread";

/** Does the selection store exist and answer? Read once per write that names `selected_participants`. */
export async function selectionStoreState(sc: SupabaseClient): Promise<SelectionStore> {
  try {
    const { error } = await sc.from("trip_plan_item_audience").select("plan_item_id").limit(1);
    if (!error) return "available";
    return isAbsentTableError(error) ? "absent" : "unread";
  } catch {
    return "unread";
  }
}

/** The plan items on this trip whose author selected `viewerId`. `null` = the read failed (fail closed). */
export async function readSelectedPlanItemIds(sc: SupabaseClient, tripId: string, viewerId: string): Promise<Set<string> | null> {
  try {
    const { data, error } = await sc
      .from("trip_plan_item_audience")
      .select("plan_item_id")
      .eq("trip_id", tripId)
      .eq("member_id", viewerId);
    if (error) return isAbsentTableError(error) ? new Set() : null;
    return new Set(((data ?? []) as Array<{ plan_item_id: string }>).map((r) => String(r.plan_item_id)));
  } catch {
    return null;
  }
}

/** Who the author selected for one plan. For the AUTHOR's own answer only (the routes check). */
export async function readPlanItemAudience(sc: SupabaseClient, planItemId: string): Promise<string[] | null> {
  const { data, error } = await sc.from("trip_plan_item_audience").select("member_id").eq("plan_item_id", planItemId);
  if (error) return isAbsentTableError(error) ? [] : null;
  return [...new Set(((data ?? []) as Array<{ member_id: string }>).map((r) => String(r.member_id)))].sort();
}

export type AudienceCheck =
  | { ok: true; memberIds: string[] }
  | { ok: false; status: 422 | 503; reason: string; message: string };

/**
 * The checks before a selection is written: the list is de-duplicated, not empty, at most 50, never the author,
 * and every id an accepted member of the trip (`acceptedMembers`, read with requireTripMember's rule; null = the
 * read failed).
 */
export function checkAudience(authorId: string, memberIds: readonly string[], acceptedMembers: ReadonlySet<string> | null): AudienceCheck {
  const ids = [...new Set(memberIds)].sort();
  if (ids.length === 0) {
    return { ok: false, status: 422, reason: "TRIP_PLAN_AUDIENCE_REQUIRED", message: "Choose at least one person to share this plan with, or make it private." };
  }
  if (ids.length > PLAN_ITEM_AUDIENCE_MAX) {
    return { ok: false, status: 422, reason: "TRIP_PLAN_AUDIENCE_TOO_LARGE", message: `A plan can be shared with at most ${PLAN_ITEM_AUDIENCE_MAX} people.` };
  }
  if (acceptedMembers === null) {
    return { ok: false, status: 503, reason: "TRIP_PLAN_AUDIENCE_UNCHECKABLE", message: "We could not check who is on this trip right now. Please try again shortly." };
  }
  if (ids.some((id) => id === authorId || !acceptedMembers.has(id))) {
    return { ok: false, status: 422, reason: "TRIP_PLAN_AUDIENCE_NOT_CREW", message: "You can only share a plan with other people on this trip." };
  }
  return { ok: true, memberIds: ids };
}

export type AudienceWrite = { ok: true; count: number } | { ok: false; reason: string };

/** Replace the selection atomically (3727's function). Every failure is named; none is "zero people". */
export async function replacePlanItemAudience(sc: SupabaseClient, planItemId: string, actorId: string, memberIds: readonly string[]): Promise<AudienceWrite> {
  try {
    const { data, error } = await sc.rpc("trip_plan_item_audience_replace", { p_item_id: planItemId, p_actor_id: actorId, p_member_ids: [...memberIds] });
    if (error) {
      const m = /TRIP_PLAN_AUDIENCE_[A-Z_]+/.exec(String((error as { message?: unknown }).message ?? ""));
      return { ok: false, reason: m ? m[0] : "TRIP_PLAN_AUDIENCE_NOT_SAVED" };
    }
    return { ok: true, count: typeof data === "number" ? data : memberIds.length };
  } catch {
    return { ok: false, reason: "TRIP_PLAN_AUDIENCE_NOT_SAVED" };
  }
}

export type ScopeGate =
  | { ok: true; memberIds: string[] | null }
  | { ok: false; status: 422 | 503; body: Record<string, unknown> };

/**
 * The write door's decision for a plan that will carry `scope` after this write (census-trips §94).
 *   - `memberIds` named for a plan that will NOT be `selected_participants` → 422 (a list nobody would honour);
 *   - not `selected_participants` → nothing to write;
 *   - the store absent (3727 unapplied) → §90's 422 TRIP_PRIVACY_SCOPE_NOT_ENFORCED, unchanged; unread → 503;
 *   - `memberIds` absent while `required` (the scope is being ENTERED) → 422: entering the scope without naming
 *     anyone would promise a sharing that does not exist;
 *   - otherwise the list must pass checkAudience.
 */
export async function selectedScopeGate(
  sc: SupabaseClient,
  scope: unknown,
  memberIds: readonly string[] | undefined,
  authorId: string,
  required: boolean,
  readAccepted: () => Promise<Set<string> | null>,
  refusalBody: (store: SelectionStore) => Record<string, unknown> | null,
): Promise<ScopeGate> {
  if (scope !== "selected_participants") {
    if (memberIds !== undefined) {
      return { ok: false, status: 422, body: { error: "invalid_payload", reason: "TRIP_PLAN_AUDIENCE_SCOPE_MISMATCH", message: "People can only be chosen for a plan shared with selected people." } };
    }
    return { ok: true, memberIds: null };
  }
  const store = await selectionStoreState(sc);
  if (store === "unread") {
    return { ok: false, status: 503, body: { error: "degraded_unavailable", reason: "TRIP_PLAN_AUDIENCE_UNREADABLE", message: "Sharing with selected people is unavailable right now. Please try again shortly." } };
  }
  const refusal = refusalBody(store);
  if (refusal) return { ok: false, status: 422, body: refusal };
  if (memberIds === undefined) {
    if (!required) return { ok: true, memberIds: null };
    return { ok: false, status: 422, body: { error: "invalid_payload", reason: "TRIP_PLAN_AUDIENCE_REQUIRED", message: "Choose at least one person to share this plan with, or make it private." } };
  }
  const checked = checkAudience(authorId, memberIds, await readAccepted());
  if (!checked.ok) return { ok: false, status: checked.status, body: { error: checked.status === 503 ? "degraded_unavailable" : "invalid_payload", reason: checked.reason, message: checked.message } };
  return { ok: true, memberIds: checked.memberIds };
}
