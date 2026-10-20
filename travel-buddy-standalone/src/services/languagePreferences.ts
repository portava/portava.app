import AsyncStorage from '@react-native-async-storage/async-storage';

export interface AutomaticDubbingPreference { userId: string; enabled: boolean }

const pending = new Map<string, Promise<unknown>>();

function serialized<Value>(userId: string, operation: (key: string) => Promise<Value>): Promise<Value> {
  const key = `@travel_buddy/automatic_dubbing_v1:${encodeURIComponent(userId)}`;
  const result = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(() => operation(key));
  pending.set(key, result);
  void result.finally(() => { if (pending.get(key) === result) pending.delete(key); }).catch(() => {});
  return result;
}

export async function readAutomaticDubbingPreference(userId: string): Promise<boolean> {
  if (!userId) return false;
  return serialized(userId, async key => {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw || raw.length > 1024) return false;
      const value = JSON.parse(raw);
      return value?.version === 1 && value.userId === userId && value.enabled === true;
    } catch { return false; }
  });
}

export async function writeAutomaticDubbingPreference(preference: AutomaticDubbingPreference, isCurrent: () => boolean): Promise<boolean> {
  if (!preference.userId || typeof preference.enabled !== 'boolean') return false;
  return serialized(preference.userId, async key => {
    if (!isCurrent()) return false;
    const previous = await AsyncStorage.getItem(key);
    if (!isCurrent()) return false;
    const restore = () => previous === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, previous);
    try {
      await AsyncStorage.setItem(key, JSON.stringify({ version: 1, userId: preference.userId, enabled: preference.enabled }));
      if (isCurrent()) return true;
      await restore();
    } catch { await restore().catch(() => {}); }
    return false;
  }).catch(() => false);
}
