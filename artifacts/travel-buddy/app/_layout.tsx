import { useCallback, useEffect, type PropsWithChildren } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
// Register the geofence background task at module root — must be imported
// before any call to Location.startGeofencingAsync.
import '../src/tasks/geofenceExitTask';
import '../src/tasks/checkpointArrivalTask';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Platform } from 'react-native';
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
import { setNotificationHandler, setNotificationChannelAsync } from '../src/lib/safeNotifications';
import { BlockedIdsProvider } from '../src/context/BlockedIdsContext';
import { CallProvider } from '../src/context/CallContext';
import { CallRealtimeBinding } from '../src/components/calls/CallRealtimeBinding';
import { CallSurface } from '../src/components/calls/CallSurface';
import { createLiveKitBridge } from '../src/services/livekitBridge';
import { AccountStatusGate } from '../src/components/AccountStatusGate';
import { AgeGate } from '../src/components/AgeGate';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { reportCrash } from '@/src/lib/crashReporter';
import { useCryptoInit } from '../src/hooks/useCryptoInit';

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
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SessionProvider>
          <BlockedIdsProvider>
          <CompassProvider>
          <LanguagePreferenceProvider>
          <LocationProvider>
            <AvailabilityProvider>
              <PlanPickerControllerProvider>
                <NotificationToastProvider>
                <StampEarnedToastProvider>
                  <RootCrashHandler>
                    <AccountStatusGate>
                      <AgeGate>
                      <CallProvider bridge={livekitBridge}>
                      <CallRealtimeBinding />
                      <PushSetup />
                      <CryptoSetup />
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
                      </Stack>
                      {/* Root-level call UI — overlays any screen, survives navigation */}
                      <CallSurface />
                      </CallProvider>
                      </AgeGate>
                    </AccountStatusGate>
                  </RootCrashHandler>
                </StampEarnedToastProvider>
                </NotificationToastProvider>
              </PlanPickerControllerProvider>
            </AvailabilityProvider>
          </LocationProvider>
          </LanguagePreferenceProvider>
          </CompassProvider>
          </BlockedIdsProvider>
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
