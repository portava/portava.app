import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { Video, ResizeMode, type AVPlaybackStatus } from 'expo-av';
import { useFocusEffect } from 'expo-router';
import { useSession } from '../../context/SessionContext.tsx';
import { supabase } from '../../lib/supabase.ts';
import { color, radius, space, type as typography } from '../../theme/tokens.ts';
import {
  createMemoryVideoSegment, deleteMemoryVideoSegment, listMemoryVideoSegments, newVideoSegmentOperationId,
  resolveMemoryVideoOriginal, sameVideoSegmentSource,
  type MemoryVideoSegment, type VideoSegmentFailureKind, type VideoSegmentList, type VideoSegmentScope, type VideoSegmentSource,
} from '../../services/memoryVideoSegments.ts';

export interface MemoryVideoSegmentsProps extends VideoSegmentScope {
  uri: string;
  style?: StyleProp<ViewStyle>;
}

const messages: Record<VideoSegmentFailureKind, string> = {
  feature_disabled: 'Video segments are not available yet. You can still play the original.',
  degraded_unavailable: 'Segments are temporarily unavailable. You can still try the original.',
  not_found: 'This video is no longer available.',
  unauthenticated: 'Sign in again to view this video.',
  forbidden: 'This video is no longer available.',
  conflict: 'The video or segment changed. Refresh before trying again.',
  invalid_payload: 'Choose a start and end within the video, with end after start.',
  network_unreachable: 'Could not connect. Refresh to try again.',
  cancelled: 'Request cancelled. Refresh to try again.',
};

function milliseconds(value: string): number | null {
  if (!/^\d+(?:\.\d{1,3})?$/.test(value.trim())) return null;
  const amount = Math.round(Number(value.trim()) * 1000);
  return Number.isSafeInteger(amount) && amount <= 2147483647 ? amount : null;
}

function seconds(value: number): string { return String(value / 1000); }

function isDenied(kind: VideoSegmentFailureKind): boolean {
  return kind === 'not_found' || kind === 'forbidden' || kind === 'unauthenticated';
}

function allowsOriginal(kind: VideoSegmentFailureKind): boolean {
  return kind === 'feature_disabled' || kind === 'degraded_unavailable';
}

function sameOriginal(left: VideoSegmentSource, right: VideoSegmentSource): boolean {
  return sameVideoSegmentSource(left, right) && left.mediaRef === right.mediaRef;
}

interface PlaybackLease {
  generation: number;
  source: VideoSegmentSource | null;
  mediaRef: string;
  segment: MemoryVideoSegment | null;
  video: Video;
  expiresAt: number;
}

export function MemoryVideoSegments(props: MemoryVideoSegmentsProps) {
  const { userId } = useSession();
  if (!userId || userId !== props.ownerId) return null;
  return <OwnerVideoSegments key={`${userId}:${props.memoryId}:${props.itemId}:${props.uri}`} {...props} />;
}

function OwnerVideoSegments({ ownerId, memoryId, itemId, uri, style }: MemoryVideoSegmentsProps) {
  const scope = useMemo(() => ({ ownerId, memoryId, itemId }), [ownerId, memoryId, itemId]);
  const player = useRef<Video | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const focused = useRef(false);
  const foreground = useRef(AppState.currentState === null || AppState.currentState === 'active');
  const accountValid = useRef(true);
  const busyRef = useRef(false);
  const snapshotRef = useRef<VideoSegmentList | null>(null);
  const range = useRef<MemoryVideoSegment | null>(null);
  const operationId = useRef<string | null>(null);
  const epoch = useRef(0);
  const actionSequence = useRef(0);
  const playbackGeneration = useRef(0);
  const playback = useRef<PlaybackLease | null>(null);
  const [snapshot, setSnapshot] = useState<VideoSegmentList | null>(null);
  const [busy, setBusy] = useState(true);
  const [available, setAvailable] = useState(true);
  const [playerEpoch, setPlayerEpoch] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewing, setPreviewing] = useState(0);
  const [message, setMessage] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [label, setLabel] = useState('');

  const replacePlayer = useCallback(() => { epoch.current += 1; setPlayerEpoch(epoch.current); }, []);

  const current = useCallback((controller: AbortController) => (
    lifecycle.current === controller && !controller.signal.aborted && accountValid.current && focused.current && foreground.current
  ), []);

  const stop = useCallback(() => {
    playbackGeneration.current += 1;
    playback.current = null;
    range.current = null;
    setPreviewing(0);
    setPlaying(false);
    const video = player.current;
    if (video) void video.pauseAsync().catch(() => undefined);
  }, []);

  const resetDraft = useCallback(() => {
    operationId.current = null;
    setStart(''); setEnd(''); setLabel('');
  }, []);

  const clear = useCallback(() => {
    actionSequence.current += 1;
    lifecycle.current?.abort();
    lifecycle.current = null;
    busyRef.current = false;
    stop();
    const video = player.current;
    if (video) void video.unloadAsync().catch(() => undefined);
    snapshotRef.current = null;
    setSnapshot(null);
    setBusy(false);
    setAvailable(false);
    resetDraft();
  }, [resetDraft, stop]);

  const adopt = useCallback((next: VideoSegmentList) => {
    if (snapshotRef.current && !sameOriginal(snapshotRef.current.source, next.source)) {
      stop(); resetDraft();
      replacePlayer();
    }
    if (range.current && !next.segments.some(segment => segment.id === range.current?.id)) stop();
    snapshotRef.current = next;
    setSnapshot(next);
  }, [replacePlayer, resetDraft, stop]);

  const refuse = useCallback((kind: VideoSegmentFailureKind) => {
    stop();
    snapshotRef.current = null;
    setSnapshot(null);
    setMessage(messages[kind]);
    if (isDenied(kind)) {
      setAvailable(false);
      const video = player.current;
      if (video) void video.unloadAsync().catch(() => undefined);
      resetDraft();
    }
  }, [resetDraft, stop]);

  const refresh = useCallback(() => {
    clear();
    if (!accountValid.current || !focused.current || !foreground.current) return;
    const controller = new AbortController();
    lifecycle.current = controller;
    replacePlayer();
    setAvailable(true);
    setBusy(true); busyRef.current = true;
    setMessage('');
    void listMemoryVideoSegments(scope, controller.signal).then(result => {
      if (!current(controller)) return;
      if (result.ok) adopt(result); else refuse(result.kind);
      busyRef.current = false; setBusy(false);
    });
  }, [adopt, clear, current, refuse, replacePlayer, scope]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    refresh();
    return () => { focused.current = false; clear(); };
  }, [clear, refresh]));

  useEffect(() => {
    const state = AppState.addEventListener('change', next => {
      foreground.current = next === 'active';
      if (foreground.current) refresh(); else clear();
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || session?.user.id !== ownerId) {
        accountValid.current = event !== 'SIGNED_OUT' && session?.user.id === ownerId;
        clear();
        if (accountValid.current) refresh();
      }
    });
    return () => { state.remove(); subscription.unsubscribe(); };
  }, [clear, ownerId, refresh]);

  const run = async (work: (controller: AbortController) => Promise<void>) => {
    const controller = lifecycle.current;
    if (!controller || !current(controller) || busyRef.current) return;
    actionSequence.current += 1;
    const sequence = actionSequence.current;
    busyRef.current = true; setBusy(true); setMessage('');
    stop();
    try { await work(controller); } catch {
      if (current(controller) && sequence === actionSequence.current) { stop(); setMessage('Video could not be played. Refresh to try again.'); }
    } finally {
      if (current(controller) && sequence === actionSequence.current) { busyRef.current = false; setBusy(false); }
    }
  };

  const play = (selected?: MemoryVideoSegment) => run(async controller => {
    const generation = playbackGeneration.current;
    const active = () => current(controller) && playbackGeneration.current === generation;
    const latest = await listMemoryVideoSegments(scope, controller.signal);
    if (!active()) return;
    if (!latest.ok) {
      if (selected || !allowsOriginal(latest.kind)) { refuse(latest.kind); return; }
      snapshotRef.current = null;
      setSnapshot(null);
      setMessage(messages[latest.kind]);
    } else {
      adopt(latest);
      if (selected && (!sameVideoSegmentSource(selected, latest.source)
        || !latest.segments.some(segment => segment.id === selected.id))) {
        setMessage(messages.conflict); return;
      }
    }
    if (!active()) { setMessage(messages.conflict); return; }
    const mediaRef = latest.ok ? latest.source.mediaRef : uri;
    const signed = await resolveMemoryVideoOriginal(scope, mediaRef, controller.signal);
    if (!active()) return;
    if (!signed.ok) { refuse(signed.kind); return; }
    const rechecked = await listMemoryVideoSegments(scope, controller.signal);
    if (!active()) return;
    if (latest.ok) {
      if (!rechecked.ok) { refuse(rechecked.kind); return; }
      if (!sameOriginal(latest.source, rechecked.source)
        || (selected && !rechecked.segments.some(segment => segment.id === selected.id))) {
        refuse('conflict'); return;
      }
      adopt(rechecked);
    } else if (rechecked.ok || !allowsOriginal(rechecked.kind)) {
      refuse(rechecked.ok ? 'conflict' : rechecked.kind); return;
    }
    const video = player.current;
    if (!video || !active()) return;
    const lease: PlaybackLease = {
      generation, source: latest.ok ? latest.source : null, mediaRef, segment: selected ?? null, video, expiresAt: Date.now() + 15000,
    };
    playback.current = lease;
    range.current = selected ?? null;
    setPreviewing(generation);
    const authorized = () => {
      if (active() && playback.current === lease && player.current === video && Date.now() < lease.expiresAt) return true;
      if (active()) refuse('network_unreachable');
      void video.pauseAsync().catch(() => undefined);
      void video.unloadAsync().catch(() => undefined);
      return false;
    };
    await video.unloadAsync();
    if (!authorized()) return;
    if (!isLoadablePlaybackUri(signed.uri)) { refuse('degraded_unavailable'); return; } await video.loadAsync({ uri: signed.uri }, { shouldPlay: false, isLooping: false, progressUpdateIntervalMillis: 50 }); // 2026-10-24: the one playback rule
    if (!authorized()) return;
    await video.setPositionAsync(selected?.startMs ?? 0, { toleranceMillisBefore: 0, toleranceMillisAfter: 0 });
    if (!authorized()) return;
    await video.playAsync();
    authorized();
  });

  useEffect(() => {
    if (!previewing) return;
    const controller = lifecycle.current;
    const playbackLease = playback.current;
    if (!controller || !playbackLease || playbackLease.generation !== previewing) return;
    const active = () => current(controller) && playback.current === playbackLease && playbackGeneration.current === previewing;
    let pending = false;
    const expire = () => {
      if (active()) refuse('network_unreachable');
    };
    let lease = setTimeout(expire, Math.max(0, playbackLease.expiresAt - Date.now()));
    const recheck = async () => {
      try {
        const result = await listMemoryVideoSegments(scope, controller.signal);
        if (!active()) return;
        if (playbackLease.source) {
          if (!result.ok) { refuse(result.kind); return; }
          if (!sameOriginal(playbackLease.source, result.source)
            || (playbackLease.segment && !result.segments.some(segment => segment.id === playbackLease.segment?.id))) {
            refuse('conflict'); return;
          }
        } else {
          if (result.ok || !allowsOriginal(result.kind)) { refuse(result.ok ? 'conflict' : result.kind); return; }
          const signed = await resolveMemoryVideoOriginal(scope, playbackLease.mediaRef, controller.signal);
          if (!active()) return;
          if (!signed.ok) { refuse(signed.kind); return; }
        }
        if (Date.now() >= playbackLease.expiresAt) { expire(); return; }
        playbackLease.expiresAt = Date.now() + 15000;
        clearTimeout(lease);
        lease = setTimeout(expire, 15000);
      } catch {
        if (active()) refuse('network_unreachable');
      } finally { pending = false; }
    };
    const timer = setInterval(() => {
      if (!active() || pending || busyRef.current) return;
      pending = true;
      void recheck();
    }, 5000);
    return () => { clearInterval(timer); clearTimeout(lease); };
  }, [current, previewing, refuse, scope]);

  const status = (next: AVPlaybackStatus) => {
    const controller = lifecycle.current;
    if (!controller || !current(controller) || epoch.current !== playerEpoch) return;
    const lease = playback.current;
    if (!lease || lease.generation !== previewing || lease.generation !== playbackGeneration.current || lease.video !== player.current) {
      if (!lease && next.isLoaded && next.isPlaying) void player.current?.pauseAsync().catch(() => undefined);
      return;
    }
    if (Date.now() >= lease.expiresAt) { refuse('network_unreachable'); return; }
    if (!next.isLoaded) {
      if (next.error) { stop(); setMessage('Video could not be played. Refresh to try again.'); }
      return;
    }
    const selected = range.current;
    if (selected && (next.positionMillis >= selected.endMs || next.didJustFinish)) {
      stop();
      void player.current?.setStatusAsync({ shouldPlay: false, positionMillis: selected.endMs }).catch(() => undefined);
      return;
    }
    if (next.didJustFinish) { stop(); return; }
    setPlaying(next.isPlaying);
  };

  const save = () => {
    const source = snapshotRef.current?.source;
    const startMs = milliseconds(start);
    const endMs = milliseconds(end);
    if (!source || startMs === null || endMs === null || startMs >= endMs || endMs > source.durationMs || label.trim().length > 160) {
      setMessage(messages.invalid_payload); return;
    }
    const id = operationId.current ?? newVideoSegmentOperationId();
    operationId.current = id;
    void run(async controller => {
      const created = await createMemoryVideoSegment(scope, source, {
        operationId: id, assetId: source.assetId, assetVersion: source.assetVersion, startMs, endMs, label: label.trim() || null,
      }, controller.signal);
      if (!current(controller)) return;
      if (!created.ok) {
        if (created.kind === 'conflict' || isDenied(created.kind) || created.kind === 'feature_disabled') refuse(created.kind);
        else setMessage(messages[created.kind]);
        return;
      }
      resetDraft();
      const latest = await listMemoryVideoSegments(scope, controller.signal);
      if (!current(controller)) return;
      if (latest.ok) { adopt(latest); setMessage('Segment saved. Original video unchanged.'); } else refuse(latest.kind);
    });
  };

  const remove = (selected: MemoryVideoSegment) => run(async controller => {
    const removed = await deleteMemoryVideoSegment(scope, selected.id, controller.signal);
    if (!current(controller)) return;
    if (!removed.ok) { setMessage(messages[removed.kind]); if (isDenied(removed.kind)) refuse(removed.kind); return; }
    if (snapshotRef.current) adopt({ ...snapshotRef.current, segments: snapshotRef.current.segments.filter(segment => segment.id !== selected.id) });
    setMessage('Segment removed. Original video unchanged.');
  });

  const edit = (setter: (value: string) => void) => (value: string) => { operationId.current = null; setter(value); };

  return (
    <View testID="memory-video-segments" style={styles.container}>
      {available && <Video key={playerEpoch} ref={player} style={[styles.video, style]} resizeMode={ResizeMode.CONTAIN}
        useNativeControls={false} onPlaybackStatusUpdate={status} accessibilityLabel="Original Memory video" />}
      <View style={styles.controls}>
        <View style={styles.row}>
          <Pressable accessibilityRole="button" accessibilityLabel="Play original video" disabled={busy || !available}
            style={[styles.button, (busy || !available) && styles.disabled]} onPress={() => { void play(); }}><Text style={styles.buttonText}>Play original</Text></Pressable>
          {playing && <Pressable accessibilityRole="button" accessibilityLabel="Pause video" disabled={busy} style={styles.button} onPress={stop}><Text style={styles.buttonText}>Pause</Text></Pressable>}
          <Pressable accessibilityRole="button" accessibilityLabel="Refresh video segments" style={styles.button} onPress={refresh}><Text style={styles.buttonText}>Refresh</Text></Pressable>
          {busy && <ActivityIndicator accessibilityLabel="Loading video segments" color={color.deep} />}
        </View>
        {!!message && <Text accessibilityLiveRegion="polite" style={styles.hint}>{message}</Text>}
        {snapshot && <>
          <Text style={styles.heading}>Video segments</Text>
          <Text style={styles.hint}>You choose the timestamps. Segments reference this original video; they do not copy or recognize scenes.</Text>
          <Text style={styles.hint}>Original duration: {seconds(snapshot.source.durationMs)} seconds</Text>
          {snapshot.segments.length === 0 && <Text style={styles.hint}>No segments yet.</Text>}
          {snapshot.segments.map(segment => <View key={segment.id} style={styles.segment}>
            <Text style={styles.label}>{segment.label ?? 'Untitled segment'}</Text>
            <Text style={styles.hint}>{seconds(segment.startMs)}–{seconds(segment.endMs)} seconds · Chosen by you</Text>
            <View style={styles.row}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Play segment ${segment.label ?? 'Untitled'} ${seconds(segment.startMs)}–${seconds(segment.endMs)}`}
                disabled={busy} style={[styles.button, busy && styles.disabled]} onPress={() => { void play(segment); }}><Text style={styles.buttonText}>Play segment</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove segment ${segment.label ?? 'Untitled'} ${seconds(segment.startMs)}–${seconds(segment.endMs)}`}
                disabled={busy} style={[styles.button, busy && styles.disabled]} onPress={() => { void remove(segment); }}><Text style={styles.buttonText}>Remove</Text></Pressable>
            </View>
          </View>)}
          {snapshot.segments.length < 100 ? <View style={styles.form}>
            <Text style={styles.label}>Add a segment</Text>
            <Text style={styles.hint}>Enter seconds, optionally with up to three decimal places.</Text>
            <TextInput accessibilityLabel="Segment start in seconds" placeholder="Start (seconds)" placeholderTextColor={color.mute}
              value={start} onChangeText={edit(setStart)} keyboardType="decimal-pad" maxLength={14} editable={!busy} style={styles.input} />
            <TextInput accessibilityLabel="Segment end in seconds" placeholder="End (seconds)" placeholderTextColor={color.mute}
              value={end} onChangeText={edit(setEnd)} keyboardType="decimal-pad" maxLength={14} editable={!busy} style={styles.input} />
            <TextInput accessibilityLabel="Segment label" placeholder="Label (optional)" placeholderTextColor={color.mute}
              value={label} onChangeText={edit(setLabel)} maxLength={160} editable={!busy} style={styles.input} />
            <Pressable accessibilityRole="button" accessibilityLabel="Save video segment" disabled={busy} style={[styles.button, busy && styles.disabled]} onPress={save}><Text style={styles.buttonText}>Save segment</Text></Pressable>
          </View> : <Text style={styles.hint}>100 segments saved. Remove one to add another.</Text>}
        </>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: color.paperRaised },
  video: { width: '100%', height: 220, backgroundColor: color.ink },
  controls: { padding: space.md, gap: space.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
  button: { minHeight: 44, paddingHorizontal: space.md, paddingVertical: space.md, backgroundColor: color.haze, borderRadius: radius.sm, justifyContent: 'center' },
  buttonText: { ...typography.small, fontWeight: '600', color: color.deep },
  disabled: { opacity: 0.5 },
  heading: { ...typography.heading, color: color.ink },
  hint: { ...typography.small, color: color.mute },
  label: { ...typography.bodyStrong, color: color.ink },
  segment: { gap: space.xs, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  form: { gap: space.sm, marginTop: space.sm },
  input: { minHeight: 44, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, padding: space.md, color: color.ink, ...typography.body },
});
import { isLoadablePlaybackUri } from '../../services/playbackUri.ts'; // 2026-10-24 video playback: the one playback rule
