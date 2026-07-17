import { useCallback, useEffect, useState } from 'react';
import { saveProfile, unsaveProfile, getSaveStatus } from '../services/saves.ts';

export function useSavedProfileActions(userId: string) {
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setChecking(true);
      const res = await getSaveStatus(userId);
      if (!cancelled && res.ok && res.data) setSaved(res.data.isSaved);
      if (!cancelled) setChecking(false);
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const toggle = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    const fn = saved ? unsaveProfile : saveProfile;
    const res = await fn(userId);
    setLoading(false);
    if (res.ok) { setSaved((s) => !s); return true; }
    return false;
  }, [userId, saved]);

  return { saved, loading, checking, toggle };
}
