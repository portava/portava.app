/**
 * Invisible mode on Telegraph's AVAILABILITY surfaces (§4.3 / §4.4).
 *
 * §4.3: "Invisible mode suppresses Nearby/Bump/public availability while
 * allowing private Map use." `lib/invisibleMode.ts` is the one definition of
 * invisible, and it names `public_availability` as a suppressed surface. Nearby
 * applied it (services/telegraph/reachablePeople.ts, `availabilitySuppressed`),
 * and Discovery's people search applies it (lib/discoveryPeoplePrivacy.ts). Two
 * Telegraph surfaces that show another person's availability windows did NOT:
 *
 *   GET /threads/:id/conversation-header   the header's AVAILABLE chip
 *                                          (routes/telegraphSharedContext.ts)
 *   Compass getParticipantAvailability     (compass/TelegraphConversationTools.ts)
 *
 * so a person who paused sharing, turned location off, or set discovery to
 * "nobody" vanished from Nearby and still had "free until 22:00 — coffee" shown
 * beside their name in every conversation and handed to Compass. Both now ask
 * this module first, and an invisible owner's windows are withheld exactly as an
 * absent window is: the surface says nothing, which is what it says for anyone
 * who is not sharing, so it does not disclose that the person went invisible.
 *
 * ── WHICH CLIENT ────────────────────────────────────────────────────────────
 * The consent row is another person's, so it is read with the SERVICE client.
 * Through a viewer's RLS client the read returns no rows rather than an error,
 * and "no row" reads as visible — the fail-open this module exists to prevent.
 * A caller that already holds the service client (Compass's tools) passes it;
 * a caller holding only the viewer's client (the header route) passes nothing
 * and this module takes the service client itself. No service client is an
 * unknown, not an absence.
 *
 * ── FAIL DIRECTION ─────────────────────────────────────────────────────────
 * An unreadable consent read answers `null`: the caller withholds EVERY
 * owner's availability. "We could not check whether they are invisible" is
 * never "they are visible". An owner with no `location_preferences` row is
 * visible — the column defaults are the discoverable ones, and that is the
 * reading resolveInvisibleMode, Nearby and Discovery all take.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveInvisibleMode, suppressesSurface } from "../../lib/invisibleMode.js";
import { getServiceClient } from "../../lib/supabase.js";

/** The surface name `lib/invisibleMode.ts` suppresses for an invisible person. */
export const AVAILABILITY_SURFACE = "public_availability";

interface ConsentRow {
  user_id?: unknown;
  location_mode?: string | null;
  sharing_paused?: boolean | null;
  discovery_visibility?: string | null;
}

/**
 * The owners among `ownerIds` whose availability invisible mode withholds, or
 * `null` when that cannot be established (the caller then withholds them all).
 */
export async function availabilityWithheldOwners(
  ownerIds: readonly string[],
  serviceClient?: SupabaseClient | null,
): Promise<ReadonlySet<string> | null> {
  const ids = [...new Set(ownerIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return new Set<string>();
  const sc: SupabaseClient | null = serviceClient === undefined ? getServiceClient() : serviceClient;
  if (!sc) return null;
  let rows: unknown;
  try {
    const { data, error } = await sc
      .from("location_preferences")
      .select("user_id, location_mode, sharing_paused, discovery_visibility")
      .in("user_id", ids);
    if (error) return null;
    rows = data;
  } catch {
    return null;
  }
  const byId = new Map<string, ConsentRow>();
  for (const r of (Array.isArray(rows) ? rows : []) as ConsentRow[]) {
    if (r && typeof r.user_id === "string") byId.set(r.user_id, r);
  }
  const withheld = new Set<string>();
  for (const id of ids) {
    const state = resolveInvisibleMode({ prefs: byId.get(id) ?? null, prefsError: null });
    if (suppressesSurface(state, AVAILABILITY_SURFACE)) withheld.add(id);
  }
  return withheld;
}

/**
 * Drop the availability of every invisible owner from a per-person list, for
 * a caller that has already built one. An unreadable consent read empties every
 * entry's windows: nothing about anyone's availability is shown on a guess.
 */
export async function withholdInvisibleAvailability<T extends { userId: string; windows: readonly unknown[] }>(
  entries: readonly T[],
  serviceClient?: SupabaseClient | null,
): Promise<{ entries: T[]; withheldForUnknown: boolean }> {
  const withheld = await availabilityWithheldOwners(entries.map((e) => e.userId), serviceClient);
  if (withheld === null) return { entries: entries.map((e) => ({ ...e, windows: [] })), withheldForUnknown: true };
  return { entries: entries.map((e) => (withheld.has(e.userId) ? { ...e, windows: [] } : e)), withheldForUnknown: false };
}

/**
 * Lead ruling P-T1 (2026-10-07) for a surface about ONE owner: is that owner's
 * availability withheld from other viewers? An unreadable consent read answers
 * true — withheld — never "visible". Used by Passport, its consumer variants and
 * the shared-context facts (independent verification of lane T, finding F2).
 */
export async function ownerAvailabilityWithheld(
  ownerId: string,
  serviceClient?: SupabaseClient | null,
): Promise<boolean> {
  const withheld = await availabilityWithheldOwners([ownerId], serviceClient);
  return withheld === null || withheld.has(ownerId);
}
