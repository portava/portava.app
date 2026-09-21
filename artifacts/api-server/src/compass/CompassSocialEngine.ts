/**
 * CompassSocialEngine — Phase 9 social intelligence.
 *
 * Three capabilities, all privacy-first:
 *   1. "Who's around" — circle/trip/event presence surfaced to Compass through
 *      the SAME permission gate the Circle UI uses (canViewCirclePresence):
 *      approximate-area granularity only, honoring visibility overrides,
 *      pauses, consent, blocks, and account restrictions. No coordinates, no
 *      needs_help flag, no precise location — ever.
 *   2. Travel compatibility — a deterministic score between the viewer and a
 *      person they share a Circle or trip with. Only the OVERLAP (shared
 *      interests/styles/languages) is revealed — never the other person's full
 *      preference list.
 *   3. Group aggregation — merges every member's preferences and constraints
 *      into a single ranking profile (most-restrictive budget, union of
 *      blocks, the youngest age the group is KNOWN to be, all-verified flag)
 *      so group recommendations satisfy everyone.
 *
 * Display-name rule: people are referred to by @handle unless they opted in
 * (profile_privacy_settings.show_real_name) — resolved by callers via
 * nameVisibilitySet.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassProfile } from "./types.js";
import {
  canViewCirclePresenceBatch,
  canBeSeenByViewersBatch,
  type ContextType,
} from "../lib/circleAccessGuard.js";
// census-compass CTG-08 — §30A.1 "canonical relationship model; no independent
// inference". `sharesSocialContext` below used to be a FOURTH relationship
// resolver with its own vocabulary; it now consumes the canonical one and this
// file infers no relationship of its own. See the function's header.
import {
  resolveInteractionPermissions,
  type RelationshipLabel,
} from "../services/interactionPermissions.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { wrapUgc } from "./CompassStructuredContext.js";
// The ONE place a date of birth becomes an age a gate may act on. This file
// used to carry its own `ageFromDob()` and is the ninth gate that copy fed;
// it now consumes an already-RESOLVED `GateAge` and does no age arithmetic.
import type { GateAge } from "../lib/gateAge.js";

// ── Travel compatibility ──────────────────────────────────────────────────────

export interface CompatibilityPrefs {
  interests: string[];
  travelStyles: string[];
  budgetStyle: string | null;
  travelPace: string | null;
  languages: string[];
}

export interface CompatibilityResult {
  /** 0–100 deterministic compatibility score. */
  score: number;
  /** Only the OVERLAP is ever revealed — never the other person's full lists. */
  sharedInterests: string[];
  sharedStyles: string[];
  sharedLanguages: string[];
  budgetAlignment: "same" | "compatible" | "different" | "unknown";
  paceAlignment: "same" | "different" | "unknown";
  factors: string[];
}

const BUDGET_ORDER: Record<string, number> = { budget: 0, "mid-range": 1, luxury: 2 };

function norm(list: unknown): string[] {
  return Array.isArray(list)
    ? [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean))]
    : [];
}

function overlap(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

/**
 * Deterministic travel-compatibility score. Pure — no IO, no randomness.
 * Baseline 40; overlap in interests/styles/budget/pace/languages adds up.
 */
export function computeTravelCompatibility(
  a: CompatibilityPrefs,
  b: CompatibilityPrefs,
): CompatibilityResult {
  const ia = norm(a.interests), ib = norm(b.interests);
  const sa = norm(a.travelStyles), sb = norm(b.travelStyles);
  const la = norm(a.languages), lb = norm(b.languages);

  const sharedInterests = overlap(ia, ib);
  const sharedStyles    = overlap(sa, sb);
  const sharedLanguages = overlap(la, lb);

  let score = 40;
  const factors: string[] = [];

  // Interests: up to +25 (jaccard-weighted)
  const iUnion = new Set([...ia, ...ib]).size;
  if (iUnion > 0 && sharedInterests.length > 0) {
    score += Math.round(25 * (sharedInterests.length / iUnion));
    factors.push(`shared interests: ${sharedInterests.slice(0, 5).join(", ")}`);
  }

  // Travel styles: up to +15
  const sUnion = new Set([...sa, ...sb]).size;
  if (sUnion > 0 && sharedStyles.length > 0) {
    score += Math.round(15 * (sharedStyles.length / sUnion));
    factors.push(`shared travel styles: ${sharedStyles.slice(0, 5).join(", ")}`);
  }

  // Budget: same +10, adjacent or flexible +5
  let budgetAlignment: CompatibilityResult["budgetAlignment"] = "unknown";
  const ba = a.budgetStyle?.toLowerCase() ?? null;
  const bb = b.budgetStyle?.toLowerCase() ?? null;
  if (ba && bb) {
    if (ba === bb) {
      budgetAlignment = "same"; score += 10; factors.push("same budget style");
    } else if (ba === "flexible" || bb === "flexible") {
      budgetAlignment = "compatible"; score += 5; factors.push("flexible budget match");
    } else if (
      ba in BUDGET_ORDER && bb in BUDGET_ORDER &&
      Math.abs(BUDGET_ORDER[ba] - BUDGET_ORDER[bb]) === 1
    ) {
      budgetAlignment = "compatible"; score += 5; factors.push("adjacent budget styles");
    } else {
      budgetAlignment = "different";
    }
  }

  // Pace: same +10
  let paceAlignment: CompatibilityResult["paceAlignment"] = "unknown";
  const pa = a.travelPace?.toLowerCase() ?? null;
  const pb = b.travelPace?.toLowerCase() ?? null;
  if (pa && pb) {
    paceAlignment = pa === pb ? "same" : "different";
    if (paceAlignment === "same") { score += 10; factors.push("same travel pace"); }
  }

  // Languages: any shared +5
  if (sharedLanguages.length > 0) {
    score += 5;
    factors.push(`shared languages: ${sharedLanguages.slice(0, 3).join(", ")}`);
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    sharedInterests,
    sharedStyles,
    sharedLanguages,
    budgetAlignment,
    paceAlignment,
    factors,
  };
}

// ── Group aggregation ─────────────────────────────────────────────────────────

export interface GroupMemberPrefs {
  userId: string;
  handle: string | null;
  interests: string[];
  travelStyles: string[];
  budgetStyle: string | null;
  travelPace: string | null;
  verified: boolean;
  /**
   * The member's age AS A GATE MAY ACT ON IT, resolved through `lib/gateAge.ts`
   * by the caller that read the profile row.
   *
   * NOT a `number | null`. The number lives only on the `ok` arm of `GateAge`,
   * so `aggregateGroupPreferences` cannot reach it without first having written
   * something for `verified_minor` and for `unreadable` — which is the whole
   * reason the seam's return type is a union. The previous shape (a plain
   * `age: number | null` filled in from `profiles.date_of_birth`) is exactly
   * how a provider-verified minor's typed adult birthday reached
   * `eventSatisfiesGroup` and passed an 18+ event for the whole group.
   */
  ageGate: GateAge;
}

export interface GroupAggregate {
  size: number;
  /** Interests shared by EVERY member (strong signal). */
  sharedInterests: string[];
  /** Union of all members' interests, most-common first (soft signal). */
  interestUnion: string[];
  /** Most restrictive concrete budget across members (flexible ignored). */
  budgetStyle: string | null;
  travelStyleUnion: string[];
  allVerified: boolean;
  /**
   * The youngest age the whole group is KNOWN to be, or null.
   *
   * null means "this group has no age an age gate may act on" — because a
   * member is a provider-verified minor, because the verification table could
   * not be read, or because a member simply has no date of birth on file. The
   * three are deliberately indistinguishable HERE: the aggregate is shared with
   * the whole group, and "which of your friends failed the check, and why" is
   * not a fact this structure is allowed to carry. `eventSatisfiesGroup` turns
   * null into a refusal.
   */
  youngestAge: number | null;
}

export function aggregateGroupPreferences(members: GroupMemberPrefs[]): GroupAggregate {
  const size = members.length;
  const interestLists = members.map((m) => norm(m.interests));
  const counts = new Map<string, number>();
  for (const list of interestLists) for (const i of list) counts.set(i, (counts.get(i) ?? 0) + 1);

  const interestUnion = [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([k]) => k);
  const sharedInterests = interestUnion.filter((i) => counts.get(i) === size && size > 1);

  // Most restrictive (lowest) concrete budget; "flexible" never restricts.
  let budgetStyle: string | null = null;
  for (const m of members) {
    const b = m.budgetStyle?.toLowerCase() ?? null;
    if (!b || !(b in BUDGET_ORDER)) continue;
    if (budgetStyle === null || BUDGET_ORDER[b] < BUDGET_ORDER[budgetStyle]) budgetStyle = b;
  }

  const travelStyleUnion = [...new Set(members.flatMap((m) => norm(m.travelStyles)))];
  const allVerified = size > 0 && members.every((m) => m.verified === true);
  // AGE. A member contributes a number ONLY from the `ok` arm of their resolved
  // GateAge: `verified_minor` (a provider result on file contradicts the typed
  // birthday) and `unreadable` (the check could not run — an OUTAGE, never a
  // statement about that person) contribute nothing, and neither does an `ok`
  // member with no date of birth on file.
  //
  // And a member who contributes nothing makes the GROUP's youngest age null,
  // rather than being skipped so the next-youngest member stands in for them.
  // Skipping is what made this a defect worth fixing: a group of {adult 30,
  // verified minor} would otherwise aggregate to youngestAge 30 and walk into
  // an `age_min: 18` event with the minor in it. Null is the answer that
  // `eventSatisfiesGroup` refuses, and refusing a group because one member's
  // age is unknown is the posture `eventSatisfiesGroup` already claimed to have.
  const knownAges: number[] = [];
  let anyMemberUnresolved = false;
  for (const m of members) {
    const resolved = m.ageGate;
    if (resolved.state === "ok" && typeof resolved.age === "number") knownAges.push(resolved.age);
    else anyMemberUnresolved = true;
  }
  const youngestAge = !anyMemberUnresolved && knownAges.length > 0 ? Math.min(...knownAges) : null;

  return { size, sharedInterests, interestUnion, budgetStyle, travelStyleUnion, allVerified, youngestAge };
}

/**
 * Build a synthetic CompassProfile representing the WHOLE group for the
 * ranking pipeline: shared interests weighted first, most-restrictive budget,
 * union of everyone's blocks/blockers (a person blocked by ANY member must
 * never influence or appear in a group answer), youngest known age for
 * age-gated eligibility.
 */
export function buildGroupRankingProfile(
  viewer: CompassProfile,
  agg: GroupAggregate,
  blockUnion: string[],
): CompassProfile {
  const profile: CompassProfile = {
    ...viewer,
    travelStyles: [...new Set([...agg.sharedInterests, ...agg.travelStyleUnion, ...agg.interestUnion])],
    budgetStyle: agg.budgetStyle ?? viewer.budgetStyle ?? null,
    blockedUserIds: [...new Set([...(viewer.blockedUserIds ?? []), ...blockUnion])],
    blockerUserIds: viewer.blockerUserIds ?? [],
    mutedUserIds: viewer.mutedUserIds ?? [],
  };
  if (agg.youngestAge !== null) profile.viewerAge = agg.youngestAge;
  // ...and when it is null, the GROUP has no age, so the group profile must not
  // keep carrying the VIEWER's own age (inherited by the spread above). An adult
  // viewer's 30 standing in for a group that contains a verified minor is the
  // same wrong number this change removed from `youngestAge`, one layer later.
  //
  // Deleting it rather than substituting a number: `viewerAge` is `number |
  // undefined` and every number here would be invented. Unset is the state both
  // downstream readers already define — CompassSafetyFilter applies its
  // conservative DEFAULT_VIEWER_AGE, CompassEligibilityEngine skips its
  // defence-in-depth check — and it is strictly more closed than the adult age
  // it replaces. It is NOT a full gate: the group's real age gate for events is
  // `eventSatisfiesGroup`, which has already refused every age-restricted
  // candidate before ranking sees it.
  else delete profile.viewerAge;
  return profile;
}

/** Group-level event constraints: capacity, age minimum, verification. */
export function eventSatisfiesGroup(
  ev: {
    max_attendees?: number | null;
    going_count?: number | null;
    age_min?: number | null;
    requires_verification?: boolean | null;
  },
  agg: GroupAggregate,
): { ok: boolean; reason?: string } {
  const cap = ev.max_attendees ?? null;
  if (cap !== null) {
    const going = Number(ev.going_count ?? 0);
    if (cap - going < agg.size) return { ok: false, reason: "not_enough_capacity_for_group" };
  }
  const ageMin = ev.age_min ?? null;
  if (ageMin !== null && ageMin > 0) {
    // Fail-closed for the group when any member's age is unknown or too low.
    //
    // The two refusals are reported SEPARATELY because they are different
    // sentences. "not met by all members" is a finding about ages we know;
    // "could not be confirmed" covers a verified-minor contradiction, an
    // unreadable identity_verifications read, and a member with no date of
    // birth on file, and says only that the check did not produce an answer.
    // Collapsing the second into the first would report an OUTAGE as a
    // statement about somebody in the group, which is precisely what
    // lib/gateAge.ts exists to stop. Neither reason names a member.
    if (agg.youngestAge === null) {
      return { ok: false, reason: "age_could_not_be_confirmed_for_every_member" };
    }
    if (agg.youngestAge < ageMin) {
      return { ok: false, reason: "age_restriction_not_met_by_all_members" };
    }
  }
  if (ev.requires_verification === true && !agg.allVerified) {
    return { ok: false, reason: "verification_required_not_all_members_verified" };
  }
  return { ok: true };
}

// `ageFromDob()` USED TO BE HERE, and it was this file's private copy of the
// un-contradicted arithmetic: a date of birth in, a number out, with the
// provider result never consulted. It is DELETED rather than left unused —
// a DOB→age helper sitting next to a gate is how the next gate skips the rule,
// which is how this defect reached nine gate families. The one implementation
// lives in `lib/ageEligibility.ts#calculateUserAge` and is reachable only
// through `lib/gateAge.ts`, which folds in the verified-minor contradiction
// before anyone sees a number. `src/test/ageGateSeamCoverage.test.ts` fails if
// a copy comes back.

// ── "Who's around" — permission-gated presence lookup ─────────────────────────

export interface WhosAroundEntry {
  /** @handle, or opted-in real name. */
  label: string;
  handle: string | null;
  status: string;
  /** UGC-wrapped user status text, or null. */
  statusLabel: string | null;
  /** Approximate area ONLY (visibility mode approximate_area). Never precise. */
  approximateArea: string | null;
  /** Venue label ONLY when the person explicitly checked in (venue_checkin mode). */
  venue: string | null;
  isStale: boolean;
  context: { type: ContextType; title: string };
}

interface ContextRef { type: ContextType; id: string; title: string }

async function activeContexts(sc: SupabaseClient, userId: string): Promise<ContextRef[]> {
  const out: ContextRef[] = [];
  try {
    const { data: memberRows } = await sc
      .from("trip_members")
      .select("trip_id, role, status")
      .eq("user_id", userId)
      .in("role", ["owner", "co_host", "member", "viewer"]);
    const tripIds = ((memberRows ?? []) as any[])
      .filter((r) => r.status == null || r.status === "accepted")
      .map((r) => r.trip_id as string);
    if (tripIds.length > 0) {
      const { data: trips } = await sc
        .from("trips")
        .select("id, title, destination_city, status")
        .in("id", tripIds)
        .in("status", ["active", "upcoming"]);
      for (const t of ((trips ?? []) as any[]).slice(0, 3)) {
        out.push({ type: "trip", id: t.id, title: String(t.title ?? t.destination_city ?? "Trip") });
      }
    }
  } catch { /* non-fatal */ }
  try {
    const cutoff = new Date(Date.now() - 6 * 3600_000).toISOString();
    const { data: rsvps } = await sc
      .from("event_rsvps")
      .select("event_id, status")
      .eq("user_id", userId)
      .eq("status", "going");
    const eventIds = ((rsvps ?? []) as any[]).map((r) => r.event_id as string);
    if (eventIds.length > 0) {
      const { data: events } = await sc
        .from("events")
        .select("id, title, starts_at")
        .in("id", eventIds)
        .gte("starts_at", cutoff)
        .order("starts_at", { ascending: true })
        .limit(3);
      for (const e of (events ?? []) as any[]) {
        out.push({ type: "event", id: e.id, title: String(e.title ?? "Event") });
      }
    }
  } catch { /* non-fatal */ }
  return out.slice(0, 5);
}

async function contextMemberIds(
  sc: SupabaseClient,
  ctx: ContextRef,
): Promise<string[]> {
  if (ctx.type === "trip") {
    const { data } = await sc
      .from("trip_members")
      .select("user_id, role, status")
      .eq("trip_id", ctx.id)
      .in("role", ["owner", "co_host", "member", "viewer"]);
    return ((data ?? []) as any[])
      .filter((r) => r.status == null || r.status === "accepted")
      .map((r) => r.user_id as string);
  }
  const [rsvpResult, attendeeResult] = await Promise.all([
    sc.from("event_rsvps").select("user_id").eq("event_id", ctx.id).eq("status", "going"),
    sc.from("event_attendees").select("user_id").eq("event_id", ctx.id),
  ]);
  const going = new Set(((rsvpResult.data ?? []) as any[]).map((r) => r.user_id as string));
  const att = new Set(((attendeeResult.data ?? []) as any[]).map((r) => r.user_id as string));
  return [...going].filter((id) => att.has(id));
}

/**
 * "Who's around" for Compass. Every target passes canViewCirclePresence —
 * the single Circle permission gate (consent, visibility mode, overrides,
 * pauses, blocks, restrictions). Hidden users (blocked/blocker/muted) are
 * removed BEFORE any presence lookup. Output is approximate-only; no
 * coordinates, no needs_help, no data beyond what the person chose to share.
 */
export async function getWhosAround(
  sc: SupabaseClient,
  viewerId: string,
  hidden: Set<string>,
): Promise<{ people: WhosAroundEntry[]; contextsChecked: number }> {
  const { found, contextsChecked } = await collectPresence(sc, viewerId, hidden);
  return { people: found.map((f) => f.entry).slice(0, 20), contextsChecked };
}

/**
 * One gated presence reading, with the two things `WhosAroundEntry` must NOT
 * carry to the model: the target's user id, and the raw presence row.
 *
 * This type is NOT exported. It exists because CT-12 needs the target id to ask
 * the second privacy question (can the target see the VIEWER?), and asking that
 * question about a person whose id had already been dropped would mean
 * re-deriving it — which is how a privacy-carrying identifier ends up being
 * looked up twice through two different gates.
 */
interface PresenceFinding {
  targetId: string;
  entry: WhosAroundEntry;
  ctx: ContextRef;
  /** The guard's staleness verdict, not the row's `is_stale` column. */
  isStale: boolean;
  /** ISO, from the row the guard already read. */
  lastSeenAt: string | null;
  staleAfterSecs: number | null;
  visibilityMode: string;
}

/**
 * The gated walk both "who's around" and CT-12's meetup opportunities rest on.
 *
 * Unchanged in every privacy respect from the `getWhosAround` body it was
 * extracted from: hidden users removed BEFORE any presence lookup, every target
 * through `canViewCirclePresenceBatch`, fail-closed per target, approximate
 * granularity only.
 */
async function collectPresence(
  sc: SupabaseClient,
  viewerId: string,
  hidden: Set<string>,
): Promise<{ found: PresenceFinding[]; contextsChecked: number }> {
  const contexts = await activeContexts(sc, viewerId);
  const found: PresenceFinding[] = [];
  const seenUsers = new Set<string>();

  for (const ctx of contexts) {
    let memberIds: string[] = [];
    try {
      memberIds = await contextMemberIds(sc, ctx);
    } catch { continue; }
    const targets = memberIds
      .filter((id) => id !== viewerId && !hidden.has(id) && !seenUsers.has(id))
      .slice(0, 20);
    if (targets.length === 0) continue;

    // Batched gate: one query per table for the whole context, same rules as
    // canViewCirclePresence. Fail-closed per target on any error.
    let accessById = new Map<string, { allowed: boolean }>();
    try {
      accessById = await canViewCirclePresenceBatch(sc, viewerId, targets, ctx.type, ctx.id);
    } catch {
      continue;
    }
    const results = targets.map((targetId) => ({
      targetId,
      access: accessById.get(targetId) ?? { allowed: false as const },
    }));

    const visible = results.filter((r) => r.access.allowed && (r.access as any).presenceRow);
    if (visible.length === 0) continue;

    const ids = visible.map((r) => r.targetId);
    const [{ data: profs }, allowedNames] = await Promise.all([
      sc.from("profiles").select("id, handle, name, display_name").in("id", ids),
      nameVisibilitySet(sc, ids),
    ]);
    const profById = new Map<string, any>();
    for (const p of (profs ?? []) as any[]) profById.set(p.id as string, p);

    for (const r of visible) {
      const row = (r.access as any).presenceRow as Record<string, any>;
      const mode = String((r.access as any).visibilityMode ?? "status_only");
      const p = profById.get(r.targetId) ?? {};
      const handle = p.handle ? `@${p.handle}` : null;
      const realName = allowedNames.has(r.targetId) ? (p.display_name ?? p.name ?? null) : null;
      const isStale = Boolean((r.access as any).isStale);

      found.push({
        targetId: r.targetId,
        ctx,
        isStale,
        lastSeenAt: row["last_seen_at"] ? String(row["last_seen_at"]) : null,
        staleAfterSecs:
          typeof row["stale_after_secs"] === "number" ? (row["stale_after_secs"] as number) : null,
        visibilityMode: mode,
        entry: {
          label: realName ?? handle ?? "A traveler",
          handle,
          status: String(row["status"] ?? "active"),
          statusLabel: row["status_label"] ? wrapUgc(String(row["status_label"])) : null,
          approximateArea:
            mode === "approximate_area" && row["approximate_label"]
              ? wrapUgc(String(row["approximate_label"]))
              : null,
          venue:
            mode === "venue_checkin" && row["checked_in"] && row["venue_label"]
              ? wrapUgc(String(row["venue_label"]))
              : null,
          isStale,
          context: { type: ctx.type, title: wrapUgc(ctx.title) },
        },
      });
      seenUsers.add(r.targetId);
    }
  }

  return { found, contextsChecked: contexts.length };
}

// ── CT-12: presence → a meetup OPPORTUNITY ────────────────────────────────────

/**
 * A suggested meeting occasion with someone nearby.
 *
 * census-compass CT-12 recorded that `get_whos_around` "is real and
 * privacy-correct … but produces presence, not an opportunity". This is the
 * step it names: an OCCASION, carrying WHY it is one and WHEN it holds — and it
 * exists only when BOTH parties' privacy allows it.
 *
 * Everything in here is derived from what the two people already chose to
 * share. There is no place, no time and no reason in this structure that was
 * not read off a gated presence row.
 */
export interface MeetupOpportunity {
  /** @handle, or the opted-in real name — exactly the label the gate allowed. */
  label: string;
  handle: string | null;
  /** The shared trip/event this meeting would happen inside. */
  context: { type: ContextType; title: string };
  /** The suggestion, phrased only from what they shared. */
  occasion: string;
  /** Where, at THEIR granularity. Null when they share only a status. */
  where: string | null;
  whereGranularity: "venue_checkin" | "approximate_area" | "none";
  /** WHY this is an occasion — each line a fact, not an inference. */
  why: string[];
  /**
   * WHEN. The window opens now and closes when their own sharing goes stale —
   * their setting, not a number this module chose. `null` when the row does not
   * state one, which is said rather than filled in.
   */
  when: { startsNow: true; expiresInMinutes: number | null; basis: string };
  reasonCodes: string[];
}

/** The occasion's window, from the sharer's own staleness setting. */
function meetupWindow(f: PresenceFinding, nowMs: number): MeetupOpportunity["when"] {
  const lastSeen = f.lastSeenAt ? Date.parse(f.lastSeenAt) : NaN;
  if (!Number.isFinite(lastSeen) || f.staleAfterSecs === null) {
    return {
      startsNow: true,
      expiresInMinutes: null,
      basis: "how long their sharing stays current is not stated",
    };
  }
  const expiresAt = lastSeen + f.staleAfterSecs * 1000;
  return {
    startsNow: true,
    expiresInMinutes: Math.max(0, Math.round((expiresAt - nowMs) / 60_000)),
    basis: "until what they shared goes stale",
  };
}

function buildMeetupOpportunity(f: PresenceFinding, nowMs: number): MeetupOpportunity {
  const e = f.entry;
  const why: string[] = [`you are both in ${e.context.title}`];
  const reasonCodes = ["SHARED_CONTEXT", "BOTH_SHARING_PRESENCE"];

  let where: string | null = null;
  let whereGranularity: MeetupOpportunity["whereGranularity"] = "none";
  let occasion: string;
  if (e.venue) {
    where = e.venue;
    whereGranularity = "venue_checkin";
    reasonCodes.push("VENUE_CHECKIN");
    why.push(`they checked in at ${e.venue}`);
    occasion = `join ${e.label} at ${e.venue}`;
  } else if (e.approximateArea) {
    where = e.approximateArea;
    whereGranularity = "approximate_area";
    reasonCodes.push("APPROXIMATE_AREA");
    why.push(`they are sharing that they are around ${e.approximateArea}`);
    occasion = `meet ${e.label} somewhere around ${e.approximateArea}`;
  } else {
    reasonCodes.push("STATUS_ONLY");
    why.push(`they are sharing a status (${e.status}) and not a location`);
    // No place is named, because none was shared. Proposing one would be this
    // module inventing the only fact the occasion turns on.
    occasion = `message ${e.label} to agree where and when`;
  }
  if (e.statusLabel) why.push(`their status: ${e.statusLabel}`);

  return {
    label: e.label,
    handle: e.handle,
    context: e.context,
    occasion,
    where,
    whereGranularity,
    why,
    when: meetupWindow(f, nowMs),
    reasonCodes,
  };
}

/**
 * CT-12 — "friend nearby → meetup opportunity, subject to BOTH parties'
 * privacy".
 *
 * TWO GATES, AND NEITHER IS WIDENED TO MAKE THIS WORK.
 *
 *   viewer → target   `canViewCirclePresenceBatch`, exactly as `getWhosAround`
 *                     runs it, fail-closed per target. A target who cannot be
 *                     viewed never reaches this function's output at all: no
 *                     entry, no placeholder, no redacted row. A redacted row is
 *                     still a statement that a specific person is nearby, which
 *                     is the fact the gate refused.
 *
 *   target → viewer   `canBeSeenByViewersBatch`, the inverse-shape guard the
 *                     who-can-see-me screen already uses. A meetup is a
 *                     two-sided proposal, so a one-sided sharing arrangement is
 *                     not one. This is the same rule TripSignals applies to
 *                     `friend_nearby` (`bothSharing`, dropped as
 *                     `TRIP_PRIVACY_SCOPE`), reached here through the Circle
 *                     guard rather than re-derived.
 *
 * A withheld person is counted and NEVER named: `withheldForPrivacy` is a
 * number so a caller can say "some people aren't sharing" honestly, and it
 * carries nothing about who — the count is the only thing this function will
 * say about them.
 *
 * A STALE presence reading yields no occasion either. "They are there now" is
 * not a fact a stale row carries, and a meetup suggestion is entirely that
 * claim; staleness is surfaced in `getWhosAround` precisely because it is not
 * something to act on.
 */
export async function getMeetupOpportunities(
  sc: SupabaseClient,
  viewerId: string,
  hidden: Set<string>,
  opts: { nowMs?: number } = {},
): Promise<{ opportunities: MeetupOpportunity[]; contextsChecked: number; withheldForPrivacy: number }> {
  const { found, contextsChecked } = await collectPresence(sc, viewerId, hidden);
  const nowMs = opts.nowMs ?? Date.now();

  // Group by context: the reciprocity guard is per-context, and one batched
  // call per context is the same shape the forward guard already uses.
  const byContext = new Map<string, PresenceFinding[]>();
  for (const f of found) {
    if (f.isStale) continue;
    const key = `${f.ctx.type}:${f.ctx.id}`;
    const list = byContext.get(key);
    if (list) list.push(f);
    else byContext.set(key, [f]);
  }

  const opportunities: MeetupOpportunity[] = [];
  let withheldForPrivacy = 0;
  for (const list of byContext.values()) {
    const ctx = list[0]!.ctx;
    let seenBy = new Map<string, { allowed: boolean; presenceRow?: Record<string, any> | null }>();
    try {
      seenBy = await canBeSeenByViewersBatch(sc, viewerId, list.map((f) => f.targetId), ctx.type, ctx.id);
    } catch {
      // Fail-closed: an unreadable reciprocity check is a closed one. Every
      // person in this context is withheld, and none is named.
      withheldForPrivacy += list.length;
      continue;
    }
    for (const f of list) {
      const access = seenBy.get(f.targetId) ?? { allowed: false };
      // `allowed` alone is not enough: the guard allows a viewer with no
      // presence row of their own, and someone who is not sharing presence in
      // this context is not the other half of a mutual arrangement.
      if (!(access.allowed && (access as any).presenceRow)) {
        withheldForPrivacy += 1;
        continue;
      }
      opportunities.push(buildMeetupOpportunity(f, nowMs));
    }
  }

  return { opportunities: opportunities.slice(0, 20), contextsChecked, withheldForPrivacy };
}

// ── Relationship gate for compatibility lookups ───────────────────────────────

/**
 * What the CANONICAL relationship model says about this pair, for the one
 * question Compass asks of it: may compatibility be computed at all?
 *
 * `relationship` is `services/interactionPermissions.RelationshipLabel`
 * verbatim. It is repeated, never translated — a local synonym is how a fourth
 * vocabulary starts.
 */
export interface SocialContextVerdict {
  /** True only when the canonical verdict shows a shared trip or Circle. */
  shares: boolean;
  /** The canonical label. `unavailable` when the canonical read failed. */
  relationship: RelationshipLabel;
  reason: "shared_trip" | "shared_circle" | "no_shared_context" | "unavailable";
}

/**
 * census-compass CTG-08 — §30A.1 "canonical relationship model; no independent
 * inference".
 *
 * THIS USED TO BE A FOURTH RESOLVER. The census's finding was precise and worth
 * keeping: the old body "is a fourth relationship resolver with its own
 * vocabulary — correct and fail-closed, not canonical". It read
 * `circle_memberships` and `trip_members` itself, decided what "accepted"
 * meant, and answered a bare boolean whose meaning existed nowhere else. Being
 * correct was never the problem; being a SECOND OPINION was. A second opinion
 * drifts — and while it drifts, the two answers disagree about the same pair
 * and neither knows it.
 *
 * It now asks `resolveInteractionPermissions`, whose own header calls it the
 * "canonical permission engine for all social actions" and which owns
 * `RelationshipLabel`. Nothing about the relationship is inferred here.
 *
 * THE ANSWER IS STRICTLY MORE CLOSED THAN THE OLD ONE, in two ways that are
 * consequences of consuming the canonical model rather than choices made here:
 *
 *   - a BLOCK in either direction now ends it. The canonical engine checks
 *     blocks at priority 2, fail-closed, and returns `blocked` / `blocks_you` /
 *     `mutual_block`. The old resolver had no concept of a block at all, so a
 *     blocked pair who shared a trip answered `true`. (The tool's own hidden-user
 *     filter already caught the common case; this closes it at the relationship,
 *     which is where the fact lives.)
 *   - a target whose profile the viewer may not view shares no context.
 *
 * FAIL-CLOSED, and the three states stay three. The canonical engine THROWS on
 * a failed critical read (blocks) and on `DegradedPermissionCheckError` — by
 * design, so that an outage is never reported as a fact about people. Compass
 * catches it and answers `unavailable`, NOT `stranger`: "we could not check"
 * and "you two are strangers" are different sentences, and only one of them is
 * a claim about the pair. Both refuse the lookup.
 */
export async function sharesSocialContext(
  sc: SupabaseClient,
  viewerId: string,
  targetId: string,
): Promise<SocialContextVerdict> {
  let verdict;
  try {
    verdict = await resolveInteractionPermissions(sc, viewerId, targetId);
  } catch {
    // An unreadable canonical model is a closed gate, and says only that.
    return { shares: false, relationship: "unavailable", reason: "unavailable" };
  }
  // `canViewProfile` is the canonical engine's own precondition for any
  // downstream capability ("canViewProfile=false → all downstream action
  // capabilities are false"). Compatibility is such a capability.
  if (!verdict.canViewProfile) {
    return { shares: false, relationship: verdict.relationshipLabel, reason: "no_shared_context" };
  }
  // The shared-context FACTS the canonical engine computed. They are read
  // rather than re-derived, and rather than matched against `relationshipLabel`
  // alone — that label is a priority-ordered single value, so a friend who also
  // shares a trip is labelled `friend`, and the trip is still a shared context.
  if (verdict.context.sharedTrip) {
    return { shares: true, relationship: verdict.relationshipLabel, reason: "shared_trip" };
  }
  if (verdict.context.sharedCircle) {
    return { shares: true, relationship: verdict.relationshipLabel, reason: "shared_circle" };
  }
  return { shares: false, relationship: verdict.relationshipLabel, reason: "no_shared_context" };
}
