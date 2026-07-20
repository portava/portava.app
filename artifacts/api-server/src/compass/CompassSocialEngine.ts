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
 *      blocks, youngest known age, all-verified flag) so group recommendations
 *      satisfy everyone.
 *
 * Display-name rule: people are referred to by @handle unless they opted in
 * (profile_privacy_settings.show_real_name) — resolved by callers via
 * nameVisibilitySet.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassProfile } from "./types.js";
import { canViewCirclePresence, type ContextType } from "../lib/circleAccessGuard.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { wrapUgc } from "./CompassStructuredContext.js";

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
  /** Age computed SERVER-SIDE from DOB — never leaves the server. */
  age: number | null;
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
  /** Youngest KNOWN age; null when no member's age is known. */
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
  const knownAges = members.map((m) => m.age).filter((a): a is number => typeof a === "number");
  const youngestAge = knownAges.length > 0 ? Math.min(...knownAges) : null;

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
    if (agg.youngestAge === null || agg.youngestAge < ageMin) {
      return { ok: false, reason: "age_restriction_not_met_by_all_members" };
    }
  }
  if (ev.requires_verification === true && !agg.allVerified) {
    return { ok: false, reason: "verification_required_not_all_members_verified" };
  }
  return { ok: true };
}

/** Age from a DOB string — server-side only; the DOB itself never leaves. */
export function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

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
  const contexts = await activeContexts(sc, viewerId);
  const people: WhosAroundEntry[] = [];
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

    const results = await Promise.all(
      targets.map(async (targetId) => {
        try {
          const access = await canViewCirclePresence(sc, viewerId, targetId, ctx.type, ctx.id);
          return { targetId, access };
        } catch {
          return { targetId, access: { allowed: false as const } };
        }
      }),
    );

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

      people.push({
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
        isStale: Boolean((r.access as any).isStale),
        context: { type: ctx.type, title: wrapUgc(ctx.title) },
      });
      seenUsers.add(r.targetId);
    }
  }

  return { people: people.slice(0, 20), contextsChecked: contexts.length };
}

// ── Relationship gate for compatibility lookups ───────────────────────────────

/**
 * True when viewer and target share a Circle (either direction of ownership)
 * or an accepted trip. Compatibility is only computable within an existing
 * trusted relationship — never for arbitrary users.
 */
export async function sharesSocialContext(
  sc: SupabaseClient,
  viewerId: string,
  targetId: string,
): Promise<boolean> {
  try {
    // Same circle: owner+member in either direction, or both members of one owner's circle.
    const { data: rows } = await sc
      .from("circle_memberships")
      .select("user_id, other_id, status")
      .in("other_id", [viewerId, targetId]);
    const accepted = ((rows ?? []) as any[]).filter((r) => (r.status ?? "accepted") === "accepted");
    const viewerOwners = new Set(accepted.filter((r) => r.other_id === viewerId).map((r) => r.user_id as string));
    const targetOwners = new Set(accepted.filter((r) => r.other_id === targetId).map((r) => r.user_id as string));
    if (viewerOwners.has(targetId) || targetOwners.has(viewerId)) return true;
    for (const o of viewerOwners) if (targetOwners.has(o)) return true;
  } catch { /* fall through to trips */ }
  try {
    const { data: mine } = await sc
      .from("trip_members")
      .select("trip_id, status")
      .eq("user_id", viewerId);
    const myTrips = new Set(
      ((mine ?? []) as any[])
        .filter((r) => r.status == null || r.status === "accepted")
        .map((r) => r.trip_id as string),
    );
    if (myTrips.size === 0) return false;
    const { data: theirs } = await sc
      .from("trip_members")
      .select("trip_id, status")
      .eq("user_id", targetId);
    return ((theirs ?? []) as any[])
      .filter((r) => r.status == null || r.status === "accepted")
      .some((r) => myTrips.has(r.trip_id as string));
  } catch {
    return false; // fail-closed: no provable relationship → no compatibility lookup
  }
}
