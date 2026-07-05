import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { getSessionUserId, onAuthChange, signOut as svcSignOut } from '../services/auth';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { getAccountStatus } from '../services/profile';
import type { AccountStatus } from '../services/profile';
import { pauseOnSessionEnd } from '../services/circle';

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
  accountStatus: AccountStatus | null;
  accountStatusLoaded: boolean;
  deletionScheduledAt: string | null;
  refreshAccountStatus: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<string | null>(null);
  const [roleLoaded, setRoleLoaded] = useState(false);
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(null);
  const [accountStatusLoaded, setAccountStatusLoaded] = useState(false);
  const [deletionScheduledAt, setDeletionScheduledAt] = useState<string | null>(null);

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

  const fetchAccountStatus = useCallback(async (uid: string | null) => {
    if (!uid) {
      setAccountStatus(null);
      setDeletionScheduledAt(null);
      setAccountStatusLoaded(true);
      return;
    }
    setAccountStatusLoaded(false);
    const result = await getAccountStatus();
    if (result.ok && result.data) {
      setAccountStatus(result.data.accountStatus);
      setDeletionScheduledAt(result.data.deletionScheduledAt);
    } else {
      // Fail-closed: on any error (network, API) we cannot confirm the account
      // is active, so keep accountStatus = null (unknown). AccountStatusGate
      // will block the app and show a retry screen until status is confirmed.
      setAccountStatus(null);
      setDeletionScheduledAt(null);
    }
    setAccountStatusLoaded(true);
  }, []);

  useEffect(() => {
    fetchAccountStatus(userId);
  }, [userId, fetchAccountStatus]);

  const refreshAccountStatus = useCallback(async () => {
    await fetchAccountStatus(userId);
  }, [userId, fetchAccountStatus]);

  // Pause Circle presence when the app goes to background / is suspended so
  // other members don't see a stale "active" badge after the user closes the
  // app.  Only fires when the user is authenticated.  Fire-and-forget — no
  // user-visible feedback on success or failure.
  useEffect(() => {
    if (!userId) return;
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        pauseOnSessionEnd().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [userId]);

  const signOut = useCallback(async () => {
    await svcSignOut();
    setUserId(null);
    setAccountStatus(null);
    setDeletionScheduledAt(null);
    setAccountStatusLoaded(false);
  }, []);

  return (
    <SessionContext.Provider value={{
      userId,
      isAuthed: Boolean(userId),
      loading,
      configured: isSupabaseConfigured,
      signOut,
      role,
      roleLoaded,
      accountStatus,
      accountStatusLoaded,
      deletionScheduledAt,
      refreshAccountStatus,
    }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    return {
      userId: null,
      isAuthed: false,
      loading: false,
      configured: isSupabaseConfigured,
      signOut: async () => {},
      role: null,
      roleLoaded: true,
      accountStatus: null,
      accountStatusLoaded: true,
      deletionScheduledAt: null,
      refreshAccountStatus: async () => {},
    };
  }
  return ctx;
}
