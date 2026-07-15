import { Redirect } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { useSession } from '../src/context/SessionContext';
import { color } from '../src/theme/tokens';

/**
 * Entry gate. While we resolve the session: spinner. Then:
 * - Supabase configured + not signed in -> sign-in screen
 * - signed in (or backend not configured -> mock fallback) -> the app
 */
export default function Index() {
  const { isAuthed, loading, configured } = useSession();

  if (configured && loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paper }}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  // If backend isn't configured, fall back to the app on mock data (previous behavior).
  if (configured && !isAuthed) {
    return <Redirect href="/(auth)/sign-in" />;
  }

  return <Redirect href="/(tabs)" />;
}
