/**
 * The Android notification channel incoming-call pushes are posted on.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `app/_layout.tsx` created `incoming_calls` with `importance: 5` and the
 * comment "AndroidImportance.MAX". expo-notifications numbers its OWN enum
 * (UNKNOWN=0 … DEFAULT=5, HIGH=6, MAX=7) rather than Android's
 * IMPORTANCE_* scale, so 5 was DEFAULT: an incoming call arrived as a quiet,
 * non-heads-up notification on Android 8+. The importance is now taken from
 * the installed enum, never a literal, and a test pins it.
 *
 * ── WHY A NEW CHANNEL ID ────────────────────────────────────────────────────
 * Android lets an app set a channel's importance only when it CREATES the
 * channel; re-registering an existing id with a higher importance is ignored
 * (only the user can change it afterwards). Every install that has already
 * run the app holds `incoming_calls` at DEFAULT and would keep it forever. So
 * the channel moves to a new id, the old one is deleted on start-up, and the
 * server's `call.incoming` push names the new id
 * (api-server `services/notifications/NotificationRouter.ts`).
 *
 * Deploy order is harmless either way: a push naming a channel the device does
 * not have is posted to the fallback channel at default importance — exactly
 * what every Android install gets today.
 */
import { AndroidImportance } from 'expo-notifications/build/NotificationChannelManager.types';
import { deleteNotificationChannelAsync, setNotificationChannelAsync } from './safeNotifications.ts';

export const CALL_CHANNEL_ID = 'incoming_calls_v2';
/** Ids an earlier build created at the wrong importance. Deleted on start-up. */
export const LEGACY_CALL_CHANNEL_IDS: readonly string[] = ['incoming_calls'];

export const CALL_CHANNEL = {
  name: 'Incoming calls',
  // Heads-up overlay with sound on Android 8+.
  importance: AndroidImportance.MAX,
  sound: true,
  vibrationPattern: [0, 250, 250, 250],
  enableLights: true,
  bypassDnd: false,
};

/** Delete the legacy channel(s), then create the call channel. Safe no-op off Android. */
export async function registerCallNotificationChannel(deps: {
  remove: (id: string) => Promise<void>;
  create: (id: string, options: typeof CALL_CHANNEL) => Promise<unknown>;
} = { remove: deleteNotificationChannelAsync, create: setNotificationChannelAsync }): Promise<void> {
  for (const id of LEGACY_CALL_CHANNEL_IDS) await deps.remove(id);
  await deps.create(CALL_CHANNEL_ID, { ...CALL_CHANNEL, vibrationPattern: [...CALL_CHANNEL.vibrationPattern] });
}
