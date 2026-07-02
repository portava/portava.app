/**
 * Pure helpers for the stamp share feature.
 *
 * Extracted from useStampShare so these functions can be imported and
 * tested in Node.js without React / React Native native module bindings.
 */
import type { PassportStampNew } from './passportStamps';
import type { PassportStamp } from '../types/models';

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
  return { id: s.id, kind, label, earnedAt: s.earnedAt, locked: s.isRevoked };
}

/**
 * Build the human-readable share message for a stamp.
 *
 * Examples:
 *   makeStampShareMessage(cityStamp, 'alice')
 *   → '@alice just earned the "Cebu" passport stamp in Cebu! 🌍\n\nCheck it out on Travel Buddy'
 *
 *   makeStampShareMessage(eventStamp, null)
 *   → 'I just earned the "Attended Jazz Night" passport stamp! 🌍\n\nCheck it out on Travel Buddy'
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
  return [
    `${who} just earned the "${name}" passport stamp${loc ? ` in ${loc}` : ''}! 🌍`,
    '',
    'Check it out on Travel Buddy',
  ].join('\n');
}

/** Ensure the URI has exactly one file:// prefix regardless of what captureRef returns. */
export function toFileUri(uri: string): string {
  return uri.startsWith('file://') ? uri : `file://${uri}`;
}
