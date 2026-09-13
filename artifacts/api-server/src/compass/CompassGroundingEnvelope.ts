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
export type GroundingViolationKind =
  /** A current-conditions claim with no `verified_live` datum anywhere in the turn. */
  | "live_claim_without_verified_source"
  /** A wait/queue figure when no tool returned a wait datum. */
  | "wait_time_without_source"
  /** "everyone is dancing" — a present-progressive crowd assertion with no crowd datum. */
  | "crowd_claim_without_observation";

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
  /** Every distinct `sourceClass` seen, sorted — for the log line and the note. */
  sourceClasses: string[];
}

export const EMPTY_GROUNDING_EVIDENCE: GroundingEvidence = Object.freeze({
  hasVerifiedLive: false,
  hasWaitDatum: false,
  hasCrowdDatum: false,
  sourceClasses: Object.freeze([]) as unknown as string[],
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
  let hasWaitDatum = false;
  let hasCrowdDatum = false;
  let nodes = 0;

  const visit = (node: unknown, depth: number): void => {
    if (node === null || node === undefined) return;
    if (depth > MAX_DEPTH) return;
    if (++nodes > MAX_NODES) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    for (const [rawKey, value] of Object.entries(node as Record<string, unknown>)) {
      const key = rawKey.toLowerCase();
      if (key === "sourceclass" && typeof value === "string" && value) {
        sourceClasses.add(value);
      }
      // A datum counts only when it actually carries a reading. `waitMinutes:
      // null` is a tool saying it could not measure one, and reading that as
      // evidence is the fail-open the CONFIDENCE RULE exists to prevent.
      if (WAIT_KEYS.has(key) && value !== null && value !== undefined && value !== false) hasWaitDatum = true;
      if (CROWD_KEYS.has(key) && value !== null && value !== undefined && value !== false) hasCrowdDatum = true;
      visit(value, depth + 1);
    }
  };

  for (const r of toolResults) visit(r, 0);

  return {
    hasVerifiedLive: sourceClasses.has("verified_live"),
    hasWaitDatum,
    hasCrowdDatum,
    sourceClasses: [...sourceClasses].sort(),
  };
}

/**
 * A sentence that already labels its own uncertainty. The CONFIDENCE RULE asks
 * the model to write exactly these, so flagging one would punish compliance.
 */
const HEDGE =
  /\b(?:last[- ]known|historical(?:ly)?|can(?:no|')?t be verified|cannot be verified|could not be verified|not verified|unverified|usually|typically|generally|often|may be|might be|probably|likely|community[- ]reported|reported by (?:app )?users|no live|without live|based on (?:past|history))\b/i;

/** "right now", "currently", … — the marker that turns a statement into a live claim. */
const NOW_MARKER =
  /\b(?:right now|at the moment|as we speak|at this hour|currently|as of now|just now|this minute)\b/i;

/** The state words a NOW-marked sentence must also carry to be a live claim. */
const LIVE_STATE =
  /\b(?:open|closed|busy|packed|rammed|heaving|buzzing|quiet|empty|dead|crowded|full|queue|queues|line|lines|wait|waiting|dancing)\b/i;

/** A wait/queue figure in minutes. */
const WAIT_CLAIM =
  /\b(?:wait|queue|line)\b[^.!?]{0,40}?(\d{1,3})\s*(?:minutes?|mins?|m)\b|(\d{1,3})\s*(?:minutes?|mins?)\b[^.!?]{0,20}?\b(?:wait|queue|line)\b/i;

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

/**
 * Sensing `:148` — read the prose back against the confidence band of its
 * inputs, and publish nothing that over-claims without saying so.
 */
export function enforceCompassGroundingEnvelope(
  answer: string,
  evidence: GroundingEvidence,
): GroundingResult {
  const violations: GroundingViolation[] = [];
  const availableBand = evidence.sourceClasses.length > 0
    ? evidence.sourceClasses.join(", ")
    : "no source class in any tool result";

  for (const s of sentencesOf(answer)) {
    if (HEDGE.test(s)) continue;

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
  }

  if (violations.length === 0) return { ok: true, text: answer, correction: null, violations };

  // One note per KIND, in a fixed order, so the same failure always reads the
  // same way and a test can pin it.
  const kinds: GroundingViolationKind[] = [
    "live_claim_without_verified_source",
    "wait_time_without_source",
    "crowd_claim_without_observation",
  ];
  const seen = new Set(violations.map((v) => v.kind));
  const parts = kinds.filter((k) => seen.has(k)).map((k) => NOTE_FOR[k]);
  const correction = `${NOTE_PREFIX} ${parts.join(" ")}`;
  const text = answer.trim().length > 0 ? `${answer.trimEnd()}\n\n${correction}` : correction;
  return { ok: false, text, correction, violations };
}
