import React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useSession } from '../../src/context/SessionContext.tsx';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { TrailSuggestionsView } from '../../src/features/discovery/trails/TrailSuggestionsView.tsx';
import { color } from '../../src/theme/tokens';

export default function TrailSuggestionsScreen() {
  const { userId } = useSession();
  return <View style={{ flex: 1, backgroundColor: color.paper }}>
    <AppHeader variant="detail" title="Trail suggestions" onBack={router.back} />
    <TrailSuggestionsView key={userId ?? 'guest'} onNavigate={(href) => router.push(href as never)} />
  </View>;
}
