---
name: expo-notifications safe wrapper
description: How to guard expo-notifications native module crashes; also covers the user_location_privacy → location_preferences table rename.
---

## Rule
Never import `expo-notifications` at the top level in files evaluated at app startup (_layout.tsx, root hooks). Use `src/lib/safeNotifications.ts` instead.

**Why:** ExpoTopicSubscriptionModule (and related modules) crash at module-load time when the native build predates the JS bundle. Top-level `import * as Notifications from 'expo-notifications'` is compiled to a synchronous require at file evaluation — there is no way to catch it from outside the module. Moving to lazy `require()` inside try/catch in safeNotifications.ts makes the failure catchable.

**How to apply:**
- `import type { X } from 'expo-notifications'` is always safe (generates no runtime code).
- Runtime API (setNotificationHandler, getPermissionsAsync, requestPermissionsAsync, getExpoPushTokenAsync, getLastNotificationResponseAsync, addNotificationResponseReceivedListener) → import from `src/lib/safeNotifications.ts`.
- safeNotifications.ts caches the require result in `_module`; repeat calls are free.

## user_location_privacy → location_preferences
`ensureProfile()` in `auth.ts` used to call `supabase.from('user_location_privacy').upsert(...)`. That table no longer exists — migration 0032 created `location_preferences` with a different schema. The upsert was removed; `location_preferences` rows are created by the location service on first access.

## supabase.auth throws on network failures
`supabase.auth.signInWithPassword` (and signUp, resetPasswordForEmail) can throw `TypeError: Network request failed` instead of returning `{ data, error }` when the network is truly unreachable. Always wrap in try/catch and convert thrown errors to `{ error: message }`.
