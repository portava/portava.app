/**
 * CompassLiveClaimContext — Sensing `:148` for the CONVERSATIONAL path, in the
 * order the census insisted on.
 *
 * ── THE ORDER, AND WHY IT IS NOT NEGOTIABLE ──────────────────────────────────
 * census-sensing S79: *"RED WHEN live claims are carried into `/compass/ask`'s
 * context and a grounding checker constrains the generated language to the band
 * of its inputs — IN THAT ORDER, because a checker over an empty context is
 * vacuous."*
 *
 * `compass/CompassGroundingEnvelope` already reads the model's prose back
 * against the turn's TOOL RESULTS, and that is real. But a turn in which the
 * model called no tool had an empty band, and an empty band cannot convict: the
 * two truth-class triggers simply never fired, because `truthClass` was null.
 * The answer was then constrained by the prompt alone, which is a request
 * rather than a boundary — the exact gap S79 names.
 *
 * So this module does the FIRST half: it puts the structured truth into the
 * context, by name, with its §5.1 band attached. The second half is that the
 * same band is handed to the envelope, so the checker now has something to
 * convict against even when no tool ran.
 *
 * ── WHAT THE CENSUS'S GREP WAS MEASURING, AND WHAT IT MISSED ─────────────────
 * The row's evidence is that `routes/compass.ts`, `CompassStructuredContext.ts`
 * and `routes/telegraph.ts` contain *"zero references to `liveClaimRead`,
 * `readLiveClaimEnvelopes`, `resolvePlaceIntelState` or `truthOfEnvelope`"*.
 * That was literally true and slightly understated the tree: `/compass/ask`
 * DOES reach live claims transitively, through
 * `CompassPlatformContext.assembleAskKernel` → `lib/contextKernelRead`, and
 * `formatKernelLines` already puts a crowd density and a truth class per
 * subject into the prompt.
 *
 * Two things were still missing, and they are what this module supplies:
 *
 *   1. The kernel line names a subject by its opaque `subjectId`. The envelope
 *      binds a sentence to a subject BY NAME (`bandForSentence`), so a kernel
 *      line could never be attached to the prose that mentions the place. This
 *      module emits the NAME the model will write.
 *   2. Nothing carried the band OUT of the context and into the checker. The
 *      prompt knew a claim was `predicted`; the checker did not.
 *
 * ── WHAT REACHES THE MODEL ───────────────────────────────────────────────────
 * Derived claim values only, through `lib/liveClaimRead`'s own client-facing
 * envelope: no contributor, no coordinate, no cohort count, no k-anonymity
 * internals. Names are UGC-wrapped like every other UGC path here, because a
 * place title is user-entered and would otherwise be an injection seam into a
 * block the model treats as verified.
 *
 * Each line carries the claim's §5.1 block — truth class, confidence band,
 * coverage, source class — and a subject with NO claim gets a line saying so.
 * That last part matters more than it looks: silence would let the model answer
 * from the general knowledge in its weights, and an absent observation must
 * read as "not known", never as "quiet".
 *
 * ── WHY IT READS THE LIVE RUNG ONLY, AND NOT `resolvePlaceIntelState` ────────
 * The obvious call is `resolvePlaceIntelState`, which walks the whole
 * degradation order LIVE → EMERGING → TYPICAL → UNKNOWN. It is not used, and
 * the reason is a production fact rather than a preference.
 *
 * Its TYPICAL rung reads `intel_historical_patterns`, and production does not
 * have that table — the migration is unapplied. `COMPASS_ENABLED` is ON in
 * production, so calling it from here makes a live, flag-on path name a table
 * that is not there. `scripts/checkFlagSchemaPrerequisites.ts` catches exactly
 * that and calls it what it is: *"NEW INSTANCE OF THE CLASS: COMPASS_ENABLED
 * is ON in production and its code names intel_historical_patterns … which
 * production lacks."* Its remedies are to apply the migration, register the
 * capability and wire a consumer, or turn the flag off — none of which is a
 * context builder's to do, and silencing it with a KNOWN entry would be
 * allowlisting a real gap.
 *
 * So this reads `readLiveClaimEnvelopes` (the live rung, over
 * `intel_state_snapshots`, which production HAS) and treats everything below it
 * as UNKNOWN. That loses the "typical" answer and loses nothing about honesty:
 * a subject with no live claim is reported as having no current evidence, which
 * is the strictest of the available readings and the one that makes the
 * grounding checker bite hardest.
 *
 * ── FAIL-SOFT, LIKE EVERY OTHER CONTEXT BUILDER HERE ─────────────────────────
 * Any error yields no lines and EMPTY evidence. Empty evidence is the state
 * that existed before this module, so a failed read degrades the checker to
 * what it already was and never invents a band that would excuse a claim.
 */
import {
  readLiveClaimEnvelopes,
  type LiveClaimEnvelope,
  type LiveState,
} from "../lib/liveClaimRead.js";
import { truthOfEnvelope } from "../lib/liveEnvelopeTruth.js";
import { weakestTruthClass, type TruthClass } from "../lib/truthClass.js";
import { CROWD_STATE_CLAIM_TYPES } from "../lib/crowdState.js";
import { EMPTY_GROUNDING_EVIDENCE, type GroundingEvidence, type SubjectEvidence } from "./CompassGroundingEnvelope.js";
import { wrapUgc } from "./CompassStructuredContext.js";

/** The header the model and the tests both read. Declared once. */
export const LIVE_CLAIM_HEADER = "[Live claims — the structured truth behind any statement about right now]";

/** At most this many subjects, matching the kernel's own cap on a turn. */
export const LIVE_CLAIM_SUBJECT_CAP = 5;
/** At most this many claims per subject, newest-best first as the read path ordered them. */
export const LIVE_CLAIM_PER_SUBJECT_CAP = 4;

/** A subject the turn already names: the id the live layer keys on, and the name the model writes. */
export interface LiveClaimSubject {
  subjectId: string;
  name: string;
}

export interface LiveClaimContext {
  lines: string[];
  /** The same claims, as a band the grounding envelope can convict against. */
  evidence: GroundingEvidence;
}

/** Claim types that ARE a wait/queue reading. The read path's own vocabulary. */
const WAIT_CLAIM_TYPES: readonly string[] = ["queue.wait"];

/**
 * A claim is CROWD evidence only if `lib/crowdState` would read it as such.
 * Borrowing that list rather than restating it means a new crowd claim type is
 * crowd evidence here the moment it is crowd evidence there.
 */
function isCrowdClaim(claimType: string): boolean {
  return CROWD_STATE_CLAIM_TYPES.includes(claimType);
}

/** Render a claim value without letting a string value carry instructions. */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "string") return wrapUgc(value.slice(0, 120));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return wrapUgc(JSON.stringify(value).slice(0, 160));
  } catch {
    return "unreadable";
  }
}

/**
 * The one rule that decides whether a claim licenses an unhedged "right now"
 * sentence. Deliberately the STRICTEST reading available: the read path reserves
 * `state === "live"` for a claim whose band actually reached live/strong, and a
 * claim that merely clears the serve floor is `emerging` — real, current, and
 * NOT a licence to say a thing is verified live.
 */
function isLiveQualified(envelope: LiveClaimEnvelope): boolean {
  return envelope.state === "live";
}

/** Build one subject's band from its envelopes. */
function subjectEvidenceOf(
  subject: LiveClaimSubject,
  envelopes: readonly LiveClaimEnvelope[],
  nowMs: number,
): SubjectEvidence {
  const classes: TruthClass[] = envelopes.map((e) => truthOfEnvelope(e, nowMs).truthClass);
  return {
    subjectId: subject.subjectId,
    // The envelope matches prose against this string, so it must be the name as
    // the model would write it — the UGC wrapper is for the PROMPT line, not
    // for the matcher.
    name: subject.name,
    hasVerifiedLive: envelopes.some(isLiveQualified),
    hasWaitDatum: envelopes.some((e) => WAIT_CLAIM_TYPES.includes(e.claimType)),
    hasCrowdDatum: envelopes.some((e) => isCrowdClaim(e.claimType)),
    // A live claim is never a measured route. Saying otherwise here would hand
    // the model a travel-time licence no tool ever granted.
    hasRouteDatum: false,
    // WEAKEST, not newest: a subject backed by one observed claim and one
    // predicted one is a predicted subject for anything said about it plainly.
    truthClass: classes.length > 0 ? weakestTruthClass(classes) : null,
  };
}

/** The sentence appended to a subject whose evidence may not be stated plainly. */
function qualificationFor(state: LiveState, truthClass: TruthClass | null): string {
  if (state === "unknown") {
    return "No current evidence — do not say whether it is busy, quiet, open or closed right now.";
  }
  if (state === "typical") {
    return "This is a TYPICAL pattern, not an observation — say \"usually\" or \"typically\", never \"right now\".";
  }
  if (state === "emerging") {
    return "Current but NOT live-verified — do not present it as checked just now.";
  }
  if (truthClass !== null && truthClass !== "observed" && truthClass !== "corroborated") {
    return `Evidence is ${truthClass} — keep that qualification in any sentence about it.`;
  }
  return "";
}

/**
 * Read the live claims for the subjects this turn already names, and render
 * them as context lines plus the band a checker can use.
 *
 * Reads through `resolvePlaceIntelState`, so the spec's degradation order —
 * LIVE / EMERGING, then TYPICAL, then UNKNOWN — is applied in one place and
 * this module cannot get it wrong.
 */
/** EMPTY is the state that existed before this module: no lines, no band. */
export const EMPTY_LIVE_CLAIM_CONTEXT: LiveClaimContext = Object.freeze({
  lines: [],
  evidence: EMPTY_GROUNDING_EVIDENCE,
});

/**
 * THE PURE CORE. Takes the envelopes already read for each subject and produces
 * the lines and the band. No I/O, no clock — `nowMs` is injected.
 *
 * It is separate from the read below so the interesting half can be exercised
 * on real `LiveClaimEnvelope` values rather than through a stub of five feature
 * flags, a promoted-scope allowlist and a snapshot query. The rung choice lives
 * in the shell; the honesty rules live here.
 */
export function liveClaimContextFrom(
  subjects: readonly LiveClaimSubject[],
  envelopesBySubject: ReadonlyMap<string, readonly LiveClaimEnvelope[]>,
  nowMs: number,
): LiveClaimContext {
  const wanted = dedupeSubjects(subjects);
  if (wanted.length === 0) return EMPTY_LIVE_CLAIM_CONTEXT;

  const lines: string[] = [];
  const subjectEvidence: SubjectEvidence[] = [];
  const sourceClasses = new Set<string>();
  const turnClasses: TruthClass[] = [];

  for (const subject of wanted) {
    const envelopes = (envelopesBySubject.get(subject.subjectId) ?? []).slice(0, LIVE_CLAIM_PER_SUBJECT_CAP);
    // The live rung only (see the header): anything below it is UNKNOWN.
    const resolvedState: LiveState = envelopes.length === 0
      ? "unknown"
      : envelopes.some((e) => e.state === "live") ? "live" : "emerging";
      const label = wrapUgc(String(subject.name).slice(0, 200));

      if (envelopes.length === 0) {
        // UNKNOWN IS A FACT AND IS SAID OUT LOUD. Leaving the subject out would
        // be silence, and silence is what the model fills from its weights.
        lines.push(`${label}: no current evidence. ${qualificationFor("unknown", null)}`);
        subjectEvidence.push({
          subjectId: subject.subjectId,
          name: subject.name,
          hasVerifiedLive: false,
          hasWaitDatum: false,
          hasCrowdDatum: false,
          hasRouteDatum: false,
          // `unknown` is a DECLARED class, not an absent one: the read path
          // looked and found nothing, which is itself a claim about the world
          // and is exactly what the envelope's truth-class trigger should bite
          // on when the prose asserts a state anyway.
          truthClass: "unknown",
        });
        turnClasses.push("unknown");
        continue;
      }

      const evidence = subjectEvidenceOf(subject, envelopes, nowMs);
      subjectEvidence.push(evidence);
      if (evidence.truthClass !== null) turnClasses.push(evidence.truthClass);

      for (const e of envelopes) sourceClasses.add(e.sourceClass);

      const rendered = envelopes.map((e) => {
        const truth = truthOfEnvelope(e, nowMs);
        return (
          `${e.claimType}=${renderValue(e.value)} ` +
          `(truth ${truth.truthClass}; confidence ${truth.confidence}; coverage ${truth.coverage}; ` +
          `source ${e.sourceClass}; ${e.conflictState === "material" ? "REPORTS DIFFER; " : ""}` +
          `observed ${e.observedAt})`
        );
      });
      const qualification = qualificationFor(resolvedState, evidence.truthClass);
      lines.push(
        `${label} [${resolvedState}]: ${rendered.join("; ")}.${qualification ? ` ${qualification}` : ""}`,
      );
  }

  if (lines.length === 0) return EMPTY_LIVE_CLAIM_CONTEXT;

  const evidence: GroundingEvidence = {
    // Turn-level booleans are the fallback for a sentence that names no
    // subject, so ANY subject carrying the datum sets them — the per-subject
    // band above is what makes a named sentence strict.
    hasVerifiedLive: subjectEvidence.some((s) => s.hasVerifiedLive),
    hasWaitDatum: subjectEvidence.some((s) => s.hasWaitDatum),
    hasCrowdDatum: subjectEvidence.some((s) => s.hasCrowdDatum),
    hasRouteDatum: false,
    sourceClasses: [...sourceClasses].sort(),
    truthClass: turnClasses.length > 0 ? weakestTruthClass(turnClasses) : null,
    subjects: subjectEvidence,
  };

  return { lines: [LIVE_CLAIM_HEADER, ...lines], evidence };
}

function dedupeSubjects(subjects: readonly LiveClaimSubject[]): LiveClaimSubject[] {
  if (!Array.isArray(subjects)) return [];
  const seen = new Set<string>();
  return subjects
    .filter((s) => s && typeof s.subjectId === "string" && s.subjectId.length > 0 && typeof s.name === "string" && s.name.length > 0)
    .filter((s) => (seen.has(s.subjectId) ? false : (seen.add(s.subjectId), true)))
    .slice(0, LIVE_CLAIM_SUBJECT_CAP);
}

/**
 * THE I/O SHELL. Reads the live rung for each subject and hands the envelopes
 * to the pure core.
 *
 * Fail-soft: any error yields no lines and EMPTY evidence, which is the state
 * that existed before this module — a failed read degrades the checker to what
 * it already was and never invents a band that would excuse a claim.
 */
export async function buildLiveClaimContext(
  sc: any,
  subjects: readonly LiveClaimSubject[],
  opts: { now?: Date } = {},
): Promise<LiveClaimContext> {
  try {
    if (!sc) return EMPTY_LIVE_CLAIM_CONTEXT;
    const wanted = dedupeSubjects(subjects);
    if (wanted.length === 0) return EMPTY_LIVE_CLAIM_CONTEXT;
    const now = opts.now ?? new Date();

    const bySubject = new Map<string, readonly LiveClaimEnvelope[]>();
    for (const subject of wanted) {
      bySubject.set(subject.subjectId, await readLiveClaimEnvelopes(sc, subject.subjectId, { now }));
    }
    return liveClaimContextFrom(wanted, bySubject, now.getTime());
  } catch {
    return EMPTY_LIVE_CLAIM_CONTEXT;
  }
}
