import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { getSessionUserId, onAuthChange, signOut as svcSignOut, ensureProfile } from '../services/auth';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { getAccountStatus } from '../services/profile';
import type { AccountStatus } from '../services/profile';
import { pauseOnSessionEnd } from '../services/circle';
import { clearForUser as clearLikedForUser, primeLikes } from '../services/likedPostsCache';
import { clearForUser as clearSavedForUser, primeSaved } from '../services/savedPostsCache';
import { fetchMyLikedPostIds, fetchMySavedPostIds } from '../services/postEngagement';
import { clearCachedFeed } from '../services/compass';

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

  // Defensive profile recovery: when a userId becomes available, try to ensure
  // the profile row exists. This covers cases where ensureProfile failed during
  // sign-up/sign-in (e.g. a network error) and the user resumes the app.
  // Fire-and-forget — never blocks the UI or shows an error.
  const lastRecoveredUserId = useRef<string | null>(null);
  useEffect(() => {
    if (!userId || lastRecoveredUserId.current === userId) return;
    // Mark immediately to prevent concurrent calls within this session.
    // Reset to null on failure so a subsequent userId change (e.g. re-sign-in)
    // can trigger a retry.
    lastRecoveredUserId.current = userId;

    const recover = async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const session = sessionData.session;
        if (!session) {
          lastRecoveredUserId.current = null;
          return;
        }
        const email = session.user?.email ?? '';
        const name = session.user?.user_metadata?.name ?? undefined;
        await ensureProfile(session.user.id, email, { name });
      } catch {
        // Transient failure — reset the guard so the next sign-in attempt
        // can trigger another recovery attempt.
        lastRecoveredUserId.current = null;
      }
    };

    recover();
  }, [userId]);

  const refreshAccountStatus = useCallback(async () => {
    await fetchAccountStatus(userId);
  }, [userId, fetchAccountStatus]);

  // Pre-warm the liked-posts and saved-posts caches as soon as we have a
  // userId so heart and bookmark indicators are correct from the first feed
  // paint.  Both are fire-and-forget — the cache starts empty on any error
  // and components fall back to the feed API's likedByMe/savedByMe props.
  useEffect(() => {
    if (!userId) return;
    fetchMyLikedPostIds().then((postIds) => {
      if (postIds.length > 0) primeLikes(userId, postIds);
    }).catch(() => {});
    fetchMySavedPostIds().then((postIds) => {
      if (postIds.length > 0) primeSaved(userId, postIds);
    }).catch(() => {});
  }, [userId]);

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
    // Clear per-user caches before wiping the userId so we can still
    // reference the outgoing user's id inside the clear calls.
    if (userId) {
      clearLikedForUser(userId);
      clearSavedForUser(userId);
      await clearCachedFeed(userId).catch(() => {});
    }
    await svcSignOut();
    setUserId(null);
    setAccountStatus(null);
    setDeletionScheduledAt(null);
    setAccountStatusLoaded(false);
  }, [userId]);

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
