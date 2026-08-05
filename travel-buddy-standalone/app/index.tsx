import { Redirect } from 'expo-router';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useSession } from '../src/context/SessionContext';
import { color, space, type as t } from '../src/theme/tokens';

/**
 * Entry gate. While we resolve the session: spinner. Then:
 * - Supabase configured + not signed in -> sign-in screen
 * - signed in -> the app
 * - backend not configured:
 *     dev builds  -> the app on mock data (previous behavior, kept for local work)
 *     prod builds -> fail loud with a full-screen configuration error; silently
 *                    booting into mock-data tabs would look like data loss.
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

  // Production build without a configured backend: render a clear error state
  // instead of redirecting into the mock-data app.
  if (!configured && !__DEV__) {
    return (
      <View style={st.errorRoot}>
        <Text style={st.errorIcon}>⚙️</Text>
        <Text style={st.errorTitle}>App not configured</Text>
        <Text style={st.errorBody}>
          This build of Portava is missing its server configuration, so it
          can't sign you in or load your data. Please install the latest
          version from the store — if the problem persists, contact support.
        </Text>
      </View>
    );
  }

  // Dev builds without a backend fall back to the app on mock data (previous behavior).
  if (configured && !isAuthed) {
    return <Redirect href="/(auth)/sign-in" />;
  }

  return <Redirect href="/(tabs)" />;
}

const st = StyleSheet.create({
  errorRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
    paddingHorizontal: space.xl,
    gap: space.md,
  },
  errorIcon: { fontSize: 48 },
  errorTitle: { ...t.heading, color: color.ink, textAlign: 'center' },
  errorBody: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 21 },
});
