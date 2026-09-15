/**
 * discoveryTrailObject — the CANONICAL TRAIL, as `02_Trails.md` defines it, and
 * nothing else.
 *
 * ⚠ THE NAME COLLIDES WITH SOMETHING ELSE IN THIS TREE. READ THIS FIRST.
 * =====================================================================
 * `lib/trailLiveIntel.ts`, `lib/trailServe.ts`, `lib/trailFollowup.ts` and the
 * `/v1/trails/:id/live-intel` handler in `routes/trails.ts` all say "trail" and
 * NONE of them is this. Theirs is a `route_plans` row — an ordered list of
 * `route_stops` for one trip, Intelligence Gathering §19. This module's Trail is
 * `docs/specs/discovery-v1/02_Trails.md`'s: a PERMANENT, themed discovery space
 * ("Bangkok After Dark", "Kyoto Hidden Temples") with a canonical slug, a
 * lifecycle, relationships to other Trails, and membership rows for content.
 * The two never read each other's tables and must not be merged.
 *
 * THE RULING THIS IS BUILT UNDER, VERBATIM
 * ========================================
 * `docs/discovery/ROADMAP.md:148`: "Anything assuming the six P1 components are
 * **peer scoring systems**: STALE — must be re-scoped before implementation."
 * `docs/architecture/02_Trails.md:5-12` records the re-scope that followed:
 * "ROADMAP step 7 keeps trails only as a future MODIFIER to the ranker, never a
 * parallel engine."
 *
 * So this file builds the OBJECT and its rules. It contains no score, no
 * ordering and no ranker. The one number Trails contributes to ranking lives in
 * lib/discoveryTrailAffinity.ts, is bounded by a constant below every taste
 * weight, and is shaped to be handed to the EXISTING ranker as one more
 * modifier map — exactly as `localMomentum` already is. There is no second
 * ranking engine here and none is proposed.
 *
 * EVERYTHING HERE IS PURE
 * =======================
 * No Supabase client, no clock, no randomness. The service layer
 * (services/trails/TrailService.ts) supplies rows; this module decides. That
 * split is what lets `02` §5's canonicalization and §4's label cap be proven
 * without a database, which matters because the tables do not exist in
 * production and a rule that can only be tested against a live schema is a rule
 * that never gets tested.
 *
 * census-discovery rows: DV-20 (canonical objects not strings), DV-24
 * (relationships navigable — the edge vocabulary), DC-02 (§4 label cap), DC-03
 * (§5 four creation checks), DC-04 (§7 both lifecycles).
 */

// ── §7 Trail state ───────────────────────────────────────────────────────────

/** `02` §7, in the specification's own order. Mirrored by 2910's CHECK. */
export const TRAIL_LIFECYCLE_STATES = [
  "proposed", "active", "needs_update", "stale", "archived",
] as const;
export type TrailLifecycleState = (typeof TRAIL_LIFECYCLE_STATES)[number];

/** `02` §7 "Content lifecycle inside a Trail", in the specification's order. */
export const TRAIL_CONTENT_STATES = [
  "just_arrived", "growing", "featured", "evergreen", "rediscovered",
  "archived_from_active_rotation",
] as const;
export type TrailContentState = (typeof TRAIL_CONTENT_STATES)[number];

/** `02` §6 relationships — DV-24's "navigable" is this vocabulary plus trail_edges. */
export const TRAIL_EDGE_TYPES = [
  "parent", "child", "related", "seasonal_variant", "geographic_sub",
  "experience_branch",
] as const;
export type TrailEdgeType = (typeof TRAIL_EDGE_TYPES)[number];

/** `02` §4 Signals. A CLOSED set: a signal outside it is refused, never stored. */
export const TRAIL_SIGNALS = [
  "luxury", "solo_friendly", "late_night", "family", "hidden_gem",
  "rooftop", "food", "live_music",
] as const;
export type TrailSignal = (typeof TRAIL_SIGNALS)[number];

/** `02` §4: content has one primary Trail, optional supporting Trails or Signals. */
export const TRAIL_RELATIONSHIPS = ["primary", "supporting", "signal"] as const;
export type TrailRelationship = (typeof TRAIL_RELATIONSHIPS)[number];

/** `02` §5 origins, as the `content_trails.source` / `trails.canonicalization` vocabulary. */
export const TRAIL_CONTENT_SOURCES = ["curated", "user", "community", "system"] as const;
export type TrailContentSource = (typeof TRAIL_CONTENT_SOURCES)[number];

/** `02` §3 components that can belong to a Trail and have an id in this repository. */
export const TRAIL_SOURCE_TYPES = ["post", "place", "event", "itinerary", "route"] as const;
export type TrailSourceType = (typeof TRAIL_SOURCE_TYPES)[number];

// ── §7 lifecycle as a RELATION (DC-04) ───────────────────────────────────────

/**
 * Trail state transitions. Two properties are deliberate:
 *
 *   `archived` is TERMINAL. `02` §15's moderation actions are "merge duplicate
 *   Trails" and "mark stale" — neither resurrects an archived Trail, and a
 *   Trail that could silently return would make every id anyone had already
 *   published unreliable. Un-archiving is a merge into a live Trail, which is a
 *   different operation with a different audit trail.
 *
 *   A NO-OP is refused. `active → active` is not a state change, and admitting
 *   it would let an idempotent retry write a lifecycle event that nothing
 *   distinguishes from a real move.
 */
const LIFECYCLE_TRANSITIONS: Readonly<Record<TrailLifecycleState, readonly TrailLifecycleState[]>> = {
  proposed:     ["active", "archived"],
  active:       ["needs_update", "stale", "archived"],
  needs_update: ["active", "stale", "archived"],
  stale:        ["active", "archived"],
  archived:     [],
};

export function isTrailLifecycleState(v: unknown): v is TrailLifecycleState {
  return typeof v === "string" && (TRAIL_LIFECYCLE_STATES as readonly string[]).includes(v);
}

export function isTrailLifecycleTransitionAllowed(
  from: TrailLifecycleState, to: TrailLifecycleState,
): boolean {
  if (!isTrailLifecycleState(from) || !isTrailLifecycleState(to)) return false;
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/**
 * In-Trail content transitions. `rediscovered` is reachable ONLY from
 * `archived_from_active_rotation` — `03` §9's own word: nothing that never
 * cooled can be RE-discovered, and admitting the shortcut would make the state
 * a synonym for "new" and stop it meaning anything.
 */
const CONTENT_TRANSITIONS: Readonly<Record<TrailContentState, readonly TrailContentState[]>> = {
  just_arrived:                  ["growing", "archived_from_active_rotation"],
  growing:                       ["featured", "archived_from_active_rotation"],
  featured:                      ["evergreen", "growing", "archived_from_active_rotation"],
  evergreen:                     ["archived_from_active_rotation"],
  rediscovered:                  ["growing", "featured", "archived_from_active_rotation"],
  archived_from_active_rotation: ["rediscovered"],
};

export function isTrailContentState(v: unknown): v is TrailContentState {
  return typeof v === "string" && (TRAIL_CONTENT_STATES as readonly string[]).includes(v);
}

export function isTrailContentTransitionAllowed(
  from: TrailContentState, to: TrailContentState,
): boolean {
  if (!isTrailContentState(from) || !isTrailContentState(to)) return false;
  return CONTENT_TRANSITIONS[from].includes(to);
}

// ── DV-20: canonical identity ────────────────────────────────────────────────

/**
 * Title → canonical slug, or null when the title carries no slug-able
 * character.
 *
 * NULL IS THE POINT. `02` §2's whole complaint is that `#danang`, `#DaNang`,
 * `#danangvietnam` and `#danangtrip` are four identities for one place. The fix
 * is a canonical id — and a canonical id that can be FABRICATED from an
 * emoji-only title is not canonical, it is a second hashtag with extra steps.
 * A title this function cannot canonicalise has no Trail, and the creation path
 * refuses it rather than minting `trail-7f3a`.
 */
export function canonicalTrailSlug(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // strip combining marks: Café → Cafe
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
}

function titleTokens(title: unknown): Set<string> {
  const slug = canonicalTrailSlug(title);
  return new Set(slug ? slug.split("-") : []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : Math.round((shared / union) * 1000) / 1000;
}

/**
 * Token-set similarity in [0, 1]. Symmetric, 1 on identity, 0 on disjoint.
 *
 * Deliberately NOT an embedding. `02` §5 asks for "semantic overlap" and an
 * embedding would be the better answer — but this repository has no embedding
 * service on the Discovery path, and a similarity that silently returned 0
 * because a model was unreachable would turn a creation CHECK into a rubber
 * stamp exactly when it mattered. A token set is weaker, deterministic, and
 * cannot fail open.
 */
export function titleSimilarity(a: unknown, b: unknown): number {
  return jaccard(titleTokens(a), titleTokens(b));
}

// ── DC-03: §5's four canonicalization checks ─────────────────────────────────

/** ≥ this token-set similarity is the SAME Trail under another spelling. */
export const DUPLICATE_TITLE_SIMILARITY = 0.8;
/** ≥ this, within one destination, is an overlapping Trail for that destination. */
export const DESTINATION_OVERLAP_SIMILARITY = 0.6;
/** ≥ this on the THEME tokens (destination words removed) is semantic overlap. */
export const SEMANTIC_OVERLAP_SIMILARITY = 0.5;

export type TrailCreationCheck =
  | "uncanonicalisable_title"
  | "duplicate_title_similarity"
  | "destination_overlap"
  | "semantic_overlap"
  | "existing_parent_child";

export interface TrailCreationRefusal {
  check: TrailCreationCheck;
  /** The existing Trail this proposal collides with, when there is one. */
  conflictsWith: string | null;
  /** The measured similarity, so a caller can explain the refusal without re-deriving it. */
  similarity: number;
}

export interface ExistingTrail {
  id: string;
  slug: string;
  title: string;
  /** Lowercased destination scope, or null for a Trail with no destination. */
  destination: string | null;
}

export interface TrailProposal {
  title: string;
  destination: string | null;
}

export interface TrailCanonicalisation {
  ok: boolean;
  slug: string | null;
  refusals: TrailCreationRefusal[];
  /** Set when CHECK 4 found a broader Trail this one belongs under (§6 parent). */
  suggestedParentTrailId: string | null;
}

function normDestination(d: unknown): string | null {
  if (typeof d !== "string") return null;
  const n = d.trim().toLowerCase().replace(/\s+/g, " ");
  return n.length > 0 ? n : null;
}

/** Tokens of the title with the destination's own words removed — the THEME. */
function themeTokens(title: unknown, destination: string | null): Set<string> {
  const t = titleTokens(title);
  for (const d of titleTokens(destination)) t.delete(d);
  return t;
}

/**
 * `02` §5: "Creation should require canonicalization checks: duplicate title
 * similarity, destination overlap, semantic overlap, existing parent/child
 * Trail."
 *
 * ALL FOUR RUN, AND ALL FOUR REPORT. An early return on the first refusal would
 * make the second proposal fix one problem and discover the next, which is how
 * a four-check gate degrades into a four-attempt gate. Every refusal names its
 * check and the Trail it collided with, so the creation route can say what to
 * do instead — and CHECK 4 additionally returns the parent, because "this
 * belongs under Bangkok After Dark" is an instruction, not just a No.
 */
export function canonicaliseTrailProposal(
  proposal: TrailProposal,
  existing: readonly ExistingTrail[],
): TrailCanonicalisation {
  const refusals: TrailCreationRefusal[] = [];
  const slug = canonicalTrailSlug(proposal?.title);
  if (!slug) {
    refusals.push({ check: "uncanonicalisable_title", conflictsWith: null, similarity: 0 });
    return { ok: false, slug: null, refusals, suggestedParentTrailId: null };
  }

  const dest = normDestination(proposal?.destination);
  const mine = titleTokens(proposal.title);
  const myTheme = themeTokens(proposal.title, dest);
  let suggestedParentTrailId: string | null = null;

  for (const other of existing ?? []) {
    if (!other || typeof other.id !== "string") continue;
    const theirs = titleTokens(other.title);
    const sim = jaccard(mine, theirs);
    const sameDestination = dest !== null && normDestination(other.destination) === dest;

    // CHECK 1 — duplicate title similarity. Destination-independent on purpose:
    // two Trails called "Bangkok After Dark" are one Trail even if someone
    // files the second under Phuket.
    if (sim >= DUPLICATE_TITLE_SIMILARITY || slug === other.slug) {
      refusals.push({ check: "duplicate_title_similarity", conflictsWith: other.id, similarity: sim });
    }

    if (sameDestination) {
      // CHECK 2 — destination overlap. A lower bar than CHECK 1, because within
      // one destination a weaker resemblance is already a fragmentation risk.
      if (sim >= DESTINATION_OVERLAP_SIMILARITY) {
        refusals.push({ check: "destination_overlap", conflictsWith: other.id, similarity: sim });
      }

      // CHECK 3 — semantic overlap. Compared on the THEME tokens only: inside
      // one destination every title shares the city's name, and letting that
      // shared word carry the comparison would make "Bangkok Temples" and
      // "Bangkok Rooftops" look alike.
      const themeSim = jaccard(myTheme, themeTokens(other.title, dest));
      if (themeSim >= SEMANTIC_OVERLAP_SIMILARITY) {
        refusals.push({ check: "semantic_overlap", conflictsWith: other.id, similarity: themeSim });
      }

      // CHECK 4 — existing parent/child. A strict token superset of a live
      // Trail in the same destination is a SUB-Trail (§6), not a new one.
      const isStrictSuperset = theirs.size > 0 && theirs.size < mine.size &&
        [...theirs].every((t) => mine.has(t));
      if (isStrictSuperset) {
        refusals.push({ check: "existing_parent_child", conflictsWith: other.id, similarity: sim });
        if (suggestedParentTrailId === null) suggestedParentTrailId = other.id;
      }
    }
  }

  return { ok: refusals.length === 0, slug, refusals, suggestedParentTrailId };
}

// ── DC-02: §4's label cap ────────────────────────────────────────────────────

/** `02` §4: "Content may have ONE primary Trail." */
export const MAX_PRIMARY_TRAILS = 1;
/** Optional supporting Trails — bounded, because §4 forbids "unlimited". */
export const MAX_SUPPORTING_TRAILS = 3;
/** Optional Signals — bounded for the same reason, with its OWN budget. */
export const MAX_SIGNALS = 5;

export interface TrailLabel {
  relationship: TrailRelationship;
  trailId: string;
  /** Required and from TRAIL_SIGNALS when relationship is "signal"; null otherwise. */
  signal: string | null;
}

export type LabelRefusalReason =
  | "unknown_relationship"
  | "unknown_signal"
  | "signal_on_non_signal_label"
  | "duplicate"
  | "primary_already_set"
  | "supporting_cap"
  | "signal_cap";

export interface LabelRefusal { label: TrailLabel; reason: LabelRefusalReason }

export interface LabelCapResult {
  accepted: TrailLabel[];
  refusals: LabelRefusal[];
}

const labelKey = (l: TrailLabel) => `${l.relationship}|${l.trailId}|${l.signal ?? ""}`;

/**
 * `02` §4: "Do not let creators attach unlimited discovery labels."
 *
 * THREE SEPARATE BUDGETS, NOT ONE POOL. A shared pool would let a creator spend
 * the whole allowance on Signals and leave the content in no Trail, which
 * inverts what §4 is for: the primary Trail is the discovery identity and the
 * Signals are adjectives on it.
 *
 * A BATCH IS NOT ALL-OR-NOTHING. The prefix that fits is accepted and the
 * overflow is refused individually, each with its reason. Refusing the whole
 * batch would make a 6th signal silently discard the 5 good ones; accepting the
 * whole batch is the thing §4 forbids. Reporting per label is the only option
 * that leaves the caller able to tell the user what happened.
 */
export function capTrailLabels(
  existing: readonly TrailLabel[],
  proposed: readonly TrailLabel[],
): LabelCapResult {
  const accepted: TrailLabel[] = [];
  const refusals: LabelRefusal[] = [];

  const held = new Set((existing ?? []).map(labelKey));
  const counts = { primary: 0, supporting: 0, signal: 0 };
  for (const l of existing ?? []) {
    if (l && (l.relationship in counts)) counts[l.relationship] += 1;
  }

  for (const label of proposed ?? []) {
    const refuse = (reason: LabelRefusalReason) => { refusals.push({ label, reason }); };

    if (!label || !(TRAIL_RELATIONSHIPS as readonly string[]).includes(label.relationship)) {
      refuse("unknown_relationship"); continue;
    }
    if (label.relationship === "signal") {
      if (!(TRAIL_SIGNALS as readonly string[]).includes(label.signal ?? "")) {
        refuse("unknown_signal"); continue;
      }
    } else if (label.signal !== null && label.signal !== undefined) {
      refuse("signal_on_non_signal_label"); continue;
    }

    // Duplicate is checked BEFORE the caps: re-sending a label you already hold
    // is a retry, and charging it to the budget would make retries destructive.
    if (held.has(labelKey(label))) { refuse("duplicate"); continue; }

    if (label.relationship === "primary" && counts.primary >= MAX_PRIMARY_TRAILS) {
      refuse("primary_already_set"); continue;
    }
    if (label.relationship === "supporting" && counts.supporting >= MAX_SUPPORTING_TRAILS) {
      refuse("supporting_cap"); continue;
    }
    if (label.relationship === "signal" && counts.signal >= MAX_SIGNALS) {
      refuse("signal_cap"); continue;
    }

    counts[label.relationship] += 1;
    held.add(labelKey(label));
    accepted.push(label);
  }

  return { accepted, refusals };
}
