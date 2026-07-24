import { Stack } from 'expo-router';
import { color } from '../../src/theme/tokens';

export default function PlaceLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: color.paperRaised },
        headerTintColor: color.ink,
        headerShadowVisible: false,
      }}
    />
  );
}
