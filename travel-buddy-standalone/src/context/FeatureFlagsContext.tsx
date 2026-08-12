/**
 * FeatureFlagsContext — app-wide feature flag availability.
 *
 * Fetches GET /api/feature-flags once on mount and re-fetches when the app
 * returns to the foreground.  The context is fail-soft: if the fetch fails or
 * a flag key is unknown, `isEnabled` returns `false` — entry points are hidden
 * rather than crashing.
 *
 * Usage:
 *   const { isEnabled } = useFeatureFlags();
 *   if (!isEnabled('map_search_enabled')) return null;
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FeatureFlagsContextValue {
  /** Returns true only when the named flag is explicitly enabled on the server. */
  isEnabled: (key: string) => boolean;
  /** Resolves the Live Places parent hierarchy for a capability. */
  isLivePlacesEnabled: (key: string) => boolean;
  /** True while the initial fetch is in-flight. */
  loading: boolean;
}

// ── Context ───────────────────────────────────────────────────────────────────

const FeatureFlagsContext = createContext<FeatureFlagsContextValue>({
  isEnabled: () => false,
  isLivePlacesEnabled: () => false,
  loading: false,
});

// ── Provider ──────────────────────────────────────────────────────────────────

const API_BASE = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

export function FeatureFlagsProvider({ children }: { children: React.ReactNode }) {
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  // Tracks whether the initial fetch has completed at least once.
  const initialFetched = useRef(false);

  const fetchFlags = useCallback(async () => {
    const base = API_BASE();
    try {
      const res = await fetch(`${base}/api/feature-flags`);
      if (!res.ok) return; // keep previous flags on transient server error
      const body: { flags?: Record<string, boolean> } = await res.json();
      if (body && typeof body.flags === 'object' && body.flags !== null) {
        setFlags(body.flags);
      }
    } catch {
      // Network error — keep previous flags (fail-soft).
    } finally {
      if (!initialFetched.current) {
        initialFetched.current = true;
        setLoading(false);
      }
    }
  }, []);

  // Fetch on mount.
  useEffect(() => {
    void fetchFlags();
  }, [fetchFlags]);

  // Re-fetch when the app returns to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        void fetchFlags();
      }
    });
    return () => sub.remove();
  }, [fetchFlags]);

  const isEnabled = useCallback((key: string): boolean => {
    const requirements: Record<string, string[]> = {
      live_places_enabled: ['external_places_enabled'],
      place_days_enabled: ['external_places_enabled', 'live_places_enabled'],
      shared_moments_enabled: ['external_places_enabled', 'live_places_enabled', 'place_days_enabled'],
      shared_moments_compass_suggestions_enabled: ['external_places_enabled', 'live_places_enabled', 'place_days_enabled', 'shared_moments_enabled'],
      shared_moments_clustering_enabled: ['external_places_enabled', 'live_places_enabled', 'place_days_enabled', 'shared_moments_enabled'],
      place_recaps_enabled: ['external_places_enabled', 'live_places_enabled', 'place_days_enabled'],
      moment_recaps_enabled: ['external_places_enabled', 'live_places_enabled', 'place_days_enabled', 'shared_moments_enabled'],
      shared_moments_chat_enabled: ['external_places_enabled', 'live_places_enabled', 'place_days_enabled', 'shared_moments_enabled'],
    };
    return flags[key] === true && (requirements[key] ?? []).every((parent) => flags[parent] === true);
  }, [flags]);

  return (
    <FeatureFlagsContext.Provider value={{ isEnabled, isLivePlacesEnabled: isEnabled, loading }}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useFeatureFlags(): FeatureFlagsContextValue {
  return useContext(FeatureFlagsContext);
}
