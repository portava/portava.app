import AsyncStorage from '@react-native-async-storage/async-storage';
import { beginIntelConsentChange, intelWithdrawalPending, onIntelConsentChange } from '../intelConsentLifecycle.ts';
const storageKey = (id: string) => `portava:intel-consent-withdrawal:v1:${id}`;
describe('durable account-local withdrawal hold', () => {
  it('invalidates synchronously, survives failed requests and cold restart, and isolates accounts', async () => {
    const listener = jest.fn(); const stop = onIntelConsentChange(listener);
    const change = beginIntelConsentChange('offline-owner', false);
    expect(listener).toHaveBeenCalledWith('offline-owner');
    await change.prepare(); await change.settle(false);
    expect(await intelWithdrawalPending('offline-owner')).toBe(true);
    expect(await intelWithdrawalPending('another-owner')).toBe(false);
    expect(await AsyncStorage.getItem(storageKey('offline-owner'))).toBe('1');
    let coldRead!: typeof intelWithdrawalPending;
    jest.doMock('@react-native-async-storage/async-storage', () => AsyncStorage);
    jest.isolateModules(() => { coldRead = require('../intelConsentLifecycle.ts').intelWithdrawalPending; });
    expect(await coldRead('offline-owner')).toBe(true); stop();
  });
  it('only a confirmed current grant clears the hold; a late older grant cannot erase withdrawal', async () => {
    const withdrawal = beginIntelConsentChange('race-owner', false); await withdrawal.prepare(); await withdrawal.settle(false);
    const grant = beginIntelConsentChange('race-owner', true); await grant.prepare();
    const laterWithdrawal = beginIntelConsentChange('race-owner', false); await laterWithdrawal.prepare();
    await grant.settle(true); await laterWithdrawal.settle(false);
    expect(await intelWithdrawalPending('race-owner')).toBe(true);
    const currentGrant = beginIntelConsentChange('race-owner', true); await currentGrant.prepare(); await currentGrant.settle(true);
    expect(await intelWithdrawalPending('race-owner')).toBe(false);
    expect(await AsyncStorage.getItem(storageKey('race-owner'))).toBeNull();
  });
  it('a persistence failure remains closed in the live session', async () => {
    (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk unavailable'));
    const withdrawal = beginIntelConsentChange('storage-failure', false);
    await expect(withdrawal.prepare()).rejects.toThrow('disk unavailable'); await withdrawal.settle(false);
    expect(await intelWithdrawalPending('storage-failure')).toBe(true);
  });
});
