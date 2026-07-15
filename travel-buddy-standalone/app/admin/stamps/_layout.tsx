/**
 * Admin Stamp Studio layout — guards the entire stamps/ subtree with admin check.
 */
import { Stack } from 'expo-router';

export default function StampStudioLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }} />
  );
}
