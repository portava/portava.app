/**
 * discoverySequenceFeatures — `04` §8's four behaviour chains, derived server-side.
 *
 * WHAT §8 ACTUALLY SAYS
 * =====================
 * `docs/specs/discovery-v1/04_Behavior_Engine.md` §8 "Behavior chains" lists
 * four high-value sequences, verbatim:
 *
 *     impression → place_open → save → trip_add
 *     video_complete → replay → send
 *     Trail open → place open → directions
 *     post → place visit → post-visit confirmation
 *
 * and then states the rule this module is the second half of:
 *
 *     "Sequence features should be derived downstream rather than hard-coded
 *      into clients."
 *
 * The prohibition half already held — no client in this repository computes a
 * chain. What did not exist was any derivation at all, anywhere: nothing was
 * hard-coded in the client because nothing was computed. This is that
 * derivation. The four chains above are the ONLY four; none is invented and
 * none is dropped.
 *
 * READ THIS BEFORE RE-OPENING THE ROW: THESE FEATURES ARE VACUOUS TODAY
 * ====================================================================
 * census-discovery §5 records that Discovery is DARK IN PRODUCTION — thirteen
 * `surface='discovery'` rows in `rank_events` ever, the latest on 2026-08-15.
 * Every chain below will therefore compute zero, or near zero, on the current
 * corpus, and will keep doing so until the surface is actually reached.
 *
 * That is a fact about TRAFFIC, not about this code. The census row grades
 * whether the derivation EXISTS, not whether it has data, and this paragraph is
 * written down so the next census does not read an empty chain as a missing
 * one and re-open a row that is closed. A derivation with no traffic is exactly
 * what a dark surface's instrumentation is supposed to look like.
 *
 * NO MIGRATION. THE LIVE SCHEMA ALREADY CARRIES WHAT THIS NEEDS
 * ============================================================
 * Production `rank_events` is thirteen columns: `id, user_id, item_id,
 * item_kind, position, features, outcome, served_at, outcome_at, surface,
 * session_id, event_type, content_type`. The five this module reads —
 * `user_id`, `session_id`, `item_id`, `outcome`, `served_at` — plus `surface`
 * for scoping are all present, so nothing here waits on a deployment.
 *
 * AND MOST OF §8's STEPS ARE STILL NOT IN IT
 * =========================================
 * The outcome CHECK vocabulary is `impression, tap, save, join, rsvp, attended,
 * analytics` (0153/0197), plus `dismiss` (2297) and `trip_add` (2894). That
 * covers ALL FOUR steps of the first chain and one step of the third. It
 * carries no token for `video_complete`, `replay` or `send`, for a Trail open,
 * for directions, for a post, for a place visit or for a post-visit
 * confirmation — and there is no `dwell_ms`, `completion_pct` or `trail_id`
 * column to stand in (census-discovery DV-38, DV-41, DV-78 each record one).
 *
 * Those steps come back `null` and are NAMED in `unrepresentableSteps`. A zero
 * would say "measured, and it never happened", which is the exact failure this
 * census exists to make impossible. Borrowing a neighbouring token would be
 * worse — and note what 2894 did NOT do: it did not make `join` mean a trip
 * add, it gave the trip add a token of its own. `attended` is still a funnel
 * token rather than a visit confirmation (census-discovery DV-19 says so).
 *
 * WHAT `trip_add` READS TODAY, AND WHY ZERO IS NOT NULL
 * ====================================================
 * 2894 admits the token; nothing WRITES it. `POST /api/places/:placeId/add-to-
 * trip-plan` (routes/plan.ts) is the production trip-add site for a Discovery
 * place and reports no outcome. So the trip_add step's counts are REAL numbers
 * that will read 0 until that writer exists — a step that was measured and
 * found empty, which is a different fact from a step nothing can record. The
 * first is `reached: 0`; the second is `reached: null` beside a named reason.
 *
 * WHY A CHAIN IS RECONSTRUCTED FROM ONE ROW AND NOT FROM SEVERAL
 * =============================================================
 * `rank_events` is a MUTABLE-STATE table. `POST /api/rank-events/outcome`
 * UPDATES the impression row in place, and `upgradableOutcomesFor` admits only
 * a strictly LOWER funnel rung, so a row can never downgrade. One (user, item,
 * surface, session) therefore holds exactly ONE outcome, and it is the furthest
 * rung that pair reached.
 *
 * So the sequence is not a series of rows to be ordered by `served_at`; it is a
 * terminal rung to be read off one row, with monotonicity guaranteed at WRITE
 * time by the route rather than assumed at read time here. `served_at` bounds
 * the window and nothing else.
 *
 * The cost of that shape, stated rather than hidden: at rung 2 the funnel forks
 * into `save | join | rsvp`, and a pair that ended at `attended` passed the
 * rung without saying through which of the three. `reached` therefore counts
 * "got at least this far" and `exact` counts "stopped exactly here", and both
 * are reported so a reader never has to guess which question a number answers.
 *
 * FAILS CLOSED
 * ============
 * An unreadable read reports `unreadable` and every count `null`. It does NOT
 * report a corpus of zero events: "the viewer did nothing" and "I could not
 * find out what the viewer did" are different facts, and only one of them is a
 * feature.
 */
import { logger } from "./logger.js";

/** The projection of `rank_events` this module reads. Structural, so callers can pass their own rows. */
export interface SequenceEvent {
  user_id: string;
  session_id: string | null;
  item_id: string;
  outcome: string;
  served_at: string;
}

/**
 * One step of one chain, and what the live schema has for it.
 *
 * `outcome` is the `rank_events.outcome` token that stands for this step, or
 * `null` when no column in the thirteen carries it — in which case
 * `unrepresentable` says which absence it is, so the gap is readable rather
 * than inferable.
 */
export interface SequenceChainStepSpec {
  step: string;
  outcome: string | null;
  unrepresentable: string | null;
}

export interface SequenceChainSpec {
  /** Stable key, for storage and for tests. */
  id: string;
  /** The chain exactly as `04` §8 writes it, punctuation and capitalisation included. */
  chain: string;
  steps: readonly SequenceChainStepSpec[];
}

/**
 * The funnel rungs, read out of `routes/rankEvents.ts` rather than restated
 * from memory: impression → tap → save/join/rsvp → trip_add → attended.
 *
 * `trip_add` (migration 2894) sits ABOVE save because that is the order `04` §8
 * writes the chain in, and BELOW attended because a plan to go is not a visit.
 * The route narrows its upgradable set further — a trip add may not consume a
 * join or an rsvp — but that is a WRITE-time rule about which rows may be
 * overwritten; for READING a terminal rung, the ordering above is the whole of
 * it, and a pair that ended at trip_add passed through save on the way.
 *
 * `dismiss` sits at the impression rung and goes no further. It is deliberately
 * not a rung of its own: a dismissed row WAS impressed (the route only admits a
 * dismiss against a row still at `impression`), and it is terminal, so a
 * dismissed pair must count towards the impression step and towards no step
 * above it. Calling it a tap would turn the strongest negative signal the
 * surface has into a place open.
 *
 * `analytics` is absent on purpose and is filtered out before any of this runs:
 * DiscoveryRankingService writes one analytics row per SCORED CANDIDATE, so a
 * single request can emit 180 of them for a page of 20. Counting those as
 * impressions would make every chain's first step a measure of the ranker's
 * candidate volume wearing a user's name.
 */
const TERMINAL_RUNG: Readonly<Record<string, number>> = {
  impression: 0,
  dismiss:    0,
  tap:        1,
  save:       2,
  join:       2,
  rsvp:       2,
  trip_add:   3,
  attended:   4,
};

/** Outcomes that are not behaviour: written by the ranker, never by a user. */
const NON_BEHAVIOUR_OUTCOMES = new Set(["analytics"]);

const NO_MEDIA_PROGRESS =
  "no completion or playback column exists — 04 §6 names completion_pct and dwell_ms, and the live " +
  "13-column schema carries neither (census-discovery DV-38, DV-41)";
const NO_SEND =
  "no send/share outcome token and no share writer on this surface (census-discovery DV-78)";
const NO_TRAIL_OBJECT =
  "there is no Trail object to open: rank_events has no trail_id and item_kind's CHECK has no 'trail' " +
  "(census-discovery DV-78 grades Trail open FAIL for exactly this reason)";
const NO_DIRECTIONS =
  "no directions outcome token and no directions writer anywhere in the tree";
const NO_AUTHORED_POST =
  "a post AUTHORED is not an event this table records; item_kind='post' is an IMPRESSION of somebody " +
  "else's post, which is the opposite end of the chain";
const NO_VISIT =
  "no visit signal exists — 'attended' is a funnel token, not a visit confirmation (census-discovery DV-19)";

/**
 * `04` §8's four chains. The list is closed: four, in the spec's order, spelled
 * as the spec spells them.
 */
export const BEHAVIOR_CHAINS: readonly SequenceChainSpec[] = [
  {
    id: "impression_place_open_save_trip_add",
    chain: "impression → place_open → save → trip_add",
    steps: [
      { step: "impression", outcome: "impression", unrepresentable: null },
      // The discovery surface reports 'tap' when a place card opens its detail
      // sheet — routes/rankEvents.ts says so in its own funnel comment, which is
      // why place_open maps here rather than to an invented token.
      { step: "place_open", outcome: "tap", unrepresentable: null },
      { step: "save", outcome: "save", unrepresentable: null },
      // Migration 2894 gave the trip add a token of its own. It is NOT `join`:
      // borrowing the events/plans rung was considered and refused, and the
      // refusal stands — 2894 removed the reason for it rather than undoing it.
      // Nothing writes this token yet (routes/plan.ts records no outcome), so
      // the counts below are real numbers that read 0 until a writer exists.
      { step: "trip_add", outcome: "trip_add", unrepresentable: null },
    ],
  },
  {
    id: "video_complete_replay_send",
    chain: "video_complete → replay → send",
    steps: [
      { step: "video_complete", outcome: null, unrepresentable: NO_MEDIA_PROGRESS },
      { step: "replay", outcome: null, unrepresentable: NO_MEDIA_PROGRESS },
      { step: "send", outcome: null, unrepresentable: NO_SEND },
    ],
  },
  {
    id: "trail_open_place_open_directions",
    chain: "Trail open → place open → directions",
    steps: [
      { step: "trail_open", outcome: null, unrepresentable: NO_TRAIL_OBJECT },
      { step: "place_open", outcome: "tap", unrepresentable: null },
      { step: "directions", outcome: null, unrepresentable: NO_DIRECTIONS },
    ],
  },
  {
    id: "post_place_visit_confirmation",
    chain: "post → place visit → post-visit confirmation",
    steps: [
      { step: "post", outcome: null, unrepresentable: NO_AUTHORED_POST },
      { step: "place_visit", outcome: null, unrepresentable: NO_VISIT },
      { step: "post_visit_confirmation", outcome: null, unrepresentable: NO_VISIT },
    ],
  },
];

/** How the derivation went. `no_client` is spelled as `ModifiersReason` spells it. */
export type SequenceReadReason = "derived" | "no_client" | "unreadable";

export interface SequenceStepFeature {
  step: string;
  /** The rank_events.outcome token standing for this step, or null when none does. */
  outcome: string | null;
  /** Why nothing stands for it. Present exactly when `outcome` is null. */
  unrepresentable: string | null;
  /**
   * Pairs that got AT LEAST this far. Monotonically non-increasing down a
   * chain, which is what makes it a funnel. Null — never 0 — when the step is
   * unrepresentable or the corpus could not be read.
   */
  reached: number | null;
  /** Pairs whose furthest recorded outcome is EXACTLY this step's token. Null as above. */
  exact: number | null;
}

export interface SequenceChainFeature {
  id: string;
  /** The chain as `04` §8 writes it. */
  chain: string;
  steps: SequenceStepFeature[];
  /** Reach of the FIRST representable step; null when no step is representable. */
  observedStart: number | null;
  /** Reach of the LAST representable step; null as above. */
  observedEnd: number | null;
  /**
   * `observedEnd / observedStart` — the conversion of the OBSERVABLE PREFIX,
   * which is not the chain's conversion unless `fullyRepresentable` is true.
   * Null when there is no prefix, or nothing to divide by.
   */
  observedConversion: number | null;
  /** The steps nothing in the schema carries, BY NAME, so silence is never read as zero. */
  unrepresentableSteps: readonly string[];
  /** True only when every step of the chain has a token. False for all four today. */
  fullyRepresentable: boolean;
}

export interface DiscoverySequenceFeatures {
  reason: SequenceReadReason;
  /** The surface the events were scoped to. */
  surface: string;
  /** How far back the window reached, in ms. */
  windowMs: number;
  /** Behaviour rows read (analytics rows excluded). 0 on a failed read, alongside `reason`. */
  events: number;
  /** Distinct sessions among them. */
  sessions: number;
  /** Rows carrying no session_id. COVERAGE: they cannot be placed in a sequence. */
  unsessioned: number;
  /** Distinct (session, item) pairs the chains are counted over. */
  pairs: number;
  chains: SequenceChainFeature[];
}

/**
 * 30 days. The same horizon `buildPlaceAffinities` uses for place engagement,
 * so two per-viewer behaviour reads on the same request do not silently
 * describe two different stretches of the user's life.
 */
export const SEQUENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

/** Cap on rows read. Ordered most-recent-first, so the window degrades by age, not at random. */
export const SEQUENCE_MAX_ROWS = 1_000;

const DISCOVERY_SURFACE = "discovery";

/** Pair key. A NUL separator, because an item id may legitimately contain any printable character. */
const PAIR_SEP = "\u0000";

/** The shape every chain takes when nothing could be derived: named, and entirely null. */
function unknownChains(): SequenceChainFeature[] {
  return BEHAVIOR_CHAINS.map((spec) => ({
    id: spec.id,
    chain: spec.chain,
    steps: spec.steps.map((s) => ({
      step: s.step, outcome: s.outcome, unrepresentable: s.unrepresentable,
      reached: null, exact: null,
    })),
    observedStart: null,
    observedEnd: null,
    observedConversion: null,
    unrepresentableSteps: spec.steps.filter((s) => s.outcome === null).map((s) => s.step),
    fullyRepresentable: spec.steps.every((s) => s.outcome !== null),
  }));
}

/** The whole answer when there is nothing to answer from. Counts are 0 BESIDE a reason that says why. */
function unknownFeatures(reason: SequenceReadReason): DiscoverySequenceFeatures {
  return {
    reason,
    surface: DISCOVERY_SURFACE,
    windowMs: SEQUENCE_WINDOW_MS,
    events: 0, sessions: 0, unsessioned: 0, pairs: 0,
    chains: unknownChains(),
  };
}

/**
 * Pure: rows → the four chains. No clock, no client, no throw.
 *
 * Every count is over DISTINCT (session_id, item_id) pairs rather than over
 * rows, because the funnel lives on the pair: one place shown twice in one
 * session is one chain, and counting it twice would inflate the top of every
 * funnel while leaving the bottom alone.
 */
export function deriveSequenceFeatures(rows: readonly SequenceEvent[]): DiscoverySequenceFeatures {
  const terminalByPair = new Map<string, number>();
  const exactByPair = new Map<string, string>();
  const sessions = new Set<string>();
  let events = 0;
  let unsessioned = 0;

  for (const r of rows) {
    if (!r || typeof r.outcome !== "string") continue;
    if (NON_BEHAVIOUR_OUTCOMES.has(r.outcome)) continue;
    const rung = TERMINAL_RUNG[r.outcome];
    if (rung === undefined) continue;          // an outcome this module has never heard of is not guessed at
    events += 1;

    const session = typeof r.session_id === "string" && r.session_id.length > 0 ? r.session_id : null;
    if (session === null) {
      // A row with no session cannot be placed in a sequence. It is reported as
      // coverage and dropped from the chains, rather than being folded into a
      // pseudo-session — which would invent an ordering nothing recorded.
      unsessioned += 1;
      continue;
    }
    sessions.add(session);

    const key = `${session}${PAIR_SEP}${r.item_id}`;
    const prior = terminalByPair.get(key);
    // The route cannot downgrade a row, but a viewer's history can hold two
    // rows for the same pair across requests; the furthest rung is the one the
    // pair reached.
    if (prior === undefined || rung > prior) {
      terminalByPair.set(key, rung);
      exactByPair.set(key, r.outcome);
    }
  }

  const rungs = [...terminalByPair.values()];
  const exacts = [...exactByPair.values()];

  const chains = BEHAVIOR_CHAINS.map((spec): SequenceChainFeature => {
    const steps = spec.steps.map((s): SequenceStepFeature => {
      if (s.outcome === null) {
        return { step: s.step, outcome: null, unrepresentable: s.unrepresentable, reached: null, exact: null };
      }
      const stepRung = TERMINAL_RUNG[s.outcome]!;
      return {
        step: s.step,
        outcome: s.outcome,
        unrepresentable: null,
        reached: rungs.filter((r) => r >= stepRung).length,
        exact: exacts.filter((o) => o === s.outcome).length,
      };
    });

    const representable = steps.filter((s) => s.outcome !== null);
    const observedStart = representable.length === 0 ? null : representable[0]!.reached;
    const observedEnd = representable.length === 0 ? null : representable[representable.length - 1]!.reached;
    return {
      id: spec.id,
      chain: spec.chain,
      steps,
      observedStart,
      observedEnd,
      observedConversion:
        observedStart === null || observedEnd === null || observedStart === 0 ? null : observedEnd / observedStart,
      unrepresentableSteps: spec.steps.filter((s) => s.outcome === null).map((s) => s.step),
      fullyRepresentable: spec.steps.every((s) => s.outcome !== null),
    };
  });

  return {
    reason: "derived",
    surface: DISCOVERY_SURFACE,
    windowMs: SEQUENCE_WINDOW_MS,
    events,
    sessions: sessions.size,
    unsessioned,
    pairs: terminalByPair.size,
    chains,
  };
}

/**
 * Read this viewer's recent discovery behaviour and derive the chains from it.
 *
 * Non-fatal in the same way every other per-viewer read on this path is: it
 * never throws, and a failure degrades the ranking inputs rather than the
 * request. What it must NOT do is degrade quietly into a corpus of zero — that
 * would hand the ranker a viewer who provably did nothing, built out of a read
 * that never happened.
 */
export async function loadSequenceFeatures(
  sc: any,
  userId: string,
  opts: { nowMs?: number } = {},
): Promise<DiscoverySequenceFeatures> {
  if (!sc) return unknownFeatures("no_client");

  try {
    const since = new Date((opts.nowMs ?? Date.now()) - SEQUENCE_WINDOW_MS).toISOString();
    const { data, error } = await sc
      .from("rank_events")
      .select("user_id, session_id, item_id, outcome, served_at")
      .eq("user_id", userId)
      .eq("surface", DISCOVERY_SURFACE)
      // Excluded at the database rather than only in the loop above, so a
      // viewer whose history is mostly scored candidates does not spend the
      // row cap on rows this module throws away.
      .neq("outcome", "analytics")
      .gte("served_at", since)
      .order("served_at", { ascending: false })
      .limit(SEQUENCE_MAX_ROWS);

    if (error) {
      logger.warn({ err: error, userId }, "discoverySequenceFeatures: rank_events read rejected — chains are UNKNOWN for this viewer, not empty");
      return unknownFeatures("unreadable");
    }
    return deriveSequenceFeatures(((data as any[]) ?? []) as SequenceEvent[]);
  } catch (err) {
    logger.warn({ err }, "discoverySequenceFeatures: rank_events read threw — chains are UNKNOWN for this viewer, not empty");
    return unknownFeatures("unreadable");
  }
}
