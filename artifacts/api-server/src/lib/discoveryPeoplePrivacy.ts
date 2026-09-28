/**
 * discoveryPeoplePrivacy — the per-person privacy gates Discovery's PEOPLE
 * surfaces apply, in one place (census-discovery §53).
 *
 * Three things live here, each of which Discovery used to get wrong:
 *
 *  1. INVISIBLE MODE (census-discovery A24; Telegraph :621 — *"Unavailable or
 *     Invisible revokes Nearby, Discovery, and Compass availability projections
 *     promptly"*). `lib/invisibleMode.ts` is the one definition of Invisible and
 *     is fail-closed; Telegraph's reachable-people query and the Nearby route
 *     consume it. Discovery's people search read only
 *     `profile_privacy_settings.allow_profile_discovery`, so a person who had
 *     gone invisible — location off, sharing paused, or discovery visibility
 *     `nobody` — was still listed as a traveler, as a buddy, in the suggest
 *     People group, and on their Discovery person card. This module reads the
 *     three consent columns `resolveInvisibleMode` reads, from the same table,
 *     with the same select list as `services/telegraph/reachablePeopleQuery.ts`,
 *     and consumes the resolver rather than re-spelling it.
 *
 *     REVOCATION IS BOTH WAYS AND IMMEDIATE BECAUSE NOTHING IS CACHED. The read
 *     happens on every request that has a candidate; no result of it is kept.
 *     Going invisible hides the person on the next request, and coming back
 *     restores them on the next request — there is no TTL in either direction.
 *
 *     A FAILED READ HIDES EVERYONE IT COVERED AND SAYS SO. The reader returns
 *     `{ ok: false, relation }` and the route throws its DiscoverySearchReadError,
 *     which is what turns a withheld bucket into a named refusal (`type=all` and
 *     /discovery/suggest: `partial` naming the people bucket; a single-type
 *     search: `coverage: "nothing"`). Silence would be the `11` §9 masquerade;
 *     serving the candidates unchecked would publish presence nobody consented
 *     to. Neither happens.
 *
 *     THE VIEWER IS NEVER HIDDEN FROM THEMSELF. Invisible mode hides a person
 *     FROM OTHER PEOPLE (`lib/invisibleMode.ts`, "the second half is the
 *     requirement"). The viewer's own id is never read and never withheld.
 *
 *  2. THE DISCOVERY PERSON CARD gains the same gate, so the list and the card
 *     it opens cannot disagree (routes/discoverySearch.ts's own contract for
 *     that route: "the same subject the list withholds … is refused here").
 *
 *  3. THE COMMUNITY BYLINE AVATAR (`GET /discovery/community`, census-discovery
 *     §47.7). The byline's `avatarUrl` was served whatever
 *     `profiles.is_private` and `profiles.show_profile_picture_publicly` said.
 *     `lib/mediaFeedItem.ts` gates the same field on the media surfaces, and
 *     `communityBylineAvatar` below is that gate, term for term:
 *
 *         showAvatar = isOwn || isFollowing
 *                   || (!creatorIsPrivate && show_profile_picture_publicly !== false)
 *
 *     `is_private` absent reads as public and `show_profile_picture_publicly`
 *     absent reads as shown — the columns' defaults (false / true) — exactly as
 *     `Boolean(profile?.is_private)` and `!== false` read them there. A test
 *     runs both implementations over the same matrix and requires agreement.
 */
import { logger } from "./logger.js";
import { resolveInvisibleMode, suppressesSurface } from "./invisibleMode.js";
import type { ConsumerAccessDecision } from "../services/passport/PassportConsumerAccess.js";
import { readBuddyEligibility, type BuddyAsk } from "./discoveryPeopleBuddy.js";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Invisible mode
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The surface name handed to `suppressesSurface`. `lib/invisibleMode.ts` does
 * not list Discovery among its surfaces, and an unknown surface is treated as
 * OUTBOUND there (fail-closed) — which is the correct reading of a people
 * search: it publishes a person to other people. Named rather than inlined so
 * the one place a future edit of that list must look is obvious.
 */
export const DISCOVERY_PEOPLE_SURFACE = "discovery_people";

/** The consent row `resolveInvisibleMode` reads. */
interface LocationConsentRow {
  user_id: string;
  location_mode?: string | null;
  sharing_paused?: boolean | null;
  discovery_visibility?: string | null;
}

export type DiscoveryInvisibleRead =
  | { ok: true; hidden: ReadonlySet<string> }
  | { ok: false; relation: "location_preferences"; error: unknown };

/**
 * Which of `candidateIds` are invisible to `viewerId`.
 *
 * An ABSENT row is the product default (location_mode 'city', discovery
 * visibility 'everyone'), which is visible — the reading `resolveInvisibleMode`
 * gives `prefs: null` with no error, and the reading mapTravelers and the
 * reachable-people query give it. A row that could not be READ is not absent:
 * the whole read is reported unreadable, and the caller withholds everyone it
 * covered.
 */
export async function readDiscoveryInvisiblePeople(
  sc: any,
  candidateIds: readonly string[],
  viewerId: string | null,
): Promise<DiscoveryInvisibleRead> {
  const others = [...new Set(candidateIds)].filter((id) => Boolean(id) && id !== viewerId);
  if (others.length === 0) return { ok: true, hidden: new Set() };

  let rows: unknown;
  try {
    const { data, error } = await sc
      .from("location_preferences")
      .select("user_id, location_mode, sharing_paused, discovery_visibility")
      .in("user_id", others);
    if (error) return { ok: false, relation: "location_preferences", error };
    rows = data;
  } catch (error) {
    return { ok: false, relation: "location_preferences", error: error ?? new Error("read rejected") };
  }

  const byId = new Map<string, LocationConsentRow>();
  for (const r of (Array.isArray(rows) ? rows : []) as LocationConsentRow[]) {
    if (r && typeof r.user_id === "string") byId.set(r.user_id, r);
  }
  const hidden = new Set<string>();
  for (const id of others) {
    const state = resolveInvisibleMode({ prefs: byId.get(id) ?? null, prefsError: null });
    if (suppressesSurface(state, DISCOVERY_PEOPLE_SURFACE)) hidden.add(id);
  }
  return { ok: true, hidden };
}

// ─────────────────────────────────────────────────────────────────────────────
// The people gate searchTravelers applies — Invisible for everyone, and the
// Buddy eligibility legs (lib/discoveryPeopleBuddy.ts) for the buddy role.
// ─────────────────────────────────────────────────────────────────────────────

export type DiscoveryPeopleGate =
  | { ok: true; withheld: ReadonlySet<string> }
  | { ok: false; relation: string; error: unknown };

/**
 * `buddyAsk` null ⇒ the traveler role (Invisible only). Non-null ⇒ the buddy
 * role: Invisible AND buddy eligibility. The two reads run in parallel; the
 * first unreadable one, in that order, is what the caller reports.
 */
export async function readDiscoveryPeopleGate(
  sc: any,
  candidateIds: readonly string[],
  viewerId: string,
  buddyAsk: BuddyAsk | null,
): Promise<DiscoveryPeopleGate> {
  const [invisible, buddy] = await Promise.all([
    readDiscoveryInvisiblePeople(sc, candidateIds, viewerId),
    buddyAsk ? readBuddyEligibility(sc, candidateIds, buddyAsk) : Promise.resolve(null),
  ]);
  if (!invisible.ok) return { ok: false, relation: invisible.relation, error: invisible.error };
  if (buddy && !buddy.ok) return { ok: false, relation: buddy.relation, error: buddy.error };
  if (!buddy || buddy.ineligible.size === 0) return { ok: true, withheld: invisible.hidden };
  const withheld = new Set<string>(invisible.hidden);
  for (const id of buddy.ineligible.keys()) withheld.add(id);
  return { ok: true, withheld };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The Discovery person card
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shared Passport gate's decision (`allowDiscoveryPersonCard`: opt-out,
 * age restriction) is taken as an argument — the route keeps calling the
 * shared gate itself, where census-discovery cites it — and Invisible is
 * applied on top. The subject viewing their own card is exempt through the
 * reader's own rule (it never reads or withholds the viewer), so the
 * self-exemption lives in ONE place: a second copy here was an equivalent
 * mutant — deleting it changed nothing any test or caller could observe.
 * An unreadable Invisible state is `check_failed`, which the route answers
 * as a retryable failure rather than as "not found": a failed read is not
 * evidence that the person does not exist.
 */
export async function withDiscoveryInvisibleGate(
  sc: any,
  subjectId: string,
  viewerId: string,
  shared: ConsumerAccessDecision,
): Promise<ConsumerAccessDecision> {
  if (!shared.allowed) return shared;
  const inv = await readDiscoveryInvisiblePeople(sc, [subjectId], viewerId);
  if (!inv.ok) {
    logger.warn({ relation: inv.relation }, "discovery person card: invisible state unreadable — refusing, not publishing");
    return { allowed: false, reason: "check_failed" };
  }
  return inv.hidden.has(subjectId) ? { allowed: false, reason: "not_discoverable" } : shared;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The community byline avatar
// ─────────────────────────────────────────────────────────────────────────────

/** The byline embed columns the avatar gate reads. */
export interface BylineProfile {
  id: string;
  avatar_url?: string | null;
  is_private?: boolean | null;
  show_profile_picture_publicly?: boolean | null;
}

/**
 * `lib/mediaFeedItem.ts`'s avatar gate, for one byline. `viewerId` null is an
 * anonymous caller: nobody's own item, nobody followed.
 */
export function communityBylineAvatar(
  profile: BylineProfile,
  viewerId: string | null,
  followed: ReadonlySet<string>,
): string | null {
  const creatorId = profile.id;
  const isOwnItem = viewerId !== null && creatorId === viewerId;
  const isFollowing = followed.has(creatorId);
  const creatorIsPrivate = Boolean(profile.is_private);
  const showAvatar =
    isOwnItem ||
    isFollowing ||
    (!creatorIsPrivate && profile.show_profile_picture_publicly !== false);
  return showAvatar ? (profile.avatar_url ?? null) : null;
}

/** True when this byline's avatar depends on whether the viewer follows its author. */
function avatarNeedsFollowEdge(p: BylineProfile, viewerId: string | null): boolean {
  if (viewerId !== null && p.id === viewerId) return false;
  if (!p.avatar_url) return false;
  return Boolean(p.is_private) || p.show_profile_picture_publicly === false;
}

/**
 * The follow edges the avatar gate needs, and ONLY those: a read is issued
 * only when some byline is private or opted out, has an avatar, and is not the
 * viewer's own — so the common page issues no extra round trip.
 *
 * FAIL-CLOSED: an unreadable `user_follows` grants no edge, so the only effect
 * of an outage is that a follower sees the privacy-preserving byline a
 * stranger sees. Nothing is revealed that the columns withhold. It is logged;
 * it is not a refusal, because every item in the response is still real and
 * complete in every field but a withheld picture.
 */
export async function readBylineFollowEdges(
  sc: any,
  viewerId: string | null,
  profiles: ReadonlyArray<BylineProfile | null | undefined>,
): Promise<ReadonlySet<string>> {
  if (!viewerId) return new Set();
  const need = [...new Set(
    profiles.filter((p): p is BylineProfile => Boolean(p && p.id) && avatarNeedsFollowEdge(p as BylineProfile, viewerId))
      .map((p) => p.id),
  )];
  if (need.length === 0) return new Set();
  try {
    const { data, error } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", viewerId)
      .in("following_id", need);
    if (error) {
      logger.warn({ err: error }, "discovery/community: follow edges unreadable — private avatars withheld");
      return new Set();
    }
    return new Set<string>(((data as any[]) ?? []).map((r) => String(r.following_id)));
  } catch (err) {
    logger.warn({ err }, "discovery/community: follow edges read rejected — private avatars withheld");
    return new Set();
  }
}

/** First profile of a PostgREST embed, which arrives as an object or a one-element array. */
export function bylineProfileOf(row: { profiles?: unknown }): BylineProfile | null {
  const p = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
  return p && typeof p === "object" && typeof (p as any).id === "string" ? (p as BylineProfile) : null;
}
