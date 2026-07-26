/**
 * mediaStore — Context + useReducer store for the Media tab.
 *
 * Holds per-mode state (MediaModeState) that survives tab switches.
 * Persists the selected mode to AsyncStorage so it is restored on next open.
 *
 * Mode reconciliation:
 *   - The store waits until `flagsLoading` is false before restoring from
 *     AsyncStorage, preventing a race where the persisted mode is set before
 *     the real enabledModes are known.
 *   - Whenever `enabledModes` changes after flags resolve, the store reconciles
 *     `selectedMode`: if the current mode is disabled, it switches to the first
 *     enabled mode automatically.
 *   - This prevents rendering disabled-mode content when flags arrive after mount.
 *
 * Usage:
 *   <MediaStoreProvider enabledModes={...} flagsLoading={loading}>…</MediaStoreProvider>
 *   const { selectedMode, setMode, getModeState, setModeState } = useMediaStore();
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Types ─────────────────────────────────────────────────────────────────────

export type MediaMode = 'watch' | 'grid' | 'gems';

/** Per-mode persistent state. Extend as each mode gains real content. */
export interface MediaModeState {
  /** Scroll offset preserved across tab switches. */
  scrollOffset: number;
}

const DEFAULT_MODE_STATE: MediaModeState = { scrollOffset: 0 };

interface AllModeState {
  watch: MediaModeState;
  grid: MediaModeState;
  gems: MediaModeState;
}

const makeAllModeState = (): AllModeState => ({
  watch: { ...DEFAULT_MODE_STATE },
  grid: { ...DEFAULT_MODE_STATE },
  gems: { ...DEFAULT_MODE_STATE },
});

// ── Context ───────────────────────────────────────────────────────────────────

interface MediaStoreContextValue {
  selectedMode: MediaMode;
  /** Switch to a different mode. Persists to AsyncStorage. */
  setMode: (mode: MediaMode) => void;
  /** Read per-mode state (scroll offset, etc.). */
  getModeState: (mode: MediaMode) => MediaModeState;
  /** Partial-update per-mode state without replacing the whole object. */
  setModeState: (mode: MediaMode, state: Partial<MediaModeState>) => void;
}

const MediaStoreContext = createContext<MediaStoreContextValue>({
  selectedMode: 'watch',
  setMode: () => {},
  getModeState: () => DEFAULT_MODE_STATE,
  setModeState: () => {},
});

// ── AsyncStorage key ──────────────────────────────────────────────────────────

const STORAGE_KEY = '@travel_buddy/media_selected_mode';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Picks a valid mode: prefers `preferred` if it's in `enabled`, else first enabled. */
export function pickValidMode(preferred: MediaMode, enabled: MediaMode[]): MediaMode {
  if (enabled.length === 0) return preferred; // no modes enabled yet — hold
  return enabled.includes(preferred) ? preferred : enabled[0];
}

// ── Provider ──────────────────────────────────────────────────────────────────

interface MediaStoreProviderProps {
  children: React.ReactNode;
  /**
   * Server-configured default mode (from MEDIA_DEFAULT_VIEW_MODE flag) or
   * 'watch'. Applied on first open when no AsyncStorage value exists.
   */
  defaultMode?: MediaMode;
  /** Subset of modes currently enabled by feature flags. */
  enabledModes?: MediaMode[];
  /**
   * True while feature flags are being fetched. When true, the store holds
   * its initial value and does not restore from AsyncStorage yet, so an
   * incomplete enabledModes cannot lock in a disabled mode.
   */
  flagsLoading?: boolean;
}

export function MediaStoreProvider({
  children,
  defaultMode = 'watch',
  enabledModes = ['watch', 'grid', 'gems'],
  flagsLoading = false,
}: MediaStoreProviderProps) {
  // selectedMode and modeStates are kept in separate useState calls so
  // setModeState updates don't trigger re-renders of the mode selector.
  const [selectedMode, setSelectedMode] = useState<MediaMode>(defaultMode);
  const [modeStates, setModeStates] = useState<AllModeState>(makeAllModeState);

  // Track whether we have restored from AsyncStorage yet.
  const restoredRef = useRef(false);

  // Step 1 — Restore from AsyncStorage once flags are loaded.
  // Flags must be loaded first so we know the real enabledModes to validate against.
  useEffect(() => {
    if (flagsLoading) return; // defer until flags are ready
    if (restoredRef.current) return; // only restore once per provider lifetime
    restoredRef.current = true;

    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        const candidate = (stored as MediaMode | null) ?? defaultMode;
        setSelectedMode((cur) => pickValidMode(candidate, enabledModes) || cur);
      })
      .catch(() => {
        setSelectedMode((cur) => pickValidMode(defaultMode, enabledModes) || cur);
      });
  // enabledModes intentionally captured at restore-time (snapshot), not tracked.
  // Ongoing reconciliation is handled by Step 2 below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagsLoading]);

  // Step 2 — Reconcile selectedMode whenever enabledModes changes after flags load.
  // This handles: flags arriving after mount, or a flag being toggled at runtime.
  // Skipped while flags are loading to avoid reacting to an incomplete set.
  const prevEnabledRef = useRef<string>(enabledModes.join(','));
  useEffect(() => {
    if (flagsLoading) return;
    if (enabledModes.length === 0) return; // all modes disabled — hold current value

    const key = enabledModes.join(',');
    if (key === prevEnabledRef.current && restoredRef.current) {
      // Same set as before — no reconciliation needed (handles first-render case
      // before Step 1 restore fires, which sets restoredRef.current = true).
      prevEnabledRef.current = key;
      return;
    }
    prevEnabledRef.current = key;

    // Reconcile: if current mode is no longer enabled, switch to first enabled.
    setSelectedMode((cur) => pickValidMode(cur, enabledModes));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledModes, flagsLoading]);

  const setMode = useCallback((mode: MediaMode) => {
    setSelectedMode(mode);
    AsyncStorage.setItem(STORAGE_KEY, mode).catch(() => {});
  }, []);

  const getModeState = useCallback(
    (mode: MediaMode): MediaModeState => modeStates[mode] ?? DEFAULT_MODE_STATE,
    [modeStates],
  );

  const setModeState = useCallback(
    (mode: MediaMode, partial: Partial<MediaModeState>) => {
      setModeStates((prev) => ({
        ...prev,
        [mode]: { ...prev[mode], ...partial },
      }));
    },
    [],
  );

  const value = useMemo<MediaStoreContextValue>(
    () => ({ selectedMode, setMode, getModeState, setModeState }),
    [selectedMode, setMode, getModeState, setModeState],
  );

  return (
    React.createElement(MediaStoreContext.Provider, { value }, children)
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMediaStore(): MediaStoreContextValue {
  return useContext(MediaStoreContext);
}
