import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { getSessionUserId, onAuthChange, signOut as svcSignOut, ensureProfile, reportEnsureProfileFailure } from '../services/auth.ts';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { getAccountStatus, TOKEN_UNAVAILABLE } from '../services/profile.ts';
import type { AccountStatus } from '../services/profile.ts';
import { pauseOnSessionEnd } from '../services/circle.ts';
import { clearForUser as clearSavedForUser, primeSaved } from '../services/savedPostsCache.ts';
import { fetchMySavedPostIds } from '../services/postEngagement.ts';
import { clearCachedFeed } from '../services/compass.ts';
import { SECURE_KEYS, deleteSecure } from '../lib/secureStore.ts';
import { isAccountScopedStorageEnabled } from '../config/accountScopedStorageFlag.ts';

// Prefixes of the per-account scoped keys introduced for reminders,
// discoveryBookmarks, and the checkpoint-arrival queue (see each service's
// scoped*Key() helper). Telegraph's suggestion cache is per-(thread,account)
// and is swept by suffix instead, since thread ids aren't enumerable here.
// Only relevant while isAccountScopedStorageEnabled() is true — no such keys
// are ever created while the flag is off, so this sweep is a no-op then.
const SCOPED_KEY_PREFIXES = [
  '@travel_buddy/reminders_scoped_v1:',
  'discovery_bookmarks_scoped_v1:',
  '@travel_buddy/pending_checkpoint_arrivals_scoped_v1:',
] as const;
const TELEGRAPH_SCOPED_PREFIX = 'telegraph_suggestions_scoped_v1_';

/**
 * Removes every account-scoped storage key belonging to the outgoing user, so
 * a different account signing in later on this device never inherits its
 * reminders, bookmarks, checkpoint queue, or Telegraph suggestion cache.
 * Only does anything while the flag is on (matches the pattern of
 * PRIVATE_ASYNC_KEYS below, extended to the newer per-account key shapes).
 */
async function clearScopedStorageForUser(userId: string): Promise<void> {
  if (!isAccountScopedStorageEnabled()) return;
  try {
    const AS = require('@react-native-async-storage/async-storage').default;
    const allKeys: string[] = await AS.getAllKeys();
    const toRemove = allKeys.filter((k) =>
      SCOPED_KEY_PREFIXES.some((p) => k === `${p}${userId}`) ||
      (k.startsWith(TELEGRAPH_SCOPED_PREFIX) && k.endsWith(`_${userId}`)),
    );
    if (toRemove.length > 0) await AS.multiRemove(toRemove);
  } catch {
    // Non-fatal — native module absent (e.g. web / test environment).
  }
}

// AsyncStorage keys that may hold private entity data and must be wiped on logout.
// Using lazy require to avoid circular-dependency issues and to preserve native-only import.
const PRIVATE_ASYNC_KEYS = [
  // Pending checkpoint arrivals — may contain precise user coordinates.
  '@travel_buddy/pending_checkpoint_arrivals',
] as const;

// E2EE identity/device key material that must be wiped on logout so the next
// account signing in on this device cannot inherit the previous user's crypto
// identity. (MLS per-group state uses a dynamic key prefix and cannot be
// enumerated through SecureStore; group state is re-established per identity.)
const CRYPTO_SECURE_KEYS = [
  SECURE_KEYS.IDENTITY_PRIVATE_KEY,
  SECURE_KEYS.IDENTITY_PUBLIC_KEY,
  SECURE_KEYS.DEVICE_ED25519_PRIVATE_KEY,
  SECURE_KEYS.DEVICE_ED25519_PUBLIC_KEY,
  SECURE_KEYS.DEVICE_X25519_PRIVATE_KEY,
  SECURE_KEYS.DEVICE_X25519_PUBLIC_KEY,
  SECURE_KEYS.REGISTERED_DEVICE_ID,
] as const;

// How long to wait before re-checking account status after a network-level
// failure was answered with the fail-open ("assume active") state.
const OFFLINE_STATUS_RETRY_MS = 15_000;

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

  // Tracks the current userId so async completions can detect a sign-out or
  // account switch that happened while their request was in flight.
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = userId;

  // Pending background retry for the offline fail-open path below. Cleared
  // whenever a new fetch starts (any result supersedes the scheduled retry)
  // and on unmount.
  const statusRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStatusRetry = useCallback(() => {
    if (statusRetryTimerRef.current !== null) {
      clearTimeout(statusRetryTimerRef.current);
      statusRetryTimerRef.current = null;
    }
  }, []);

  const fetchAccountStatus = useCallback(async (uid: string | null, opts?: { background?: boolean }) => {
    clearStatusRetry();
    if (!uid) {
      // NOT LOADED — "we have not asked", not "we asked and failed".
      //
      // These two states are both (accountStatus === null) and the gate tells
      // them apart ONLY by accountStatusLoaded. Setting it true here latched the
      // context into the exact shape AccountStatusGate renders as the full-page
      // "Couldn't verify your account" wall, and left it latched. While signed
      // out that is invisible — the gate returns children before it reads this
      // flag — but the moment userId became non-null again the gate rendered
      // with the stale latched pair before this effect could clear it.
      //
      // That is the second half of task 3658, and it is why the wall appeared
      // mid-session with the session still live: any auth event delivering a
      // null session (a discarded token rotation, a refresh that momentarily
      // reports no session) flips userId null → non-null through
      // onAuthStateChange, and the round trip alone was enough to raise the
      // wall. Nothing about the account was ever in question.
      setAccountStatus(null);
      setDeletionScheduledAt(null);
      setAccountStatusLoaded(false);
      return;
    }
    // Background retries keep the already-rendered app visible — flipping
    // accountStatusLoaded would blank the whole tree behind the gate's
    // loading screen on every offline retry tick.
    if (!opts?.background) setAccountStatusLoaded(false);
    const result = await getAccountStatus();
    // Fence: if the signed-in user changed while the request was in flight,
    // discard the result — the effect keyed on userId re-fetches for the new
    // user (or clears state on sign-out).
    if (userIdRef.current !== uid) return;
    if (result.ok && result.data) {
      setAccountStatus(result.data.accountStatus);
      setDeletionScheduledAt(result.data.deletionScheduledAt);
    } else if (result.errorKind === 'network_unreachable' || result.errorKind === TOKEN_UNAVAILABLE) {
      // Fail-OPEN, and ONLY for the two kinds that mean NO SERVER VERDICT
      // EXISTS:
      //
      //   network_unreachable — the request never reached the API (offline cold
      //                         start, airplane mode, DNS failure);
      //   TOKEN_UNAVAILABLE   — freshToken() returned null, so nothing was ever
      //                         sent. See its definition in services/profile.ts:
      //                         one failed token mint is not a claim that the
      //                         user is signed out, and userId is non-null at
      //                         this call site, so the session is live.
      //
      // In neither case has anything examined the account, so blocking the app
      // behind "Couldn't verify your account" asserts a check that never ran.
      // Assume active and keep retrying in the background until a real answer
      // lands.
      //
      // 'unauthenticated' is deliberately NOT here. That is the server's 401 on
      // a token it received, and failing open on it would render the app for a
      // genuinely invalid, expired or revoked token. Real API responses
      // (unauthenticated / forbidden / deactivated / server errors) all still
      // fail closed below.
      setAccountStatus('active');
      setDeletionScheduledAt(null);
      statusRetryTimerRef.current = setTimeout(() => {
        statusRetryTimerRef.current = null;
        // Same generation fence: only retry while this user is still signed in.
        if (userIdRef.current === uid) {
          void fetchAccountStatusRef.current(uid, { background: true });
        }
      }, OFFLINE_STATUS_RETRY_MS);
    } else {
      // Fail-closed: a real API/server response we cannot interpret as active.
      // Keep accountStatus = null (unknown) so AccountStatusGate blocks the
      // app and shows a retry screen until the status is confirmed.
      setAccountStatus(null);
      setDeletionScheduledAt(null);
    }
    setAccountStatusLoaded(true);
  }, [clearStatusRetry]);

  // Self-reference for the scheduled background retry (avoids a useCallback
  // self-dependency).
  const fetchAccountStatusRef = useRef(fetchAccountStatus);
  fetchAccountStatusRef.current = fetchAccountStatus;

  useEffect(() => {
    fetchAccountStatus(userId);
    return clearStatusRetry;
  }, [userId, fetchAccountStatus, clearStatusRetry]);

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
      } catch (e) {
        // Transient failure — reset the guard so the next sign-in attempt
        // can trigger another recovery attempt. Still fire-and-forget: this
        // must never block the UI or show an error (see comment above).
        lastRecoveredUserId.current = null;
        reportEnsureProfileFailure('sessionRecovery', userId, e);
      }
    };

    recover();
  }, [userId]);

  const refreshAccountStatus = useCallback(async () => {
    await fetchAccountStatus(userId);
  }, [userId, fetchAccountStatus]);

  // Pre-warm the saved-posts cache as soon as we have a userId so bookmark
  // indicators are correct from the first feed paint. Fire-and-forget.
  useEffect(() => {
    if (!userId) return;
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
      clearSavedForUser(userId);
      // Remove the personalised Compass feed cache so it doesn't persist
      // private recommendation data (event addresses, place details) to disk.
      void clearCachedFeed(userId).catch(() => {});
      // Remove this account's scoped reminders/bookmarks/checkpoint-queue/
      // Telegraph-cache keys (no-op while the flag is off — see helper doc).
      void clearScopedStorageForUser(userId).catch(() => {});
    }
    // Wipe other AsyncStorage keys that may hold private entity data.
    // Lazy-require keeps this from crashing on web (where AsyncStorage is
    // unavailable) — getStorage() in compass.ts does the same.
    try {
      const AS = require('@react-native-async-storage/async-storage').default;
      await Promise.allSettled(PRIVATE_ASYNC_KEYS.map((k) => AS.removeItem(k)));
    } catch {
      // Non-fatal — native module absent (e.g. web / test environment).
    }
    // Wipe E2EE key material from SecureStore so a different account signing
    // in later on this device cannot use the outgoing user's identity.
    // Sign-out must never fail on cleanup, so failures are swallowed.
    try {
      await Promise.allSettled(CRYPTO_SECURE_KEYS.map((k) => deleteSecure(k)));
    } catch {
      // Non-fatal — proceed with sign-out regardless.
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
