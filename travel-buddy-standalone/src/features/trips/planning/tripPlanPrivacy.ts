/**
 * §6.3 on the client — who can see a plan (census-trips TR116).
 *
 * WHAT WAS TRUE BEFORE THIS FILE
 * ==============================
 * `trip_plan_items.privacy_scope` has §6.3's six values (2770), the plan
 * routes take an optional `privacyScope` on create and on patch
 * (routes/trips.ts), every plan reader enforces it through one rule
 * (privateAnchorAccess.ts), and GET /trips/:tripId/plan serves it on every
 * item. The app never wrote or read it: a traveller could not see who a plan
 * was visible to, nor change it. This file is the client half — the
 * vocabulary, the reader, the writer — and TripPlanPrivacyCard is its surface.
 *
 * THE READ HAS THREE ANSWERS, NOT TWO
 * ===================================
 * The server sends `privacyScope: null` when the column was NOT READ (a
 * database without 2770). That is not `crew`: `readPrivacyScope` returns null
 * for it and for any value outside the six, and the card says "not known"
 * rather than guessing an audience nobody looked up.
 *
 * WHAT IS OFFERED, AND WHY NOT ALL SIX
 * ====================================
 * Every one of the six is READ and named. Three are offered to SET:
 *   private  the author alone — enforced by every reader.
 *   crew     the trip's accepted crew.
 *   public   anyone who can see the trip's public plan.
 * Not offered:
 *   selected_participants  needs the author's own selection of people, which
 *                          this surface does not collect, and the server
 *                          refuses it (422) until 3727's selection store exists.
 *   friends_nearby         unmodelled beyond the crew (§90.5): offering it would
 *                          promise an audience no reader enforces.
 *   trip                   admits exactly the crew on every reader today, so
 *                          offering it beside `crew` would show a difference
 *                          that does not exist.
 *
 * THE ONLY WRITE IS THE PLAN ROUTE
 * ================================
 * PATCH /trips/:tripId/plan/items/:itemId with `{ privacyScope }`. The server
 * derives `visibility` from the scope and applies the owner's narrow-only rule
 * (OD-1012-PRIV-5) for anyone who is not the author; a refusal comes back by
 * name and is shown, never swallowed. A 503 (for example a database without
 * 2770) is `unavailable`: nothing was changed, and the same write may be retried.
 */
import { readTripJson, sendTripWrite, type ApiRead } from '../shared/tripApi.ts';

/** §6.3's six, in 2770's order — the server's TRIP_PLAN_PRIVACY_SCOPES, character for character. */
export const TRIP_PLAN_PRIVACY_SCOPES = ['private', 'selected_participants', 'crew', 'friends_nearby', 'trip', 'public'] as const;
export type TripPlanPrivacyScope = (typeof TRIP_PLAN_PRIVACY_SCOPES)[number];

/** The scopes this app lets a traveller choose. See the header for the three it does not. */
export const OFFERED_PRIVACY_SCOPES = ['private', 'crew', 'public'] as const satisfies readonly TripPlanPrivacyScope[];

export const PRIVACY_SCOPE_LABEL: Record<TripPlanPrivacyScope, string> = {
  private: 'Only me',
  selected_participants: 'People I chose',
  crew: 'Trip crew',
  friends_nearby: 'Friends nearby',
  trip: 'Everyone on the trip',
  public: 'Public',
};

export function isTripPlanPrivacyScope(value: unknown): value is TripPlanPrivacyScope {
  return typeof value === 'string' && (TRIP_PLAN_PRIVACY_SCOPES as readonly string[]).includes(value);
}

/** An item's §6.3 scope as the server served it, or null: NOT READ, never a default. */
export function readPrivacyScope(item: unknown): TripPlanPrivacyScope | null {
  if (!item || typeof item !== 'object' || !('privacyScope' in item)) return null;
  const v = (item as { privacyScope?: unknown }).privacyScope;
  return isTripPlanPrivacyScope(v) ? v : null;
}

export interface OwnPlanItem {
  id: string;
  title: string;
  scope: TripPlanPrivacyScope | null;
}

function field(item: unknown, key: string): unknown {
  return item && typeof item === 'object' && key in item ? (item as Record<string, unknown>)[key] : undefined;
}

/**
 * The plans on this trip the VIEWER added, with their scope. Only the author's
 * own: anyone else may only narrow a plan's audience, and this surface does not
 * offer that.
 */
export async function readOwnPlanScopes(tripId: string, viewerId: string): Promise<ApiRead<OwnPlanItem[]>> {
  const r = await readTripJson<{ items: unknown[] }>(
    `/api/trips/${tripId}/plan`,
    (b) => Boolean(b) && typeof b === 'object' && Array.isArray((b as { items?: unknown }).items),
  );
  if (r.state !== 'ok') return r;
  const out: OwnPlanItem[] = [];
  for (const item of r.data.items) {
    const id = field(item, 'id');
    if (typeof id !== 'string' || field(item, 'creatorId') !== viewerId) continue;
    const title = field(item, 'title');
    out.push({ id, title: typeof title === 'string' ? title : '', scope: readPrivacyScope(item) });
  }
  return { state: 'ok', data: out };
}

export type ScopeWrite =
  | { state: 'saved'; scope: TripPlanPrivacyScope | null }
  | { state: 'refused'; status: number; reason: string; detail: string }
  | { state: 'unavailable'; detail: string };

/** Set one plan's scope. `saved.scope` is what the SERVER answered, read the same way as the list. */
export async function setPlanItemPrivacyScope(tripId: string, itemId: string, scope: string): Promise<ScopeWrite> {
  if (!isTripPlanPrivacyScope(scope)) {
    return { state: 'refused', status: 0, reason: 'LOCAL_INVALID', detail: 'pick one of the offered options' };
  }
  const w = await sendTripWrite<unknown>('PATCH', `/api/trips/${tripId}/plan/items/${itemId}`, { privacyScope: scope });
  if (w.state === 'done') return { state: 'saved', scope: readPrivacyScope(w.data) };
  return w;
}
