/**
 * safeNotifications — guarded wrappers around expo-notifications.
 *
 * ExpoTopicSubscriptionModule (and other expo-notifications native modules)
 * may not be registered in the native runtime when running on a dev client
 * that was built before expo-notifications was installed, or when the native
 * rebuild hasn't happened yet. Calling any API on the module in that state
 * crashes the app before any JS error boundary can catch it.
 *
 * Every function here uses a lazy require() inside try/catch so the native
 * module is only accessed after mount, inside a controlled error boundary.
 * Import from this file instead of 'expo-notifications' directly in files
 * that are evaluated at app startup (e.g. _layout.tsx, root hooks).
 *
 * Type-only imports from expo-notifications are safe: they generate no
 * runtime code and do not trigger native module access.
 */
import { Platform } from 'react-native';
import type {
  NotificationHandler,
  NotificationResponse,
  Subscription,
} from 'expo-notifications';

let _module: any = undefined;

function getModule(): any | null {
  if (Platform.OS === 'web') return null;
  if (_module !== undefined) return _module;
  try {
    _module = require('expo-notifications');
  } catch (e) {
    _module = null;
    if (__DEV__) {
      console.warn(
        '[safeNotifications] expo-notifications native module unavailable. ' +
          'Rebuild your dev client to enable push notifications.',
        e,
      );
    }
  }
  return _module;
}

const noop = { remove: () => {} };

export function setNotificationHandler(handler: NotificationHandler): void {
  try {
    getModule()?.setNotificationHandler(handler);
  } catch (e) {
    if (__DEV__) console.warn('[safeNotifications] setNotificationHandler failed', e);
  }
}

export async function getPermissionsAsync(): Promise<{ granted?: boolean }> {
  try {
    return (await getModule()?.getPermissionsAsync()) ?? {};
  } catch {
    return {};
  }
}

export async function requestPermissionsAsync(): Promise<{ granted?: boolean }> {
  try {
    return (await getModule()?.requestPermissionsAsync()) ?? {};
  } catch {
    return {};
  }
}

export async function getExpoPushTokenAsync(
  options?: { projectId?: string },
): Promise<{ data?: string }> {
  try {
    return (await getModule()?.getExpoPushTokenAsync(options)) ?? {};
  } catch {
    return {};
  }
}

export async function getLastNotificationResponseAsync(): Promise<NotificationResponse | null> {
  try {
    return (await getModule()?.getLastNotificationResponseAsync()) ?? null;
  } catch {
    return null;
  }
}

export function addNotificationResponseReceivedListener(
  listener: (response: NotificationResponse) => void,
): Subscription {
  try {
    return getModule()?.addNotificationResponseReceivedListener(listener) ?? noop;
  } catch {
    return noop as Subscription;
  }
}
