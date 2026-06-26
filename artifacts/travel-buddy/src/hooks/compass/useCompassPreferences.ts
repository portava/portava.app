import { useState, useEffect, useCallback } from 'react';
import {
  fetchCompassPreferences,
  patchCompassPreferences,
  type CompassPreferences,
} from '../../services/compass';
import { useSession } from '../../context/SessionContext';

interface UseCompassPreferencesResult {
  prefs:   CompassPreferences | null;
  loading: boolean;
  saving:  boolean;
  error:   string | null;
  update:  (patch: Partial<CompassPreferences>) => Promise<boolean>;
  reload:  () => void;
}

export function useCompassPreferences(): UseCompassPreferencesResult {
  const { isAuthed } = useSession();
  const [prefs, setPrefs]     = useState<CompassPreferences | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isAuthed) return;
    setLoading(true);
    const r = await fetchCompassPreferences();
    setLoading(false);
    if (r.ok && r.data) {
      setPrefs(r.data);
      setError(null);
    } else {
      setError(r.error ?? 'unknown');
    }
  }, [isAuthed]);

  useEffect(() => { load(); }, [load]);

  const update = useCallback(async (patch: Partial<CompassPreferences>): Promise<boolean> => {
    setSaving(true);
    // Optimistic update
    setPrefs((prev) => prev ? { ...prev, ...patch } : patch);
    const r = await patchCompassPreferences(patch);
    setSaving(false);
    if (r.ok && r.data) {
      setPrefs(r.data);
      return true;
    }
    // Revert on failure
    load();
    return false;
  }, [load]);

  return { prefs, loading, saving, error, update, reload: load };
}
