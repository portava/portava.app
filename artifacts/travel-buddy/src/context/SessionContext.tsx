import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { getSessionUserId, onAuthChange, signOut as svcSignOut } from '../services/auth';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

/**
 * Session context — single source of auth truth for the app. Wraps the auth
 * service. If Supabase isn't configured, userId stays null and the app can fall
 * back to its previous (mock) behavior.
 */
interface SessionContextValue {
  userId: string | null;
  isAuthed: boolean;
  loading: boolean;
  configured: boolean;
  signOut: () => Promise<void>;
  role: string | null;
  roleLoaded: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  const [roleLoaded, setRoleLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    getSessionUserId().then((uid) => { if (active) { setUserId(uid); setLoading(false); } });
    const unsub = onAuthChange((uid) => { if (active) setUserId(uid); });
    return () => { active = false; unsub(); };
  }, []);

  useEffect(() => {
    if (!userId) {
      setRole(null);
      setRoleLoaded(true);
      return;
    }
    setRoleLoaded(false);
    supabase.from('profiles').select('role').eq('id', userId).maybeSingle()
      .then(
        ({ data }) => { setRole((data as any)?.role ?? null); setRoleLoaded(true); },
        () => { setRole(null); setRoleLoaded(true); }
      );
  }, [userId]);

  const signOut = useCallback(async () => {
    await svcSignOut();
    setUserId(null);
  }, []);

  return (
    <SessionContext.Provider value={{ userId, isAuthed: Boolean(userId), loading, configured: isSupabaseConfigured, signOut, role, roleLoaded }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    return { userId: null, isAuthed: false, loading: false, configured: isSupabaseConfigured, signOut: async () => {}, role: null, roleLoaded: true };
  }
  return ctx;
}
