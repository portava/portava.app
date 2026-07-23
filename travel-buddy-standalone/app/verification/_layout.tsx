import { Stack } from 'expo-router';

export default function VerificationLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="pending" />
      <Stack.Screen name="result" />
      {/* mock-complete is DEV only; rendered only when __DEV__ === true */}
      <Stack.Screen name="mock-complete" />
    </Stack>
  );
}
