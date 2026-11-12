import React, { useEffect, useState } from 'react';
import { AppState, View, Text, Pressable, StyleSheet } from 'react-native';
import { useFeatureFlags } from '../../context/FeatureFlagsContext.tsx';
import { useSession } from '../../context/SessionContext.tsx';
import { useLanguagePreference } from '../../context/LanguagePreferenceContext.tsx';
import { resolveCaptionSource, readCaptionTrack, readCaptionDraft, CaptionRequestError, type CaptionSource, type CaptionTrackResult } from '../../services/media/captions.ts';
import { TimedCaptionOverlay, type CaptionPlaybackStatus } from './TimedCaptionOverlay.tsx';
import { CaptionAuthoringSheet } from './CaptionAuthoringSheet.tsx';
import { CaptionAsrSheet } from './CaptionAsrSheet.tsx';
import { CaptionTranslationSheet } from './CaptionTranslationSheet.tsx';

export function MediaCaptionControls({ source, status, active = true, onSourceChanged }: { source: string; status: CaptionPlaybackStatus | null; active?: boolean; onSourceChanged?: () => void }) {
  const { isEnabled } = useFeatureFlags();
  const { userId } = useSession();
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => listener.remove();
  }, []);
  if (!active || !foreground || !userId || !isEnabled('media_captions_enabled')) return null;
  return <CaptionSession key={`${userId}:${source}`} source={source} status={status} onSourceChanged={onSourceChanged} />;
}

function CaptionSession({ source, status, onSourceChanged }: { source: string; status: CaptionPlaybackStatus | null; onSourceChanged?: () => void }) {
  const { preferredLanguage } = useLanguagePreference();
  const [descriptor, setDescriptor] = useState<CaptionSource | null>(null);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [sourceFailed, setSourceFailed] = useState(false);
  const [sourceErrorOpen, setSourceErrorOpen] = useState(false);
  const [sourceMessage, setSourceMessage] = useState('Captions unavailable. Try again.');
  const [resolving, setResolving] = useState(false);
  const [track, setTrack] = useState<CaptionTrackResult | null>(null);
  const [trackFailed, setTrackFailed] = useState(false);
  const [shown, setShown] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const [languageOverride, setLanguageOverride] = useState<string | null | undefined>();
  const language = languageOverride === undefined ? (shown ? preferredLanguage ?? undefined : undefined) : languageOverride ?? undefined;
  const [reviewingDraft, setReviewingDraft] = useState(false);
  const [requestingAsr, setRequestingAsr] = useState(false);
  const [translating, setTranslating] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    setTrack(null);
    setDescriptor(null);
    setResolving(true);
    resolveCaptionSource(source, abort.signal).then((value) => {
      if (!abort.signal.aborted) { setDescriptor(value); setSourceFailed(false); }
    }).catch((error) => {
      if (!abort.signal.aborted) {
        setSourceFailed(true);
        setSourceMessage(error instanceof CaptionRequestError ? error.message : 'Captions unavailable. Try again.');
      }
    }).finally(() => { if (!abort.signal.aborted) setResolving(false); });
    return () => abort.abort();
  }, [source, sourceAttempt]);

  useEffect(() => {
    if (!descriptor || (!shown && !editing)) return;
    const abort = new AbortController();
    setBusy(true);
    setTrack(null);
    setTrackFailed(false);
    setMessage('');
    const request = editing && reviewingDraft ? readCaptionDraft(descriptor, abort.signal) : readCaptionTrack(descriptor, abort.signal, language);
    request.then((value) => {
      if (abort.signal.aborted) return;
      setTrack(value);
      setExpiresAt(Date.now() + 10_000);
      setMessage(value.cues.length ? '' : 'No timed captions yet.');
    }).catch((error) => {
      if (!abort.signal.aborted) { setTrack(null); setTrackFailed(true); setMessage(error instanceof CaptionRequestError ? error.message : 'Captions unavailable. Try again.'); }
    }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [descriptor, shown, editing, refresh, language, reviewingDraft]);

  useEffect(() => {
    if (!shown || editing || !descriptor || trackFailed) return;
    const timer = setInterval(() => { setTrack(null); setRefresh((value) => value + 1); }, 10_000);
    return () => clearInterval(timer);
  }, [shown, editing, descriptor, trackFailed]);

  const retry = () => {
    // Re-resolve access and generation as well as the track. Retrying an old
    // descriptor forever cannot recover after the source video was replaced.
    setTrack(null);
    setDescriptor(null);
    setSourceFailed(true);
    setSourceErrorOpen(true);
    setResolving(true);
    setSourceAttempt((value) => value + 1);
  };
  if (!descriptor) return sourceFailed ? <View style={styles.controls}>
    {!sourceErrorOpen ? <Pressable accessibilityRole="button" accessibilityLabel="Captions unavailable. Show details" onPress={() => setSourceErrorOpen(true)} style={styles.button}><Text style={styles.text}>CC unavailable</Text></Pressable> : <>
    <Text accessibilityRole="alert" style={styles.message}>{resolving ? 'Loading captions…' : sourceMessage}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Retry captions" accessibilityState={{ disabled: resolving, busy: resolving }} disabled={resolving} onPress={retry} style={styles.button}><Text style={styles.text}>Retry captions</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="Dismiss caption error" onPress={() => setSourceErrorOpen(false)} style={styles.button}><Text style={styles.text}>Dismiss</Text></Pressable>
    </>}
  </View> : null;
  return <>
    {shown && track && Date.now() < expiresAt ? <TimedCaptionOverlay cues={track.cues} status={status} /> : null}
    <View style={styles.controls}>
      <Pressable accessibilityRole="button" accessibilityLabel={shown ? 'Hide timed captions' : 'Show timed captions'} accessibilityState={{ selected: shown, busy }} onPress={() => setShown(!shown)} style={styles.button}><Text style={styles.text}>CC {shown ? 'On' : 'Off'}</Text></Pressable>
      {descriptor.canEdit ? <Pressable accessibilityRole="button" accessibilityLabel="Edit timed captions" onPress={() => { setTrack(null); setReviewingDraft(false); setEditing(true); }} style={styles.button}><Text style={styles.text}>Edit captions</Text></Pressable> : null}
      {descriptor.canEdit ? <Pressable accessibilityRole="button" accessibilityLabel="Review generated caption draft" onPress={() => { setTrack(null); setReviewingDraft(true); setEditing(true); }} style={styles.button}><Text style={styles.text}>Review ASR draft</Text></Pressable> : null}
      {descriptor.canEdit ? <Pressable accessibilityRole="button" accessibilityLabel="Manage local transcription" onPress={() => { setTrack(null); setEditing(false); setRequestingAsr(true); }} style={styles.button}><Text style={styles.text}>Generate captions</Text></Pressable> : null}
      {descriptor.canEdit ? <Pressable accessibilityRole="button" accessibilityLabel="Manage subtitle translation" onPress={() => { setTrack(null); setEditing(false); setRequestingAsr(false); setTranslating(true); }} style={styles.button}><Text style={styles.text}>Translate captions</Text></Pressable> : null}
      {shown && track ? <Pressable accessibilityRole="button" accessibilityLabel="Use original captions" accessibilityState={{ selected: languageOverride === null, busy }} onPress={() => setLanguageOverride(null)} style={styles.button}><Text style={styles.text}>Original</Text></Pressable> : null}
      {shown && track && (track.availableLanguages?.length ?? 0) > 1 ? <Pressable accessibilityRole="button" accessibilityLabel={`Caption language: ${track.language}. Change language`} onPress={() => {
        const languages = track.availableLanguages!;
        setLanguageOverride(languages[(languages.indexOf(track.language ?? '') + 1) % languages.length]);
      }} style={styles.button}><Text style={styles.text}>{track.language}</Text></Pressable> : null}
      {shown && track?.aiLabel ? <Text style={styles.message}>{track.aiLabel}</Text> : null}
      {message && (shown || editing) ? <Text accessibilityRole="alert" style={styles.message}>{message}</Text> : null}
      {trackFailed && (shown || editing) ? <Pressable accessibilityRole="button" accessibilityLabel="Retry captions" onPress={retry} style={styles.button}><Text style={styles.text}>Retry captions</Text></Pressable> : null}
    </View>
    {editing && track ? <CaptionAuthoringSheet key={`${descriptor.assetId}:${descriptor.version}:${track.revisionKey}`} source={{ ...descriptor, revisionKey: track.revisionKey }} initialVtt={track.vtt} initialLanguage={track.language} draftId={track.draftId} onClose={() => setEditing(false)} onSaved={(result) => {
      setEditing(false);
      setTrack(null);
      setDescriptor({ ...descriptor, version: result.version, revisionKey: result.revisionKey });
      setMessage(result.cleanupPending ? 'Caption access updated. Storage cleanup needs retry.' : 'Captions saved.');
      onSourceChanged?.();
    }} /> : null}
    {requestingAsr ? <CaptionAsrSheet source={descriptor} onClose={() => setRequestingAsr(false)} onRevoked={() => { setTrack(null); setReviewingDraft(false); setEditing(false); setRefresh((value) => value + 1); onSourceChanged?.(); }} /> : null}
    {translating ? <CaptionTranslationSheet source={descriptor} onClose={() => setTranslating(false)} onPublished={(result) => {
      setTranslating(false); setTrack(null); setDescriptor({ ...descriptor, version: result.version, revisionKey: result.revisionKey });
      setMessage(result.cleanupPending ? 'Translation published. Draft cleanup needs retry.' : 'Translation published. Original captions preserved.');
      onSourceChanged?.();
    }} onRevoked={() => { setTrack(null); setRefresh((value) => value + 1); onSourceChanged?.(); }} /> : null}
  </>;
}

const styles = StyleSheet.create({
  controls: { position: 'absolute', top: 12, left: 12, gap: 8, maxWidth: '80%' },
  button: { minHeight: 44, minWidth: 44, justifyContent: 'center', backgroundColor: '#111', borderRadius: 6, padding: 10, alignSelf: 'flex-start' },
  text: { color: '#fff', fontSize: 14 },
  message: { color: '#fff', backgroundColor: '#111', padding: 8, fontSize: 14 },
});
