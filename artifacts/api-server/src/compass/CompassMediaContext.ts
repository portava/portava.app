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

export interface CompassMediaContext {
  mediaAssetId: string;
  entityRefs: MediaEntityRef[];
  viewerContext: CompassMediaViewerContext;
  /** Ids of intel the viewer is PERMITTED to see (place-level, IG-gated). */
  permittedIntelligenceRefs: string[];
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
  for (const placeId of eligiblePlaceIds) {
    try {
      const envelopes = await readLiveClaimEnvelopes(sc, placeId, { now: new Date(nowMs) });
      for (const env of envelopes) {
        if (env && typeof env.id === "string" && env.id) {
          candidates.push({ ref: env.id, placeId });
        }
      }
    } catch {
      /* non-fatal — no intel from this place */
    }
  }

  const permittedIntelligenceRefs = filterPermittedIntelRefs(candidates, eligiblePlaceIds);

  return {
    mediaAssetId: entities.mediaId,
    entityRefs: entities.refs,
    viewerContext: {
      viewerCountry: viewer.viewerCountry,
      subjectCity: entities.city,
    },
    permittedIntelligenceRefs,
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

  return lines;
}
