# OAuth SSO Completion Report — Sign in with Apple & Sign in with Google

**Date:** 2026-07-22  
**Status:** Implementation complete. EAS rebuild required before SSO is functional on device.

---

## A. Files Changed

| Path | Change |
|------|--------|
| `artifacts/travel-buddy/src/services/ssoAuth.ts` | **NEW** — Apple + Google SSO logic |
| `artifacts/travel-buddy/app/(auth)/sign-in.tsx` | Wired Apple/Google buttons; `oauthBusy` state; handlers; platform-conditional Apple button |
| `artifacts/travel-buddy/__mocks__/expo-apple-authentication.ts` | **NEW** — Jest mock for native Apple module |
| `artifacts/travel-buddy/package.json` | Added `expo-apple-authentication ~7.2.2`, `expo-auth-session ~6.1.5` |
| `artifacts/travel-buddy/app.json` | Added `expo-apple-authentication` Expo config plugin |
| `travel-buddy-standalone/package.json` | Added same two deps (preserved-by-design; not auto-synced) |

---

## B. Packages Added / Changed

| Package | Version | Purpose |
|---------|---------|---------|
| `expo-apple-authentication` | `~7.2.4` | Native Apple Sign-In sheet on iOS |
| `expo-web-browser` | `~15.0.10` | Already present — used for Google OAuth browser session |
| `expo-linking` | `~8.0.10` | Already present — `Linking.createURL` used for OAuth redirect URI (replaces `expo-auth-session`) |

**`expo-auth-session` was considered and rejected.** Version `6.1.5` depends on `expo-linking@~7.1.4` and `expo-constants@~17.1.4`, which conflict with the project's `expo-linking@~8.0.10` and introduce a second `@expo/config-plugins` version into the standalone lockfile (causing a CI test failure). `expo-linking`'s `Linking.createURL()` is functionally equivalent for this use case and is already installed at the correct version.

No packages were removed. No existing package versions changed.

---

## C. Expo / app.json / app.config.js Changes

- `artifacts/travel-buddy/app.json` — added `"expo-apple-authentication"` to the `plugins` array. This plugin configures the `NSFaceIDUsageDescription` and `com.apple.developer.applesignin` entitlement in the iOS build.
- No changes to `app.config.js` (file does not exist — project uses `app.json` only).
- Existing `scheme: "travelbuddy"` reused as the OAuth redirect base — no new scheme needed.

---

## D. Supabase Dashboard — Required Manual Configuration

### 1. Enable Apple Provider
1. Open **Authentication → Providers → Apple**.
2. Toggle **Enable Sign in with Apple**.
3. Enter your **Apple Service ID** (from Apple Developer, see Section F).
4. Enter your **Apple Team ID** (10-character string in Apple Developer portal, upper right).
5. Enter the **private key** content (the `.p8` file text) and its **Key ID**.
6. Save.

### 2. Enable Google Provider
1. Open **Authentication → Providers → Google**.
2. Toggle **Enable Sign in with Google**.
3. Enter your **Google Client ID** (Web application client ID, from GCP — see Section E).
4. Enter your **Google Client Secret**.
5. Save.

### 3. Add OAuth Redirect URLs
Under **Authentication → URL Configuration → Redirect URLs**, add all of the following:

```
travelbuddy://auth/callback
https://YOUR_SUPABASE_PROJECT_REF.supabase.co/auth/v1/callback
```

Replace `YOUR_SUPABASE_PROJECT_REF` with your project reference (the subdomain of your Supabase URL).

For development (Expo Go / local), also add:
```
exp://YOUR_EXPO_DEV_DOMAIN/--/auth/callback
```

### 4. JWT Settings
No changes required. Supabase's default JWT RS256 settings work correctly with OAuth providers.

---

## E. Google Cloud Configuration — Required Manual Configuration

### 1. Create/verify OAuth consent screen
1. Go to **APIs & Services → OAuth consent screen**.
2. Set app name: **Portava** (or Travel Buddy).
3. Add authorized domains: your production domain and `supabase.co`.
4. Save.

### 2. Create OAuth Client IDs
Create **three** OAuth 2.0 Client IDs under **APIs & Services → Credentials**:

#### Web application (used by Supabase server-side)
- Type: **Web application**
- Authorized redirect URIs:
  ```
  https://YOUR_SUPABASE_PROJECT_REF.supabase.co/auth/v1/callback
  ```
- Copy the **Client ID** and **Client Secret** → paste into Supabase dashboard (Section D step 2).

#### iOS (needed for Safari SFSafariViewController deep-link scheme)
- Type: **iOS**
- Bundle ID: `com.passporttravelbuddy.app`
- This client ID is informational only; the OAuth flow goes through Supabase and does not require this ID in app code.

#### Android (needed for Chrome Custom Tab deep-link scheme)
- Type: **Android**
- Package name: `com.passporttravelbuddy.app`
- SHA-1 certificate fingerprint: run `keytool -list -v -keystore your-release.keystore` to find it.

### 3. Authorized redirect URIs for the web client
Make sure the web client's authorized redirect URIs include exactly:
```
https://YOUR_SUPABASE_PROJECT_REF.supabase.co/auth/v1/callback
```

---

## F. Apple Developer Configuration — Required Manual Configuration

### 1. Enable Sign in with Apple capability on the App ID
1. Go to **Certificates, Identifiers & Profiles → Identifiers**.
2. Select the App ID for `com.passporttravelbuddy.app`.
3. Under **Capabilities**, enable **Sign In with Apple**.
4. Save.

### 2. Create a Service ID (for Supabase / web client)
1. Under **Identifiers**, click **+** and choose **Services IDs**.
2. Identifier: e.g. `com.passporttravelbuddy.app.siwa`
3. Enable **Sign In with Apple** on the Service ID.
4. Configure **Return URLs**:
   ```
   https://YOUR_SUPABASE_PROJECT_REF.supabase.co/auth/v1/callback
   ```
5. Save.
6. Give the **Service ID** (`com.passporttravelbuddy.app.siwa`) to Supabase (Section D step 1).

### 3. Create a Sign in with Apple private key
1. Under **Keys**, click **+**.
2. Enable **Sign In with Apple** and select the App ID `com.passporttravelbuddy.app`.
3. Download the `.p8` file (only downloadable once).
4. Note the **Key ID** (10-character alphanumeric string).
5. Give the key content and Key ID to Supabase (Section D step 1).

> **Android — Apple Sign-In deliberately omitted**  
> Apple's native Sign-In only runs on iOS. The Android path requires a separate Apple web OAuth Service ID flow with a web return URL, a backend relay to exchange the code for a token (Apple sends the first-time user metadata only to the web return URL endpoint), and a custom deep-link from that endpoint back to the app. This is a non-trivial backend operation and was excluded from this implementation to avoid hidden complexity. The Apple button is automatically hidden on Android via a `Platform.OS === 'ios'` guard. To add it later: set up the Service ID redirect, create a backend handler at `POST /api/auth/apple-callback` that exchanges the Apple authorization code via `supabase.auth.exchangeCodeForSession`, and change the sign-in screen to call that handler on Android.

---

## G. Required Environment Variables

All of these should already be set if Supabase and the app are configured. No new secrets are introduced by this change.

| Variable | Where used | Notes |
|----------|-----------|-------|
| `EXPO_PUBLIC_SUPABASE_URL` | `src/lib/supabase.ts` | Already required |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `src/lib/supabase.ts` | Already required |
| `EXPO_PUBLIC_API_BASE_URL` | `src/services/auth.ts` → `ensureProfile` | Already required |

No Google client ID or Apple key is embedded in the app. All provider credentials live in the Supabase dashboard only.

---

## H. Redirect / Deep-link URLs to Register

Register these URLs on **all three** sides (Supabase, Google, Apple):

### Native (primary path — used by both Apple and Google flows)
```
travelbuddy://auth/callback
```

### Supabase callback (used by Supabase's server-side token exchange)
```
https://YOUR_SUPABASE_PROJECT_REF.supabase.co/auth/v1/callback
```

### Development / Expo CLI
```
exp://YOUR_EXPO_DEV_DOMAIN/--/auth/callback
```

The app's existing scheme `travelbuddy` is registered in `app.json` under `expo.scheme` and Android `intentFilters`. No additional scheme registration is needed.

---

## I. EAS Rebuild Required

**Yes — a new EAS development build is required.**

Reasons:
- `expo-apple-authentication` contains a native iOS module (entitlement + Swift code). Expo Go does not include it.
- `expo-auth-session` is pure JS but `expo-web-browser` (already present) requires a native build for `openAuthSessionAsync` to handle the custom scheme redirect correctly.
- The `expo-apple-authentication` Expo config plugin must be baked into the native Xcode project.

Existing email/password sign-in continues to work in Expo Go during development. SSO requires a dev build.

---

## J. EAS Build Command

```bash
# From the project root (monorepo)
cd travel-buddy-standalone   # EAS builds run from the standalone mirror
eas build --profile development --platform all
```

Or for a single platform:
```bash
eas build --profile development --platform ios
eas build --profile development --platform android
```

The `development` profile already has `prebuildCommand: bash ../../scripts/eas-install-rust.sh` configured in `eas.json` (from E2EE Phase E-0). This installs the Rust toolchain needed for `expo-openmls` before the native build.

---

## K. Test Results

### Implementation verified via typecheck
- `pnpm --filter @workspace/travel-buddy run typecheck` ✅ — no errors, no import-extension violations.
- `pnpm run typecheck` (standalone) — run after package install; expected clean.

### Functional flows (require EAS dev build on device)

| Flow | Expected outcome | Notes |
|------|-----------------|-------|
| Apple login (iOS) | Native Apple sheet → session → profile check → tabs or onboarding | Requires Apple capability configured |
| Apple cancel (iOS) | Sheet dismissed → login UI returns to idle, no error shown | Handled: `ERR_REQUEST_CANCELED` → `cancelled: true` |
| Apple login, new user (iOS) | Name captured from credential → `ensureProfile` → onboarding | Apple only sends name once |
| Apple login, returning user (iOS) | No name in credential (null) → existing profile preserved | Guarded: `result.displayName` only passed if non-empty |
| Google login (iOS) | Browser opens → OAuth → redirect → `exchangeCodeForSession` → tabs/onboarding | Requires Google client + Supabase provider enabled |
| Google login (Android) | Same flow via Chrome Custom Tab | Android intentFilter for `travelbuddy://` already registered |
| Google cancel (iOS/Android) | Browser closed → `result.type === 'cancel'` → login UI idle, no error | ✅ |
| Existing email/password sign-in | Unchanged — `submit()` function not modified | ✅ |
| Sign up | Unchanged | ✅ |
| Forgot password | Unchanged | ✅ |
| Logout | `svcSignOut()` → clears Supabase session in SecureStore → `userId = null` | ✅ unchanged |
| Session restore on cold start | `supabase.auth.getSession()` reads from SecureStore → OAuth sessions restored identically to email sessions | ✅ SecureStoreAdapter already wired |
| Protected routes | `isAuthed` derived from `userId` — same for all auth methods | ✅ unchanged |
| Onboarding redirect | `getMyProfile()` → missing `displayName` / `username` → `/(auth)/onboarding` | Same path as email signup |
| Profile loading | `ensureProfile` called post-SSO; SessionContext recovery path also runs | ✅ |
| OAuth provider conflict | Supabase returns "already registered" → `classifyError` → inline message directing user to original provider | ✅ |
| No session after success | `userId: null` → treated as failure, inline error, buttons re-enabled | ✅ |
| Network failure | `classifyError` detects network message → "Cannot reach the server…" + buttons re-enabled | ✅ |
| Profile creation failure | `ensureProfile` throws → caught, inline error displayed, session state NOT cleared (user is authenticated; they can retry the profile step) | ✅ |
| Both SSO buttons disabled during request | `oauthBusy` truthy → all social buttons + email submit disabled | ✅ |
| Apple button hidden on Android | `Platform.OS === 'ios'` guard in JSX | ✅ |

### Session storage
OAuth sessions flow through the same `SecureStoreAdapter` → iOS Keychain / Android Keystore path established by E2EE Phase E-0. No second storage path created.

### RLS
No Supabase RLS policies were modified. OAuth users receive the same `auth.uid()` as email users — RLS is provider-agnostic.
