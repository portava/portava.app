/**
 * safeNotifications — guarded wrappers around expo-notifications.
 *
 * ExpoTopicSubscriptionModule (and other expo-notifications native modules)
 * may not be registered when running in Expo Go or a dev client built before
 * expo-notifications was installed.
 *
 * IMPORTANT: In Hermes on Android, "Cannot find native module" errors thrown
 * by TurboModuleRegistry.getEnforcing() inside a module's JS shim fire during
 * the Metro module-factory evaluation phase, which happens BEFORE the try{}
 * frame on the caller side is active. That means try/catch around require()
 * cannot intercept them. We guard with a NativeModules pre-check instead.
 *
 * Import from this file instead of 'expo-notifications' directly in files
 * evaluated at app startup (_layout.tsx, root hooks, etc.).
 * Type-only imports from expo-notifications are safe — they produce no runtime code.
 */
import { NativeModules, Platform } from 'react-native';
import type {
  NotificationHandler,
  NotificationResponse,
  Subscription,
} from 'expo-notifications';

let _module: any = undefined;

function getModule(): any | null {
  if (Platform.OS === 'web') return null;
  if (_module !== undefined) return _module;

  // Pre-guard: NativeModules is populated synchronously at startup.
  // If ExpoTopicSubscriptionModule is absent the require() would throw an
  // uncatchable error in Hermes. Skip the require entirely in that case.
  const nm = NativeModules as Record<string, unknown>;
  if (!nm['ExpoTopicSubscriptionModule'] && !nm['ExpoNotifications']) {
    _module = null;
    if (__DEV__) {
      console.warn(
        '[safeNotifications] ExpoTopicSubscriptionModule not found — ' +
          'notifications disabled. Rebuild your dev client to enable push notifications.',
      );
    }
    return null;
  }

  try {
    _module = require('expo-notifications');
  } catch (e) {
    _module = null;
    if (__DEV__) {
      console.warn('[safeNotifications] expo-notifications require failed:', e);
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

/**
 * Would scheduling a notification RIGHT NOW put an OS permission dialog in
 * front of the traveller?
 *
 * §17.1 asks a caller to explain a permission before the system asks for it,
 * and a caller cannot explain what is not about to happen: showing a rationale
 * when permission is already granted, or when there is no native module to
 * prompt with (web, Expo Go without the module), is noise that teaches people
 * to dismiss the sheet that matters.
 *
 * FAILS TOWARDS NO SHEET, deliberately. `getPermissionsAsync` already swallows
 * its own error and answers `{}`, and `{}` is indistinguishable from "denied".
 * Treating unknown as "needs a prompt" would show the explanation on every tap
 * for anyone whose permission state cannot be read; treating it as "no prompt"
 * costs at most a missing explanation on a dialog the OS may not even raise.
 * The prompt itself is unaffected either way — `scheduleLocalNotificationAt`
 * owns it and is untouched.
 */
export async function notificationPromptWouldAppear(): Promise<boolean> {
  if (!getModule()) return false;
  try {
    const perms = await getModule()?.getPermissionsAsync();
    return perms?.granted === false;
  } catch {
    return false;
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

/**
 * Schedule a local notification at a specific Date.
 * Returns the notification identifier, or null when notifications are
 * unavailable (web, Expo Go without the native module, permission denied).
 */
export async function scheduleLocalNotificationAt(
  date: Date,
  content: { title: string; body?: string; data?: Record<string, unknown> },
): Promise<string | null> {
  const mod = getModule();
  if (!mod) return null;
  try {
    const perms = await mod.getPermissionsAsync();
    if (!perms?.granted) {
      const req = await mod.requestPermissionsAsync();
      if (!req?.granted) return null;
    }
    if (date.getTime() <= Date.now()) return null;
    return await mod.scheduleNotificationAsync({
      content,
      trigger: { type: 'date', date },
    });
  } catch (e) {
    if (__DEV__) console.warn('[safeNotifications] scheduleLocalNotificationAt failed', e);
    return null;
  }
}

export async function cancelScheduledNotification(identifier: string | null | undefined): Promise<void> {
  if (!identifier) return;
  try {
    await getModule()?.cancelScheduledNotificationAsync(identifier);
  } catch {
    /* already fired or unavailable */
  }
}

/**
 * Register an Android notification channel.
 * Safe no-op on iOS and web (those platforms ignore notification channels).
 * Must be called before a push with a matching channelId can surface as a
 * heads-up overlay on Android 8+.
 *
 * @param channelId  Unique channel identifier (e.g. "incoming_calls")
 * @param options    Channel configuration forwarded to expo-notifications
 */
export async function setNotificationChannelAsync(
  channelId: string,
  options: {
    name: string;
    importance: number;
    sound?: boolean;
    vibrationPattern?: number[];
    enableLights?: boolean;
    lightColor?: string;
    bypassDnd?: boolean;
    lockscreenVisibility?: number;
  },
): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await getModule()?.setNotificationChannelAsync(channelId, options);
  } catch (e) {
    if (__DEV__) console.warn('[safeNotifications] setNotificationChannelAsync failed', e);
  }
}
