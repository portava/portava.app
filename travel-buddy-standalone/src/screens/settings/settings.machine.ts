/**
 * Settings screen — account activation/deactivation state machine.
 *
 * Pure logic backing app/settings/index.tsx (kept outside app/ so expo-router
 * does not register it as a route) so it can be tested
 * with node:test without rendering the component (RNTL is broken with
 * React 19 + jest-expo; machine-layer is the working alternative).
 *
 * The component calls these functions and applies the returned directives
 * to its own state and Alert calls. If this file diverges from the
 * component, tests will catch the mismatch.
 */

import type { ProfileResult } from '../../services/profile.ts';

/** Which account-management button the Settings screen should render. */
export type AccountButtonMode = 'reactivate' | 'deactivate';

/**
 * Given the locally-cached accountStatus, returns which action button
 * should be displayed. Both buttons are never visible at the same time.
 */
export function resolveAccountButton(accountStatus: string | null): AccountButtonMode {
  return accountStatus === 'deactivated' ? 'reactivate' : 'deactivate';
}

/** What the component should do after reactivateAccount() resolves. */
export type ReactivateDirective =
  | { type: 'success'; nextStatus: 'active' }
  | { type: 'error'; message: string };

/**
 * Derives the UI directive from a reactivateAccount() response.
 * The component applies nextStatus via setAccountStatus and calls
 * Alert.alert with the appropriate message.
 */
export function applyReactivateResult(
  res: Pick<ProfileResult<unknown>, 'ok' | 'errorKind' | 'message'>,
): ReactivateDirective {
  if (res.ok) {
    return { type: 'success', nextStatus: 'active' };
  }
  const message =
    res.errorKind === 'forbidden'
      ? 'This account cannot be self-reactivated. Please contact support.'
      : (res.message ?? 'Could not reactivate. Try again.');
  return { type: 'error', message };
}
