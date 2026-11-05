/** Pending withdrawals pause this phone immediately and survive a failed API call.
 * The server remains the consent authority. A hold only removes permission; it
 * can never grant capture, upload or publication. No sensor data is stored here.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SensingConsentScope } from '../../lib/sensing/consentSplit.ts';
const held = new Map<string, Set<SensingConsentScope>>();
const loaded = new Map<string, Promise<void>>();
const writes = new Map<string, Promise<void>>();
const keyFor = (owner: string) => `sensing_withdrawal_hold_v1:${encodeURIComponent(owner)}`;
function scopesFor(owner: string) {
  let scopes = held.get(owner); if (!scopes) { scopes = new Set(); held.set(owner, scopes); }
  return scopes;
}
async function load(owner: string): Promise<void> {
  if (!loaded.has(owner)) {
    const request = AsyncStorage.getItem(keyFor(owner)).then(raw => {
      if (!raw) return;
      const value: unknown = JSON.parse(raw);
      if (!Array.isArray(value) || value.some(s => !['capture', 'upload', 'surface'].includes(s))) throw new Error('Unreadable sensing withdrawal');
      for (const scope of value) scopesFor(owner).add(scope as SensingConsentScope);
    }).catch(error => { loaded.delete(owner); throw error; });
    loaded.set(owner, request);
  }
  await loaded.get(owner);
}
function persist(owner: string): Promise<void> {
  const next = (writes.get(owner) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await load(owner);
    await AsyncStorage.setItem(keyFor(owner), JSON.stringify([...scopesFor(owner)]));
  });
  writes.set(owner, next); return next;
}
export function holdSensingWithdrawal(owner: string, scope: SensingConsentScope): Promise<void> {
  scopesFor(owner).add(scope); // synchronous: stop before any storage/network await
  return persist(owner);
}
export async function clearSensingWithdrawal(owner: string, scope: SensingConsentScope): Promise<void> {
  await load(owner);
  scopesFor(owner).delete(scope);
  try { await persist(owner); } catch (error) { scopesFor(owner).add(scope); throw error; }
}
export async function readSensingWithdrawalHolds(owner: string): Promise<SensingConsentScope[]> {
  await load(owner); return [...scopesFor(owner)];
}
