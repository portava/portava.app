/**
 * Latest request wins — the stale-response guard for the trip cards
 * (census-trips §79; the DV-83 "stale-response race" class).
 *
 * Every trip card reads with `setRead(await load(...))`. When two reads of the
 * same card overlap — a vote's re-read racing the one before it, a note added
 * while the first list read is still out, the trip id changing under a mounted
 * card — whichever response ARRIVES last is drawn, not whichever was ASKED
 * last. A slow, older answer then overwrites a newer one: a tally without the
 * vote just recorded, a list without the note just added, or another trip's
 * Today.
 *
 * `useLatestRead()` returns `begin()`. Call it when a read starts; it returns
 * `isCurrent()`, which stays true only while no later read has begun and the
 * card is still mounted. Apply a response only if `isCurrent()`.
 */
import { useCallback, useEffect, useRef } from 'react';

export type IsCurrent = () => boolean;

/** The pure counter behind the hook, so the rule is testable without React. */
export function latestReadCounter(): { begin: () => IsCurrent; invalidate: () => void } {
  let seq = 0;
  return {
    begin() {
      const mine = ++seq;
      return () => mine === seq;
    },
    invalidate() { seq++; },
  };
}

export function useLatestRead(): () => IsCurrent {
  const counter = useRef(latestReadCounter());
  // Unmounting invalidates whatever is still out: nothing is drawn after the
  // card has gone.
  useEffect(() => () => counter.current.invalidate(), []);
  return useCallback(() => counter.current.begin(), []);
}
