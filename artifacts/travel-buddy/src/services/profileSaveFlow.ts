/**
 * Shared save-result handling for the edit-profile screens.
 *
 * Every edit-profile save flow must surface an ok:false result from
 * updateMyProfile as a visible error — most importantly errorKind
 * 'partial_save', where the server returned 200 but silently dropped some
 * fields (database schema drift). A screen that ignores the failure would
 * show a success toast while the user's fields were lost.
 *
 * Screens call resolveProfileSaveOutcome(res) and branch on the outcome
 * instead of re-implementing the ok/error split inline; identity.tsx uses
 * classifyIdentitySaveFailure to additionally route username/DOB failures
 * to their field-level banners without ever swallowing partial_save.
 */
import type { ProfileResult } from './profile.ts';

export type ProfileSaveOutcome =
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

/**
 * Collapse a ProfileResult into the UI decision every save screen makes:
 * show a success state, or show an error banner with the server's message
 * (including the partial-save "Some fields couldn't be saved…" warning).
 */
export function resolveProfileSaveOutcome<T>(
  res: Pick<ProfileResult<T>, 'ok' | 'message'>,
  fallbackMessage = 'Failed to save profile',
): ProfileSaveOutcome {
  if (res.ok) return { kind: 'saved' };
  return { kind: 'error', message: res.message ?? fallbackMessage };
}

/** Field-level routing used only by the Identity screen. */
export type IdentitySaveFailure =
  | { field: 'username'; status: 'cooldown' | 'taken'; message: string }
  | { field: 'dob'; message: string }
  | { field: 'form'; message: string };

/**
 * Route an ok:false updateMyProfile result to the right Identity-screen
 * banner. Anything that is not specifically a username or date-of-birth
 * validation failure — including partial_save — falls through to the
 * general form-level save error so the message is always shown.
 */
export function classifyIdentitySaveFailure(
  res: Pick<ProfileResult<unknown>, 'errorKind' | 'message'>,
): IdentitySaveFailure {
  const kind = res.errorKind ?? '';
  const msg = res.message ?? '';
  const msgLower = msg.toLowerCase();
  if (kind === 'rate_limited') {
    return { field: 'username', status: 'cooldown', message: msg || 'Username cannot be changed yet' };
  }
  if ((kind === 'invalid_payload' || kind === 'conflict') && msgLower.includes('username')) {
    return { field: 'username', status: 'taken', message: msg || 'Username not available' };
  }
  if (
    kind === 'invalid_payload' &&
    (msgLower.includes('dateofbirth') || msgLower.includes('13 years') || msgLower.includes('date of birth'))
  ) {
    return { field: 'dob', message: msg || 'Invalid date of birth' };
  }
  return { field: 'form', message: msg || 'Failed to save profile' };
}
