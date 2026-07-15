import { Stack } from 'expo-router';
import { PP } from '../../../src/theme/passportTokens';

export default function EditProfileLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: PP.paper },
      }}
    />
  );
}
