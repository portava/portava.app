/**
 * layoverAnswerMemory — census-layover L190, the device half of "what changed
 * since the last answer" (the Layover spec's north star).
 *
 * The server can diff two STORED answers (`GET …/decisions/diff`), but only the
 * device knows which answer this traveller last acknowledged. This keeps exactly
 * that: one snapshot id per layover, nothing else — no verdict, deadline or
 * time, so a stale copy can never be shown as an answer. The comparison itself
 * is always the server's.
 *
 * Device-only and private: the prefix is in `layoverOfflineStorage`'s sign-out
 * purge. Every read or write that fails answers "nothing remembered" / `false`,
 * which makes the card compare nothing rather than compare against a guess.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export const ANSWER_SEEN_PREFIX = 'layover.answerSeen.v1:';
const SNAPSHOT_ID = /^snap:[0-9a-f]{32}$/;

export function answerSeenKey(sessionId: string): string {
  return `${ANSWER_SEEN_PREFIX}${sessionId}`;
}

/** The snapshot id of the answer this traveller last acknowledged for this layover, or null. */
export async function readAnswerSeen(sessionId: string): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(answerSeenKey(sessionId));
    if (!raw) return null;
    const v = JSON.parse(raw) as { snapshotId?: unknown };
    return typeof v?.snapshotId === 'string' && SNAPSHOT_ID.test(v.snapshotId) ? v.snapshotId : null;
  } catch {
    return null;
  }
}

/** Remember `snapshotId` as acknowledged. A malformed id is refused, never stored. */
export async function rememberAnswerSeen(sessionId: string, snapshotId: string): Promise<boolean> {
  if (!SNAPSHOT_ID.test(snapshotId)) return false;
  try {
    await AsyncStorage.setItem(answerSeenKey(sessionId), JSON.stringify({ snapshotId }));
    return true;
  } catch {
    return false;
  }
}
