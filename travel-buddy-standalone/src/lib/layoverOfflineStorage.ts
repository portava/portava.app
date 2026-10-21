import AsyncStorage from '@react-native-async-storage/async-storage';
/** All device-only Layover cache families; session UUIDs are not account isolation. */
const PRIVATE_LAYOVER_PREFIXES = ['layover.plan.v1:', 'layover.deadline.v1:', 'layover.crewProximity.v1:', 'layover.return-route.v1.', 'layover.experience.v1:'] as const;
export async function clearLayoverOfflineStorage(): Promise<boolean> {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter(key => PRIVATE_LAYOVER_PREFIXES.some(prefix => key.startsWith(prefix)));
    if (keys.length) await AsyncStorage.multiRemove(keys);
    return true;
  } catch { return false; }
}
