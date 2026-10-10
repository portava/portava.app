/**
 * Telegraph §11.2 row 5 across an absence — what the member last SAW in a
 * conversation's Shared Context Rail, kept on this device per (account, thread)
 * (census-telegraph T264; the decisions are pure, in railBehavior.ts).
 *
 * WHAT IS STORED: per shared object id, its status and start time as shown —
 * nothing the rail did not already show, no title, no place, no person. The key
 * carries the account id, so another account on the device never reads it, and
 * `clearRailSeenForUser` removes an account's records at sign-out.
 *
 * A FAILED READ IS NOT "NEVER SEEN". `readRailSeen` answers `unreadable` when
 * storage throws; the rail then promotes nothing (as on a first load) AND writes
 * nothing, so the snapshot the member really saw survives to the next read.
 * With no account resolvable there is no record at all (`key: null`): the rail
 * behaves exactly as before, comparing only two fetches of one mount.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCurrentAccountId } from '../../../services/accountId.ts';
import type { SeenSnapshot } from './railBehavior.ts';

export const RAIL_SEEN_PREFIX = 'telegraph_rail_seen_v1_';

export function railSeenKey(threadId: string, accountId: string): string {
  return `${RAIL_SEEN_PREFIX}${threadId}_${accountId}`;
}

export type RailSeenRead =
  | { key: null; state: 'no_account' }
  | { key: string; state: 'none' }
  | { key: string; state: 'seen'; snapshot: SeenSnapshot }
  | { key: string; state: 'unreadable' };

function parseSnapshot(raw: string): SeenSnapshot | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || (v as { v?: unknown }).v !== 1) return null;
    const items = (v as { items?: unknown }).items;
    if (!items || typeof items !== 'object') return null;
    const out: SeenSnapshot = {};
    for (const [id, e] of Object.entries(items as Record<string, unknown>)) {
      if (!e || typeof e !== 'object') continue;
      const s = (e as { status?: unknown }).status;
      const t = (e as { startsAt?: unknown }).startsAt;
      out[id] = { status: typeof s === 'string' ? s : null, startsAt: typeof t === 'string' ? t : null };
    }
    return out;
  } catch {
    return null;
  }
}

export async function readRailSeen(threadId: string): Promise<RailSeenRead> {
  const accountId = await getCurrentAccountId();
  if (!accountId) return { key: null, state: 'no_account' };
  const key = railSeenKey(threadId, accountId);
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch {
    return { key, state: 'unreadable' };
  }
  if (raw === null) return { key, state: 'none' };
  // A record that does not parse cannot say what was seen; it is replaced on the
  // next write, like a first visit (it holds nothing worth refusing over).
  const snapshot = parseSnapshot(raw);
  return snapshot ? { key, state: 'seen', snapshot } : { key, state: 'none' };
}

export async function writeRailSeen(key: string, snapshot: SeenSnapshot): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify({ v: 1, items: snapshot }));
  } catch {
    // Best effort: a write that fails leaves the previous record, which still
    // describes something the member saw.
  }
}

/** Sign-out: remove every rail record of this account on the device. */
export async function clearRailSeenForUser(userId: string): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((k) => k.startsWith(RAIL_SEEN_PREFIX) && k.endsWith(`_${userId}`));
    if (mine.length > 0) await AsyncStorage.multiRemove(mine);
  } catch {
    // Non-fatal at sign-out, like the other per-account sweeps.
  }
}
