/**
 * A place on a PRESENCE stamp, at the two generic award endpoints, only with
 * occurrence evidence — census-highlights-memories H4, BD-OD-2's remainder.
 *
 * WHAT WAS OPEN
 * =============
 * `POST /admin/stamps/award` and the internal `POST /stamps/award` hand any
 * caller-supplied slug and place to `StampAwardEngine.awardStamp`. Since §BG
 * the engine drops the place of a NON-presence slug (OD-1012-STAMP-2). For a
 * PRESENCE slug it keeps whatever it is given, so an admin, or anything holding
 * the internal secret, could write "City Explorer, Lisbon" or "First trip
 * completed, Paris, France" for a person nobody showed was there. Every other
 * presence writer requires evidence first: trip completion a check-in on that
 * trip (tripCompletionPresence.ts), the postcard awards a GPS stamp-eligible
 * postcard (routes/posts.ts `if (verdict.stampEligible && locationCity)`).
 *
 * WHAT THESE ENDPOINTS NOW REQUIRE
 * ================================
 * For a presence slug (`isPresenceStamp`, fail closed):
 *
 *   - coordinates (`lat`/`lng`) are refused outright: no evidence this system
 *     keeps verifies a point a caller names;
 *   - a city or country is refused unless `evidence` names one of the two
 *     kinds the rest of the system uses, and it is READ and holds for THIS
 *     person:
 *       { kind: "trip_checkin",      tripId }  — readTripPresenceEvidence
 *       { kind: "verified_postcard", postId }  — a stamp-eligible, unrevoked
 *                                                 postcard of theirs for the post;
 *   - with evidence, the PLACE WRITTEN IS THE EVIDENCE'S (the trip's
 *     destination, the postcard's verified city/country). A city or country
 *     the caller also sent must equal it, or the award is refused;
 *   - with evidence, the stamp's source BECOMES the evidence (`trips`/tripId,
 *     `posts`/postId), so every reader re-checks this award exactly as it
 *     re-checks the route writers' (stampPresenceView.ts). A different
 *     caller-supplied source is refused rather than overwritten silently.
 *     The admin id still reaches `stamp_award_events.admin_id` and the reason
 *     `award_reason`, so the attestation stays attributable.
 *
 * A presence slug with NO place and no evidence still passes: an attested
 * achievement with no place in it (the ratchet's `admin_attestation` /
 * `internal_service` basis). A non-presence slug passes unchanged; the engine
 * drops its place.
 *
 * Unreadable evidence is 503 and nothing is written: an award skipped can be
 * re-sent, an award wrongly granted is a durable row in someone's passport.
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AwardInput } from "./StampAwardEngine.js";
import { isPresenceStamp } from "./nonPresenceStampAwards.js";
import { readTripPresenceEvidence } from "./tripCompletionPresence.js";
import { postcardIsStampEvidence } from "./stampOccurrenceEvidence.js";

export const presenceEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trip_checkin"), tripId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("verified_postcard"), postId: z.string().uuid() }).strict(),
]);

export type PresenceEvidenceClaim = z.infer<typeof presenceEvidenceSchema>;

export type PresenceAwardRefusal =
  /** 422 — a city or country on a presence slug, and no evidence. */
  | "presence_evidence_required"
  /** 422 — the evidence named does not show this person there. */
  | "presence_evidence_absent"
  /** 503 — the evidence could not be read. Nothing was written. */
  | "presence_evidence_unverifiable"
  /** 422 — the place sent is not the place the evidence shows. */
  | "presence_place_mismatch"
  /** 422 — coordinates on a presence slug. */
  | "presence_coordinates_refused"
  /** 422 — a source other than the evidence the award rests on. */
  | "presence_source_conflict";

export type PresenceAwardDecision =
  | { ok: true; input: AwardInput; evidence: PresenceEvidenceClaim | null }
  | { ok: false; status: 422 | 503; reason: PresenceAwardRefusal; message: string };

const refuse = (status: 422 | 503, reason: PresenceAwardRefusal, message: string): PresenceAwardDecision =>
  ({ ok: false, status, reason, message });

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const same = (a: unknown, b: unknown): boolean => text(a).toLowerCase() === text(b).toLowerCase();

type Row = Record<string, unknown>;

/**
 * Decide what the engine is handed. Pure apart from the evidence reads, which
 * happen only for a presence slug that names evidence.
 */
export async function decidePresenceAward(
  sc: SupabaseClient,
  input: AwardInput,
  evidence?: PresenceEvidenceClaim | null,
): Promise<PresenceAwardDecision> {
  if (!isPresenceStamp(input.definitionSlug)) {
    // OD-1012-STAMP-2: the engine drops this slug's place; evidence is moot.
    return { ok: true, input, evidence: null };
  }
  if (input.lat != null || input.lng != null) {
    return refuse(422, "presence_coordinates_refused",
      "Coordinates cannot be attached to a presence stamp here; name the evidence and its place is used.");
  }
  const placeSent = text(input.city) !== "" || text(input.country) !== "";
  if (!evidence) {
    if (placeSent) {
      return refuse(422, "presence_evidence_required",
        "A place on this stamp needs evidence that the person was there: a trip check-in or a verified postcard.");
    }
    return { ok: true, input, evidence: null };
  }

  const source = evidence.kind === "trip_checkin" ? "trips" : "posts";
  const sourceId = evidence.kind === "trip_checkin" ? evidence.tripId : evidence.postId;
  if ((input.sourceType != null && input.sourceType !== source) || (input.sourceId != null && input.sourceId !== sourceId)) {
    return refuse(422, "presence_source_conflict",
      "With evidence, the stamp's source is the evidence; send no other sourceType or sourceId.");
  }

  let place: { city: string | null; country: string | null };
  if (evidence.kind === "trip_checkin") {
    const trip = await Promise.resolve(
      sc.from("trips").select("id, destination_city, destination_country").eq("id", evidence.tripId).maybeSingle(),
    ).catch((err: unknown) => ({ data: null, error: { message: String(err) } }));
    if (trip.error) return refuse(503, "presence_evidence_unverifiable", "The trip could not be read. Nothing was awarded.");
    if (!trip.data) return refuse(422, "presence_evidence_absent", "No such trip.");
    const seen = await readTripPresenceEvidence(sc, evidence.tripId, [input.userId]);
    if (!seen.present.has(input.userId)) {
      return seen.unreadable.length > 0
        ? refuse(503, "presence_evidence_unverifiable", "The trip's check-ins could not be read. Nothing was awarded.")
        : refuse(422, "presence_evidence_absent", "This person has no check-in on that trip.");
    }
    const t = trip.data as Row;
    place = { city: text(t.destination_city) || null, country: text(t.destination_country) || null };
  } else {
    const pc = await Promise.resolve(
      sc.from("passport_postcards")
        .select("user_id, post_id, stamp_eligible, stamp_revoked, location_city, location_country")
        .eq("post_id", evidence.postId).eq("user_id", input.userId).maybeSingle(),
    ).catch((err: unknown) => ({ data: null, error: { message: String(err) } }));
    if (pc.error) return refuse(503, "presence_evidence_unverifiable", "The postcard could not be read. Nothing was awarded.");
    const row = pc.data as Row | null;
    if (!postcardIsStampEvidence(row)) {
      return refuse(422, "presence_evidence_absent", "This person has no GPS-verified, unrevoked postcard for that post.");
    }
    place = { city: text(row!.location_city) || null, country: text(row!.location_country) || null };
  }

  if (text(input.city) && !same(input.city, place.city)) {
    return refuse(422, "presence_place_mismatch", "The city sent is not the place the evidence shows.");
  }
  if (text(input.country) && !same(input.country, place.country)) {
    return refuse(422, "presence_place_mismatch", "The country sent is not the place the evidence shows.");
  }

  return {
    ok: true,
    evidence,
    input: {
      ...input,
      sourceType: source,
      sourceId,
      city: place.city ?? undefined,
      country: place.country ?? undefined,
      lat: undefined,
      lng: undefined,
      metadata: { ...(input.metadata ?? {}), presence_evidence: { kind: evidence.kind, id: sourceId } },
    },
  };
}

/** The HTTP answer for a refusal: the reason is the error code, nothing is written. */
export function refusePresenceAward(
  res: { status: (n: number) => { json: (b: unknown) => unknown } },
  decision: Extract<PresenceAwardDecision, { ok: false }>,
): void {
  res.status(decision.status).json({ error: decision.reason, message: decision.message });
}
