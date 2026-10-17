import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useSession } from './SessionContext.tsx';
import { getMyLanguageSettings, updateMyLanguageSettings } from '../services/messaging.ts';
import { supabase } from '../lib/supabase.ts';
import { messagingSessionIdentity } from '../services/messagingOwnerRequest.ts';
import { readAutomaticDubbingPreference, writeAutomaticDubbingPreference, type AutomaticDubbingPreference } from '../services/languagePreferences.ts';

interface LanguagePreferenceContextValue {
  preferredLanguage: string | null;
  loading: boolean;
  updateLanguage: (code: string | null) => Promise<{ ok: boolean; message?: string }>;
  automaticDubbingPreference: AutomaticDubbingPreference | undefined;
  automaticDubbingLoading: boolean;
  updateAutomaticDubbing: (preference: AutomaticDubbingPreference) => Promise<{ ok: boolean; message?: string }>;
  preferenceSession: number;
}

const LanguagePreferenceContext = createContext<LanguagePreferenceContextValue>({
  preferredLanguage: null,
  loading: false,
  updateLanguage: async () => ({ ok: false }),
  automaticDubbingPreference: undefined,
  automaticDubbingLoading: false,
  updateAutomaticDubbing: async () => ({ ok: false }),
  preferenceSession: 0,
});

export function LanguagePreferenceProvider({ children }: { children: React.ReactNode }) {
  const { isAuthed, configured, userId } = useSession();
  const viewerId = configured && isAuthed ? userId ?? null : null;
  const renderedViewer = useRef(viewerId);
  const scope = useRef<{ viewerId: string | null; identity: ReturnType<typeof messagingSessionIdentity>; epoch: number; observed: boolean }>({ viewerId, identity: null, epoch: 0, observed: false });
  const authRevision = useRef(0);
  const authObserved = useRef(false);
  const observingAuth = useRef(false);
  const [, refreshAuth] = useState(0);
  if (renderedViewer.current !== viewerId) {
    renderedViewer.current = viewerId;
    const identity = scope.current.identity?.ownerId === viewerId ? scope.current.identity : null;
    scope.current = { viewerId, identity, epoch: scope.current.epoch + 1, observed: Boolean(identity) || !viewerId };
  }
  const session = scope.current;
  const operation = useRef(0);
  const automaticOperation = useRef(0);
  const confirmedLanguage = useRef<string | null>(null);
  const [state, setState] = useState<{ session: typeof session | null; language: string | null; loading: boolean }>({
    session: null, language: null, loading: false,
  });
  const [automaticState, setAutomaticState] = useState<{ session: typeof session | null; enabled: boolean; loading: boolean }>({ session: null, enabled: false, loading: false });
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const acceptIdentity = useCallback((identity: ReturnType<typeof messagingSessionIdentity>, force = false) => {
    const previous = scope.current;
    const ownerId = identity?.ownerId ?? null;
    if (!force && previous.observed && previous.viewerId === ownerId
      && previous.identity?.ownerId === identity?.ownerId && previous.identity?.sessionId === identity?.sessionId) return;
    scope.current = { viewerId: ownerId, identity, epoch: previous.epoch + 1, observed: true };
    refreshAuth(value => value + 1);
  }, []);

  useEffect(() => {
    if (!configured) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    authObserved.current = false;
    try {
      const { data } = supabase.auth.onAuthStateChange((event, authSession) => {
        if (!active || (event === 'INITIAL_SESSION' && authObserved.current)) return;
        authObserved.current = true;
        authRevision.current += 1;
        acceptIdentity(event === 'SIGNED_OUT' ? null : messagingSessionIdentity(authSession), event === 'SIGNED_OUT');
      });
      observingAuth.current = true;
      unsubscribe = () => data.subscription.unsubscribe();
    } catch {
      observingAuth.current = false;
      acceptIdentity(null, true);
    }
    return () => {
      active = false;
      observingAuth.current = false;
      authRevision.current += 1;
      scope.current = { ...scope.current, identity: null, observed: false, epoch: scope.current.epoch + 1 };
      unsubscribe?.();
    };
  }, [configured, acceptIdentity]);

  useEffect(() => {
    if (!viewerId || !observingAuth.current || (scope.current.observed && scope.current.identity?.ownerId === viewerId)) return;
    let cancelled = false;
    const revision = authRevision.current;
    const initialScope = scope.current;
    const current = () => !cancelled && isMounted.current && observingAuth.current && authRevision.current === revision
      && scope.current === initialScope && renderedViewer.current === viewerId;
    void (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (!current()) return;
        if (!error) authObserved.current = true;
        acceptIdentity(error ? null : messagingSessionIdentity(data.session));
      } catch {
        if (current()) acceptIdentity(null);
      }
    })();
    return () => { cancelled = true; };
  }, [viewerId, configured, acceptIdentity]);

  const isCurrentSession = useCallback(() => isMounted.current && observingAuth.current && scope.current === session
    && !!viewerId && session.viewerId === viewerId && session.identity?.ownerId === viewerId, [session, viewerId]);

  useEffect(() => {
    const request = ++operation.current;
    const automaticRequest = ++automaticOperation.current;
    let cancelled = false;
    const current = () => !cancelled && isCurrentSession();
    confirmedLanguage.current = null;
    setState({ session, language: null, loading: Boolean(viewerId) });
    setAutomaticState({ session, enabled: false, loading: Boolean(viewerId) });
    if (!viewerId || !current()) return;
    getMyLanguageSettings({ userId: viewerId, isCurrent: current }).then((res) => {
      if (!current() || request !== operation.current) return;
      const language = res.ok && res.data ? res.data.preferred_language ?? null : null;
      confirmedLanguage.current = language;
      setState({ session, language, loading: false });
    }).catch(() => {
      if (current() && request === operation.current) {
        setState({ session, language: null, loading: false });
      }
    });
    void readAutomaticDubbingPreference(viewerId).then(enabled => {
      if (current() && automaticRequest === automaticOperation.current) setAutomaticState({ session, enabled, loading: false });
    });
    return () => { cancelled = true; };
  }, [session, viewerId, isCurrentSession]);

  const validViewer = !!viewerId && session.viewerId === viewerId && session.identity?.ownerId === viewerId && observingAuth.current;
  const preferredLanguage = validViewer && state.session === session ? state.language : null;
  const loading = validViewer ? state.session === session ? state.loading : true : Boolean(viewerId && !session.observed);
  const automaticDubbingLoading = validViewer ? automaticState.session === session ? automaticState.loading : true : Boolean(viewerId && !session.observed);
  const automaticDubbingPreference = validViewer && automaticState.session === session
    ? { userId: viewerId, enabled: !automaticDubbingLoading && automaticState.enabled } : undefined;

  const updateLanguage = useCallback(async (code: string | null): Promise<{ ok: boolean; message?: string }> => {
    const current = isCurrentSession;
    if (!viewerId || !current()) return { ok: false, message: 'Sign in to update your language.' };
    const request = ++operation.current;
    setState({ session, language: code, loading: false });
    const result = await updateMyLanguageSettings({ preferred_language: code }, { userId: viewerId, isCurrent: current }).catch(() => ({ ok: false }));
    if (!current()) return { ok: false, message: 'Your account changed. Try again.' };
    if (result.ok) confirmedLanguage.current = code;
    if (!result.ok && request === operation.current) {
      setState({ session, language: confirmedLanguage.current, loading: false });
    }
    return result;
  }, [session, viewerId, isCurrentSession]);

  const updateAutomaticDubbing = useCallback(async (preference: AutomaticDubbingPreference) => {
    if (!viewerId || preference.userId !== viewerId || !isCurrentSession()) return { ok: false, message: 'Sign in to update your audio preference.' };
    const request = ++automaticOperation.current;
    const current = () => isCurrentSession() && request === automaticOperation.current;
    setAutomaticState({ session, enabled: false, loading: true });
    const ok = await writeAutomaticDubbingPreference(preference, current);
    if (!current()) return { ok: false, message: 'Your account or audio preference changed. Try again.' };
    setAutomaticState({ session, enabled: ok && preference.enabled, loading: false });
    return ok ? { ok: true } : { ok: false, message: 'Automatic audio preference was not saved.' };
  }, [session, viewerId, isCurrentSession]);

  return (
    <LanguagePreferenceContext.Provider value={{ preferredLanguage, loading, updateLanguage, automaticDubbingPreference, automaticDubbingLoading, updateAutomaticDubbing, preferenceSession: session.epoch }}>
      {children}
    </LanguagePreferenceContext.Provider>
  );
}

export function useLanguagePreference() {
  return useContext(LanguagePreferenceContext);
}
