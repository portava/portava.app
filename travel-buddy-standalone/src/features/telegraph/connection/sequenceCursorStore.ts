/**
 * The per-conversation SEQUENCE cursors this device holds (census-telegraph T233, §71).
 *
 * useThreadMessages notes the highest sequence it holds for its thread; the
 * realtime service sends the most recent 50 in the `X-Telegraph-Sequence-Cursors`
 * header when it (re)connects, and the server replays exactly what came after
 * each. Memory only — nothing persists a conversation id — and cleared at
 * sign-out. With the server capability OFF no message carries a sequence, so
 * nothing is ever noted and no header is sent.
 */
export const MAX_CURSORS = 50;
const cursors = new Map<string, number>(); // insertion order = recency

export function noteThreadCursor(threadId: string | null | undefined, sequence: number | null): void {
  if (!threadId || sequence === null || !Number.isSafeInteger(sequence) || sequence < 0) return;
  const prev = cursors.get(threadId);
  if (prev !== undefined && prev >= sequence) return;
  cursors.delete(threadId);
  cursors.set(threadId, sequence);
  while (cursors.size > MAX_CURSORS) {
    const oldest = cursors.keys().next().value as string;
    cursors.delete(oldest);
  }
}

/** The header value, or null when there is nothing to send. */
export function cursorHeaderValue(): string | null {
  if (cursors.size === 0) return null;
  return [...cursors.entries()].map(([t, s]) => `${t}:${s}`).join(','); // the store itself holds at most MAX_CURSORS
}

export function clearThreadCursors(): void {
  cursors.clear();
}
