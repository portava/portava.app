/**
 * eventPassportShareUtils — the PURE half of the temporary event Passport
 * client (spec §25/§31, Phase 8).
 *
 * Split out of eventPassport.ts, exactly as passportShareUtils.ts is split out
 * of the QR share hook, so these functions can be imported and tested in Node
 * without React Native's runtime. Nothing here talks to the network or decides
 * policy: the server owns expiry, revocation, the event's end and
 * co-attendance, and re-checks all four on every resolve.
 */
import { canonicalUrl } from '../../constants/canonicalUrl.ts';

/** Deep link a scanner opens. Carries the opaque token and nothing else. */
export function eventPassportDeepLink(token: string): string {
  return `travelbuddy://passport/event/${encodeURIComponent(token)}`;
}

/** Web fallback for the same token. */
export function eventPassportWebLink(token: string): string {
  return canonicalUrl(`/passport/event/${encodeURIComponent(token)}`);
}

/**
 * Is this share still live from the client's point of view? Purely local, and
 * only ever used to stop showing a lapsed share — the server re-checks expiry
 * on every resolve, so a wrong clock here can withhold but never grant.
 */
export function isShareLive(share: { expiresAt: string } | null, nowMs: number = Date.now()): boolean {
  if (!share) return false;
  const t = Date.parse(share.expiresAt);
  return Number.isFinite(t) && t > nowMs;
}

/** "Sharing for 42m" / "Sharing for 3h 10m" — null once the share has lapsed. */
export function shareRemainingLabel(
  share: { expiresAt: string } | null,
  nowMs: number = Date.now(),
): string | null {
  if (!isShareLive(share, nowMs)) return null;
  const ms = Date.parse(share!.expiresAt) - nowMs;
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m left`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h left` : `${hours}h ${minutes}m left`;
}
