---
name: expo-notifications safe wrapper
description: How to guard expo-notifications native module crashes on Hermes/Android; also covers the user_location_privacy → location_preferences table rename.
---

## Rule
Never import `expo-notifications` at the top level in files evaluated at app startup (_layout.tsx, root hooks). Use `src/lib/safeNotifications.ts` instead.

**Why:** ExpoTopicSubscriptionModule crashes at module-load time when the native build predates the JS bundle (e.g. running in Expo Go or an old dev client).

## CRITICAL: try/catch does NOT work on Hermes (Android)

Lazy `require('expo-notifications')` inside try/catch is NOT sufficient.
In Hermes, "Cannot find native module 'ExpoTopicSubscriptionModule'" is thrown by
`TurboModuleRegistry.getEnforcing()` inside the expo-notifications JS shim during the
Metro module-factory evaluation phase — BEFORE the try{} frame on the caller side is
entered. The catch block never runs.

**The fix:** Use a `NativeModules` pre-check before calling `require()`:

```typescript
import { NativeModules, Platform } from 'react-native';

function getModule(): any | null {
  if (Platform.OS === 'web') return null;
  if (_module !== undefined) return _module;

  const nm = NativeModules as Record<string, unknown>;
  if (!nm['ExpoTopicSubscriptionModule'] && !nm['ExpoNotifications']) {
    _module = null;
    return null;  // skip require entirely — it would throw uncatchably
  }

  try {
    _module = require('expo-notifications');
  } catch (e) {
    _module = null;
  }
  return _module;
}
```

`NativeModules` is populated synchronously at startup. If the key is absent, the native
module isn't registered — skip the require. The try/catch stays as a second line of
defense for other failure modes.

**How to apply:**
- `import type { X } from 'expo-notifications'` is always safe (generates no runtime code).
- All runtime APIs (setNotificationHandler, getPermissionsAsync, requestPermissionsAsync,
  getExpoPushTokenAsync, getLastNotificationResponseAsync,
  addNotificationResponseReceivedListener) → import from `src/lib/safeNotifications.ts`.
- safeNotifications.ts caches the require result in `_module`; repeat calls are free.
- Apply fixes to BOTH `artifacts/travel-buddy/src/lib/` AND `travel-buddy-standalone/src/lib/`.

## user_location_privacy → location_preferences
`ensureProfile()` in `auth.ts` used to call `supabase.from('user_location_privacy').upsert(...)`. That table no longer exists — migration 0032 created `location_preferences` with a different schema. The upsert was removed; `location_preferences` rows are created by the location service on first access.

## supabase.auth throws on network failures
`supabase.auth.signInWithPassword` (and signUp, resetPasswordForEmail) can throw `TypeError: Network request failed` instead of returning `{ data, error }` when the network is truly unreachable. Always wrap in try/catch and convert thrown errors to `{ error: message }`.
