/**
 * useIntelPrompts — the single authority for "may I show a capture prompt?".
 *
 * Combines the three suppression axes the spec requires, in priority order:
 *   1. Feature flags  — `intel_capture_quick_signal` (and the read/Trail flags),
 *      seeded OFF. With the flag off, `captureEnabled` is false and every entry
 *      point hides: the whole surface is an inert no-op.
 *   2. Safe Return / emergency — never prompt while an emergency is active.
 *   3. Prompt-pause  — per session / per category / permanent, chosen by the
 *      traveler in settings.
 *
 * `canPrompt(category?)` folds all three into one boolean a screen calls before
 * rendering any prompt. The pause setters persist through `promptPauseStorage`
 * and update local state optimistically.
 *
 * The chips read path and the Trail path have their own flags exposed here too
 * (`liveLabelEnabled`, `trailEnabled`) so a caller can gate those independently.
 */
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';
import { useSafeReturnActive } from './useSafeReturnActive.ts';
import { INTEL_FLAGS, type VenueCategory } from '../lib/intel/contracts.ts';
import { resolveConflictReask, type ConflictReask, type ConflictReaskCandidate } from '../lib/intel/conflict.ts';
import {
  cachedPromptPause,
  loadPromptPause,
  savePromptPause,
  setCategoryPaused,
  setSessionPaused,
  isSessionPaused,
  isPromptPaused,
  clearPromptPause,
  type PersistedPromptPause,
} from '../lib/intel/promptPauseStorage.ts';
import {
  cachedThrottle,
  loadPromptThrottle,
  isSubjectThrottled,
  recordPromptShown as recordThrottle,
  type PromptThrottleMap,
} from '../lib/intel/promptThrottleStorage.ts';
import { checkPromptEligibility, type PromptEligibility } from '../services/intelPrompts.ts';

export type SuppressReason = 'disabled' | 'safe_return' | 'paused' | 'throttled' | null;

export interface UseIntelPromptsResult {
  /** intel_capture_quick_signal — the master capture flag. */
  captureEnabled: boolean;
  /** intel_live_label_crowd — gates the place-card decision-exposure chips. */
  liveLabelEnabled: boolean;
  /** intel_trail_followup — gates the Trail "where next?" + exit sheet. */
  trailEnabled: boolean;
  /** True while an emergency / Safe Return session is active. */
  safeReturnActive: boolean;
  /** Durable pause state (permanent + per-category). */
  pauseState: PersistedPromptPause;
  /** In-memory per-session pause. */
  sessionPaused: boolean;
  /** May a capture prompt be shown now for this (optional) venue category? */
  canPrompt: (category?: VenueCategory | 'general') => boolean;
  /** Why a prompt is suppressed for this category (or null if it is allowed). */
  suppressReason: (category?: VenueCategory | 'general') => SuppressReason;
  /**
   * May an UNSOLICITED prompt be shown for a specific subject now? Folds the
   * category gates with the local 45-minute per-subject throttle (spec §6). Call
   * `recordPrompt(subjectId)` when a prompt is actually shown so the window starts.
   */
  canPromptForSubject: (subjectId: string, category?: VenueCategory | 'general') => boolean;
  /** Record that an unsolicited prompt was shown for a subject (starts the 45-min window). */
  recordPrompt: (subjectId: string) => void;
  /**
   * Ask the SERVER whether a prompt is eligible (throttle + fresh-evidence, spec §6).
   * Returns null when the API is unavailable — the caller then relies on the local
   * gates. Never overrides a local suppression: a local 'no' stays 'no'.
   */
  checkServerEligibility: (subjectId: string, opts?: { followupRequired?: boolean }) => Promise<PromptEligibility | null>;
  /**
   * §10 contradiction-resolution opportunity. Given the claims served for the
   * subject the viewer is at, the re-ask to offer (same claim family, reason
   * 'conflict') — or null when no claim is in material conflict, the family is
   * not re-askable, or a prompt may not be shown at all (`canPrompt(category)`:
   * flag off / Safe Return / paused — the same suppression every prompt obeys).
   */
  conflictReask: (
    claims: ReadonlyArray<ConflictReaskCandidate>,
    category?: VenueCategory | 'general',
  ) => ConflictReask | null;
  pauseSession: () => void;
  resumeSession: () => void;
  pauseCategory: (category: VenueCategory | 'general', paused: boolean) => void;
  pauseAll: (paused: boolean) => void;
  resumeEverything: () => void;
}

export function useIntelPrompts(): UseIntelPromptsResult {
  const { isEnabled } = useFeatureFlags();

  const captureEnabled = isEnabled(INTEL_FLAGS.quickSignal);
  const liveLabelEnabled = isEnabled(INTEL_FLAGS.liveLabelCrowd);
  const trailEnabled = isEnabled(INTEL_FLAGS.trailFollowup);

  // Only consult Safe Return when some intel surface is actually live — with
  // every flag off, mounting a place page must not touch the Safe Return API.
  const { active: safeReturnActive } = useSafeReturnActive(captureEnabled || liveLabelEnabled || trailEnabled);

  const [pauseState, setPauseState] = useState<PersistedPromptPause>(() => cachedPromptPause());
  const [sessionPaused, setSessionPausedState] = useState<boolean>(() => isSessionPaused());
  const [throttle, setThrottle] = useState<PromptThrottleMap>(() => cachedThrottle());

  useEffect(() => {
    let alive = true;
    loadPromptPause(AsyncStorage).then((s) => {
      if (alive) setPauseState(s);
    });
    loadPromptThrottle(AsyncStorage).then((t) => {
      if (alive) setThrottle(t);
    });
    return () => {
      alive = false;
    };
  }, []);

  const suppressReason = useCallback(
    (category?: VenueCategory | 'general'): SuppressReason => {
      if (!captureEnabled) return 'disabled';
      if (safeReturnActive) return 'safe_return';
      if (isPromptPaused(pauseState, category)) return 'paused';
      return null;
    },
    [captureEnabled, safeReturnActive, pauseState],
  );

  const canPrompt = useCallback(
    (category?: VenueCategory | 'general') => suppressReason(category) === null,
    [suppressReason],
  );

  const canPromptForSubject = useCallback(
    (subjectId: string, category?: VenueCategory | 'general') => {
      if (suppressReason(category) !== null) return false;      // flags / Safe Return / pause
      if (isSubjectThrottled(throttle, subjectId)) return false; // §6 45-minute window
      return true;
    },
    [suppressReason, throttle],
  );

  const recordPrompt = useCallback((subjectId: string) => {
    setThrottle(recordThrottle(AsyncStorage, subjectId));
  }, []);

  const checkServerEligibility = useCallback(
    async (subjectId: string, opts?: { followupRequired?: boolean }) => {
      // A local suppression is authoritative — never round-trip past it.
      if (!canPromptForSubject(subjectId)) return { prompt: false, reason: 'paused', throttleWindowMs: 45 * 60_000 } as PromptEligibility;
      return checkPromptEligibility(subjectId, opts);
    },
    [canPromptForSubject],
  );

  const conflictReask = useCallback(
    (claims: ReadonlyArray<ConflictReaskCandidate>, category?: VenueCategory | 'general') =>
      resolveConflictReask(claims, canPrompt(category)),
    [canPrompt],
  );

  const pauseSession = useCallback(() => {
    setSessionPaused(true);
    setSessionPausedState(true);
  }, []);
  const resumeSession = useCallback(() => {
    setSessionPaused(false);
    setSessionPausedState(false);
  }, []);

  const pauseCategory = useCallback((category: VenueCategory | 'general', paused: boolean) => {
    setPauseState((prev) => {
      const next = setCategoryPaused(prev, category, paused);
      savePromptPause(AsyncStorage, next);
      return next;
    });
  }, []);

  const pauseAll = useCallback((paused: boolean) => {
    setPauseState((prev) => {
      const next = { ...prev, pausedAll: paused };
      savePromptPause(AsyncStorage, next);
      return next;
    });
  }, []);

  const resumeEverything = useCallback(() => {
    clearPromptPause(AsyncStorage).finally(() => {
      setPauseState(cachedPromptPause());
      setSessionPausedState(false);
    });
  }, []);

  return {
    captureEnabled,
    liveLabelEnabled,
    trailEnabled,
    safeReturnActive,
    pauseState,
    sessionPaused,
    canPrompt,
    suppressReason,
    canPromptForSubject,
    recordPrompt,
    checkServerEligibility,
    conflictReask,
    pauseSession,
    resumeSession,
    pauseCategory,
    pauseAll,
    resumeEverything,
  };
}
