/**
 * runOnboardingFinish — extracted from the Onboarding screen's handleFinish.
 *
 * Responsibilities:
 *   1. PATCH the user profile with the onboarding data (including
 *      `onboardingComplete: true`, which triggers the server-side @Portava
 *      auto-follow).
 *   2. Bump the social-version counter so any already-mounted hook that tracks
 *      the following list (useFollow, useFollowingFeed, etc.) immediately
 *      re-fetches and reflects the new follow — without requiring a restart.
 *   3. Call `onComplete` on success (or on soft errors such as config_error /
 *      unauthenticated, which fall through to navigation like the original code).
 *   4. Call `onError` on hard errors (db_error, network_unreachable, etc.) so
 *      the caller can show a retry alert.
 *
 * Extracted to make the bump→navigate sequence unit-testable without the
 * React-19 + RNTL renderer-budget constraints of a full component test.
 */
import { updateMyProfile, type UpdateProfileInput, type ProfileResult } from './profile.ts';
import { bumpSocialVersion } from '../hooks/useSocialVersion.ts';

export async function runOnboardingFinish(options: {
  patch: UpdateProfileInput;
  /** Called on success (and on soft config/auth errors). */
  onComplete: () => void;
  /** Called on hard server/network errors so the caller can show a retry alert. */
  onError: (result: ProfileResult<unknown>) => void;
}): Promise<void> {
  const result = await updateMyProfile(options.patch);

  // Hard errors → let the caller decide (retry vs. continue-anyway).
  if (
    !result.ok &&
    result.errorKind !== 'config_error' &&
    result.errorKind !== 'unauthenticated'
  ) {
    options.onError(result);
    return;
  }

  // Success (or soft config/auth error that still navigates): bump the
  // social-version counter BEFORE navigation so mounted hooks start
  // re-fetching before the tab stack mounts.
  bumpSocialVersion();
  options.onComplete();
}
