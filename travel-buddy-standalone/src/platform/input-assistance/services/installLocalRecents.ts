/**
 * installLocalRecents — bind the device-local recents store to AsyncStorage
 * (§32 census G199, §34 census G213).
 *
 * A SEAM, NOT AN AUTO-INSTALL, exactly like `installInputTelemetry` and
 * `installInputPolicySync`: importing this module starts nothing and reads
 * nothing. `app/_layout.tsx` calls it once. `localZeroState.ts` and
 * `localRecentsStore.ts` never import AsyncStorage, which is what keeps them
 * importable from node:test and is what the `suggestionHistory.ts` header has
 * asked for since Phase 1 ("dependency-free … so it is safe to import
 * anywhere").
 *
 * WHY THIS IS THE FILE THAT DECIDES G199 IS BUILT RATHER THAN MERELY WRITTEN.
 * The census's own reason for dropping this work earlier was that persisting a
 * store with "no production consumer at all" would produce a second unread
 * module. The consumer exists now (G216 wired `localZeroState` into the hook
 * and `SmartInput` into the write path), and this is the line that makes the
 * store survive a restart on a real device. Without it the platform behaves
 * exactly as it did before: in-session only, and no worse.
 *
 * FAIL-SOFT, ALWAYS. Hydration failures are swallowed inside
 * `attachLocalRecents` — an unreadable device makes the app behave as one with
 * no device, never as one that throws on boot.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { attachLocalRecents, detachLocalRecents } from './localZeroState.ts';

/**
 * Attach the device-local recents store. Returns a teardown that UNBINDS
 * without erasing what is on the device — a root layout remount must not cost
 * the user their recents. Erasing is `clearLocalRecents`, and the only thing
 * that calls it is an account change (`policySync.ts#applyAccountChange`).
 */
export function installLocalRecents(): () => void {
  void attachLocalRecents(AsyncStorage);
  return () => detachLocalRecents();
}
