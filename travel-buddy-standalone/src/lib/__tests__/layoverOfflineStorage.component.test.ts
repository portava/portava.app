import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearLayoverOfflineStorage } from '../layoverOfflineStorage.ts';
test('sign-out cleanup removes every Layover cache family while preserving unrelated device settings', async () => {
  await AsyncStorage.clear();
  const keys = ['layover.plan.v1:s', 'layover.deadline.v1:s', 'layover.crewProximity.v1:s', 'layover.return-route.v1.s', 'layover.experience.v1:s'];
  await AsyncStorage.multiSet([...keys.map(k => [k, 'private'] as [string, string]), ['theme', 'dark'], ['layover.plan.v10:future', 'not this version']]);
  expect(await clearLayoverOfflineStorage()).toBe(true);
  expect(await AsyncStorage.getAllKeys()).toEqual(expect.arrayContaining(['theme', 'layover.plan.v10:future']));
  for (const key of keys) expect(await AsyncStorage.getItem(key)).toBeNull();
});
