/**
 * MyWorldMemoryService (§31 / §31.1) — the Media v2 "My World + Memory" reader.
 *
 * PRIVATE, OWNER-ONLY, SESSION-SCOPED, READ-ONLY.
 *
 * This service CONSUMES the existing Memory system — it never writes a second
 * memory store. The §31 "Memory Integration" groupings and the §31.1 "Hidden Gem
 * Memory" lines are DERIVED, on read, from:
 *   - the §12 derived-memory core (memory_remembers_for_user, via the SHARED
 *     PassportRemembersService.buildDerivedMemory + mapDerivedRow deny gate), and
 *   - the media / gem / trip-crew / outcome source signals the media product
 *     already owns (hidden_gem_*, post_saves, posts.trip_id + trip_members,
 *     compass_outcome_events).
 *
 * ── IT REUSES THE §12 ALLOW/DENY BOUNDARY. IT DOES NOT FORK IT. ──────────────
 * Every entry passes through the SAME suppression filter the §12 surface uses
 * (PassportRemembersService.loadSuppressions + isSuppressed), keyed by a
 * namespaced (subjectType, subjectId) so a "Forget" applied in the memory
 * transparency surface uniformly hides the matching My-World entry too, and so
 * nothing the owner has forgotten / hidden re-surfaces here. Derived-memory
 * entries additionally carry the §12 core's own deny gate (expired / non-active /
 * sensitive / sensitive-category inference / deleted-subject are excluded inside
 * memory_remembers_for_user and re-checked by mapDerivedRow) — so a sensitive or
 * forgotten memory can never leak into My World.
 *
 * ── SESSION IDENTITY ONLY (the 2182 lesson) ──────────────────────────────────
 * Every read is scoped to the id passed in, which the route derives from the
 * authenticated session — NEVER from a `?user_id=` query param. A viewer only
 * ever sees their OWN My World memory.
 *
 * ── FAIL-AVAILABLE, EMPTY IS NORMAL ──────────────────────────────────────────
 * Pre-launch there is no data; every read degrades to an empty, well-formed
 * grouping rather than throwing. A single failing read never sinks the surface.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildDerivedMemory,
  loadSuppressions,
  isSuppressed,
  type RememberItem,
  type SuppressionSet,
} from "../../compass/PassportRemembersService.js";

// ── §31 group taxonomy ───────────────────────────────────────────────────────

export type MyWorldMemoryGroup =
  | "visited_hidden_gem"
  | "discovered_hidden_gem"
  | "returned_to_place"
  | "night_out_with_trip_crew"
  | "favorite_atmosphere"
  | "saved_visual_inspiration"
  | "experience_matched_expectation";

const GROUP_ORDER: MyWorldMemoryGroup[] = [
  "visited_hidden_gem",
  "discovered_hidden_gem",
  "returned_to_place",
  "night_out_with_trip_crew",
  "favorite_atmosphere",
  "saved_visual_inspiration",
  "experience_matched_expectation",
];

const GROUP_LABELS: Record<MyWorldMemoryGroup, string> = {
  visited_hidden_gem: "Visited Hidden Gem",
  discovered_hidden_gem: "Discovered Hidden Gem",
  returned_to_place: "Returned to Place",
  night_out_with_trip_crew: "Night out with Trip Crew",
  favorite_atmosphere: "Favorite atmosphere",
  saved_visual_inspiration: "Saved visual inspiration",
  experience_matched_expectation: "Experience matched expectation",
};

const GROUP_DESCRIPTIONS: Record<MyWorldMemoryGroup, string> = {
  visited_hidden_gem: "Hidden Gems you have been to.",
  discovered_hidden_gem: "Hidden Gems you were the first to log.",
  returned_to_place: "Places you have come back to.",
  night_out_with_trip_crew: "Evenings out you captured with your Trip Crew.",
  favorite_atmosphere: "The kinds of places and vibes you keep coming back to.",
  saved_visual_inspiration: "Media you saved for inspiration.",
  experience_matched_expectation: "Recommendations you followed through on.",
};

export interface MyWorldMemoryEntry {
  /** Stable, namespaced client id. */
  id: string;
  group: MyWorldMemoryGroup;
  title: string;
  detail?: string;
  /** Namespaced suppression subject — the "Forget" key. */
  subjectType: string;
  subjectId: string;
  /** When it happened, best-effort; undefined when the source has no date. */
  occurredAt?: string;
  /** How this entry was derived — the "why", never a second memory row. */
  source: {
    kind: "derived_memory" | "gem_signal" | "media" | "trip_crew" | "outcome";
    derivation: string;
    originTable?: string;
  };
  /** Owner-only, always. */
  visibility: "owner_only";
}

export interface MyWorldMemoryGroupBlock {
  group: MyWorldMemoryGroup;
  label: string;
  description: string;
  entries: MyWorldMemoryEntry[];
}

// ── §31.1 Hidden Gem Memory lines ────────────────────────────────────────────

export type HiddenGemMemoryLineKind =
  | "discovered"
  | "early_contributor"
  | "brought_trip_crew"
  | "confirmed_twice"
  | "visited_before_popular";

const GEM_LINE_LABELS: Record<HiddenGemMemoryLineKind, string> = {
  discovered: "You discovered this Gem.",
  early_contributor: "You were an early contributor.",
  brought_trip_crew: "You brought your Trip Crew here.",
  confirmed_twice: "You confirmed it twice.",
  visited_before_popular: "You visited before it became popular.",
};

export interface HiddenGemMemoryLine {
  gemId: string;
  gemName: string | null;
  kind: HiddenGemMemoryLineKind;
  label: string;
  subjectType: string;
  subjectId: string;
  occurredAt?: string;
  visibility: "owner_only";
}

export interface MyWorldMemory {
  ownerId: string;
  visibility: "owner_only";
  groups: MyWorldMemoryGroupBlock[];
  hiddenGemMemory: HiddenGemMemoryLine[];
  /** Observable proof of the boundary: how many entries the deny gate removed. */
  totals: { surfaced: number; suppressed: number };
  notes: string[];
}

// ── Tunables ─────────────────────────────────────────────────────────────────
const LIST_LIMIT = 100;
const MAX_GEMS = 20; // cap §31.1 per-gem reads
const EARLY_CONTRIBUTOR_RANK = 5; // among the first N distinct contributors
const EARLY_VISITOR_RANK = 5; // among the first N distinct visitors
const CONFIRMED_TWICE_MIN = 2; // ≥ this many confirmations
const NIGHTLIFE_CATEGORIES = new Set(["nightlife", "bar", "bars", "club", "clubs", "drinks", "pub"]);

const NOTES = [
  "This view is private to you — it is never shown on your public profile or anyone else's My World.",
  "Memory here is derived from what you did; it reuses the same allow/deny boundary as your memory settings, so anything you forgot, hid, or that is sensitive is not shown.",
  "Nothing here writes a new memory — it is read from your existing activity.",
];

function safeArr(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function isoOrUndefined(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (s === "") return undefined;
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? undefined : s;
}

// ── Group A/B: derived-memory-sourced (Returned to Place, Favorite atmosphere) ─
/**
 * Classify the ALREADY-ELIGIBLE derived-memory items (they came through
 * memory_remembers_for_user + mapDerivedRow, so the §12 deny gate is already
 * applied) into the two §31 groups the memory system can source directly.
 * Suppression is applied by the caller uniformly across all groups.
 */
function classifyDerivedMemory(derived: RememberItem[]): MyWorldMemoryEntry[] {
  const out: MyWorldMemoryEntry[] = [];
  for (const item of derived) {
    // Returned to Place — an episodic visit memory that recorded a return.
    // The §12 episodic content reads "Visited <city> (returned)" (migration 2186,
    // derivation compass_graph_edges:visited with returned=true).
    if (item.memoryType === "episodic" && /\(returned\)|\breturned\b/i.test(item.title)) {
      out.push({
        id: `myworld:returned::${item.subjectType}::${item.subjectId}`,
        group: "returned_to_place",
        title: GROUP_LABELS.returned_to_place,
        detail: item.title,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        occurredAt: item.occurredAt,
        source: { kind: "derived_memory", derivation: item.source?.derivation ?? "memory_remembers_for_user", originTable: "memory_projections" },
        visibility: "owner_only",
      });
      continue;
    }
    // Favorite atmosphere — a derived preference / vibe the owner keeps choosing.
    // The §12 semantic memory is the closest thing the memory system derives to a
    // "favourite vibe" (derived_preference from compass_user_preferences, or an
    // inferred_interest). Sensitive-category inferences are already excluded by
    // the §12 core, so nothing sensitive reaches here.
    if (item.memoryType === "semantic") {
      out.push({
        id: `myworld:atmosphere::${item.subjectType}::${item.subjectId}`,
        group: "favorite_atmosphere",
        title: GROUP_LABELS.favorite_atmosphere,
        detail: item.title,
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        occurredAt: item.occurredAt,
        source: { kind: "derived_memory", derivation: item.source?.derivation ?? "memory_remembers_for_user", originTable: "memory_projections" },
        visibility: "owner_only",
      });
    }
  }
  return out;
}

// ── Owner crew trips (shared by Night out + §31.1 brought-crew) ───────────────
interface CrewTrips {
  /** trip_id → destination_city, for trips with a crew (≥2 accepted members). */
  crewTripCities: Map<string, string | null>;
  /** Lowercased destination cities of the owner's crew trips. */
  crewCities: Set<string>;
}

/**
 * The owner's trips that have a CREW (≥2 accepted members, the owner included).
 * Reused by both "Night out with Trip Crew" (§31) and "You brought your Trip
 * Crew here" (§31.1). Owner-scoped: memberships are read for THIS owner only.
 */
async function loadCrewTrips(sc: SupabaseClient, ownerId: string): Promise<CrewTrips> {
  const crewTripCities = new Map<string, string | null>();
  const crewCities = new Set<string>();

  const myTripIds = await safe(async () => {
    const { data } = await (sc as any)
      .from("trip_members")
      .select("trip_id, status")
      .eq("user_id", ownerId);
    const ids = new Set<string>();
    for (const r of safeArr(data)) {
      if (String(r.status ?? "accepted") === "accepted" && r.trip_id != null) ids.add(String(r.trip_id));
    }
    return ids;
  }, new Set<string>());

  if (myTripIds.size === 0) return { crewTripCities, crewCities };

  // Count accepted members per candidate trip — ≥2 means a crew.
  const acceptedCount = await safe(async () => {
    const { data } = await (sc as any)
      .from("trip_members")
      .select("trip_id, status")
      .in("trip_id", Array.from(myTripIds));
    const counts = new Map<string, number>();
    for (const r of safeArr(data)) {
      if (String(r.status ?? "accepted") !== "accepted" || r.trip_id == null) continue;
      const k = String(r.trip_id);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, new Map<string, number>());

  const crewIds = Array.from(myTripIds).filter((id) => (acceptedCount.get(id) ?? 0) >= 2);
  if (crewIds.length === 0) return { crewTripCities, crewCities };

  await safe(async () => {
    const { data } = await (sc as any)
      .from("trips")
      .select("id, destination_city")
      .in("id", crewIds);
    for (const r of safeArr(data)) {
      const city = r.destination_city == null ? null : String(r.destination_city);
      crewTripCities.set(String(r.id), city);
      if (city) crewCities.add(city.toLowerCase());
    }
  }, undefined);

  return { crewTripCities, crewCities };
}

// ── Group E: Night out with Trip Crew (media + crew) ─────────────────────────
async function buildNightOutWithCrew(
  sc: SupabaseClient,
  ownerId: string,
  crew: CrewTrips,
): Promise<MyWorldMemoryEntry[]> {
  if (crew.crewTripCities.size === 0) return [];
  return safe(async () => {
    const { data } = await (sc as any)
      .from("posts")
      .select("id, trip_id, category, location_city, location_name, created_at, status, post_status")
      .eq("author_id", ownerId)
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT);
    const out: MyWorldMemoryEntry[] = [];
    for (const r of safeArr(data)) {
      if (String(r.status ?? "active") !== "active") continue;
      const ps = r.post_status;
      if (ps != null && String(ps) === "draft") continue; // owner's night out, but not a draft placeholder
      const tripId = r.trip_id == null ? null : String(r.trip_id);
      if (!tripId || !crew.crewTripCities.has(tripId)) continue; // must be a crew trip
      const cat = String(r.category ?? "").toLowerCase();
      if (!NIGHTLIFE_CATEGORIES.has(cat)) continue; // "night out" — nightlife media only
      out.push({
        id: `myworld:nightout::${r.id}`,
        group: "night_out_with_trip_crew",
        title: GROUP_LABELS.night_out_with_trip_crew,
        detail: (r.location_name as string) ?? (r.location_city as string) ?? crew.crewTripCities.get(tripId) ?? undefined,
        subjectType: "myworld:nightout",
        subjectId: String(r.id),
        occurredAt: isoOrUndefined(r.created_at),
        source: { kind: "trip_crew", derivation: "posts.trip_id+trip_members", originTable: "posts" },
        visibility: "owner_only",
      });
    }
    return out;
  }, []);
}

// ── Group F: Saved visual inspiration (media the owner bookmarked) ────────────
async function buildSavedInspiration(sc: SupabaseClient, ownerId: string): Promise<MyWorldMemoryEntry[]> {
  return safe(async () => {
    const { data } = await (sc as any)
      .from("post_saves")
      .select("post_id, created_at")
      .eq("user_id", ownerId)
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT);
    const out: MyWorldMemoryEntry[] = [];
    for (const r of safeArr(data)) {
      if (r.post_id == null) continue;
      out.push({
        id: `myworld:inspiration::${r.post_id}`,
        group: "saved_visual_inspiration",
        title: GROUP_LABELS.saved_visual_inspiration,
        subjectType: "myworld:inspiration",
        subjectId: String(r.post_id),
        occurredAt: isoOrUndefined(r.created_at),
        source: { kind: "media", derivation: "post_saves", originTable: "post_saves" },
        visibility: "owner_only",
      });
    }
    return out;
  }, []);
}

// ── Group G: Experience matched expectation (outcome follow-through) ──────────
// A positive TERMINAL outcome stage means the owner acted on a recommendation —
// the experience matched the expectation. 'viewed'/'saved' are not follow-through.
const MATCHED_STAGES = new Set(["went", "stayed", "made_memory", "returned"]);

async function buildExperienceMatched(sc: SupabaseClient, ownerId: string): Promise<MyWorldMemoryEntry[]> {
  return safe(async () => {
    const { data } = await (sc as any)
      .from("compass_outcome_events")
      .select("id, recommendation_id, item_id, item_type, stage, occurred_at")
      .eq("user_id", ownerId)
      .order("occurred_at", { ascending: false })
      .limit(LIST_LIMIT);
    const out: MyWorldMemoryEntry[] = [];
    const seen = new Set<string>();
    for (const r of safeArr(data)) {
      const stage = String(r.stage ?? "");
      if (!MATCHED_STAGES.has(stage)) continue;
      const rec = String(r.recommendation_id ?? r.id ?? "");
      if (rec === "" || seen.has(rec)) continue; // one entry per recommendation
      seen.add(rec);
      out.push({
        id: `myworld:matched::${rec}`,
        group: "experience_matched_expectation",
        title: GROUP_LABELS.experience_matched_expectation,
        detail: r.item_type ? String(r.item_type) : undefined,
        subjectType: "myworld:matched",
        subjectId: rec,
        occurredAt: isoOrUndefined(r.occurred_at),
        source: { kind: "outcome", derivation: `compass_outcome_events:${stage}`, originTable: "compass_outcome_events" },
        visibility: "owner_only",
      });
    }
    return out;
  }, []);
}

// ── Gem signals (Visited / Discovered gem + §31.1 lines) ─────────────────────
interface GemSignals {
  visited: MyWorldMemoryEntry[];
  discovered: MyWorldMemoryEntry[];
  hiddenGemMemory: HiddenGemMemoryLine[];
}

async function buildGemSignals(
  sc: SupabaseClient,
  ownerId: string,
  crew: CrewTrips,
): Promise<GemSignals> {
  // 1. Owner's own gem relationships → the candidate gem set.
  const discoveredRows = await safe(async () => {
    const { data } = await (sc as any)
      .from("hidden_gems")
      .select("id, name, city, status, submitted_by, created_at")
      .eq("submitted_by", ownerId)
      .order("created_at", { ascending: false })
      .limit(LIST_LIMIT);
    // A "discovery" is a live gem — exclude rejected/removed/merged submissions
    // (matches the §30 Gems bucket, which counts active/pending only).
    return safeArr(data).filter((r) => ["active", "pending"].includes(String(r.status ?? "active")));
  }, [] as Array<Record<string, unknown>>);

  const myVisitRows = await safe(async () => {
    const { data } = await (sc as any)
      .from("hidden_gem_visits")
      .select("gem_id, is_suspicious, visited_at")
      .eq("user_id", ownerId)
      .order("visited_at", { ascending: false })
      .limit(LIST_LIMIT);
    return safeArr(data).filter((r) => r.is_suspicious !== true);
  }, [] as Array<Record<string, unknown>>);

  const myContribRows = await safe(async () => {
    const { data } = await (sc as any)
      .from("hidden_gem_contributions")
      .select("gem_id, created_at")
      .eq("user_id", ownerId)
      .limit(LIST_LIMIT);
    return safeArr(data);
  }, [] as Array<Record<string, unknown>>);

  const myVerifRows = await safe(async () => {
    const { data } = await (sc as any)
      .from("hidden_gem_verifications")
      .select("gem_id, result")
      .eq("user_id", ownerId)
      .limit(LIST_LIMIT);
    return safeArr(data).filter((r) => String(r.result ?? "") === "approved");
  }, [] as Array<Record<string, unknown>>);

  // Candidate gems: discovered ∪ visited ∪ contributed (capped).
  const candidateIds: string[] = [];
  const seenGem = new Set<string>();
  const addGem = (id: unknown) => {
    if (id == null) return;
    const s = String(id);
    if (seenGem.has(s)) return;
    seenGem.add(s);
    if (candidateIds.length < MAX_GEMS) candidateIds.push(s);
  };
  for (const r of discoveredRows) addGem(r.id);
  for (const r of myVisitRows) addGem(r.gem_id);
  for (const r of myContribRows) addGem(r.gem_id);

  // Gem name/city lookup for candidates (best-effort). Includes gems the owner
  // did not submit but visited — a public gem's name is fine for the owner's own
  // private memory line.
  const gemMeta = new Map<string, { name: string | null; city: string | null; submittedBy: string | null }>();
  for (const r of discoveredRows) {
    gemMeta.set(String(r.id), {
      name: (r.name as string) ?? null,
      city: (r.city as string) ?? null,
      submittedBy: (r.submitted_by as string) ?? null,
    });
  }
  const unknownIds = candidateIds.filter((id) => !gemMeta.has(id));
  if (unknownIds.length > 0) {
    await safe(async () => {
      const { data } = await (sc as any)
        .from("hidden_gems")
        .select("id, name, city, submitted_by")
        .in("id", unknownIds);
      for (const r of safeArr(data)) {
        gemMeta.set(String(r.id), {
          name: (r.name as string) ?? null,
          city: (r.city as string) ?? null,
          submittedBy: (r.submitted_by as string) ?? null,
        });
      }
    }, undefined);
  }

  // Owner's per-gem tallies.
  const myVisitCount = new Map<string, number>();
  const myEarliestVisit = new Map<string, string | undefined>();
  for (const r of myVisitRows) {
    const g = String(r.gem_id);
    myVisitCount.set(g, (myVisitCount.get(g) ?? 0) + 1);
    const at = isoOrUndefined(r.visited_at);
    const cur = myEarliestVisit.get(g);
    if (at && (!cur || new Date(at) < new Date(cur))) myEarliestVisit.set(g, at);
  }
  const myVerifCount = new Map<string, number>();
  for (const r of myVerifRows) {
    const g = String(r.gem_id);
    myVerifCount.set(g, (myVerifCount.get(g) ?? 0) + 1);
  }
  const myContribGem = new Set(myContribRows.map((r) => String(r.gem_id)));

  // 2. Visited / Discovered Hidden Gem (§31 groups).
  const visited: MyWorldMemoryEntry[] = [];
  const discovered: MyWorldMemoryEntry[] = [];
  for (const r of discoveredRows) {
    const gid = String(r.id);
    discovered.push({
      id: `myworld:gem_discovered::${gid}`,
      group: "discovered_hidden_gem",
      title: GROUP_LABELS.discovered_hidden_gem,
      detail: (r.name as string) ?? undefined,
      subjectType: "myworld:gem_discovered",
      subjectId: gid,
      occurredAt: isoOrUndefined(r.created_at),
      source: { kind: "gem_signal", derivation: "hidden_gems.submitted_by", originTable: "hidden_gems" },
      visibility: "owner_only",
    });
  }
  const seenVisitedGem = new Set<string>();
  for (const r of myVisitRows) {
    const gid = String(r.gem_id);
    if (seenVisitedGem.has(gid)) continue;
    seenVisitedGem.add(gid);
    const meta = gemMeta.get(gid);
    visited.push({
      id: `myworld:gem_visited::${gid}`,
      group: "visited_hidden_gem",
      title: GROUP_LABELS.visited_hidden_gem,
      detail: meta?.name ?? undefined,
      subjectType: "myworld:gem_visited",
      subjectId: gid,
      occurredAt: myEarliestVisit.get(gid),
      source: { kind: "gem_signal", derivation: "hidden_gem_visits", originTable: "hidden_gem_visits" },
      visibility: "owner_only",
    });
  }

  // 3. §31.1 Hidden Gem Memory lines (per candidate gem).
  const hiddenGemMemory: HiddenGemMemoryLine[] = [];
  for (const gid of candidateIds) {
    const meta = gemMeta.get(gid);
    const gemName = meta?.name ?? null;
    const push = (kind: HiddenGemMemoryLineKind, occurredAt?: string) => {
      hiddenGemMemory.push({
        gemId: gid,
        gemName,
        kind,
        label: GEM_LINE_LABELS[kind],
        subjectType: `myworld_gem:${kind}`,
        subjectId: gid,
        occurredAt,
        visibility: "owner_only",
      });
    };

    // "You discovered this Gem." — owner submitted it.
    if (meta?.submittedBy === ownerId) {
      const row = discoveredRows.find((r) => String(r.id) === gid);
      push("discovered", isoOrUndefined(row?.created_at));
    }

    // "You confirmed it twice." — ≥2 confirmations (visits + approved verifications).
    const confirmations = (myVisitCount.get(gid) ?? 0) + (myVerifCount.get(gid) ?? 0);
    if (confirmations >= CONFIRMED_TWICE_MIN) push("confirmed_twice", myEarliestVisit.get(gid));

    // "You brought your Trip Crew here." — visited AND gem's city is a crew-trip city.
    if (myVisitCount.get(gid) && meta?.city && crew.crewCities.has(meta.city.toLowerCase())) {
      push("brought_trip_crew", myEarliestVisit.get(gid));
    }

    // "You were an early contributor." — among the first N distinct contributors.
    if (myContribGem.has(gid)) {
      const rank = await distinctUserRank(sc, "hidden_gem_contributions", "created_at", gid, ownerId);
      if (rank != null && rank <= EARLY_CONTRIBUTOR_RANK) push("early_contributor");
    }

    // "You visited before it became popular." — among the first N distinct visitors.
    if (myVisitCount.get(gid)) {
      const rank = await distinctUserRank(sc, "hidden_gem_visits", "visited_at", gid, ownerId);
      if (rank != null && rank <= EARLY_VISITOR_RANK) push("visited_before_popular", myEarliestVisit.get(gid));
    }
  }

  return { visited, discovered, hiddenGemMemory };
}

/**
 * The owner's 1-based rank among DISTINCT users who acted on a gem, ordered by
 * each user's EARLIEST action timestamp. Reads the whole gem's rows via the
 * service client (RLS-bypassing, as the gem-intelligence pipeline does) purely
 * to compute ordering — no per-user row is surfaced. Returns null if the owner
 * is absent or the read fails.
 */
async function distinctUserRank(
  sc: SupabaseClient,
  table: string,
  timeCol: string,
  gemId: string,
  ownerId: string,
): Promise<number | null> {
  return safe(async () => {
    const { data } = await (sc as any)
      .from(table)
      .select(`user_id, ${timeCol}, gem_id`)
      .eq("gem_id", gemId)
      .limit(2000);
    const earliest = new Map<string, number>();
    for (const r of safeArr(data)) {
      if (r.user_id == null) continue;
      const t = new Date(String(r[timeCol])).getTime();
      if (!Number.isFinite(t)) continue;
      const u = String(r.user_id);
      const cur = earliest.get(u);
      if (cur == null || t < cur) earliest.set(u, t);
    }
    if (!earliest.has(ownerId)) return null;
    const ordered = [...earliest.entries()].sort((a, b) => a[1] - b[1]);
    return ordered.findIndex(([u]) => u === ownerId) + 1;
  }, null);
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/**
 * Build the owner's My World memory surface (§31 + §31.1). OWNER-ONLY,
 * SESSION-SCOPED (ownerId is the authenticated caller — never a query param),
 * READ-ONLY, and fail-available: every read degrades to empty.
 */
export async function buildMyWorldMemory(
  sc: SupabaseClient,
  ownerId: string,
): Promise<MyWorldMemory> {
  const empty = (): MyWorldMemory => ({
    ownerId,
    visibility: "owner_only",
    groups: GROUP_ORDER.map((g) => ({ group: g, label: GROUP_LABELS[g], description: GROUP_DESCRIPTIONS[g], entries: [] })),
    hiddenGemMemory: [],
    totals: { surfaced: 0, suppressed: 0 },
    notes: NOTES,
  });

  if (!ownerId) return empty();

  return safe(async () => {
    // Reuse the §12 core: the derived-memory read (memory_remembers_for_user +
    // mapDerivedRow deny gate) and the SAME suppression set.
    const [sup, derived, crew] = await Promise.all([
      safe(() => loadSuppressions(sc, ownerId), { keys: new Set<string>(), projectionIds: new Set<string>() } as SuppressionSet),
      safe(() => buildDerivedMemory(sc, ownerId), [] as RememberItem[]),
      loadCrewTrips(sc, ownerId),
    ]);

    const [nightOut, inspiration, matched, gems] = await Promise.all([
      buildNightOutWithCrew(sc, ownerId, crew),
      buildSavedInspiration(sc, ownerId),
      buildExperienceMatched(sc, ownerId),
      buildGemSignals(sc, ownerId, crew),
    ]);

    const derivedEntries = classifyDerivedMemory(derived);

    const all: MyWorldMemoryEntry[] = [
      ...gems.visited,
      ...gems.discovered,
      ...derivedEntries, // returned_to_place + favorite_atmosphere
      ...nightOut,
      ...inspiration,
      ...matched,
    ];

    // ── The uniform §12 suppression gate over EVERY entry ──────────────────────
    // Reuse isSuppressed with the entry's namespaced (subjectType, subjectId) so
    // a "Forget" hides the matching My-World entry, and nothing forgotten leaks.
    let surfaced = 0;
    let suppressed = 0;
    const byGroup: Record<MyWorldMemoryGroup, MyWorldMemoryEntry[]> = {
      visited_hidden_gem: [],
      discovered_hidden_gem: [],
      returned_to_place: [],
      night_out_with_trip_crew: [],
      favorite_atmosphere: [],
      saved_visual_inspiration: [],
      experience_matched_expectation: [],
    };
    for (const entry of all) {
      if (isSuppressedEntry(entry, sup)) {
        suppressed += 1;
        continue;
      }
      byGroup[entry.group].push(entry);
      surfaced += 1;
    }

    // §31.1 lines also pass the SAME suppression gate.
    const hiddenGemMemory = gems.hiddenGemMemory.filter((line) => {
      if (isSuppressedKey(line.subjectType, line.subjectId, sup)) {
        suppressed += 1;
        return false;
      }
      surfaced += 1;
      return true;
    });

    const groups: MyWorldMemoryGroupBlock[] = GROUP_ORDER.map((g) => ({
      group: g,
      label: GROUP_LABELS[g],
      description: GROUP_DESCRIPTIONS[g],
      entries: byGroup[g],
    }));

    return {
      ownerId,
      visibility: "owner_only" as const,
      groups,
      hiddenGemMemory,
      totals: { surfaced, suppressed },
      notes: NOTES,
    };
  }, empty());
}

/** Reuse the §12 isSuppressed shape via a RememberItem-compatible probe. */
function isSuppressedEntry(entry: MyWorldMemoryEntry, sup: SuppressionSet): boolean {
  return isSuppressedKey(entry.subjectType, entry.subjectId, sup);
}

function isSuppressedKey(subjectType: string, subjectId: string, sup: SuppressionSet): boolean {
  // Mirror PassportRemembersService.isSuppressed's key form exactly so a Forget
  // recorded there (subject_type::subject_id) uniformly suppresses here too.
  return isSuppressed(
    { subjectType, subjectId, group: "saved_content", id: `${subjectType}:${subjectId}` } as unknown as RememberItem,
    sup,
  );
}
