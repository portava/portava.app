import AsyncStorage from '@react-native-async-storage/async-storage';
import { readAutomaticDubbingPreference, writeAutomaticDubbingPreference } from '../languagePreferences.ts';

const key = '@travel_buddy/automatic_dubbing_v1:alice';

beforeEach(async () => { await AsyncStorage.clear(); jest.clearAllMocks(); });

it.each([null, 'true', '{}', '{bad json', JSON.stringify({ version: 2, userId: 'alice', enabled: true }), JSON.stringify({ version: 1, userId: 'bob', enabled: true }), JSON.stringify({ version: 1, userId: 'alice', enabled: 'true' })])('does not opt in from missing, corrupt, unversioned or another account storage: %s', async raw => {
  if (raw !== null) await AsyncStorage.setItem(key, raw);
  expect(await readAutomaticDubbingPreference('alice')).toBe(false);
});

it('ignores global legacy keys and persists only the explicit account-bound boolean', async () => {
  await AsyncStorage.setItem('automatic_dubbing', 'true');
  expect(await readAutomaticDubbingPreference('alice')).toBe(false);
  expect(await writeAutomaticDubbingPreference({ userId: 'alice', enabled: true }, () => true)).toBe(true);
  expect(JSON.parse((await AsyncStorage.getItem(key))!)).toEqual({ version: 1, userId: 'alice', enabled: true });
  expect(await readAutomaticDubbingPreference('alice')).toBe(true);
  expect(await readAutomaticDubbingPreference('bob')).toBe(false);
});

it('serializes writes and reads so a late older write never overwrites a newer preference', async () => {
  const originalSet = jest.mocked(AsyncStorage.setItem).getMockImplementation()!;
  let finish!: () => void;
  jest.mocked(AsyncStorage.setItem).mockImplementationOnce((storageKey, value) => new Promise(resolve => {
    finish = () => { void originalSet(storageKey, value).then(() => resolve()); };
  }));
  const first = writeAutomaticDubbingPreference({ userId: 'alice', enabled: true }, () => true);
  while (!finish) await Promise.resolve();
  const second = writeAutomaticDubbingPreference({ userId: 'alice', enabled: false }, () => true);
  const reading = readAutomaticDubbingPreference('alice');
  finish();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(await reading).toBe(false);
});

it('does not persist a queued stale callback or anonymous preference', async () => {
  expect(await writeAutomaticDubbingPreference({ userId: 'alice', enabled: true }, () => false)).toBe(false);
  expect(await writeAutomaticDubbingPreference({ userId: '', enabled: true }, () => true)).toBe(false);
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it('storage rejection remains disabled and does not poison subsequent reads or saves', async () => {
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('unavailable'));
  expect(await readAutomaticDubbingPreference('alice')).toBe(false);
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('unavailable'));
  expect(await writeAutomaticDubbingPreference({ userId: 'alice', enabled: true }, () => true)).toBe(false);
  expect(await readAutomaticDubbingPreference('alice')).toBe(false);
  expect(await writeAutomaticDubbingPreference({ userId: 'alice', enabled: true }, () => true)).toBe(true);
});
