/**
 * liveEnvelopeTruth — the §5.1 truth block of ONE live-claim envelope, through
 * the Wall's derivation, so every consumer that grades an envelope (the
 * Compass decision, the Wall's moments) grades it the same way.
 *
 * PURE. No I/O, no clock of its own.
 */
import type { ConfidenceBand } from "./intelContracts.js";
import { deriveFreshness } from "./mapObjects.js";
import { composeTruth, type TruthMetadata } from "./experienceTruth.js";
import { coverageFromBucket, deriveWallTruthClass } from "./wallProjection.js";
import { truthClassMayRenderAsObservation } from "./truthClass.js";
import type { LiveClaimEnvelope } from "./liveClaimRead.js";

/** One envelope's §5.1 block: class via the Wall's rule, band as served, freshness from the observation, coverage as the read path bucketed it. */
export function truthOfEnvelope(e: LiveClaimEnvelope, nowMs: number): TruthMetadata {
  const freshness = deriveFreshness(e.observedAt, e.validUntil, nowMs);
  const coverage = coverageFromBucket(e.sourceCountBucket);
  return {
    truthClass: deriveWallTruthClass({
      sourceClass: e.sourceClass,
      conflictState: e.conflictState ?? null,
      freshness: freshness === "historical" ? "stale" : freshness,
      coverage,
    }),
    confidence: e.band as ConfidenceBand,
    freshness,
    coverage,
    provenance: [e.sourceClass],
  };
}

/** Weakest-on-every-axis truth over several envelopes. Empty ⇒ the floor. */
export function truthOfEnvelopes(envelopes: readonly LiveClaimEnvelope[], nowMs: number): TruthMetadata {
  return composeTruth(envelopes.map((e) => truthOfEnvelope(e, nowMs)));
}

/** True when the envelope's class may be rendered as a current observation (observed / corroborated). */
export function envelopeIsObservational(e: LiveClaimEnvelope, nowMs: number): boolean {
  return truthClassMayRenderAsObservation(truthOfEnvelope(e, nowMs).truthClass);
}
