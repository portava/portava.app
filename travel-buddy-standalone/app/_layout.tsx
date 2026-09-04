import { useCallback, useEffect, type PropsWithChildren } from 'react';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Sentry from '@sentry/react-native';
// Register the geofence background task at module root — must be imported
// before any call to Location.startGeofencingAsync.
import '../src/tasks/geofenceExitTask';
import '../src/tasks/checkpointArrivalTask';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Platform, Linking, AppState } from 'react-native';

// Initialize Sentry as early as possible — before any component tree mounts —
// so that native crashes and JS errors during startup are captured.
// EXPO_PUBLIC_SENTRY_DSN must be set in the EAS / Replit environment secrets.
// When the DSN is absent (e.g. local dev without the secret) Sentry is a no-op.
Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  // Disable Sentry in dev mode to keep the local console clean.
  enabled: !__DEV__,
  // Performance tracing — 10 % sample rate; adjust once baseline is known.
  tracesSampleRate: 0.1,
});

// Warn loudly in non-dev builds when the DSN is missing so the misconfiguration
// is visible in EAS build logs and device consoles rather than silently dropping
// all crash reports.
if (!__DEV__ && !process.env.EXPO_PUBLIC_SENTRY_DSN) {
  // eslint-disable-next-line no-console
  console.warn(
    '[Sentry] EXPO_PUBLIC_SENTRY_DSN is not set — crash reporting is disabled for this build. ' +
    'Add the secret to the EAS production build profile to enable error tracking.',
  );
}
import { PlanPickerControllerProvider } from '../src/components/PlanPickerController';
import { AvailabilityProvider } from '../src/context/AvailabilityStore';
import { SessionProvider, useSession } from '../src/context/SessionContext';
import { LocationProvider } from '../src/context/LocationContext';
import { LanguagePreferenceProvider } from '../src/context/LanguagePreferenceContext';
import { usePushToken } from '../src/hooks/usePushToken';
import { useNotificationStream } from '../src/hooks/useNotifications';
import { useNotificationHandler } from '../src/hooks/useNotificationHandler';
import { useCompassFrontload } from '../src/hooks/compass/useCompassFrontload';
import { CompassProvider } from '../src/context/CompassContext';
import { color } from '../src/theme/tokens';
import { NotificationToastProvider } from '../src/components/NotificationToast';
import { StampEarnedToastProvider } from '../src/components/stamps/StampEarnedToast';
import { StampAnimationProvider } from '../src/context/StampAnimationContext';
import { setNotificationHandler, setNotificationChannelAsync } from '../src/lib/safeNotifications';
import { BlockedIdsProvider } from '../src/context/BlockedIdsContext';
import { CallProvider } from '../src/context/CallContext';
import { FeatureFlagsProvider } from '../src/context/FeatureFlagsContext';
import { CallRealtimeBinding } from '../src/components/calls/CallRealtimeBinding';
import { CallSurface } from '../src/components/calls/CallSurface';
import { createLiveKitBridge } from '../src/services/livekitBridge';
import { AccountStatusGate } from '../src/components/AccountStatusGate';
import { AgeGate } from '../src/components/AgeGate';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { reportCrash } from '@/src/lib/crashReporter';
import { useCryptoInit } from '../src/hooks/useCryptoInit';
import { supabase } from '../src/lib/supabase';
import { freshToken } from '../src/services/apiToken';
import { installPassportTelemetry } from '../src/features/passport/installPassportTelemetry';

/**
 * Session-aware root crash boundary. Sits inside SessionProvider so it can
 * attach the current userId to crash reports without exposing any PII.
 */
function RootCrashHandler({ children }: PropsWithChildren) {
  const { userId } = useSession();
  const handleError = useCallback(
    (error: Error, stack: string) => {
      reportCrash(error, stack, { userId: userId ?? undefined });
    },
    [userId],
  );
  return (
    <ErrorBoundary onError={handleError}>
      {children}
    </ErrorBoundary>
  );
}

function CompassFrontloadSetup() {
  useCompassFrontload();
  return null;
}

function CryptoSetup() {
  useCryptoInit();
  return null;
}

/**
 * §32 Passport telemetry — bind the passportTelemetry seam to the real
 * batched/authenticated transport once at boot. Until this mounts the seam
 * only dev-logs, so nothing is lost or sent early; dispose flushes and
 * restores the default sink if the root ever unmounts.
 */
function PassportTelemetrySetup() {
  useEffect(() => {
    const handle = installPassportTelemetry({
      baseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? '',
      getToken: freshToken,
      appState: AppState,
    });
    return () => handle.dispose();
  }, []);
  return null;
}

function PushSetup() {
  usePushToken();
  useNotificationStream();
  useNotificationHandler();

  // Register the foreground notification handler after mount via the safe
  // wrapper. This avoids crashing at module load if ExpoTopicSubscriptionModule
  // or other expo-notifications native modules are absent in the current build.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowList: true,
      }),
    });

    // Register the Android notification channel for incoming calls.
    // This must be done at runtime — app.json registers the channel in the
    // compiled manifest, but expo-notifications also requires the JS-side
    // setNotificationChannelAsync call so the OS actually creates the channel
    // with the correct importance before the first FCM message arrives.
    // AndroidImportance.MAX = 5 (heads-up overlay on Android 8+).
    void setNotificationChannelAsync('incoming_calls', {
      name: 'Incoming calls',
      importance: 5, // AndroidImportance.MAX
      sound: true,
      vibrationPattern: [0, 250, 250, 250],
      enableLights: true,
      bypassDnd: false,
    });
  }, []);

  return null;
}

// Created once at module scope — null in Expo Go/web, where CallContext then
// fails gracefully ("Calling is not available in this build yet.").
const livekitBridge = createLiveKitBridge();

export default function RootLayout() {
  // Navigate to update-password screen when Supabase fires a PASSWORD_RECOVERY
  // event (user opened the app via the reset-password email link).
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        router.replace('/(auth)/update-password' as any);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // Handle deep links that carry Supabase password-recovery tokens.
  //
  // When a user taps the reset-email link the Supabase auth server redirects to
  //   travelbuddy://update-password#access_token=…&refresh_token=…&type=recovery
  // (implicit flow) or
  //   travelbuddy://update-password?code=…
  // (PKCE flow).
  //
  // Because detectSessionInUrl is false on the Supabase client (required for RN),
  // supabase-js never sees the URL on its own — we must feed it the tokens so it
  // can fire the PASSWORD_RECOVERY onAuthStateChange event above.
  useEffect(() => {
    async function handleDeepLink(url: string) {
      try {
        // ── PKCE flow: ?code=<authorization_code> ─────────────────────────────
        const parsed = new URL(url);
        const code = parsed.searchParams.get('code');
        if (code) {
          await supabase.auth.exchangeCodeForSession(code);
          // onAuthStateChange PASSWORD_RECOVERY fires after exchange — routing
          // is handled there.
          return;
        }

        // ── Implicit flow: #access_token=…&refresh_token=…&type=recovery ─────
        const fragment = url.includes('#') ? url.split('#')[1] : '';
        if (!fragment) return;
        const params = new URLSearchParams(fragment);
        const type = params.get('type');
        const access_token = params.get('access_token');
        const refresh_token = params.get('refresh_token');
        if (type === 'recovery' && access_token && refresh_token) {
          await supabase.auth.setSession({ access_token, refresh_token });
          // onAuthStateChange PASSWORD_RECOVERY fires after setSession.
        }
      } catch {
        // Non-fatal — if parsing fails the user stays on the current screen
        // and can request another reset link.
      }
    }

    // Cold-start: app was not running when the link was tapped.
    Linking.getInitialURL().then((url) => { if (url) void handleDeepLink(url); });

    // Warm-start: app was already running when the link arrived.
    const sub = Linking.addEventListener('url', ({ url }) => void handleDeepLink(url));
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <FeatureFlagsProvider>
        <SessionProvider>
          <BlockedIdsProvider>
          <CompassProvider>
          <LanguagePreferenceProvider>
          <LocationProvider>
            <AvailabilityProvider>
              <PlanPickerControllerProvider>
                <NotificationToastProvider>
                <StampEarnedToastProvider>
                  <StampAnimationProvider>
                  <RootCrashHandler>
                    <AccountStatusGate>
                      <AgeGate>
                      <CallProvider bridge={livekitBridge}>
                      <CallRealtimeBinding />
                      <PushSetup />
                      <CryptoSetup />
                      <PassportTelemetrySetup />
                      <CompassFrontloadSetup />
                      <StatusBar style="dark" />
                      <Stack
                        screenOptions={{
                          headerShown: false,
                          contentStyle: { backgroundColor: color.paper },
                          animation: 'slide_from_right',
                        }}
                      >
                        <Stack.Screen name="(tabs)" />
                        <Stack.Screen name="(auth)" />
                        <Stack.Screen name="create" />
                        <Stack.Screen name="notifications" options={{ presentation: 'modal' }} />
                        <Stack.Screen name="compass-preferences" options={{ presentation: 'card' }} />
                        <Stack.Screen name="compass-memories" options={{ presentation: 'card' }} />
                        <Stack.Screen name="safety-number" options={{ presentation: 'modal', headerShown: false }} />
                        {/* Intelligence Gathering capture surfaces (flag-gated, off by default) */}
                        <Stack.Screen name="intel/quick-signal" options={{ presentation: 'modal' }} />
                        <Stack.Screen name="intel/trail" options={{ presentation: 'modal' }} />
                        <Stack.Screen name="intel/moment" options={{ presentation: 'modal' }} />
                        <Stack.Screen name="settings/intel-prompts" options={{ presentation: 'card' }} />
                      </Stack>
                      {/* Root-level call UI — overlays any screen, survives navigation */}
                      <CallSurface />
                      </CallProvider>
                      </AgeGate>
                    </AccountStatusGate>
                  </RootCrashHandler>
                  </StampAnimationProvider>
                </StampEarnedToastProvider>
                </NotificationToastProvider>
              </PlanPickerControllerProvider>
            </AvailabilityProvider>
          </LocationProvider>
          </LanguagePreferenceProvider>
          </CompassProvider>
          </BlockedIdsProvider>
        </SessionProvider>
        </FeatureFlagsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
