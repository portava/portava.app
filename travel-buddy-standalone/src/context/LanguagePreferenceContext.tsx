import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useSession } from './SessionContext.tsx';
import { getMyLanguageSettings, updateMyLanguageSettings } from '../services/messaging.ts';

interface LanguagePreferenceContextValue {
  preferredLanguage: string | null;
  loading: boolean;
  updateLanguage: (code: string | null) => Promise<{ ok: boolean; message?: string }>;
}

const LanguagePreferenceContext = createContext<LanguagePreferenceContextValue>({
  preferredLanguage: null,
  loading: false,
  updateLanguage: async () => ({ ok: false }),
});

export function LanguagePreferenceProvider({ children }: { children: React.ReactNode }) {
  const { isAuthed, configured } = useSession();
  const [preferredLanguage, setPreferredLanguage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const live = configured && isAuthed;

  useEffect(() => {
    if (!live) {
      setPreferredLanguage(null);
      return;
    }
    setLoading(true);
    getMyLanguageSettings().then((res) => {
      if (!isMounted.current) return;
      if (res.ok && res.data) setPreferredLanguage(res.data.preferred_language ?? null);
      setLoading(false);
    });
  }, [live]);

  const updateLanguage = useCallback(async (code: string | null): Promise<{ ok: boolean; message?: string }> => {
    const prev = preferredLanguage;
    setPreferredLanguage(code);
    const result = await updateMyLanguageSettings({ preferred_language: code });
    if (!result.ok && isMounted.current) {
      setPreferredLanguage(prev);
    }
    return result;
  }, [preferredLanguage]);

  return (
    <LanguagePreferenceContext.Provider value={{ preferredLanguage, loading, updateLanguage }}>
      {children}
    </LanguagePreferenceContext.Provider>
  );
}

export function useLanguagePreference() {
  return useContext(LanguagePreferenceContext);
}
