/**
 * LayoverPrivacyGuard
 *
 * Strips exact GPS from all layover outputs.
 * Enforces Ghost Mode, location mode settings, and meetup privacy rules.
 * Nearby travelers shown as approximate city/zone only.
 */

export interface RawRecommendation {
  id?: string;
  recType: string;
  title: string;
  description?: string | null;
  safetyRating: string;
  travelTimeMin: number;
  activityTimeMin: number;
  returnBufferMin: number;
  hardReturnTime?: Date | string | null;
  warningReason?: string | null;
  insideAirport: boolean;
  locationLabel?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  // Raw coords — NEVER forwarded to client
  lat?: number | null;
  lng?: number | null;
  planItemId?: string | null;
  placeId?: string | null;
  // Meetup: exact location hidden until accepted
  meetupAccepted?: boolean;
  sortOrder?: number;
}

export interface SafeRecommendation {
  id?: string;
  recType: string;
  title: string;
  description: string | null;
  safetyRating: string;
  safetyLabel: string;
  travelTimeMin: number;
  activityTimeMin: number;
  returnBufferMin: number;
  hardReturnTime: string | null;
  warningReason: string | null;
  insideAirport: boolean;
  // Safe location info — no coords
  locationLabel: string | null;
  city: string | null;
  neighborhood: string | null;
  // Meetup location hidden until accepted
  meetupLocationHidden: boolean;
  meetupLocationReveal: string | null;
  planItemId: string | null;
  placeId: string | null;
  sortOrder: number;
}

import { safetyLabel } from "./LayoverSafetyEngine.js";

export function sanitizeRecommendation(rec: RawRecommendation): SafeRecommendation {
  const isMeetup = rec.recType === "meetup";
  // Hide exact meetup location until accepted
  const meetupLocationHidden = isMeetup && !rec.meetupAccepted;

  let hardReturnStr: string | null = null;
  if (rec.hardReturnTime) {
    try {
      hardReturnStr = new Date(rec.hardReturnTime).toISOString();
    } catch { hardReturnStr = null; }
  }

  return {
    id:                   rec.id,
    recType:              rec.recType,
    title:                rec.title,
    description:          rec.description   ?? null,
    safetyRating:         rec.safetyRating,
    safetyLabel:          safetyLabel(rec.safetyRating as any),
    travelTimeMin:        rec.travelTimeMin,
    activityTimeMin:      rec.activityTimeMin,
    returnBufferMin:      rec.returnBufferMin,
    hardReturnTime:       hardReturnStr,
    warningReason:        rec.warningReason  ?? null,
    insideAirport:        rec.insideAirport,
    locationLabel:        meetupLocationHidden ? null : (rec.locationLabel ?? null),
    city:                 rec.city           ?? null,
    neighborhood:         meetupLocationHidden ? null : (rec.neighborhood ?? null),
    meetupLocationHidden,
    meetupLocationReveal: meetupLocationHidden
      ? "Exact meetup location revealed after invite is accepted."
      : null,
    planItemId:           rec.planItemId ?? null,
    placeId:              rec.placeId    ?? null,
    sortOrder:            rec.sortOrder  ?? 0,
  };
}

/** Strip GPS from Compass answers — replace any coordinate-like patterns. */
export function sanitizeCompassAnswer(text: string): string {
  // Remove patterns like (12.345, 67.890) or coordinates mentioned literally
  return text
    .replace(/\(?\s*-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\s*\)?/g, "[location hidden]")
    .replace(/\b-?\d{1,3}\.\d{4,}\b/g, "[coords hidden]");
}

/** Sanitize nearby traveler — return only city/zone, never exact coords. */
export function sanitizeNearbyTraveler(traveler: {
  userId: string;
  username?: string | null;
  avatarUrl?: string | null;
  city?: string | null;
  country?: string | null;
  // strip anything more precise
  lat?: number | null;
  lng?: number | null;
  neighborhood?: string | null;
}): {
  userId: string;
  username: string | null;
  avatarUrl: string | null;
  approximateLocation: string | null;
} {
  const parts = [traveler.city, traveler.country].filter(Boolean);
  return {
    userId:              traveler.userId,
    username:            traveler.username  ?? null,
    avatarUrl:           traveler.avatarUrl ?? null,
    approximateLocation: parts.length > 0 ? parts.join(", ") : null,
  };
}

/** Check if GPS sharing context is safe to include (ghost mode / location off). */
export function isSharingAllowed(opts: {
  locationMode: string;
  sharingPaused: boolean;
  ghostMode?: boolean;
}): boolean {
  if (opts.sharingPaused) return false;
  if (opts.ghostMode) return false;
  if (opts.locationMode === "off") return false;
  return true;
}
