/**
 * postAuthRedirect — remembers the screen a signed-out person was trying to
 * open, so signing in (or finishing onboarding) lands them back on it.
 *
 * Without it, a trip invite link opened while signed out showed "Sign in to
 * join", and signing in dropped the person on the Pulse tab with the invite
 * gone: they had to find and tap the link again.
 *
 * The path is kept in memory for this app session only, expires after
 * REDIRECT_TTL_MS, and is read (not consumed) by every sign-in exit, because
 * the sign-in screen can route twice (its own handler, then its isAuthed
 * effect). The destination screen clears it once it has loaded signed in.
 *
 * Only an in-app path is accepted: it must start with a single "/".
 */

export const REDIRECT_TTL_MS = 30 * 60 * 1000;

let pending: { path: string; at: number } | null = null;

export function isSafeInAppPath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !/[\s\\]/.test(path);
}

export function setPostAuthRedirect(path: string, now: number = Date.now()): void {
  pending = isSafeInAppPath(path) ? { path, at: now } : null;
}

export function getPostAuthRedirect(now: number = Date.now()): string | null {
  if (!pending) return null;
  if (now - pending.at > REDIRECT_TTL_MS) {
    pending = null;
    return null;
  }
  return pending.path;
}

export function clearPostAuthRedirect(): void {
  pending = null;
}

/** Where to go after signing in: the remembered screen, else the tabs. */
export function postAuthDestination(now: number = Date.now()): string {
  return getPostAuthRedirect(now) ?? '/(tabs)';
}
