/**
 * Deep-link entry point: travelbuddy://discover?category=food
 *
 * Expo Router resolves `discover/` to this screen. It immediately redirects
 * to the main Discovery Hub tab, forwarding any `category` query param so the
 * hub can preselect the correct tab on mount.
 */
import { Redirect, useLocalSearchParams } from 'expo-router';

export default function DiscoverRedirect() {
  const { category } = useLocalSearchParams<{ category?: string }>();
  const href = category
    ? `/(tabs)/discovery?category=${encodeURIComponent(category)}`
    : '/(tabs)/discovery';
  return <Redirect href={href as any} />;
}
