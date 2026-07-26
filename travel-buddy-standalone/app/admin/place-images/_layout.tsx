/**
 * Admin Place Images layout — guards the entire place-images/ subtree.
 */
import { Stack } from 'expo-router';

export default function PlaceImagesAdminLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }} />
  );
}
