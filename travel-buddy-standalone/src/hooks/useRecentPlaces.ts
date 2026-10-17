/**
 * useRecentPlaces — fetch and save recent place selections for the authed user.
 * Falls back to a module-level in-memory list if the user is not authed or
 * the server is unavailable.
 */
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import type { Place } from '../lib/location/placeTypes.ts';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import {
  ANONYMOUS_VIEWER, currentDiscoveryScope, isCurrentDiscoveryScope, onDiscoveryScopeChange,
} from '../services/discoveryViewerScope.ts';
import {
  captureMessagingOwnerRequest, messagingOwnerToken, type MessagingOwnerRequest,
} from '../services/messagingOwnerRequest.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

type RecentContext = { owner: MessagingOwnerRequest | null; isCurrent: () => boolean };
type RecentCache = { context: RecentContext; places: Place[] };
const emptyPlaces: Place[] = [];
let localCache: RecentCache | null = null;
let cacheRevision = 0;
let anonymousObserved = false;
let anonymousRevision = 0;
let authObserved = false;
const cacheListeners = new Set<() => void>();
const lifetimeListeners = new Set<() => void>();

function captureContext(): RecentContext | null {
  const owner = captureMessagingOwnerRequest();
  if (owner) return { owner, isCurrent: owner.isCurrent };
  const scope = currentDiscoveryScope();
  if (!anonymousObserved || scope.viewer !== ANONYMOUS_VIEWER) return null;
  const revision = anonymousRevision;
  return { owner: null, isCurrent: () => anonymousObserved && anonymousRevision === revision && isCurrentDiscoveryScope(scope) };
}

function readCache(): Place[] {
  return localCache?.context.isCurrent() ? localCache.places : emptyPlaces;
}

function publishCache(next: RecentCache | null): void {
  localCache = next;
  cacheRevision += 1;
  for (const listener of cacheListeners) listener();
}

function subscribeCache(listener: () => void): () => void {
  cacheListeners.add(listener);
  return () => { cacheListeners.delete(listener); };
}

function reconcileLifetime(): void {
  if (localCache && !localCache.context.isCurrent()) publishCache(null);
  for (const listener of lifetimeListeners) listener();
}

onDiscoveryScopeChange(() => {
  if (currentDiscoveryScope().viewer !== ANONYMOUS_VIEWER) {
    anonymousObserved = false;
    anonymousRevision += 1;
  }
  reconcileLifetime();
});

if (isSupabaseConfigured) {
  try {
    supabase.auth.onAuthStateChange((event, session) => {
      if (event !== 'INITIAL_SESSION' || !authObserved) {
        authObserved = true;
        const anonymous = event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && session === null);
        if (anonymous !== anonymousObserved || event === 'SIGNED_OUT') anonymousRevision += 1;
        anonymousObserved = anonymous;
      }
      queueMicrotask(reconcileLifetime);
    });
  } catch {}
}

export function useRecentPlaces() {
  const recents = useSyncExternalStore(subscribeCache, readCache, readCache);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(false);
  const readGeneration = useRef(0);
  const lifetime = useRef<RecentContext | null>(null);
  const pending = useRef(new Set<() => void>());

  const load = useCallback(async () => {
    if (!mounted.current) return;
    const generation = ++readGeneration.current;
    const context = captureContext();
    lifetime.current = context;
    if (!context?.owner) { setLoading(false); return; }
    const attempt = captureMessagingOwnerRequest();
    if (!attempt || attempt.ownerId !== context.owner.ownerId || attempt.sessionId !== context.owner.sessionId) {
      attempt?.invalidate();
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const cancel = () => { controller.abort(); attempt.invalidate(); };
    pending.current.add(cancel);
    const revision = cacheRevision;
    const isCurrent = () => mounted.current && generation === readGeneration.current && context.isCurrent() && !controller.signal.aborted;
    setLoading(true);
    try {
      const token = await messagingOwnerToken(attempt);
      if (!token || !isCurrent()) return;
      const res = await fetch(`${apiBase()}/api/me/recent-places`, {
        headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      });
      if (!isCurrent() || !res.ok) return;
      const body = await res.json();
      if (!isCurrent() || revision !== cacheRevision) return;
      const places: Place[] = (body.places ?? []);
      if (Array.isArray(places)) publishCache({ context, places });
    } catch {} finally {
      pending.current.delete(cancel);
      attempt.invalidate();
      if (mounted.current && generation === readGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let waitingForObservation = captureContext() === null;
    const changed = () => {
      if (lifetime.current?.isCurrent()) return;
      readGeneration.current += 1;
      for (const cancel of pending.current) cancel();
      setLoading(false);
      lifetime.current = captureContext();
      if (waitingForObservation && lifetime.current) {
        waitingForObservation = false;
        void load();
      }
    };
    lifetimeListeners.add(changed);
    void load();
    return () => {
      mounted.current = false;
      readGeneration.current += 1;
      lifetimeListeners.delete(changed);
      for (const cancel of pending.current) cancel();
    };
  }, [load]);

  const saveRecent = useCallback(async (place: Place, usedFor?: string) => {
    if (!mounted.current) return;
    const context = captureContext();
    if (!context) return;
    lifetime.current = context;
    const places = [place, ...readCache().filter(item => item.id !== place.id)].slice(0, 10);
    publishCache({ context, places });
    if (!context.owner) return;
    const attempt = captureMessagingOwnerRequest();
    if (!attempt || attempt.ownerId !== context.owner.ownerId || attempt.sessionId !== context.owner.sessionId) {
      attempt?.invalidate();
      return;
    }
    const controller = new AbortController();
    const cancel = () => { controller.abort(); attempt.invalidate(); };
    pending.current.add(cancel);
    const isCurrent = () => mounted.current && context.isCurrent() && !controller.signal.aborted;
    try {
      const token = await messagingOwnerToken(attempt);
      if (!token || !isCurrent()) return;
      await fetch(`${apiBase()}/api/me/recent-places`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ place, usedFor }),
        signal: controller.signal,
      });
    } catch {} finally {
      pending.current.delete(cancel);
      attempt.invalidate();
    }
  }, []);

  return { recents, loading, saveRecent, reload: load };
}
