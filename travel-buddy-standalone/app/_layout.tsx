import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
// Register the geofence background task at module root — must be imported
// before any call to Location.startGeofencingAsync.
import '../src/tasks/geofenceExitTask';
import '../src/tasks/checkpointArrivalTask';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AttachmentProvider } from '../src/context/AttachmentStore';
import { AttachControllerProvider } from '../src/components/AttachController';
import { PlanPickerControllerProvider } from '../src/components/PlanPickerController';
import { AvailabilityProvider } from '../src/context/AvailabilityStore';
import { SessionProvider } from '../src/context/SessionContext';
import { LocationProvider } from '../src/context/LocationContext';
import { LanguagePreferenceProvider } from '../src/context/LanguagePreferenceContext';
import { usePushToken } from '../src/hooks/usePushToken';
import { useNotificationStream } from '../src/hooks/useNotifications';
import { useNotificationHandler } from '../src/hooks/useNotificationHandler';
import { useCompassFrontload } from '../src/hooks/compass/useCompassFrontload';
import { CompassProvider } from '../src/context/CompassContext';
import { color } from '../src/theme/tokens';
import { NotificationToastProvider } from '../src/components/NotificationToast';

// Notify handler: show banner even when app is foregrounded
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowList: true,
    }),
  });
}

function CompassFrontloadSetup() {
  useCompassFrontload();
  return null;
}

function PushSetup() {
  usePushToken();
  useNotificationStream();
  useNotificationHandler();
  return null;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SessionProvider>
          <CompassProvider>
          <LanguagePreferenceProvider>
          <LocationProvider>
            <AvailabilityProvider>
              <AttachmentProvider>
                <AttachControllerProvider>
                  <PlanPickerControllerProvider>
                    <NotificationToastProvider>
                      <PushSetup />
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
                        <Stack.Screen name="create" options={{ presentation: 'modal' }} />
                        <Stack.Screen name="notifications" options={{ presentation: 'modal' }} />
                        <Stack.Screen name="compass-preferences" options={{ presentation: 'card' }} />
                      </Stack>
                    </NotificationToastProvider>
                  </PlanPickerControllerProvider>
                </AttachControllerProvider>
              </AttachmentProvider>
            </AvailabilityProvider>
          </LocationProvider>
          </LanguagePreferenceProvider>
          </CompassProvider>
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
