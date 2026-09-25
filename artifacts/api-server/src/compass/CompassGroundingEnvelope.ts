/**
 * CompassGroundingEnvelope — Sensing `:148`, enforced on the text the model
 * actually produced.
 *
 * ── WHAT WAS MISSING, STATED AS THE CENSUS STATED IT ─────────────────────────
 * census-compass CX-04 scores Sensing `:148` ("ground natural-language claims in
 * structured truth") BUILT-BUT-WRONG, and its reason is precise:
 *
 *     "More grounding exists than the registry credited: the CANDIDATE RULE, a
 *      CONFIDENCE RULE that forbids claiming live status without verified_live
 *      data, factor-grounded 'why this', and UI blocks that drop any id the
 *      tools did not return. All of it is INPUT-side or REFERENCE-side; nothing
 *      reads the model's prose back against the confidence band of its inputs.
 *      The failure the spec names (low-confidence dance_likelihood → 'everyone
 *      is dancing') is prevented only by prompt text."
 *
 * A prompt rule is a request, not a boundary. This module is the boundary: it
 * reads the answer the model produced, compares the CLAIMS in it against the
 * CONFIDENCE of the tool results of the same turn, and refuses to publish an
 * unhedged current-conditions claim that no datum in the turn supports.
 *
 * The shape is deliberately `services/airport/LayoverCompassService.ts`'s
 * `enforceCompassEnvelope`, which is the tree's existing precedent for reading
 * model prose back against a certified record (census-compass CL-02, moved
 * W→C on exactly that argument). Same posture, different certified record:
 * there it is a layover's deadline and usable minutes, here it is whether any
 * tool result in the turn carried a `verified_live` source class at all.
 *
 * ── WHY IT ANNOTATES INSTEAD OF REPLACING ────────────────────────────────────
 * The layover guard REPLACES a refused answer with a deterministic one, and it
 * can: that answer is one paragraph about one certified record, so discarding it
 * loses nothing that was not already in the record. A Compass answer is free
 * prose over many candidates, most of them correctly grounded; replacing all of
 * it because one sentence over-claimed would throw away grounded content and
 * tell the user less than before. So a refusal here APPENDS a bounded,
 * server-authored correction and the published message carries it. Nothing the
 * model wrote is deleted, and nothing it over-claimed is published unqualified.
 *
 * That choice also survives the streaming path, which a replacement does not.
 * `/compass/ask`'s streamed branch sends the final round token by token and the
 * client rebuilds the bubble from the accumulated deltas
 * (`travel-buddy-standalone/src/services/compass.ts:897#message`), so a
 * replacement computed after the last token is already too late to un-say
 * anything. An appended correction is one more delta and reaches the live bubble
 * with no client change. The words already sent cannot be retracted, and the
 * correction says so rather than pretending otherwise.
 *
 * ── WHY EVERY TRIGGER IS NARROW ──────────────────────────────────────────────
 * A guard that fires on innocent sentences gets turned off, so each trigger
 * below needs BOTH a claim shape and the absence of a hedge, and each fires only
 * when the turn's own tool results cannot support the claim. An answer that
 * already labels its claim as last-known — which the CONFIDENCE RULE asks the
 * model to do, and which it usually does — is not a violation and is not
 * flagged. Being unable to police a correctly-hedged sentence is the point.
 */

/** What kind of claim outran the turn's evidence. */
import { isTruthClass, truthClassMayRenderAsObservation, weakestTruthClass, type TruthClass } from "../lib/truthClass.js";

export type GroundingViolationKind =
  /** A current-conditions claim with no `verified_live` datum anywhere in the turn. */
  | "live_claim_without_verified_source"
  /** A wait/queue figure when no tool returned a wait datum. */
  | "wait_time_without_source"
  /** "everyone is dancing" — a present-progressive crowd assertion with no crowd datum. */
  | "crowd_claim_without_observation"
  /** "it's a ten-minute walk" when no tool returned a travel term for any route. */
  | "travel_duration_without_route"
  /**
   * CPV2-02 — a state asserted about a subject whose evidence is PREDICTED,
   * INFERRED, CONFLICTING, STALE or UNKNOWN, without the qualification the
   * evidence carried. The datum kept its class through the tool result; the
   * prose dropped it.
   */
  | "truth_class_not_qualified";

export interface GroundingViolation {
  kind: GroundingViolationKind;
  /** The fragment of the answer that triggered it, bounded for logging. */
  stated: string;
  /** What the turn's tool results actually carried. */
  available: string;
}

/**
 * The confidence band of a turn's inputs, reduced to the four facts a claim can
 * be checked against.
 */
export interface GroundingEvidence {
  /** Some tool result carried `confidence.sourceClass === "verified_live"`. */
  hasVerifiedLive: boolean;
  /** Some tool result carried a wait/queue reading. */
  hasWaitDatum: boolean;
  /** Some tool result carried a crowd / occupancy / busyness reading. */
  hasCrowdDatum: boolean;
  /** Some tool result carried a MEASURED travel term for a route or hop. */
  hasRouteDatum: boolean;
  /** Every distinct `sourceClass` seen, sorted — for the log line and the note. */
  sourceClasses: string[];
  /**
   * CPV2-02 — the WEAKEST §5.1 truth class any tool result declared this turn
   * (lib/truthClass `weakestTruthClass`), or null when none declared one. An
   * absent class is NOT read as `unknown`: a tool that says nothing leaves the
   * source-class checks above to do their work; a tool that says `unknown` is
   * making a claim, and the claim is kept.
   */
  truthClass: TruthClass | null;
  /**
   * CCL-12 — the same four facts, attached to the SUBJECT each datum was read
   * under rather than pooled across the turn. A sentence that names a subject
   * is checked against that subject's own band; the turn-level booleans above
   * are the fallback for a sentence that names none.
   */
  subjects: readonly SubjectEvidence[];
}

/** What one named subject's own tool data carried. */
export interface SubjectEvidence {
  /** The subject's id where the tool result gave one; null when it gave only a name. */
  subjectId: string | null;
  /** The name as the model would write it — UGC wrapper removed. */
  name: string;
  hasVerifiedLive: boolean;
  hasWaitDatum: boolean;
  hasCrowdDatum: boolean;
  hasRouteDatum: boolean;
  /** The weakest truth class declared under this subject, or null when none was. */
  truthClass: TruthClass | null;
}

/** The bands a claim can be checked against, for a subject or for the turn. */
type EvidenceBand = Pick<
  GroundingEvidence,
  "hasVerifiedLive" | "hasWaitDatum" | "hasCrowdDatum" | "hasRouteDatum" | "truthClass"
>;

export const EMPTY_GROUNDING_EVIDENCE: GroundingEvidence = Object.freeze({
  hasVerifiedLive: false,
  hasWaitDatum: false,
  hasCrowdDatum: false,
  hasRouteDatum: false,
  sourceClasses: Object.freeze([]) as unknown as string[],
  truthClass: null,
  subjects: Object.freeze([]) as readonly SubjectEvidence[],
});

/**
 * Keys that ARE a wait reading. Matched on the key, not on a number in the
 * payload: a tool that returns `{ minutes: 15 }` for a walking time is not
 * evidence that a queue was measured, and treating it as such would grant the
 * model a licence the data never gave it.
 */
const WAIT_KEYS = new Set([
  "waitminutes", "wait_minutes", "waittime", "wait_time", "queuewait", "queue_wait",
  "queuewaitminutes", "queue_wait_minutes", "queueminutes", "queue_minutes",
]);

/** Keys that ARE a crowd / occupancy reading. */
const CROWD_KEYS = new Set([
  "crowdlevel", "crowd_level", "crowdtrajectory", "crowd_trajectory",
  "occupancy", "busyness", "busy_level", "busylevel", "dance_likelihood", "dancelikelihood",
  "packedlevel", "packed_level", "popularity_now", "popularitynow",
]);

/**
 * Keys that ARE a MEASURED travel term. `durationMinutes` is deliberately NOT
 * here: the tool set uses it for a free window and for a live session's length,
 * and a dwell time is not a route. CPV2-03's "an unmeasured route remains
 * unknown, not zero" is carried by the same null rule the wait keys use — a hop
 * that reports `boundMinutes: null` with an `unknownReason` says it could not
 * measure the term, and counting that as evidence is the fail-open this trigger
 * exists to prevent.
 */
const ROUTE_KEYS = new Set([
  "boundminutes", "bound_minutes", "expectedminutes", "expected_minutes",
  "etaminutes", "eta_minutes", "travelminutes", "travel_minutes",
  "traveltimeminutes", "travel_time_minutes", "routeminutes", "route_minutes",
  "walkminutes", "walk_minutes", "walkingminutes", "walking_minutes",
  "drivingminutes", "driving_minutes", "transitminutes", "transit_minutes",
]);

/**
 * Keys whose string value NAMES a subject. A tool result that carries one is
 * the node every datum beneath it is attributed to (CCL-12).
 */
const SUBJECT_NAME_KEYS = new Set(["name", "title", "placename", "place_name", "venuename", "venue_name"]);
/** Keys whose string value IDENTIFIES the subject a name belongs to. */
const SUBJECT_ID_KEYS = new Set(["id", "placeid", "place_id", "subjectid", "subject_id", "venueid", "venue_id"]);

/** A name short enough to collide with ordinary prose is not usable for attribution. */
const MIN_SUBJECT_NAME_LENGTH = 3;

/** Remove the UGC envelope a tool wraps user text in, so the name matches the prose. */
function unwrapUgc(text: string): string {
  return text.replace(/<\/?portava:ugc>/gi, "").trim();
}

/** Recursion bounds — a tool result is attacker-adjacent data, not a config file. */
const MAX_DEPTH = 10;
const MAX_NODES = 50_000;

/**
 * Read the confidence band out of a turn's tool results.
 *
 * Walks the JSON the tools returned rather than asking each tool to declare its
 * own band: the tool set is forty-one entries across three modules and growing,
 * and a per-tool declaration is one more thing that can silently fall out of
 * step with what the tool returns. The walk sees whatever shipped.
 */
export function readGroundingEvidence(toolResults: readonly unknown[]): GroundingEvidence {
  const sourceClasses = new Set<string>();
  const turnTruth: TruthClass[] = [];
  let hasWaitDatum = false;
  let hasCrowdDatum = false;
  let hasRouteDatum = false;
  let nodes = 0;

  /**
   * CCL-12 — one accumulator per subject, keyed on its id where the tool gave
   * one and on its name otherwise, so the same place returned twice in a turn
   * accumulates rather than splitting into two half-evidenced subjects.
   */
  const subjects = new Map<string, { subjectId: string | null; name: string; truth: TruthClass[] } & Omit<EvidenceBand, "truthClass">>();

  /** A datum counts only when it carries a reading; see the WAIT_KEYS note. */
  const present = (value: unknown): boolean => value !== null && value !== undefined && value !== false;

  const visit = (node: unknown, depth: number, subjectKey: string | null): void => {
    if (node === null || node === undefined) return;
    if (depth > MAX_DEPTH) return;
    if (++nodes > MAX_NODES) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, subjectKey);
      return;
    }
    if (typeof node !== "object") return;
    const entries = Object.entries(node as Record<string, unknown>);

    // Does THIS node name a subject? If so it, and everything under it, is
    // attributed to that subject rather than to the enclosing one.
    let name: string | null = null;
    let id: string | null = null;
    for (const [rawKey, value] of entries) {
      const key = rawKey.toLowerCase();
      if (name === null && SUBJECT_NAME_KEYS.has(key) && typeof value === "string") {
        const unwrapped = unwrapUgc(value);
        if (unwrapped.length >= MIN_SUBJECT_NAME_LENGTH) name = unwrapped;
      }
      if (id === null && SUBJECT_ID_KEYS.has(key) && typeof value === "string" && value.length > 0) id = value;
    }
    let here = subjectKey;
    if (name !== null) {
      here = id ?? `name:${name.toLowerCase()}`;
      if (!subjects.has(here)) {
        subjects.set(here, {
          subjectId: id, name, truth: [],
          hasVerifiedLive: false, hasWaitDatum: false, hasCrowdDatum: false, hasRouteDatum: false,
        });
      }
    }
    const bucket = here === null ? null : subjects.get(here) ?? null;

    for (const [rawKey, value] of entries) {
      const key = rawKey.toLowerCase();
      if (key === "sourceclass" && typeof value === "string" && value) {
        sourceClasses.add(value);
        if (bucket && value === "verified_live") bucket.hasVerifiedLive = true;
      }
      // CPV2-02 — a truth class is kept exactly as declared; an unrecognised
      // word is not a class and is not silently read as one.
      if (key === "truthclass" && isTruthClass(value)) {
        turnTruth.push(value);
        if (bucket) bucket.truth.push(value);
      }
      // A datum counts only when it actually carries a reading. `waitMinutes:
      // null` is a tool saying it could not measure one, and reading that as
      // evidence is the fail-open the CONFIDENCE RULE exists to prevent.
      if (WAIT_KEYS.has(key) && present(value)) { hasWaitDatum = true; if (bucket) bucket.hasWaitDatum = true; }
      if (CROWD_KEYS.has(key) && present(value)) { hasCrowdDatum = true; if (bucket) bucket.hasCrowdDatum = true; }
      if (ROUTE_KEYS.has(key) && present(value)) { hasRouteDatum = true; if (bucket) bucket.hasRouteDatum = true; }
      visit(value, depth + 1, here);
    }
  };

  for (const r of toolResults) visit(r, 0, null);

  return {
    hasVerifiedLive: sourceClasses.has("verified_live"),
    hasWaitDatum,
    hasCrowdDatum,
    hasRouteDatum,
    sourceClasses: [...sourceClasses].sort(),
    truthClass: turnTruth.length > 0 ? weakestTruthClass(turnTruth) : null,
    subjects: [...subjects.values()].map(({ truth, ...v }) => ({
      ...v,
      truthClass: truth.length > 0 ? weakestTruthClass(truth) : null,
    })),
  };
}

/**
 * A sentence that already labels its own uncertainty. The CONFIDENCE RULE asks
 * the model to write exactly these, so flagging one would punish compliance.
 */
const HEDGE =
  /\b(?:last[- ]known|historical(?:ly)?|can(?:no|')?t be verified|cannot be verified|could not be verified|not verified|unverified|usually|typically|generally|often|may be|might be|probably|likely|community[- ]reported|reported by (?:app )?users|no live|without live|based on (?:past|history))\b/i;

/**
 * CPV2-02 — the words that ARE a truth-class qualification. A sentence that
 * carries one has retained the evidence's class; flagging it would punish the
 * exact compliance the clause asks for. The list is lib/compassDecision's
 * TRUTH_WORDS plus the plain forms a model writes.
 */
const TRUTH_QUALIFIER =
  /\b(?:predicted|prediction|forecast|expected to|inferred|inference|reports differ|conflicting reports|reports disagree|stale|out of date|no current evidence|not known|unknown|estimate[ds]?)\b/i;

/** "right now", "currently", … — the marker that turns a statement into a live claim. */
const NOW_MARKER =
  /\b(?:right now|at the moment|as we speak|at this hour|currently|as of now|just now|this minute)\b/i;

/** The state words a NOW-marked sentence must also carry to be a live claim. */
const LIVE_STATE =
  /\b(?:open|closed|busy|packed|rammed|heaving|buzzing|quiet|empty|dead|crowded|full|queue|queues|line|lines|wait|waiting|dancing)\b/i;

/** A wait/queue figure in minutes. */
const WAIT_CLAIM =
  /\b(?:wait|queue|line)\b[^.!?]{0,40}?(\d{1,3})\s*(?:minutes?|mins?|m)\b|(\d{1,3})\s*(?:minutes?|mins?)\b[^.!?]{0,20}?\b(?:wait|queue|line)\b/i;

/**
 * A duration figure, in digits or in the small words a model writes. Paired
 * with TRAVEL_MODE below, never read on its own: a number of minutes is a dwell
 * time as often as it is a journey.
 */
const DURATION_FIGURE =
  /\b(?:\d{1,3}|a (?:few|couple of)|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|forty[- ]five|sixty|ninety)[\s-]*(?:minutes?|mins?|hours?|hrs?)\b/i;

/** The words that make a duration a TRAVEL duration rather than a dwell time. */
const TRAVEL_MODE =
  /\b(?:walk|walks|walking|on foot|stroll|drive|drives|driving|ride|rides|riding|cycle|cycling|bike|biking|away|door[- ]to[- ]door|commute|transit|taxi|uber|cab|metro|subway|tube|tram|bus|train|ferry)\b/i;

/** The spec's own example: "everyone is dancing". */
const CROWD_PROGRESSIVE =
  /\b(?:everyone|everybody|the whole place|the place|the crowd|the room|the bar|the floor)\s+(?:is|are|'s)\s+\w+ing\b/i;

/** Split into sentences so a hedge on one sentence does not excuse another. */
function sentencesOf(answer: string): string[] {
  return answer
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOTE_PREFIX = "Grounding note:";

const NOTE_FOR: Record<GroundingViolationKind, string> = {
  live_claim_without_verified_source:
    "no source checked live in this turn, so treat anything above about conditions right now as last-known rather than checked just now.",
  wait_time_without_source:
    "no wait or queue reading was returned by any tool in this turn, so any wait figure above is not a measurement.",
  crowd_claim_without_observation:
    "no crowd reading was returned by any tool in this turn, so any statement above about how busy a place is right now is not a measurement.",
  travel_duration_without_route:
    "no route or travel time was returned by any tool in this turn, so any journey time above is an estimate rather than a measured route.",
  truth_class_not_qualified:
    "the evidence behind at least one place above is not an observation (a prediction, an inference, disagreeing reports, stale data, or no current evidence), so any state asserted about it above carries that qualification even where the sentence dropped it.",
};

export interface GroundingResult {
  /** True when nothing over-claimed. */
  ok: boolean;
  /** The answer as published — the model's text, plus the correction when `ok` is false. */
  text: string;
  /** The appended correction, or null. Emitted separately so a stream can send it as one delta. */
  correction: string | null;
  violations: GroundingViolation[];
}

/** Escape a subject name for use inside a name-matching expression. */
function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does this sentence name this subject? Whole-phrase, case-insensitive. */
function sentenceNames(sentence: string, name: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeForRegex(name)}(?![\\p{L}\\p{N}])`, "iu").test(sentence);
}

/**
 * CCL-12 — the evidence band one sentence may be checked against.
 *
 * The clause is "attach evidence to the particular claim it supports; do not
 * attach a general valid citation to unsupported generated prose". The turn's
 * pooled booleans ARE that general citation: a `verified_live` datum about
 * place A licensed an unhedged live sentence about place B, because nothing
 * was bound to a subject. So: when a sentence names subjects the turn returned
 * data for, it is checked against THOSE subjects — and against all of them,
 * since a claim covering two places is licensed only when both carry the datum.
 * A sentence naming no returned subject has nothing to attach to and keeps the
 * turn-level band, which is the behaviour every existing case pins.
 */
function bandForSentence(sentence: string, evidence: GroundingEvidence): EvidenceBand {
  const named = evidence.subjects.filter((sub) => sentenceNames(sentence, sub.name));
  if (named.length === 0) {
    return {
      hasVerifiedLive: evidence.hasVerifiedLive,
      hasWaitDatum: evidence.hasWaitDatum,
      hasCrowdDatum: evidence.hasCrowdDatum,
      hasRouteDatum: evidence.hasRouteDatum,
      truthClass: evidence.truthClass,
    };
  }
  const declared = named.map((sub) => sub.truthClass).filter((c): c is TruthClass => c !== null);
  return {
    hasVerifiedLive: named.every((sub) => sub.hasVerifiedLive),
    hasWaitDatum: named.every((sub) => sub.hasWaitDatum),
    hasCrowdDatum: named.every((sub) => sub.hasCrowdDatum),
    // A route term is about a JOURNEY, not about a place, so a hop the turn
    // returned licenses the sentence whichever endpoint it names.
    hasRouteDatum: evidence.hasRouteDatum,
    // The WEAKEST class among the named subjects governs the sentence: a claim
    // covering an observed place and a predicted one is a predicted claim.
    truthClass: declared.length > 0 ? weakestTruthClass(declared) : null,
  };
}

/**
 * S79 — fold the CONTEXT's band together with the TOOL RESULTS' band.
 *
 * The census requires live claims in `/compass/ask`'s context first, then a
 * checker over the band of its inputs — and "its inputs" is both halves. A turn
 * where the model called no tool had `truthClass: null` and the two truth-class
 * triggers could not fire at all; carrying the context's claims in is what
 * makes the checker non-vacuous there.
 *
 * THE FOLD IS FAIL-WEAK ON EVERY AXIS, so that adding context can only ever
 * make the checker STRICTER:
 *
 *   • the datum booleans UNION. A crowd reading in either half means a crowd
 *     reading was available, which is honest — and on its own it would LOOSEN
 *     the crowd trigger, which is why the next line matters.
 *   • the truth class takes the WEAKEST of the two. So a context that supplies
 *     a `typical` crowd pattern turns off `crowd_claim_without_observation`
 *     (there WAS a reading) and turns on `truth_class_not_qualified` (it was
 *     not an observation). The sentence is still refused; it is refused for the
 *     accurate reason, which is the point of grounding against a BAND rather
 *     than against a presence bit.
 *   • subjects MERGE BY NAME, and a merged subject is weakest-wins on its truth
 *     class and AND-wins on `hasVerifiedLive`: a place the tools verified live
 *     and the context knows only a stale pattern for is not a live subject.
 *     `bandForSentence` already requires every named subject to carry a datum,
 *     so this keeps that posture inside one subject too.
 */
export function mergeGroundingEvidence(
  a: GroundingEvidence,
  b: GroundingEvidence,
): GroundingEvidence {
  const byName = new Map<string, SubjectEvidence>();
  for (const sub of [...(a.subjects ?? []), ...(b.subjects ?? [])]) {
    const key = sub.name.toLowerCase();
    const prior = byName.get(key);
    if (!prior) { byName.set(key, sub); continue; }
    byName.set(key, {
      subjectId: prior.subjectId ?? sub.subjectId,
      name: prior.name,
      // AND, not OR: a subject is only live-verified if BOTH halves that
      // mentioned it agree it is. One half's silence is not a veto — silence
      // produces no subject entry at all — but one half's contradiction is.
      hasVerifiedLive: prior.hasVerifiedLive && sub.hasVerifiedLive,
      // A reading in either half IS a reading; the truth class below is what
      // keeps that from becoming a licence.
      hasWaitDatum: prior.hasWaitDatum || sub.hasWaitDatum,
      hasCrowdDatum: prior.hasCrowdDatum || sub.hasCrowdDatum,
      hasRouteDatum: prior.hasRouteDatum || sub.hasRouteDatum,
      truthClass:
        prior.truthClass === null ? sub.truthClass
        : sub.truthClass === null ? prior.truthClass
        : weakestTruthClass([prior.truthClass, sub.truthClass]),
    });
  }

  const declared = [a.truthClass, b.truthClass].filter((c): c is TruthClass => c != null);
  return {
    hasVerifiedLive: a.hasVerifiedLive || b.hasVerifiedLive,
    hasWaitDatum: a.hasWaitDatum || b.hasWaitDatum,
    hasCrowdDatum: a.hasCrowdDatum || b.hasCrowdDatum,
    hasRouteDatum: a.hasRouteDatum || b.hasRouteDatum,
    sourceClasses: [...new Set([...(a.sourceClasses ?? []), ...(b.sourceClasses ?? [])])].sort(),
    // An absent class stays absent — see GroundingEvidence.truthClass — but once
    // either half DECLARES one, the weaker governs.
    truthClass: declared.length > 0 ? weakestTruthClass(declared) : null,
    subjects: [...byName.values()],
  };
}

/**
 * Sensing `:148` — read the prose back against the confidence band of its
 * inputs, and publish nothing that over-claims without saying so.
 */
export function enforceCompassGroundingEnvelope(
  answer: string,
  turnEvidence: GroundingEvidence,
): GroundingResult {
  const violations: GroundingViolation[] = [];
  const availableBand = turnEvidence.sourceClasses.length > 0
    ? turnEvidence.sourceClasses.join(", ")
    : "no source class in any tool result";

  for (const s of sentencesOf(answer)) {
    if (HEDGE.test(s)) continue;

    // CCL-12 — `evidence` is the band THIS SENTENCE may be checked against,
    // not the turn's pooled one. A sentence that names subjects is checked
    // against those subjects' own data; naming none falls back to the turn.
    // Naming several requires EVERY one of them to carry the datum, because
    // the claim covers all of them.
    const evidence = bandForSentence(s, turnEvidence);

    if (!evidence.hasVerifiedLive && NOW_MARKER.test(s) && LIVE_STATE.test(s)) {
      violations.push({
        kind: "live_claim_without_verified_source",
        stated: s.slice(0, 200),
        available: availableBand,
      });
    }
    const wait = WAIT_CLAIM.exec(s);
    if (!evidence.hasWaitDatum && wait) {
      violations.push({
        kind: "wait_time_without_source",
        stated: s.slice(0, 200),
        available: "no wait or queue datum",
      });
    }
    if (!evidence.hasCrowdDatum && CROWD_PROGRESSIVE.test(s)) {
      violations.push({
        kind: "crowd_claim_without_observation",
        stated: s.slice(0, 200),
        available: "no crowd datum",
      });
    }
    // CCL-11 — the fifth of the five classes the spec names. A journey time is
    // a measurement only when some tool returned a travel term for a route.
    if (!evidence.hasRouteDatum && DURATION_FIGURE.test(s) && TRAVEL_MODE.test(s)) {
      violations.push({
        kind: "travel_duration_without_route",
        stated: s.slice(0, 200),
        available: "no route or travel-time datum",
      });
    }
    // CPV2-02 — a state asserted over evidence that is not an observation must
    // keep the qualification the evidence carried. Only a DECLARED class is
    // judged (see GroundingEvidence.truthClass); a bare state word with no
    // qualifier over a predicted / inferred / conflicting / stale / unknown
    // class is the "inference upgraded into fact" the clause forbids.
    if (
      evidence.truthClass !== null &&
      !truthClassMayRenderAsObservation(evidence.truthClass) &&
      LIVE_STATE.test(s) &&
      !TRUTH_QUALIFIER.test(s)
    ) {
      violations.push({
        kind: "truth_class_not_qualified",
        stated: s.slice(0, 200),
        available: `truth class ${evidence.truthClass}`,
      });
    }
  }

  if (violations.length === 0) return { ok: true, text: answer, correction: null, violations };

  // One note per KIND, in a fixed order, so the same failure always reads the
  // same way and a test can pin it.
  const kinds: GroundingViolationKind[] = [
    "live_claim_without_verified_source",
    "wait_time_without_source",
    "crowd_claim_without_observation",
    "travel_duration_without_route",
    "truth_class_not_qualified",
  ];
  const seen = new Set(violations.map((v) => v.kind));
  const parts = kinds.filter((k) => seen.has(k)).map((k) => NOTE_FOR[k]);
  const correction = `${NOTE_PREFIX} ${parts.join(" ")}`;
  const text = answer.trim().length > 0 ? `${answer.trimEnd()}\n\n${correction}` : correction;
  return { ok: false, text, correction, violations };
}
