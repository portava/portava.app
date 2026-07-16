/**
 * useCompassSettings — loads and patches Compass data-use settings.
 *
 * Optimistic update: applies the patch locally before the API call
 * so the UI responds immediately; rolls back on error.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchCompassSettings,
  patchCompassSettings,
  deleteCompassContext,
  type CompassSettings,
} from '../../services/compass.ts';

interface UseCompassSettingsReturn {
  settings:          CompassSettings | null;
  loading:           boolean;
  saving:            boolean;
  error:             string | null;
  updateSetting:     (key: keyof CompassSettings, value: boolean) => Promise<void>;
  resetPersonalisation: () => Promise<{ ok: boolean; error?: string }>;
}

const DEFAULT_SETTINGS: CompassSettings = {
  use_location:                true,
  use_chosen_city:             true,
  use_trip_data:               true,
  use_saved_items:             true,
  use_history:                 true,
  show_buddy_recommendations:  true,
  show_people_recommendations: true,
  allow_smart_notifications:   true,
  onboarding_completed:        false,
};

export function useCompassSettings(): UseCompassSettingsReturn {
  const [settings, setSettings] = useState<CompassSettings | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const prevRef = useRef<CompassSettings | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    fetchCompassSettings().then((r) => {
      if (!mounted) return;
      if (r.ok && r.data) {
        const merged = { ...DEFAULT_SETTINGS, ...r.data };
        setSettings(merged);
        prevRef.current = merged;
      } else {
        setError(r.error ?? 'load_failed');
        setSettings(DEFAULT_SETTINGS);
        prevRef.current = DEFAULT_SETTINGS;
      }
      setLoading(false);
    });
    return () => { mounted = false; };
  }, []);

  const updateSetting = useCallback(
    async (key: keyof CompassSettings, value: boolean) => {
      const snapshot = settings ?? DEFAULT_SETTINGS;
      const optimistic = { ...snapshot, [key]: value };
      setSettings(optimistic);
      setSaving(true);

      const r = await patchCompassSettings({ [key]: value });
      setSaving(false);
      if (r.ok && r.data) {
        setSettings({ ...DEFAULT_SETTINGS, ...r.data });
        prevRef.current = { ...DEFAULT_SETTINGS, ...r.data };
      } else {
        // rollback
        setSettings(snapshot);
        setError(r.error ?? 'save_failed');
      }
    },
    [settings],
  );

  const resetPersonalisation = useCallback(async () => {
    setSaving(true);
    const r = await deleteCompassContext();
    setSaving(false);
    return r;
  }, []);

  return { settings, loading, saving, error, updateSetting, resetPersonalisation };
}
