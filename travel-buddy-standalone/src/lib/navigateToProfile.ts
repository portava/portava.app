/**
 * navigateToProfile — canonical routing for tapping a user identity.
 *
 * Routes to the viewer's own Passport tab when they tap their own identity;
 * otherwise navigates to the public /u/:handle profile screen.
 *
 * All surfaces that navigate from a user identity tap should call this
 * instead of pushing /u/:handle directly, so that "tap self → own Passport"
 * is consistently enforced across every surface.
 */
import { router } from 'expo-router';

export function navigateToProfile(
  handle: string | null | undefined,
  userId: string | null | undefined,
  currentUserId: string | null | undefined,
): void {
  if (!handle) return;
  try {
    if (userId && currentUserId && userId === currentUserId) {
      router.push('/(tabs)/passport' as any);
    } else {
      router.push(`/u/${handle}` as any);
    }
  } catch {
    // Navigation errors are silently ignored so a bad route never crashes the UI.
  }
}
