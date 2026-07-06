import { useEffect } from 'react';
import { router } from 'expo-router';
import { useSession } from '../context/SessionContext';
import { resolveAdminGate } from '../screens/admin/featureFlags.machine';

/**
 * Redirects unauthenticated users to the sign-in screen and
 * non-admin authenticated users to the home screen.
 * Returns true while still loading (auth + role checks pending).
 *
 * Usage: call at the top of any admin screen component.
 *   const adminLoading = useRequireAdmin();
 */
export function useRequireAdmin(): boolean {
  const { isAuthed, loading, role, roleLoaded } = useSession();
  const adminLoading = loading || (isAuthed && !roleLoaded);

  useEffect(() => {
    const outcome = resolveAdminGate({ adminLoading, isAuthed, role });
    if (outcome === 'pending') return;
    if (outcome === 'redirect_signin') {
      router.replace('/(auth)/sign-in' as any);
      return;
    }
    if (outcome === 'redirect_home') {
      router.replace('/' as any);
    }
  }, [adminLoading, isAuthed, role]);

  return adminLoading;
}
