import { Stack } from 'expo-router';

export default function SettingsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="location" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="emergency-contacts" />
    </Stack>
  );
}
