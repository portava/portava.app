/**
 * whyShownOpened — the §35 `why_shown_opened` payload, derived from the §9
 * panel rather than from the raw object.
 *
 * WHY THIS EXISTS AS A MODULE RATHER THAN AS THREE LINES AT THE CALL SITE
 * ======================================================================
 * `WhyShownOpenedPayload.lineCount` means "how many provenance lines the §9
 * panel showed" and `provenanceRefs` means "the opaque claim-snapshot refs it
 * showed". Both are properties of `buildWhyPanel(object)` — the exact call
 * `WhyShownSheet` renders — and neither can be read off the object, because
 * `buildWhyLines` SYNTHESISES the panel's evidence whenever the server sent no
 * `provenance.lines`: a source count, an activity reading, a trend, a freshness
 * line, an aggregation note.
 *
 * Computing the payload from the object instead produces an event that
 * contradicts the screen. `obj.provenance?.lines.length ?? 0` reports ZERO for
 * every synthesised panel — which is the common case — so §35's only measure of
 * whether an explanation was legible reads 0 on exactly the objects whose
 * explanation Portava built for itself. `obj.sourceRefs` diverges the other
 * way: when the server DID send lines with refs, those are what was shown and
 * `sourceRefs` is a different list, or absent.
 *
 * So the payload is built here, once, from the panel model, and the emitter
 * calls this instead of restating the rule. §9's line rules can then change in
 * `buildWhyLines` without the telemetry quietly drifting away from the pixels.
 *
 * This module deliberately does NOT emit. The decision of WHEN the panel counts
 * as opened belongs to the screen that opens it; the decision of WHAT to say
 * about it belongs here.
 */
import { buildWhyPanel } from '../truth/liveTruth.ts';
import { describeMapObject } from './mapTelemetry.ts';
import type { MapObject } from '../../../types/mapObjects.ts';

/** Structurally `WhyShownOpenedPayload`, restated here to avoid an import cycle. */
export interface WhyShownOpenedFields {
  ref: ReturnType<typeof describeMapObject>;
  lineCount: number;
  provenanceRefs?: string[];
}

/**
 * Build the §35 payload for a §9 panel about to be shown for `object`.
 *
 * `now` is the same injectable clock `WhyShownSheet` takes, so the event and
 * the panel resolve relative wording — and therefore the same line set — at one
 * instant.
 */
export function whyShownOpenedPayload(
  object: MapObject,
  now?: Date | number,
): WhyShownOpenedFields {
  const panel = buildWhyPanel(object, now);

  const provenanceRefs = panel.lines
    .map((line) => line.ref)
    .filter((ref): ref is string => typeof ref === 'string' && ref !== '');

  const payload: WhyShownOpenedFields = {
    ref: describeMapObject(object),
    lineCount: panel.lines.length,
  };
  // Omitted rather than sent empty: `provenanceRefs: []` reads as "the panel
  // showed refs, and there were none of them", which is a different claim from
  // "the panel showed lines that carry no refs".
  if (provenanceRefs.length > 0) payload.provenanceRefs = provenanceRefs;
  return payload;
}
