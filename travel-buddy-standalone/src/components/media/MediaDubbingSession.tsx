import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../context/SessionContext.tsx';
import { useFeatureFlags } from '../../context/FeatureFlagsContext.tsx';
import { useLanguagePreference } from '../../context/LanguagePreferenceContext.tsx';
import { useDubbingPlayback, type DubbingVideoController } from '../../hooks/useDubbingPlayback.ts';
import { DUBBING_LABEL, getDubbingOptions, subscribeDubbingAuth, type DubbingOptions } from '../../services/media/dubbing.ts';
import { resolveCaptionSource } from '../../services/media/captions.ts';
import { MediaDubbingControls } from './MediaDubbingControls.tsx';
import { MediaDubbingManagementEntry } from './MediaDubbingManagementEntry.tsx';

export function useMediaDubbingSession(input: {
  source: string; active: boolean; controller: DubbingVideoController | null;
  controlSource: { shouldPlay: boolean; isMuted: boolean; volume: number; rate: number };
}) {
  const { userId, isAuthed } = useSession();
  const { isEnabled } = useFeatureFlags();
  const { automaticDubbingPreference, automaticDubbingLoading, updateAutomaticDubbing, preferenceSession } = useLanguagePreference();
  const [revision, setRevision] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const enabled = Platform.OS !== 'web' && isAuthed && !!userId && isEnabled('media_dubbing_enabled') && isEnabled('media_captions_enabled');
  const identity = JSON.stringify([input.source, isAuthed ? userId : null, revision, preferenceSession]);
  const selectionIdentity = JSON.stringify([input.source, isAuthed ? userId : null, preferenceSession]);
  const [stored, setStored] = useState<{ identity: string; value: DubbingOptions } | null>(null);
  const latest = useRef(identity); latest.current = identity;
  const inflight = useRef<AbortController | null>(null);
  const invalidate = useCallback(() => {
    inflight.current?.abort(); setStored(null); setRevision(value => value + 1);
  }, []);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') invalidate();
      setForeground(state === 'active');
    });
    const unsubscribe = subscribeDubbingAuth(invalidate);
    return () => { listener.remove(); unsubscribe(); };
  }, [invalidate]);
  useEffect(() => {
    setStored(null);
    if (!enabled || !input.active || !foreground || !userId) return;
    const controller = new AbortController();
    inflight.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (controller.signal.aborted) return;
      const timeout = new AbortController();
      let deadline: ReturnType<typeof setTimeout>;
      const abort = () => { timeout.abort(); clearTimeout(deadline); };
      controller.signal.addEventListener('abort', abort, { once: true });
      deadline = setTimeout(() => { timeout.abort(); if (latest.current === identity) setStored(null); }, 10_000);
      try {
        const source = await resolveCaptionSource(input.source, timeout.signal);
        if (timeout.signal.aborted || controller.signal.aborted || latest.current !== identity) return;
        const value = await getDubbingOptions({ assetId: source.assetId, userId: userId! }, timeout.signal);
        if (value.sourceVersion !== source.version) throw new Error('stale_source');
        if (!timeout.signal.aborted && !controller.signal.aborted && latest.current === identity) setStored({ identity, value });
      } catch { if (!controller.signal.aborted && latest.current === identity) setStored(null); }
      finally {
        clearTimeout(deadline); controller.signal.removeEventListener('abort', abort);
        if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 5000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); if (inflight.current === controller) inflight.current = null; };
  }, [identity, enabled, input.active, input.source, foreground, userId]);
  const options = stored?.identity === identity && enabled && input.active && foreground ? stored.value : null;
  const playback = useDubbingPlayback({
    assetId: options?.assetId ?? '', sourceKey: options?.sourceKey ?? identity,
    enabled: enabled && options?.enabled === true, active: input.active && foreground,
    controller: input.controller, controlSource: input.controlSource,
    languages: options?.languages.filter(language => language.ready).map(language => language.code) ?? [],
    automaticPreference: automaticDubbingPreference,
    sessionKey: selectionIdentity,
  });
  return { options, playback, userId, enabled, invalidate, source: input.source, active: input.active && foreground,
    automaticDubbingPreference, automaticDubbingLoading, updateAutomaticDubbing };
}

export function MediaDubbingSession({ session }: { session: ReturnType<typeof useMediaDubbingSession> }) {
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const { options, playback, userId, enabled } = session;
  const panelIdentity = JSON.stringify([session.source, options?.sourceKey, userId]);
  const hasOptions = !!options && (options.canEdit || options.languages.some(language => language.ready));
  const showPreferences = !!userId && session.active && (enabled || session.automaticDubbingPreference?.enabled === true);
  const playingLabel = playback.status === 'ready' ? `${DUBBING_LABEL}: ${options?.languages.find(language => language.code === playback.language)?.label ?? playback.language}` : null;
  useEffect(() => { setOpenedFor(null); }, [panelIdentity]);
  const recovery = !hasOptions ? <>
    <MediaDubbingManagementEntry source={session.source} active={session.active} onWithdrawn={session.invalidate} />
    {playback.muteOriginal ? <View style={styles.recovery}>
    <Text style={styles.text} accessibilityLiveRegion="polite">Audio cleanup or restoration is incomplete. Stop playback; if retry cannot recover, restart the app before retrying AI audio.</Text>
    <Pressable style={styles.retry} accessibilityRole="button" accessibilityLabel="Retry original audio" onPress={() => { void playback.selectOriginal(); }}><Text style={styles.text}>Retry original audio</Text></Pressable>
    </View> : null}
  </> : null;
  if (!hasOptions && !showPreferences) return recovery;
  return <>
    {recovery}
    <Pressable style={styles.open} accessibilityRole="button" accessibilityLabel="Audio language options" accessibilityValue={playingLabel ? { text: playingLabel } : undefined} onPress={() => setOpenedFor(panelIdentity)}><Text style={styles.text} accessibilityLiveRegion="polite">{playingLabel ?? 'Audio language'}</Text></Pressable>
    <Modal visible={openedFor !== null && openedFor === panelIdentity} transparent animationType="slide" onRequestClose={() => setOpenedFor(null)}>
      <View style={styles.shade}><ScrollView style={styles.sheet}>
        <Pressable style={styles.close} accessibilityRole="button" accessibilityLabel="Close audio language options" onPress={() => setOpenedFor(null)}><Text style={styles.text}>Close</Text></Pressable>
        <MediaDubbingControls assetId={options?.assetId ?? ''} sourceKey={options?.sourceKey ?? session.source} ownerId={options?.canEdit ? userId ?? '' : ''}
          automaticPreference={session.automaticDubbingPreference} automaticPreferenceLoading={session.automaticDubbingLoading}
          onAutomaticPreferenceChange={async preference => {
            const result = await session.updateAutomaticDubbing(preference);
            if (!result.ok) throw new Error(result.message ?? 'Automatic audio preference was not saved.');
          }}
          enabled={enabled && options?.enabled === true} languages={options?.languages ?? []} disclosure={options?.disclosure} playback={playback} />
      </ScrollView></View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  open: { position: 'absolute', left: 12, bottom: 12, backgroundColor: '#111', minHeight: 44, padding: 12, borderRadius: 6 },
  recovery: { position: 'absolute', left: 12, right: 12, bottom: 12, backgroundColor: '#111', padding: 12, borderRadius: 6 },
  retry: { minHeight: 44, justifyContent: 'center' },
  text: { color: '#fff', fontSize: 14 },
  shade: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#0008', paddingTop: 64 },
  sheet: { flexGrow: 0, backgroundColor: '#fff', padding: 16, maxHeight: '85%' },
  close: { alignSelf: 'flex-end', backgroundColor: '#111', minHeight: 44, padding: 12, marginBottom: 12 },
});
