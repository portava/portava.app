/**
 * Pure helpers for the stamp share feature.
 *
 * Extracted from useStampShare so these functions can be imported and
 * tested in Node.js without React / React Native native module bindings.
 */
import type { PassportStampNew } from './passportStamps.ts';
import type { PassportStamp } from '../types/models.ts';
import { canonicalUrl } from '../constants/canonicalUrl.ts';

/** Convert the new stamp shape to the legacy PassportStamp used by StampShareCard. */
export function stampToLegacy(s: PassportStampNew): PassportStamp {
  const label =
    s.titleOverride ??
    s.definition?.name ??
    s.city ??
    s.country ??
    s.stampType.replace(/_/g, ' ').toUpperCase();
  const kind = (
    s.stampType === 'city'          ? 'city'
    : s.stampType === 'plan'        ? 'plan'
    : s.stampType === 'hidden_gem'  ? 'gem'
    : s.stampType === 'safe_return' ? 'safe'
    : s.stampType === 'host'        ? 'host'
    : 'city'
  ) as PassportStamp['kind'];
  return {
    id: s.id,
    kind,
    label,
    earnedAt: s.earnedAt,
    locked: s.isRevoked,
    universalArtworkUrl: s.definition?.universalArtworkUrl ?? undefined,
    rarity: s.definition?.rarity,
  };
}

/**
 * Return a { deepLink, webUrl } pair for a stamp share.
 *
 * Deep link:  travelbuddy://passport/@<username>?stamp=<id>  (with username)
 *             travelbuddy://stamp/<id>                       (without username)
 * Web URL:    <origin>/u/<username>?stamp=<id>               (with username)
 *             <origin>/stamp/<id>                            (without username)
 *
 * The ?stamp=<id> query on the web URL lets the share-page server render a
 * stamp-specific Open Graph preview (label + artwork) in chat apps.
 *
 * The username-less pair used to be `travelbuddy://stamps/<id>` and
 * `<origin>/passport`, and neither resolved. `/stamps/<id>` is not a route —
 * app/stamps.tsx is the stamp *list* and the detail screen is
 * app/stamp/[stampId].tsx — so the deep link landed on +not-found. `/passport`
 * with no username is not a server route either (wellKnownShare registers
 * /passport/:username), so the web fallback 404'd. Both now point at the
 * stamp itself, whose landing page exists.
 */
export function makeStampShareLinks(
  stamp: PassportStampNew,
  username?: string | null,
): { deepLink: string; webUrl: string } {
  const id = encodeURIComponent(stamp.id);

  if (username) {
    const u = encodeURIComponent(username);
    return {
      deepLink: `travelbuddy://passport/@${u}?stamp=${id}`,
      webUrl: canonicalUrl(`/u/${u}?stamp=${id}`),
    };
  }
  return {
    deepLink: `travelbuddy://stamp/${id}`,
    webUrl: canonicalUrl(`/stamp/${id}`),
  };
}

/**
 * Build the human-readable share message for a stamp.
 *
 * Always includes deep link + web fallback URL so recipients can open the
 * stamp whether or not they have the app installed.
 *
 * Examples:
 *   makeStampShareMessage(cityStamp, 'alice')
 *   → '@alice just earned the "Cebu" passport stamp in Cebu! 🌍\n\nOpen in app: travelbuddy://...\nView online: https://...'
 *
 *   makeStampShareMessage(eventStamp, null)
 *   → 'I just earned the "Attended Jazz Night" passport stamp! 🌍\n\nOpen in app: travelbuddy://...\nView online: https://...'
 */
export function makeStampShareMessage(stamp: PassportStampNew, username?: string | null): string {
  const name =
    stamp.titleOverride ??
    stamp.definition?.name ??
    stamp.city ??
    stamp.country ??
    'a stamp';
  const loc = stamp.city ?? stamp.country ?? null;
  const who = username ? `@${username}` : 'I';
  const { deepLink, webUrl } = makeStampShareLinks(stamp, username);
  return [
    `${who} just earned the "${name}" passport stamp${loc ? ` in ${loc}` : ''}! 🌍`,
    '',
    `Open in app: ${deepLink}`,
    `View online: ${webUrl}`,
  ].join('\n');
}

/** Ensure the URI has exactly one file:// prefix regardless of what captureRef returns. */
export function toFileUri(uri: string): string {
  return uri.startsWith('file://') ? uri : `file://${uri}`;
}
