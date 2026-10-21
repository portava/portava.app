/** L259: an opaque Portava directional corridor reference, not a provider road/line identifier. */
import { createHmac } from "node:crypto";

export function layoverRouteSubjectRef(
  from: { lat: number; lng: number }, to: { lat: number; lng: number }, mode: string | undefined,
  secret = process.env["LAYOVER_ROUTE_SUBJECT_HMAC_SECRET"] ?? "",
): string | null {
  if (secret.length < 32 || !["walk", "drive", "transit"].includes(mode ?? "")) return null;
  if (![from, to].every(p => Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180)) return null;
  // A secret prevents dictionary lookup of a precise origin from a public event reference.
  // No clock: the same directional corridor remains the same event subject across forecasts.
  const key = JSON.stringify(["layover-route-v1", mode, from.lat, from.lng, to.lat, to.lng]);
  return `layover-route:v1:${createHmac("sha256", secret).update(key).digest("hex")}`;
}

export function validLayoverRouteSubject(ref: unknown): ref is string {
  return typeof ref === "string" && /^layover-route:v1:[a-f0-9]{64}$/.test(ref);
}
