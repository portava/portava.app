/**
 * Admin AI Visuals layout — guards the entire visuals/ subtree with admin check.
 */
import { Stack } from 'expo-router';

export default function AdminVisualsLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }} />
  );
}
