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
import { onAuthChange } from '../../../services/auth.ts';
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

export interface RailSeenScope {
  readonly accountId: string;
  readonly key: string;
  isCurrent: () => boolean;
  dispose: () => void;
}

const accountGenerations = new Map<string, number>();
const accountOperations = new Map<string, Promise<unknown>>();
const writeOwners = new WeakMap<RailSeenScope, () => { isCurrent: () => boolean; release: () => void } | null>();

function orderedForAccount<Result>(accountId: string, operation: () => Promise<Result>): Promise<Result> {
  const previous = accountOperations.get(accountId) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  accountOperations.set(accountId, pending);
  const settled = () => { if (accountOperations.get(accountId) === pending) accountOperations.delete(accountId); };
  void pending.then(settled, settled);
  return pending;
}

export async function captureRailSeenScope(threadId: string, expectedAccountId: string): Promise<RailSeenScope | null> {
  const generation = accountGenerations.get(expectedAccountId) ?? 0;
  let active = true;
  let authorized = true;
  let confirmed = false;
  let pendingWrites = 0;
  const ownerCurrent = () => authorized && (accountGenerations.get(expectedAccountId) ?? 0) === generation;
  const unsubscribe = onAuthChange((accountId) => {
    if (!authorized || accountId === expectedAccountId) return;
    authorized = false;
    if (confirmed) void clearRailSeenForUser(expectedAccountId);
  });
  const releaseIfIdle = () => { if (!active && pendingWrites === 0) unsubscribe(); };
  const scope: RailSeenScope = {
    accountId: expectedAccountId,
    key: railSeenKey(threadId, expectedAccountId),
    isCurrent: () => active && ownerCurrent(),
    dispose: () => { active = false; releaseIfIdle(); },
  };
  writeOwners.set(scope, () => {
    if (!scope.isCurrent()) return null;
    pendingWrites++;
    return { isCurrent: ownerCurrent, release: () => { pendingWrites--; releaseIfIdle(); } };
  });
  try {
    const accountId = await getCurrentAccountId();
    if (accountId !== expectedAccountId || !scope.isCurrent()) {
      scope.dispose();
      return null;
    }
    confirmed = true;
    return scope;
  } catch {
    scope.dispose();
    return null;
  }
}

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

export async function readRailSeen(scope: RailSeenScope): Promise<RailSeenRead> {
  return orderedForAccount<RailSeenRead>(scope.accountId, async () => {
    if (!scope.isCurrent()) return { key: null, state: 'no_account' };
    const key = scope.key;
    let raw: string | null;
    try {
      raw = await AsyncStorage.getItem(key);
    } catch {
      return { key, state: 'unreadable' };
    }
    if (!scope.isCurrent()) return { key: null, state: 'no_account' };
    if (raw === null) return { key, state: 'none' };
    // A record that does not parse cannot say what was seen; it is replaced on the
    // next write, like a first visit (it holds nothing worth refusing over).
    const snapshot = parseSnapshot(raw);
    return snapshot ? { key, state: 'seen', snapshot } : { key, state: 'none' };
  });
}

export async function writeRailSeen(scope: RailSeenScope, snapshot: SeenSnapshot): Promise<void> {
  const owner = writeOwners.get(scope)?.();
  if (!owner) return;
  try {
    const serialized = JSON.stringify({ v: 1, items: snapshot });
    await orderedForAccount(scope.accountId, async () => {
      if (owner.isCurrent()) await AsyncStorage.setItem(scope.key, serialized);
    });
  } catch {
    // Best effort: a write that fails leaves the previous record, which still
    // describes something the member saw.
  } finally {
    owner.release();
  }
}

/** Sign-out: remove every rail record of this account on the device. */
export async function clearRailSeenForUser(userId: string): Promise<void> {
  accountGenerations.set(userId, (accountGenerations.get(userId) ?? 0) + 1);
  return orderedForAccount(userId, async () => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const mine = keys.filter((k) => k.startsWith(RAIL_SEEN_PREFIX) && k.endsWith(`_${userId}`));
      if (mine.length > 0) await AsyncStorage.multiRemove(mine);
    } catch {
      // Non-fatal at sign-out, like the other per-account sweeps.
    }
  });
}
