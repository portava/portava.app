/**
 * Universal display-name rule (client side).
 *
 * The API redacts real names server-side: `displayName`/`name` fields arrive
 * as null unless that user opted in to "Show my real name" (or the viewer is
 * looking at themselves). These helpers centralize the client-side fallback so
 * every surface renders identity the same way:
 *
 *   primaryIdentityText   → real name when present, otherwise "@handle",
 *                           otherwise "Traveler"
 *   secondaryIdentityText → "@handle" shown alongside a real name; null when
 *                           the primary text is already the handle (no dupes)
 */

import { truncateDisplayName } from '../utils/identity.ts';

export interface DisplayIdentity {
  displayName?: string | null;
  name?: string | null;
  fullName?: string | null;
  handle?: string | null;
  username?: string | null;
}

function clean(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s.length > 0 ? s : null;
}

/** Bare handle (no leading @) from whichever field the API used. */
export function identityHandle(id: DisplayIdentity | null | undefined): string | null {
  const h = clean(id?.handle) ?? clean(id?.username);
  if (!h) return null;
  return h.startsWith('@') ? clean(h.slice(1)) : h;
}

/** Real name if the subject opted in (server sends null otherwise). */
export function identityRealName(id: DisplayIdentity | null | undefined): string | null {
  return clean(id?.displayName) ?? clean(id?.name) ?? clean(id?.fullName);
}

/** The one line every surface should render for a user reference. */
export function primaryIdentityText(id: DisplayIdentity | null | undefined): string {
  const real = identityRealName(id);
  // Legacy accounts predating the 40-char limit can still have longer names
  // stored; cap at render time so no surface overflows or wraps badly.
  if (real) return truncateDisplayName(real);
  const h = identityHandle(id);
  return h ? `@${h}` : 'Traveler';
}

/**
 * Optional second line: "@handle" under a real name. Null when there is no
 * real name (primary already shows the handle) or when they'd duplicate.
 */
export function secondaryIdentityText(id: DisplayIdentity | null | undefined): string | null {
  const real = identityRealName(id);
  const h = identityHandle(id);
  if (!real || !h) return null;
  const rl = real.toLowerCase();
  if (rl === h.toLowerCase() || rl === `@${h.toLowerCase()}`) return null;
  return `@${h}`;
}
