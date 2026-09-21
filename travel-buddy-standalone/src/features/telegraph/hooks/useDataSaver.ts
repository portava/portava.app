/**
 * Telegraph §16.2 / §17.4 — data-saver, and the degradation ladder it drives.
 *
 * §16.2: "Data-saver mode prioritizes text/status/coordinates over media/AI."
 * §17.4: "Low bandwidth → deprioritize typing, reactions, media preview and AI
 *         before text or safety coordination."
 *
 * census-telegraph T227: "No data-saver setting exists in the client." T239:
 * "No bandwidth signal and no degradation ladder."
 *
 * ONE SETTING, ONE ORDER, NAMED
 * =============================
 * Both requirements are the same requirement seen from two ends: there is an
 * ORDER in which things are given up, and text and safety are last. Encoding
 * that order as a list — `DEGRADATION_LADDER` — rather than as scattered `if
 * (dataSaver)` checks is the difference between a policy and a habit: a
 * surface that wants to know whether it may fetch asks `mayLoad('media')`, and
 * a rung that nobody asks about is visible as a rung with no caller.
 *
 * WHAT IS NOT NEGOTIABLE
 * ======================
 * `text` and `safety` are in the ladder so that the ladder is complete, and
 * `mayLoad` refuses to shed them at any level. That is not a special case
 * bolted on; it is §17.4's actual sentence, and putting it in the function
 * means a future level that tried to shed them would have to delete a line
 * that says why it cannot.
 *
 * PERSISTED PER DEVICE, NOT PER ACCOUNT
 * =====================================
 * Data-saver is a property of the connection a person is on, not of who they
 * are: the same account is on hotel wifi in the evening and on roaming data at
 * a border crossing. AsyncStorage, unnamespaced by user, is therefore correct
 * here — and is the opposite of the choice `useSnapshotCache` makes for
 * content, which IS per user.
 */
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'telegraph:dataSaver:v1';

/**
 * What may be given up, in the order it is given up.
 *
 * Index 0 goes first. `text` and `safety` are last and are never actually shed
 * — see `mayLoad`.
 */
export const DEGRADATION_LADDER = [
  'ai',            // §17.4 "AI" — suggestion trays, Compass recommendations
  'typing',        // §17.4 "typing"
  'reactions',     // §17.4 "reactions"
  'mediaPreview',  // §17.4 "media preview" — thumbnails and posters
  'media',         // full media fetches
  'text',          // never shed
  'safety',        // never shed
] as const;
export type DegradableFeature = (typeof DEGRADATION_LADDER)[number];

/** Nothing below this index is ever shed, whatever the level. */
const NEVER_SHED_FROM = DEGRADATION_LADDER.indexOf('text');

export type DataSaverLevel = 'off' | 'on';

/**
 * How many rungs each level sheds, counted from index 0.
 *
 * Two levels today. The shape takes a third without changing any caller, which
 * is the point of expressing this as a count rather than as a set of booleans.
 */
const SHED_COUNT: Record<DataSaverLevel, number> = {
  off: 0,
  on: 5, // ai, typing, reactions, mediaPreview, media
};

/**
 * May this feature load at this level?
 *
 * Pure, exported, and tested directly — the hook below is a thin wrapper, and
 * the interesting thing (the ladder) is decidable without React.
 */
export function mayLoad(feature: DegradableFeature, level: DataSaverLevel): boolean {
  const idx = DEGRADATION_LADDER.indexOf(feature);
  if (idx < 0) return true;
  // §17.4: text and safety coordination are shed after everything else, which
  // in practice means never. Deleting this line is what a future "aggressive"
  // level would have to do, and it would have to explain itself.
  if (idx >= NEVER_SHED_FROM) return true;
  return idx >= SHED_COUNT[level];
}

export interface DataSaverState {
  level: DataSaverLevel;
  /** True until the stored preference has been read. Nothing is shed while loading. */
  loading: boolean;
  setLevel: (next: DataSaverLevel) => Promise<void>;
  mayLoad: (feature: DegradableFeature) => boolean;
}

export function useDataSaver(): DataSaverState {
  const [level, setLevelState] = useState<DataSaverLevel>('off');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!cancelled && (raw === 'on' || raw === 'off')) setLevelState(raw);
      } catch {
        // An unreadable preference means data-saver stays OFF. That is the
        // permissive direction and it is the right one here: the cost of being
        // wrong is a slower page, not a leak, and a person who cannot read
        // their own setting should not silently lose their media.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setLevel = useCallback(async (next: DataSaverLevel) => {
    setLevelState(next);
    try { await AsyncStorage.setItem(STORAGE_KEY, next); } catch { /* in-memory only this session */ }
  }, []);

  const may = useCallback(
    (feature: DegradableFeature) => (loading ? true : mayLoad(feature, level)),
    [level, loading],
  );

  return { level, loading, setLevel, mayLoad: may };
}

export default useDataSaver;
