/**
 * usePushToken — registers the device for Expo push notifications and saves
 * the token to the API server so the backend can send nudges.
 *
 * Call this hook once after the user is authenticated. It is idempotent:
 * re-registering with the same token is a no-op on the server.
 *
 * Token registration logic lives in src/services/pushTokenService.ts so it
 * can be tested in Node.js without native Expo bindings.
 *
 * Important: getExpoPushTokenAsync() requires the EAS projectId in SDK 54+.
 * Without it the call throws on standalone builds (works only in Expo Go).
 */
import { useEffect } from 'react';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { useSession } from '../context/SessionContext';
import { savePushToken } from '../services/pushTokenService';
import {
  getPermissionsAsync,
  requestPermissionsAsync,
  getExpoPushTokenAsync,
} from '../lib/safeNotifications';

export function usePushToken(): void {
  const { isAuthed } = useSession();

  useEffect(() => {
    if (!isAuthed || Platform.OS === 'web') return;

    let cancelled = false;

    (async () => {
      const perms = await getPermissionsAsync();

      if (!perms.granted) {
        const newPerms = await requestPermissionsAsync();
        if (!newPerms.granted || cancelled) return;
      }

      if (cancelled) return;

      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId as string | undefined;

      const { data: pushToken } = await getExpoPushTokenAsync(
        projectId ? { projectId } : undefined,
      );
      if (!pushToken || cancelled) return;

      await savePushToken(pushToken);
    })().catch(() => {});

    return () => { cancelled = true; };
  }, [isAuthed]);
}
