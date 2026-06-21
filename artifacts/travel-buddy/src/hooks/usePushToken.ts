/**
 * usePushToken — registers the device for Expo push notifications and saves
 * the token to the API server so the backend can send nudges.
 *
 * Call this hook once after the user is authenticated. It is idempotent:
 * re-registering with the same token is a no-op on the server.
 */
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { useSession } from '../context/SessionContext';
import { supabase } from '../lib/supabase';

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

async function savePushToken(pushToken: string): Promise<void> {
  const base = apiBase();
  if (!base) return;
  const token = await freshToken();
  if (!token) return;
  await fetch(`${base}/api/me/push-token`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: pushToken }),
  }).catch(() => {});
}

export function usePushToken(): void {
  const { isAuthed } = useSession();

  useEffect(() => {
    if (!isAuthed || Platform.OS === 'web') return;

    let cancelled = false;

    (async () => {
      const perms = (await Notifications.getPermissionsAsync()) as { granted?: boolean };

      if (!perms.granted) {
        const newPerms = (await Notifications.requestPermissionsAsync()) as { granted?: boolean };
        if (!newPerms.granted || cancelled) return;
      }

      if (cancelled) return;

      const { data: pushToken } = await Notifications.getExpoPushTokenAsync();
      if (!pushToken || cancelled) return;

      await savePushToken(pushToken);
    })().catch(() => {});

    return () => { cancelled = true; };
  }, [isAuthed]);
}
