import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { Audio, type AVPlaybackStatus, type AVPlaybackStatusToSet } from 'expo-av';
import { useSession } from '../context/SessionContext.tsx';
import { useLanguagePreference } from '../context/LanguagePreferenceContext.tsx';
import { dubbingAudioSource, subscribeDubbingAuth } from '../services/media/dubbing.ts';
import { dubbingPlaybackLifetime, type DubbingPlaybackLease, type DubbingReleaseOutcome } from '../services/media/dubbingPlaybackLifetime.ts';

export interface DubbingVideoController {
  getStatusAsync(): Promise<AVPlaybackStatus>;
  setStatusAsync(status: AVPlaybackStatusToSet): Promise<AVPlaybackStatus>;
}
export interface DubbingPlaybackOptions {
  assetId: string;
  sourceKey: string;
  enabled: boolean;
  active: boolean;
  controller: DubbingVideoController | null;
  controlSource: { shouldPlay: boolean; isMuted: boolean; volume: number; rate: number };
  languages: readonly string[];
  automaticPreference?: { userId: string; enabled: boolean };
  sessionKey?: string;
}
export interface DubbingPlayback {
  status: 'original' | 'loading' | 'ready' | 'restoring' | 'unavailable';
  language: string | null;
  muteOriginal: boolean;
  selectDubbed(language: string): Promise<void>;
  selectOriginal(): Promise<void>;
  onSourceStatus(status: AVPlaybackStatus): void;
}
type Snapshot = Pick<DubbingPlayback, 'status' | 'language' | 'muteOriginal'> & { key: string };
interface Slot {
  key: string;
  generation: number;
  language: string;
  automatic: boolean;
  controller: DubbingVideoController;
  sound: Audio.Sound;
  abort: AbortController;
  chain: Promise<void>;
  cancelled: boolean;
  ownsMute: boolean;
  lease: DubbingPlaybackLease | null;
  loadAttempted: boolean;
  unloaded: boolean;
  audioStatus: AVPlaybackStatus;
  cleanupUncertain?: boolean;
  heartbeat?: ReturnType<typeof setInterval>;
}

export function useDubbingPlayback(options: DubbingPlaybackOptions): DubbingPlayback {
  const { userId, isAuthed } = useSession();
  const { preferredLanguage } = useLanguagePreference();
  const key = JSON.stringify([options.assetId, options.sourceKey, isAuthed ? userId : null, options.sessionKey]);
  const selectionKey = options.sessionKey ?? key;
  const automaticLanguage = options.automaticPreference?.enabled === true && options.automaticPreference.userId === userId && preferredLanguage && options.languages.includes(preferredLanguage) ? preferredLanguage : null;
  const languagesKey = JSON.stringify(options.languages);
  const latest = useRef({ options, userId, isAuthed, key, selectionKey, automaticLanguage });
  latest.current = { options, userId, isAuthed, key, selectionKey, automaticLanguage };
  const mounted = useRef(true);
  const foreground = useRef(AppState.currentState === 'active');
  const generation = useRef(0);
  const slotRef = useRef<Slot | null>(null);
  const ownedSlot = useRef<Slot | null>(null);
  const lifetime = useRef(dubbingPlaybackLifetime).current;
  useSyncExternalStore(lifetime.subscribe, lifetime.getRevision, lifetime.getRevision);
  const sourceStatus = useRef<{ key: string; status: AVPlaybackStatus } | null>(null);
  const suppressAutomatic = useRef<string | null>(null);
  const automaticAttempt = useRef<string | null>(null);
  const [state, setState] = useState<Snapshot>({ key, status: 'original', language: null, muteOriginal: false });
  const publish = (value: Snapshot) => { if (mounted.current) setState(value); };
  const current = (slot: Slot) => mounted.current && !slot.cancelled && slot.generation === generation.current && slot.key === latest.current.key && latest.current.options.controller === slot.controller && latest.current.options.enabled && latest.current.options.active && foreground.current && latest.current.isAuthed && !!latest.current.userId && latest.current.options.languages.includes(slot.language) && (!slot.automatic || (latest.current.automaticLanguage === slot.language && suppressAutomatic.current !== latest.current.selectionKey));

  const cleanup = async (slot: Slot): Promise<DubbingReleaseOutcome> => {
    await slot.chain.catch(() => {});
    if (slot.cleanupUncertain) return 'native_uncertain';
    if (!slot.unloaded) {
      let paused = !slot.loadAttempted;
      let unloaded = !slot.loadAttempted;
      if (slot.loadAttempted) {
        try {
          const status = await slot.sound.setStatusAsync({ shouldPlay: false, isMuted: true });
          paused = status.isLoaded && !status.isPlaying && status.isMuted === true;
        } catch {}
        try { unloaded = (await slot.sound.unloadAsync()).isLoaded === false; } catch {}
      }
      if (!paused || !unloaded) {
        slot.cleanupUncertain = true;
        return 'native_uncertain';
      }
      slot.unloaded = true;
    }
    if (slot.ownsMute && mounted.current && latest.current.options.controller === slot.controller) {
      const muted = latest.current.options.controlSource.isMuted;
      try {
        await slot.controller.setStatusAsync({ isMuted: muted });
        if (mounted.current && latest.current.options.controller === slot.controller && latest.current.options.controlSource.isMuted !== muted) return 'restoration_failed';
      } catch {
        if (mounted.current && latest.current.options.controller === slot.controller) return 'restoration_failed';
      }
    }
    slot.ownsMute = false;
    return 'released';
  };

  const release = (slot: Slot) => slot.lease!.retire();

  const stop = useCallback(async (status: Snapshot['status'] = 'original') => {
    const captured = ++generation.current;
    const stoppedKey = latest.current.key;
    const slot = slotRef.current ?? ownedSlot.current; slotRef.current = null;
    const ownsMute = !!slot?.ownsMute && slot.controller === latest.current.options.controller;
    publish({ key: stoppedKey, status: ownsMute ? 'restoring' : status, language: null, muteOriginal: ownsMute });
    const outcome = slot ? await release(slot) : 'released';
    if (outcome === 'released' && ownedSlot.current === slot) ownedSlot.current = null;
    if (captured === generation.current && stoppedKey === latest.current.key) publish({ key: stoppedKey, status: outcome === 'released' ? status : 'unavailable', language: null, muteOriginal: outcome !== 'released' && !!slot?.ownsMute && slot.controller === latest.current.options.controller });
  }, []);

  const sync = useCallback((slot: Slot) => {
    const operation = slot.chain.then(async () => {
      if (!current(slot)) return;
      const source = sourceStatus.current;
      if (!source || source.key !== slot.key || !source.status.isLoaded || !slot.audioStatus.isLoaded) throw new Error('source_unavailable');
      const control = latest.current.options.controlSource;
      if (!Number.isFinite(control.volume) || control.volume < 0 || control.volume > 1 || !Number.isFinite(control.rate) || control.rate < 0.5 || control.rate > 2) throw new Error('unsupported_playback');
      const status = source.status;
      if (!Number.isFinite(status.positionMillis) || !status.durationMillis || !slot.audioStatus.durationMillis || Math.abs(status.durationMillis - slot.audioStatus.durationMillis) > 250) throw new Error('duration_mismatch');
      const patch: AVPlaybackStatusToSet = { shouldPlay: control.shouldPlay && status.isPlaying && !status.isBuffering && !status.didJustFinish, isMuted: control.isMuted, volume: control.volume, rate: control.rate, shouldCorrectPitch: true, isLooping: false };
      if (Math.abs(slot.audioStatus.positionMillis - status.positionMillis) > 120) patch.positionMillis = status.positionMillis;
      if (!current(slot)) return;
      slot.audioStatus = await slot.sound.setStatusAsync(patch);
    });
    slot.chain = operation;
    void operation.catch(() => { if (current(slot)) void stop('unavailable'); });
    return operation;
  }, [stop]);

  const startDubbed = useCallback(async (language: string, automatic: boolean) => {
    const allowed = latest.current;
    if (!allowed.options.enabled || !allowed.options.active || !foreground.current || !allowed.userId || !allowed.isAuthed || !allowed.options.controller || !allowed.options.sourceKey || !allowed.options.languages.includes(language) || Platform.OS === 'web') return;
    if (automatic && (allowed.automaticLanguage !== language || suppressAutomatic.current === allowed.selectionKey)) return;
    if (!automatic) suppressAutomatic.current = allowed.selectionKey;
    const stopping = stop();
    const admission = generation.current;
    const admissionKey = allowed.key;
    await stopping;
    const valid = () => mounted.current && admission === generation.current && admissionKey === latest.current.key && latest.current.options.controller === allowed.options.controller && latest.current.options.enabled && latest.current.options.active && foreground.current && latest.current.isAuthed && latest.current.options.languages.includes(language) && (!automatic || (latest.current.automaticLanguage === language && suppressAutomatic.current !== latest.current.selectionKey));
    if (!valid() || !lifetime.canAdmit(allowed.options.controller)) return;
    publish({ key: admissionKey, status: 'loading', language, muteOriginal: false });
    const slot: Slot = { key: admissionKey, generation: admission, language, automatic, controller: allowed.options.controller, sound: new Audio.Sound(), abort: new AbortController(), chain: Promise.resolve(), cancelled: false, ownsMute: false, lease: null, loadAttempted: false, unloaded: false, audioStatus: { isLoaded: false } };
    slot.lease = lifetime.retain({
      controller: slot.controller,
      ownsMute: () => slot.ownsMute,
      cancel: () => {
        slot.cancelled = true; slot.abort.abort(); clearInterval(slot.heartbeat);
        try { slot.sound.setOnPlaybackStatusUpdate(null); } catch {}
      },
      release: () => cleanup(slot),
    });
    if (!slot.lease) return;
    slotRef.current = slot;
    ownedSlot.current = slot;
    const initialize = async () => {
      const source = await dubbingAudioSource({ assetId: allowed.options.assetId, userId: allowed.userId! }, language, slot.abort.signal);
      if (!current(slot)) return;
      slot.loadAttempted = true;
      slot.audioStatus = await slot.sound.loadAsync(source, { shouldPlay: false, isMuted: true, progressUpdateIntervalMillis: 250 }, false);
      if (!current(slot)) return;
      const status = await slot.controller.getStatusAsync();
      if (!current(slot)) return;
      sourceStatus.current = { key: slot.key, status };
      slot.ownsMute = true;
      await slot.controller.setStatusAsync({ isMuted: true });
      if (!current(slot)) return;
      slot.sound.setOnPlaybackStatusUpdate((audioStatus) => {
        slot.audioStatus = audioStatus;
        if (current(slot) && !audioStatus.isLoaded && audioStatus.error) void stop('unavailable');
      });
      publish({ key: slot.key, status: 'ready', language, muteOriginal: true });
      let checking = false;
      slot.heartbeat = setInterval(() => {
        if (!current(slot) || checking) return;
        checking = true;
        void dubbingAudioSource({ assetId: allowed.options.assetId, userId: allowed.userId! }, language, slot.abort.signal)
          .catch(() => { if (current(slot)) void stop('unavailable'); }).finally(() => { checking = false; });
      }, 10_000);
    };
    slot.chain = initialize();
    try { await slot.chain; if (current(slot)) await sync(slot); else await release(slot); }
    catch { if (current(slot)) await stop('unavailable'); else await release(slot); }
  }, [stop, sync]);

  const selectDubbed = useCallback((language: string) => startDubbed(language, false), [startDubbed]);
  const selectOriginal = useCallback(async () => { suppressAutomatic.current = latest.current.selectionKey; await stop(); }, [stop]);
  const onSourceStatus = useCallback((status: AVPlaybackStatus) => {
    if (key !== latest.current.key || options.controller !== latest.current.options.controller) return;
    sourceStatus.current = { key, status };
    const slot = slotRef.current;
    if (slot && slot.ownsMute && current(slot)) void sync(slot).catch(() => {});
  }, [key, options.controller, sync]);

  useLayoutEffect(() => {
    mounted.current = true; sourceStatus.current = null; void stop();
    return () => { mounted.current = false; void stop(); };
  }, [key, options.controller, options.enabled, options.active, stop]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { foreground.current = state === 'active'; if (!foreground.current) void stop(); });
    const unsubscribe = subscribeDubbingAuth(() => { void stop(); });
    return () => { subscription.remove(); unsubscribe(); };
  }, [stop]);
  useEffect(() => {
    const slot = slotRef.current;
    if (slot?.ownsMute && current(slot)) void sync(slot).catch(() => {});
  }, [options.controlSource.shouldPlay, options.controlSource.isMuted, options.controlSource.volume, options.controlSource.rate, sync]);
  useEffect(() => {
    const slot = slotRef.current;
    if (slot && (!options.languages.includes(slot.language) || (slot.automatic && slot.language !== automaticLanguage))) void stop();
    if (!automaticLanguage) { automaticAttempt.current = null; return; }
    if (!options.enabled || !options.active || !options.controller || !foreground.current || suppressAutomatic.current === selectionKey) return;
    const attempt = JSON.stringify([key, automaticLanguage]);
    if (automaticAttempt.current === attempt || (slot && current(slot))) return;
    automaticAttempt.current = attempt;
    void startDubbed(automaticLanguage, true);
  }, [key, selectionKey, automaticLanguage, options.enabled, options.active, options.controller, languagesKey, startDubbed, stop]);
  const retained = lifetime.inspect(options.controller);
  const ownsMute = retained.ownsMute || (!!slotRef.current?.ownsMute && slotRef.current.controller === options.controller);
  const visible = !slotRef.current && retained.blocked
    ? { status: retained.pending && retained.ownsMute ? 'restoring' as const : 'unavailable' as const, language: null, muteOriginal: retained.ownsMute }
    : state.key === key ? { ...state, muteOriginal: ownsMute } : { status: ownsMute ? 'restoring' as const : 'original' as const, language: null, muteOriginal: ownsMute };
  return { ...visible, selectDubbed, selectOriginal, onSourceStatus };
}
