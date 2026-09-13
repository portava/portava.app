/**
 * CompassMediaContext (§32) — the thin media→Compass adapter.
 *
 * The existing Compass ask path (CompassStructuredContext) carries circles,
 * bookings and Passport history but has NO media input. This adapter packages a
 * media item into the structured shape §32 defines —
 *
 *     { mediaAssetId, entityRefs, viewerContext, permittedIntelligenceRefs }
 *
 * — and renders it as prompt lines that /api/compass/ask appends to its context
 * block, so "Ask Compass" / "Is this worth going to now?" / "Find somewhere like
 * this" carry STRUCTURED media context, not a raw string. It does NOT fork the
 * Compass engine; the engine stays propose-only.
 *
 * PRIVACY — the load-bearing rules:
 *   • The media item is run through the SHARED media-eligibility gate first; a
 *     viewer who cannot see it gets NO context (null), so the adapter can never
 *     leak an item into the prompt the viewer isn't entitled to.
 *   • `permittedIntelligenceRefs` is eligibility-filtered TWICE over: the intel
 *     comes only from the gated, fail-closed live-claim read (which honors every
 *     IG gate — flag chain, kill switch, per-scope promotion, freshness, k-anon —
 *     and returns [] when live is off, so nothing is fabricated), and it is then
 *     filtered to refs whose place is one the viewer is actually eligible to see
 *     (`filterPermittedIntelRefs`). A ref about a place the viewer may not see is
 *     dropped, not attached.
 *   • COARSE only — entity refs are opaque ids + coarse labels, never a
 *     coordinate. User-authored labels are wrapped in <portava:ugc> data-not-
 *     instructions delimiters, exactly like every other Compass context source.
 * §32's NINE QUESTIONS — the two that had no concept here (census-compass CM-03):
 *   • "Find a quieter or cheaper version" needs a COMPARATOR: "quieter" and
 *     "cheaper" are relative words, and relative to nothing they are an
 *     invitation to invent. The two axes have structured claim types already —
 *     `crowd.level` and `price.cover` (lib/intelContracts PHASE1_CLAIM_TYPES) —
 *     so the adapter reports, per axis, whether a PERMITTED, UNEXPIRED claim of
 *     that type exists for the subject place. Grounded ⇒ the comparison has a
 *     baseline to be relative to; not grounded ⇒ the answer is "I cannot
 *     compare", not an estimate.
 *   • "Where should we go after this?" needs SEQUENCING: a next stop is only
 *     meaningful relative to an anchor. The anchor is the canonical place the
 *     media resolved to — and when the location/gem choke point withheld that
 *     place, there IS no anchor and the question is not answerable at all,
 *     which the context says outright rather than letting the model pick a
 *     plausible city.
 *   Neither block carries a claim VALUE. That is the same rule
 *   `permittedIntelligenceRefs` already follows: the adapter says what
 *   grounded intelligence EXISTS and leaves reading it to the live/place tools,
 *   so a prompt built minutes ago can never assert a current condition.
 *
 *   • The refs come from resolveMediaEntities, which now runs the media
 *     location/gem choke point: a venue the owner chose to hide, a canonical
 *     place under a Hidden Gem's ceiling, and a protected / reveal-gated gem's
 *     id and NAME are all withheld before anything is rendered into the prompt.
 *     That matches CompassHiddenGemService's long-standing rule that only
 *     `sensitivity_level = 'public'` gems ever reach the model.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { readLiveClaimEnvelopes } from "../lib/liveClaimRead.js";
import { wrapUgc } from "./CompassStructuredContext.js";
import {
  loadEligibleMediaRow,
  resolveMediaEntities,
  type MediaEntityRef,
} from "../services/media/MediaActionResolver.js";
import type { ViewerResolved } from "../services/media/MediaProjectionService.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompassMediaViewerContext {
  /** Coarse viewer geography — country only, never a coordinate. */
  viewerCountry: string | null;
  /** The coarse city the media is about (subject city), never a coordinate. */
  subjectCity: string | null;
}

/** §32 "find a quieter or cheaper version" — the two comparable axes. */
export type CompassComparatorAxis = "quieter" | "cheaper";

/** The claim type that grounds each comparator axis. One source, named once. */
export const COMPARATOR_AXIS_CLAIM: Readonly<Record<CompassComparatorAxis, string>> = {
  quieter: "crowd.level",
  cheaper: "price.cover",
};

/** The claim type that grounds a §32 "where should we go after this?" answer. */
export const SEQUENCING_CLAIM = "experience.next_move";

/**
 * Whether one comparator axis has a baseline to be relative to. PROVENANCE
 * ONLY — band, source class and observation time. Never the value: reading the
 * value is the live/place tools' job, and a value copied into a prompt is a
 * current-conditions claim with no expiry.
 */
export interface CompassComparatorBaseline {
  axis: CompassComparatorAxis;
  claimType: string;
  /** True only when a permitted, unexpired claim of that type exists here. */
  grounded: boolean;
  band: string | null;
  sourceClass: string | null;
  observedAt: string | null;
}

/** §32 "where should we go after this?" — the anchor a next stop is next to. */
export interface CompassSequencingAnchor {
  /** The canonical place the media resolves to, or null when it was withheld. */
  anchorPlaceId: string | null;
  /** The coarse city a next stop must stay in. Never a coordinate. */
  city: string | null;
  /** A permitted aggregate next-move claim exists for the anchor. */
  nextMoveGrounded: boolean;
  /**
   * False when there is no anchor — the media resolved to no place the viewer
   * may see. "Where after this?" has no `this`, and the answer must say so.
   */
  chainable: boolean;
}

export interface CompassMediaContext {
  mediaAssetId: string;
  entityRefs: MediaEntityRef[];
  viewerContext: CompassMediaViewerContext;
  /** Ids of intel the viewer is PERMITTED to see (place-level, IG-gated). */
  permittedIntelligenceRefs: string[];
  /** §32 comparator axes, one entry per axis, always both present. */
  comparator: CompassComparatorBaseline[];
  /** §32 sequencing anchor for "where should we go after this?". */
  sequencing: CompassSequencingAnchor;
}

// ── The intel permission filter (mutation-proof chokepoint) ───────────────────

/** A candidate intel ref tagged with the place it is about. */
export interface CandidateIntelRef {
  ref: string;
  placeId: string;
}

/**
 * Keep ONLY intel refs whose place is one the viewer is eligible to see. This is
 * the single privacy chokepoint for permittedIntelligenceRefs: dropping it would
 * attach a ref about a place outside the viewer's eligible set — which is exactly
 * the leak the "only permitted intel" test guards. It is a pure function so the
 * guard can be proven in isolation.
 */
export function filterPermittedIntelRefs(
  candidates: CandidateIntelRef[],
  eligiblePlaceIds: Set<string>,
): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    if (!c.ref) continue;
    if (!eligiblePlaceIds.has(c.placeId)) continue; // ← the load-bearing filter
    out.push(c.ref);
  }
  return out;
}

// ── §32 comparator + sequencing (pure, so they can be proven in isolation) ────

/** The shape of an envelope these reducers need. Structural, not imported, so a
 *  test can drive them without building a full LiveClaimEnvelope. */
export interface ComparatorCandidateClaim {
  claimType: string;
  band?: string | null;
  sourceClass?: string | null;
  observedAt?: string | null;
  /** Freshness horizon; an envelope past it is not a baseline. */
  validUntil?: string | null;
}

/** True when the claim is still inside its own freshness horizon at `nowMs`. */
function unexpired(c: ComparatorCandidateClaim, nowMs: number): boolean {
  if (!c.validUntil) return true; // the seam only serves unexpired envelopes
  const t = Date.parse(c.validUntil);
  return !Number.isFinite(t) || t > nowMs;
}

/**
 * Reduce the subject place's PERMITTED claims to one baseline per §32
 * comparator axis. Both axes are always reported — an axis with no claim comes
 * back `grounded: false`, which is the answer "no comparison is possible here",
 * not a missing field the model can read past.
 */
export function buildComparatorBaselines(
  claims: readonly ComparatorCandidateClaim[],
  nowMs: number,
): CompassComparatorBaseline[] {
  const axes = Object.keys(COMPARATOR_AXIS_CLAIM) as CompassComparatorAxis[];
  return axes.map((axis) => {
    const claimType = COMPARATOR_AXIS_CLAIM[axis];
    const hit = claims.find((c) => c.claimType === claimType && unexpired(c, nowMs)) ?? null;
    return {
      axis,
      claimType,
      grounded: hit !== null,
      band: hit?.band ?? null,
      sourceClass: hit?.sourceClass ?? null,
      observedAt: hit?.observedAt ?? null,
    };
  });
}

/**
 * The §32 sequencing anchor. `chainable` is false whenever there is no
 * anchor place — which is exactly the case the media location/gem choke point
 * produces when a venue is hidden, and the case in which "where after this?"
 * cannot be answered from structured truth at all.
 */
export function buildSequencingAnchor(
  anchorPlaceId: string | null,
  city: string | null,
  claims: readonly ComparatorCandidateClaim[],
  nowMs: number,
): CompassSequencingAnchor {
  const anchored = typeof anchorPlaceId === "string" && anchorPlaceId.length > 0 ? anchorPlaceId : null;
  return {
    anchorPlaceId: anchored,
    city: anchored ? city : null,
    nextMoveGrounded:
      anchored !== null && claims.some((c) => c.claimType === SEQUENCING_CLAIM && unexpired(c, nowMs)),
    chainable: anchored !== null,
  };
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build the §32 media context for a viewer, or null when the viewer may not see
 * the media item. Never throws.
 */
export async function buildCompassMediaContext(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  mediaId: string,
  nowMs: number,
): Promise<CompassMediaContext | null> {
  const row = await loadEligibleMediaRow(sc, viewer, mediaId);
  if (!row) return null; // not visible to this viewer → no context.

  const entities = await resolveMediaEntities(sc, viewer, row, nowMs);

  // The places the viewer is ELIGIBLE to see (place + gem refs already passed
  // resolution). Intel about any other place must not be attached.
  const eligiblePlaceIds = new Set<string>();
  for (const r of entities.refs) {
    if (r.kind === "place" || r.kind === "gem") eligiblePlaceIds.add(r.id);
  }
  // The gem ref may carry a distinct gem id; the underlying canonical place is
  // what the live-claim read is keyed on, so ensure it is in the eligible set.
  if (entities.placeId) eligiblePlaceIds.add(entities.placeId);

  // Gather candidate intel from the GATED live-claim read for each eligible place.
  // The read is fail-closed: live off/stale/unpromoted ⇒ [] ⇒ no fabricated live.
  const candidates: CandidateIntelRef[] = [];
  // §32 — the claims about the ANCHOR place only. A comparator baseline for a
  // different place is not a baseline for this one, so they are kept apart.
  const anchorPlaceId =
    typeof entities.placeId === "string" && entities.placeId.length > 0 ? entities.placeId : null;
  const anchorClaims: ComparatorCandidateClaim[] = [];
  for (const placeId of eligiblePlaceIds) {
    try {
      const envelopes = await readLiveClaimEnvelopes(sc, placeId, { now: new Date(nowMs) });
      for (const env of envelopes) {
        if (env && typeof env.id === "string" && env.id) {
          candidates.push({ ref: env.id, placeId });
        }
        if (env && placeId === anchorPlaceId && typeof env.claimType === "string") {
          anchorClaims.push({
            claimType: env.claimType,
            band: env.band ?? null,
            sourceClass: env.sourceClass ?? null,
            observedAt: env.observedAt ?? null,
            validUntil: env.validUntil ?? null,
          });
        }
      }
    } catch {
      /* non-fatal — no intel from this place */
    }
  }

  const permittedIntelligenceRefs = filterPermittedIntelRefs(candidates, eligiblePlaceIds);

  // The anchor must itself be a place the viewer is eligible to see. When the
  // gem/location choke point withheld it, there is no anchor and no comparator
  // baseline — the two §32 questions become "cannot answer", by construction.
  const permittedAnchor = anchorPlaceId && eligiblePlaceIds.has(anchorPlaceId) ? anchorPlaceId : null;

  return {
    mediaAssetId: entities.mediaId,
    entityRefs: entities.refs,
    viewerContext: {
      viewerCountry: viewer.viewerCountry,
      subjectCity: entities.city,
    },
    permittedIntelligenceRefs,
    comparator: buildComparatorBaselines(permittedAnchor ? anchorClaims : [], nowMs),
    sequencing: buildSequencingAnchor(permittedAnchor, entities.city, anchorClaims, nowMs),
  };
}

// ── Prompt formatting ─────────────────────────────────────────────────────────

const REF_KIND_LABEL: Record<MediaEntityRef["kind"], string> = {
  media: "media",
  place: "place",
  trip: "trip",
  gem: "hidden gem",
};

/**
 * Render the media context as Compass prompt lines. Coarse only — opaque ids +
 * UGC-wrapped labels, never a coordinate. Empty sections are omitted. The number
 * of permitted intel refs is surfaced (never their raw values) so the model
 * knows current-state intelligence is available for this place without the
 * adapter fabricating any claim text.
 */
export function formatMediaContextLines(ctx: CompassMediaContext): string[] {
  const lines: string[] = ["[Media context — the item the traveler is looking at]"];
  lines.push(`Media: ${ctx.mediaAssetId}`);

  const named = ctx.entityRefs.filter((r) => r.kind !== "media");
  if (named.length > 0) {
    lines.push("Resolves to:");
    for (const r of named) {
      const label = r.label ? ` — ${wrapUgc(String(r.label).slice(0, 120))}` : "";
      lines.push(`• ${REF_KIND_LABEL[r.kind]} (${r.id})${label}`);
    }
  }

  if (ctx.viewerContext.subjectCity) {
    lines.push(`Subject city: ${wrapUgc(String(ctx.viewerContext.subjectCity).slice(0, 80))}`);
  }

  if (ctx.permittedIntelligenceRefs.length > 0) {
    lines.push(
      `Current-state intelligence available for this place: ${ctx.permittedIntelligenceRefs.length} permitted claim(s). ` +
        `Use the live/place tools to read current conditions — do not assume or invent them.`,
    );
  }

  // §32 "Find a quieter or cheaper version." Both axes are always stated, so a
  // missing baseline is a printed "not grounded" rather than a silent absence
  // the model fills in.
  const grounded = ctx.comparator.filter((c) => c.grounded).map((c) => c.axis);
  const ungrounded = ctx.comparator.filter((c) => !c.grounded).map((c) => c.axis);
  lines.push(
    `Comparator (§32 "find a quieter or cheaper version") — grounded axes: ` +
      `${grounded.length > 0 ? grounded.join(", ") : "none"}; ungrounded: ` +
      `${ungrounded.length > 0 ? ungrounded.join(", ") : "none"}. ` +
      `A grounded axis has a permitted, unexpired baseline for THIS place — read it with the ` +
      `live/place tools and compare against it. For an ungrounded axis, say the comparison cannot ` +
      `be made from what is known; never estimate how busy or how expensive somewhere is.`,
  );

  // §32 "Where should we go after this?"
  if (ctx.sequencing.chainable) {
    lines.push(
      `Sequencing (§32 "where should we go after this?") — anchor: place ${ctx.sequencing.anchorPlaceId}` +
        `${ctx.sequencing.city ? ` in ${wrapUgc(String(ctx.sequencing.city).slice(0, 80))}` : ""}. ` +
        `A next stop must be a DIFFERENT place reachable from that anchor and stay in that city. ` +
        `${ctx.sequencing.nextMoveGrounded
          ? "An aggregate next-move reading is permitted for this anchor; read it with the live tools rather than guessing where people go."
          : "No aggregate next-move reading is permitted here, so order the suggestion on the trip/plan tools' own facts, not on an invented crowd flow."}`,
    );
  } else {
    lines.push(
      `Sequencing (§32 "where should we go after this?") — NO ANCHOR: this media resolves to no ` +
        `place the viewer may see, so "after this" has no "this". Say the question cannot be ` +
        `answered for this item instead of choosing a plausible city.`,
    );
  }

  return lines;
}
