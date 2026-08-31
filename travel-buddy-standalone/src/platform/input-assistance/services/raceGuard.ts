/**
 * Global Input Intelligence — request race guard (spec §33, §49 "Race safety").
 *
 * "Older response must never replace results for newer text." Every assisted
 * input in the app used to reimplement this (or, in the case of MentionInput,
 * omit it — see the client audit). This is the ONE shared implementation of the
 * monotonic sequence guard, extracted as a pure module so it can be unit-tested
 * under node:test without React or the network.
 *
 * The legacy `useSearchSuggestions` inlines exactly this pattern (a `seqRef`
 * incremented per keystroke, with `if (mySeq !== seqRef.current) return`);
 * `useInputAssistance` uses this module instead so the behavior is guaranteed
 * identical everywhere.
 */

export interface SequenceGuard {
  /** Begin a new request; returns its monotonically-increasing sequence id. */
  next(): number;
  /** True only if `seq` is still the most recent request begun. */
  isCurrent(seq: number): boolean;
  /** Invalidate all in-flight requests without starting a new one (e.g. on
   *  clear / disable / unmount) so any late response is ignored. */
  invalidate(): void;
  /** The current (latest issued) sequence id. */
  readonly current: number;
}

/**
 * Create a fresh sequence guard. Each `next()` supersedes every prior request:
 * a response is only allowed to commit when `isCurrent(itsSeq)` is true.
 */
export function createSequenceGuard(): SequenceGuard {
  let seq = 0;
  return {
    next(): number {
      seq += 1;
      return seq;
    },
    isCurrent(candidate: number): boolean {
      return candidate === seq;
    },
    invalidate(): void {
      // Bump so any request issued before this call is now stale, but don't
      // hand the new value to anyone — nothing is "current" until next().
      seq += 1;
    },
    get current(): number {
      return seq;
    },
  };
}
