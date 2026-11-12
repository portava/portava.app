import { createHash } from "node:crypto";
import { normaliseVenueName, type LiveVenueAnchor } from "./liveIntelligence.js";

/** Only identity-checked resolutions use this namespace. Legacy rows contain
 * no matching evidence and must never be promoted just because their URL loads.
 * Full coordinates prevent adjacent branches sharing the old rounded cache key;
 * binding the supplied name/anchor also prevents a request poisoning another
 * place's durable cache by reusing its placeKey. */
export function verifiedPlacePhotoKey(placeKey: string, name: string, anchor: LiveVenueAnchor): string {
  const digest = createHash("sha256").update(JSON.stringify([normaliseVenueName(name), anchor.lat, anchor.lng])).digest("hex");
  return `${placeKey}:photo-v2:${digest}`;
}

/** A photo URL is a provider CDN artifact, never an arbitrary provider field. */
export function foursquarePhotoUrl(prefix: unknown, suffix: unknown): string | null {
  if (typeof prefix !== "string" || typeof suffix !== "string") return null;
  try {
    const url = new URL(`${prefix}original${suffix}`);
    if (url.protocol !== "https:" || url.username || url.password || !/(^|\.)4sqi\.net$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
