---
name: OAuth SSO — Apple + Google implementation
description: Architecture decisions and gotchas for Sign in with Apple / Google in this Expo app
---

# OAuth SSO Implementation Notes

## Architecture
- **Apple**: `expo-apple-authentication` (native, lazy-required) → `supabase.auth.signInWithIdToken({ provider: 'apple', token: identityToken })`
- **Google**: `supabase.auth.signInWithOAuth({ provider: 'google', skipBrowserRedirect: true })` → `WebBrowser.openAuthSessionAsync` → parse redirect URL → `supabase.auth.exchangeCodeForSession(code)` (PKCE) or `supabase.auth.setSession({ access_token, refresh_token })` (implicit)

## Redirect URI
Uses `Linking.createURL('auth/callback')` from `expo-linking` (already installed). Produces `travelbuddy://auth/callback`.

**Why NOT expo-auth-session:** `expo-auth-session@6.1.5` depends on `expo-linking@~7.1.4` and `expo-constants@~17.1.4` — older SDK-aligned versions that pull in `@expo/config-plugins@10.1.2`, conflicting with the project's `@expo/config-plugins@54.0.4` and breaking a CI lockfile-consistency check.

## Platform rule
Apple button: iOS only (`Platform.OS === 'ios'` guard). Apple web OAuth (Android) not implemented — requires a Service ID relay backend. Google: both iOS and Android.

## Session flow
After SSO, Supabase client holds the session. `SessionContext.onAuthChange` picks it up via `onAuthStateChange`. The `oauthBusy` state in sign-in.tsx suppresses the automatic `/(tabs)` redirect while routing decisions are made (check profile → onboarding or tabs).

## Apple name is first-auth only
Apple only sends `credential.fullName` on the very first authorization. Subsequent sign-ins have null name. Always guard with `|| undefined` before passing to `ensureProfile`.

## Files
- `src/services/ssoAuth.ts` — SSO logic (canonical; auto-synced to standalone)
- `app/(auth)/sign-in.tsx` — button wiring
- `__mocks__/expo-apple-authentication.ts` — Jest mock

## EAS rebuild required
`expo-apple-authentication` is a native module. Must build a dev/production build before SSO works. EAS command: `cd travel-buddy-standalone && eas build --profile development --platform all`
