/**
 * usePushToken — registers the device for Expo push notifications and saves
 * the token to the API server so the backend can send nudges.
 *
 * Call this hook once after the user is authenticated. It is idempotent:
 * re-registering with the same token is a no-op on the server.
 *
 * Token registration logic lives in src/services/pushTokenService.ts so it
 * can be tested in Node.js without native Expo bindings.
 */
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { useSession } from '../context/SessionContext';
import { savePushToken } from '../services/pushTokenService';

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
