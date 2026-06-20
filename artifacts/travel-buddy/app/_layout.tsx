import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AttachmentProvider } from '../src/context/AttachmentStore';
import { AttachControllerProvider } from '../src/components/AttachController';
import { PlanPickerControllerProvider } from '../src/components/PlanPickerController';
import { AvailabilityProvider } from '../src/context/AvailabilityStore';
import { SessionProvider } from '../src/context/SessionContext';
import { color } from '../src/theme/tokens';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SessionProvider>
          <AvailabilityProvider>
            <AttachmentProvider>
              <AttachControllerProvider>
                <PlanPickerControllerProvider>
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
                </Stack>
                </PlanPickerControllerProvider>
              </AttachControllerProvider>
            </AttachmentProvider>
          </AvailabilityProvider>
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
