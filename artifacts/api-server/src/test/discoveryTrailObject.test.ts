/**
 * `02_Trails.md` — the CANONICAL TRAIL OBJECT's pure rules.
 *
 * SCOPE, STATED FIRST BECAUSE THE NAME COLLIDES
 * =============================================
 * This is NOT `lib/trailLiveIntel.ts` / `routes/trails.ts`'s trail. That one is
 * a `route_plans` row — a trip route, Intelligence Gathering §19. This is
 * `docs/specs/discovery-v1/02_Trails.md`'s themed discovery space: a permanent,
 * canonical object with a slug, a lifecycle and relationships.
 *
 * WHAT THIS FILE PROVES — census-discovery DV-20, DV-24, DC-02, DC-03, DC-04:
 *   • the four vocabularies exist as closed sets and are the spec's own
 *     (5 lifecycle states, 6 content states, 6 edge types, 8 signals);
 *   • a Trail is addressed by a canonical slug derived from its title, so two
 *     spellings of one theme cannot become two Trails — DV-20's "canonical
 *     objects, not strings";
 *   • `02` §5's FOUR creation checks each refuse independently, and each names
 *     itself in the refusal — DC-03;
 *   • `02` §4's "Do not let creators attach unlimited discovery labels" is a
 *     cap that refuses, per relationship class — DC-02;
 *   • `02` §7's lifecycle is a transition RELATION, not a free text column —
 *     an unknown or illegal move is refused — DC-04.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRAIL_LIFECYCLE_STATES,
  TRAIL_CONTENT_STATES,
  TRAIL_EDGE_TYPES,
  TRAIL_SIGNALS,
  MAX_SUPPORTING_TRAILS,
  MAX_SIGNALS,
  canonicalTrailSlug,
  titleSimilarity,
  canonicaliseTrailProposal,
  capTrailLabels,
  isTrailLifecycleTransitionAllowed,
  isTrailContentTransitionAllowed,
  type ExistingTrail,
} from "../lib/discoveryTrailObject.js";

// ── Vocabularies (DC-04, DV-24) ──────────────────────────────────────────────

describe("02 §6/§7 vocabularies are the spec's own closed sets", () => {
  it("§7 Trail state — exactly the five the spec lists, in its order", () => {
    assert.deepEqual([...TRAIL_LIFECYCLE_STATES], [
      "proposed", "active", "needs_update", "stale", "archived",
    ]);
  });

  it("§7 content lifecycle inside a Trail — exactly the six", () => {
    assert.deepEqual([...TRAIL_CONTENT_STATES], [
      "just_arrived", "growing", "featured", "evergreen", "rediscovered",
      "archived_from_active_rotation",
    ]);
  });

  it("§6 relationships — exactly the six kinds of edge (DV-24)", () => {
    assert.deepEqual([...TRAIL_EDGE_TYPES], [
      "parent", "child", "related", "seasonal_variant", "geographic_sub",
      "experience_branch",
    ]);
  });

  it("§4 Signals — exactly the eight", () => {
    assert.deepEqual([...TRAIL_SIGNALS], [
      "luxury", "solo_friendly", "late_night", "family", "hidden_gem",
      "rooftop", "food", "live_music",
    ]);
  });
});

// ── DV-20: canonical objects, not strings ────────────────────────────────────

describe("DV-20 — a Trail is addressed by a canonical slug, not by its string", () => {
  it("case, whitespace and punctuation variants of one title collapse onto ONE slug", () => {
    const slugs = new Set([
      canonicalTrailSlug("Da Nang"),
      canonicalTrailSlug("da nang"),
      canonicalTrailSlug("  DA   NANG  "),
      canonicalTrailSlug("Da-Nang"),
      canonicalTrailSlug("Da_Nang!"),
    ]);
    assert.equal(slugs.size, 1, "one theme, one canonical identity");
    assert.equal([...slugs][0], "da-nang");
  });

  // THE RESIDUE, ASSERTED RATHER THAN HIDDEN. `02` §2's four hashtags are
  // `#danang`, `#DaNang`, `#danangvietnam`, `#danangtrip`. Case folding collapses
  // the first two; the WORD-BOUNDARY and suffix variants it cannot, because
  // deciding that "danang" and "da nang" are one place needs a destination
  // dictionary (`canonical_locations`), which is another lane's table. What
  // actually makes a Trail canonical is not this string function: it is that
  // content references `content_trails.trail_id` — a uuid — and never a title.
  // This test exists so the limit is a claim someone can read, not a gap.
  it("word-boundary variants do NOT collapse — the slug alone is not the canonicaliser", () => {
    assert.equal(canonicalTrailSlug("danang"), "danang");
    assert.equal(canonicalTrailSlug("Da Nang"), "da-nang");
    assert.notEqual(canonicalTrailSlug("danang"), canonicalTrailSlug("Da Nang"));
    assert.equal(titleSimilarity("danang", "da nang"), 0,
      "and the token-set similarity cannot see it either — stated, not papered over");
  });

  it("diacritics, punctuation and emoji are folded away, never carried into the id", () => {
    assert.equal(canonicalTrailSlug("Café — Crawl!"), "cafe-crawl");
    assert.equal(canonicalTrailSlug("Bangkok After Dark 🌙"), "bangkok-after-dark");
  });

  it("a title with no slug-able character has NO canonical identity (null, never a fabricated id)", () => {
    assert.equal(canonicalTrailSlug("🌙🌙"), null);
    assert.equal(canonicalTrailSlug("   "), null);
    assert.equal(canonicalTrailSlug(""), null);
  });

  it("the slug shape matches what the migration's CHECK admits", () => {
    const shape = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const t of ["Tokyo First-Timer", "Seminyak Beach Clubs", "Kyoto  Hidden   Temples"]) {
      assert.match(canonicalTrailSlug(t)!, shape, t);
    }
  });
});

// ── DC-03: §5's four canonicalization checks ─────────────────────────────────

const EXISTING: ExistingTrail[] = [
  { id: "t-bkk-dark", slug: "bangkok-after-dark", title: "Bangkok After Dark", destination: "bangkok" },
  { id: "t-dn-coffee", slug: "da-nang-coffee-crawl", title: "Da Nang Coffee Crawl", destination: "da nang" },
];

describe("DC-03 — §5 creation requires four canonicalization checks, each refusing on its own", () => {
  it("a clean proposal passes all four and is admitted with its slug", () => {
    const r = canonicaliseTrailProposal(
      { title: "Kyoto Hidden Temples", destination: "kyoto" }, EXISTING);
    assert.equal(r.ok, true);
    assert.equal(r.slug, "kyoto-hidden-temples");
    assert.deepEqual(r.refusals, []);
  });

  it("CHECK 1 duplicate title similarity — a re-spelling of an existing Trail is refused BY NAME", () => {
    const r = canonicaliseTrailProposal(
      { title: "bangkok  after   dark", destination: "phuket" }, EXISTING);
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => x.check === "duplicate_title_similarity"),
      `expected duplicate_title_similarity, got ${JSON.stringify(r.refusals)}`);
    assert.equal(r.refusals.find((x) => x.check === "duplicate_title_similarity")!.conflictsWith, "t-bkk-dark");
  });

  it("CHECK 2 destination overlap — same destination, near-same title, refused", () => {
    const r = canonicaliseTrailProposal(
      { title: "Da Nang Coffee Crawls", destination: "da nang" }, EXISTING);
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => x.check === "destination_overlap"),
      `expected destination_overlap, got ${JSON.stringify(r.refusals)}`);
  });

  it("CHECK 3 semantic overlap — same destination, same theme words, different phrasing", () => {
    const r = canonicaliseTrailProposal(
      { title: "After Dark Bangkok Nights", destination: "bangkok" }, EXISTING);
    assert.equal(r.ok, false);
    assert.ok(r.refusals.some((x) => x.check === "semantic_overlap"),
      `expected semantic_overlap, got ${JSON.stringify(r.refusals)}`);
  });

  it("CHECK 4 existing parent/child — a narrower title under an existing Trail is refused AND given its parent", () => {
    const r = canonicaliseTrailProposal(
      { title: "Bangkok After Dark Rooftops", destination: "bangkok" }, EXISTING);
    assert.equal(r.ok, false);
    const pc = r.refusals.find((x) => x.check === "existing_parent_child");
    assert.ok(pc, `expected existing_parent_child, got ${JSON.stringify(r.refusals)}`);
    assert.equal(pc!.conflictsWith, "t-bkk-dark");
    assert.equal(r.suggestedParentTrailId, "t-bkk-dark");
  });

  it("an unsluggable title is refused by the slug check and NO trail id is invented", () => {
    const r = canonicaliseTrailProposal({ title: "🌙", destination: "bangkok" }, EXISTING);
    assert.equal(r.ok, false);
    assert.equal(r.slug, null);
    assert.ok(r.refusals.some((x) => x.check === "uncanonicalisable_title"));
  });

  it("all four checks are reported, not just the first — a proposal can fail several", () => {
    const r = canonicaliseTrailProposal(
      { title: "Bangkok After Dark", destination: "bangkok" }, EXISTING);
    assert.equal(r.ok, false);
    const names = r.refusals.map((x) => x.check);
    assert.ok(names.includes("duplicate_title_similarity"), JSON.stringify(names));
    assert.ok(names.includes("destination_overlap"), JSON.stringify(names));
  });

  it("titleSimilarity is symmetric, 1 for identity and 0 for disjoint", () => {
    assert.equal(titleSimilarity("Bangkok After Dark", "Bangkok After Dark"), 1);
    assert.equal(titleSimilarity("Bangkok After Dark", "Kyoto Temples"), 0);
    assert.equal(
      titleSimilarity("Bangkok After Dark", "After Dark Bangkok Nights"),
      titleSimilarity("After Dark Bangkok Nights", "Bangkok After Dark"),
    );
  });
});

// ── DC-02: §4 "Do not let creators attach unlimited discovery labels" ────────

describe("DC-02 — §4 caps how many discovery labels one piece of content may carry", () => {
  const primary = { relationship: "primary" as const, trailId: "t1", signal: null };

  it("one primary Trail is accepted", () => {
    const r = capTrailLabels([], [primary]);
    assert.deepEqual(r.accepted, [primary]);
    assert.deepEqual(r.refusals, []);
  });

  it("a SECOND primary Trail is refused — §4 says content has ONE primary Trail", () => {
    const r = capTrailLabels([primary], [{ relationship: "primary", trailId: "t2", signal: null }]);
    assert.deepEqual(r.accepted, []);
    assert.equal(r.refusals[0].reason, "primary_already_set");
  });

  it(`supporting Trails are capped at MAX_SUPPORTING_TRAILS (${MAX_SUPPORTING_TRAILS})`, () => {
    const have = Array.from({ length: MAX_SUPPORTING_TRAILS }, (_, i) => ({
      relationship: "supporting" as const, trailId: `s${i}`, signal: null,
    }));
    const r = capTrailLabels(have, [{ relationship: "supporting", trailId: "over", signal: null }]);
    assert.deepEqual(r.accepted, []);
    assert.equal(r.refusals[0].reason, "supporting_cap");
  });

  it(`signals are capped at MAX_SIGNALS (${MAX_SIGNALS}) and the cap is per CLASS, not shared`, () => {
    const have = [
      primary,
      ...TRAIL_SIGNALS.slice(0, MAX_SIGNALS).map((s) => ({
        relationship: "signal" as const, trailId: "t1", signal: s,
      })),
    ];
    const r = capTrailLabels(have, [
      { relationship: "signal", trailId: "t1", signal: TRAIL_SIGNALS[MAX_SIGNALS] },
    ]);
    assert.equal(r.refusals[0].reason, "signal_cap");
    // The supporting budget is untouched by a full signal budget.
    const s = capTrailLabels(have, [{ relationship: "supporting", trailId: "s0", signal: null }]);
    assert.equal(s.accepted.length, 1, "classes have separate budgets");
  });

  it("a signal outside §4's vocabulary is refused rather than stored as free text", () => {
    const r = capTrailLabels([], [{ relationship: "signal", trailId: "t1", signal: "vibes" }]);
    assert.deepEqual(r.accepted, []);
    assert.equal(r.refusals[0].reason, "unknown_signal");
  });

  it("re-attaching a label already present is refused as a duplicate, not silently doubled", () => {
    const r = capTrailLabels([primary], [primary]);
    assert.deepEqual(r.accepted, []);
    assert.equal(r.refusals[0].reason, "duplicate");
  });

  it("a batch that overflows mid-way accepts the prefix and refuses the rest — never all-or-nothing silence", () => {
    const batch = TRAIL_SIGNALS.slice(0, MAX_SIGNALS + 2).map((s) => ({
      relationship: "signal" as const, trailId: "t1", signal: s,
    }));
    const r = capTrailLabels([], batch);
    assert.equal(r.accepted.length, MAX_SIGNALS);
    assert.equal(r.refusals.length, 2);
    assert.ok(r.refusals.every((x) => x.reason === "signal_cap"));
  });
});

// ── DC-04: §7 lifecycle is a relation, not a text column ─────────────────────

describe("DC-04 — §7 Trail lifecycle and in-Trail content lifecycle are transition relations", () => {
  it("proposed → active is allowed; proposed → featured is not a Trail state at all", () => {
    assert.equal(isTrailLifecycleTransitionAllowed("proposed", "active"), true);
    assert.equal(isTrailLifecycleTransitionAllowed("proposed", "featured" as any), false);
  });

  it("archived is terminal — nothing leaves it (§15 merges rather than resurrects)", () => {
    for (const to of TRAIL_LIFECYCLE_STATES) {
      assert.equal(isTrailLifecycleTransitionAllowed("archived", to), false, `archived → ${to}`);
    }
  });

  it("a no-op transition is refused, so an idempotent write cannot masquerade as a state change", () => {
    assert.equal(isTrailLifecycleTransitionAllowed("active", "active"), false);
  });

  it("stale may be revived to active (§15 'mark stale' is not a death sentence)", () => {
    assert.equal(isTrailLifecycleTransitionAllowed("stale", "active"), true);
    assert.equal(isTrailLifecycleTransitionAllowed("needs_update", "active"), true);
  });

  it("content lifecycle: just_arrived climbs, and only archived content can be rediscovered", () => {
    assert.equal(isTrailContentTransitionAllowed("just_arrived", "growing"), true);
    assert.equal(isTrailContentTransitionAllowed("growing", "featured"), true);
    assert.equal(isTrailContentTransitionAllowed("featured", "evergreen"), true);
    assert.equal(isTrailContentTransitionAllowed("archived_from_active_rotation", "rediscovered"), true);
    assert.equal(isTrailContentTransitionAllowed("just_arrived", "rediscovered"), false,
      "nothing never-cooled can be REdiscovered — that would be a word doing no work");
    assert.equal(isTrailContentTransitionAllowed("just_arrived", "evergreen"), false,
      "evergreen is earned through the ladder, not asserted on arrival");
  });

  it("every state in each vocabulary is reachable, so no state is decoration", () => {
    const reachable = (states: readonly string[], allowed: (a: any, b: any) => boolean, root: string) => {
      const seen = new Set([root]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const a of seen) for (const b of states) {
          if (!seen.has(b) && allowed(a, b)) { seen.add(b); grew = true; }
        }
      }
      return seen;
    };
    assert.equal(
      reachable(TRAIL_LIFECYCLE_STATES, isTrailLifecycleTransitionAllowed, "proposed").size,
      TRAIL_LIFECYCLE_STATES.length);
    assert.equal(
      reachable(TRAIL_CONTENT_STATES, isTrailContentTransitionAllowed, "just_arrived").size,
      TRAIL_CONTENT_STATES.length);
  });
});
