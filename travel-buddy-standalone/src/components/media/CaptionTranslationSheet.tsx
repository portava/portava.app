import React, { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import type { CaptionSource } from '../../services/media/captions.ts';
import { getCaptionTranslationStatus, requestCaptionTranslation, revokeCaptionTranslation, readCaptionTranslationDraft, publishCaptionTranslation, type CaptionTranslationStatus, type CaptionTranslationDraftDto, type CaptionTranslationPublishResponse } from '../../services/media/captionTranslation.ts';

export function CaptionTranslationSheet({ source, onClose, onPublished, onRevoked }: {
  source: CaptionSource;
  onClose: () => void;
  onPublished: (result: CaptionTranslationPublishResponse) => void;
  onRevoked: () => void;
}) {
  const [status, setStatus] = useState<CaptionTranslationStatus | null>(null);
  const [pairIndex, setPairIndex] = useState(0);
  const [consent, setConsent] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [draft, setDraft] = useState<CaptionTranslationDraftDto | null>(null);
  const [vtt, setVtt] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [message, setMessage] = useState('Checking subtitle translation availability…');
  const operation = useRef(0);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const request = ++operation.current;
    const abort = new AbortController();
    controller.current = abort;
    pending.current = false;
    setStatus(null); setPairIndex(0); setConsent(false); setReviewed(false); setDraft(null); setVtt(''); setBusy(false); setConfirmRevoke(false);
    setMessage('Checking subtitle translation availability…');
    if (source.canEdit) getCaptionTranslationStatus(source, abort.signal).then((value) => {
      if (request === operation.current) { setStatus(value); setMessage(value.enabled ? `Translation: ${value.state.replace(/_/g, ' ')}` : 'Local subtitle translation is unavailable until its model and language pairs are validated.'); }
    }).catch(() => { if (request === operation.current) setMessage('Translation status unavailable. You can still withdraw permission and erase drafts.'); });
    return () => { operation.current += 1; controller.current?.abort(); };
  }, [source.assetId, source.version, source.revisionKey, source.canEdit]);

  const stale = Boolean(status && (status.sourceVersion !== source.version || status.revisionKey !== source.revisionKey || !status.current));
  const pair = status?.allowedPairs[pairIndex];
  const ready = Boolean(status?.enabled && !stale);
  const clearDraft = () => { setDraft(null); setVtt(''); setReviewed(false); };
  async function run(action: 'request' | 'revoke' | 'refresh' | 'review' | 'publish') {
    if (pending.current || !source.canEdit || action === 'request' && (!ready || !pair || !consent) || action === 'review' && (!ready || status?.state !== 'completed') || action === 'publish' && (!ready || !draft || !reviewed)) return;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const request = ++operation.current;
    const current = () => request === operation.current && !abort.signal.aborted;
    pending.current = true; setBusy(true);
    try {
      if (action === 'request') {
        const response = await requestCaptionTranslation(source, pair!.source, pair!.target, consent, status!.consentEpoch, abort.signal);
        if (current()) { setStatus(response); setConsent(false); clearDraft(); setMessage(`Translation: ${response.state.replace(/_/g, ' ')}. Nothing is published until you review and publish a draft.`); }
      } else if (action === 'revoke') {
        const response = await revokeCaptionTranslation(source, abort.signal);
        if (!current()) return;
        setStatus(null); setConsent(false); setConfirmRevoke(false); clearDraft();
        setMessage(response.cleanupPending ? 'Translation permission revoked. Draft access stopped; storage cleanup needs retry. Published captions are unchanged.' : 'Translation permission revoked. Draft cleanup confirmed. Published captions are unchanged.');
        onRevoked();
        try { const refreshed = await getCaptionTranslationStatus(source, abort.signal); if (current()) { setStatus(refreshed); setPairIndex(0); } }
        catch { if (current()) setMessage((value) => `${value} Reopen to refresh permission before requesting another draft.`); }
      } else if (action === 'refresh') {
        setConsent(false); clearDraft();
        const refreshed = await getCaptionTranslationStatus(source, abort.signal);
        if (current()) { setStatus(refreshed); setPairIndex(0); setMessage(refreshed.enabled ? `Translation: ${refreshed.state.replace(/_/g, ' ')}` : 'Local subtitle translation is unavailable until its model and language pairs are validated.'); }
      } else if (action === 'review') {
        clearDraft();
        const value = await readCaptionTranslationDraft(source, abort.signal);
        if (current()) { setDraft(value); setVtt(value?.vtt ?? ''); setMessage(value ? 'Review every cue and its timing before publishing. Translation accuracy is not guaranteed.' : 'No completed translation draft is available. Refresh status to check again.'); }
      } else {
        const response = await publishCaptionTranslation(source, draft!, vtt, reviewed, abort.signal);
        if (current()) { clearDraft(); setConsent(false); setStatus(null); setMessage(response.cleanupPending ? 'Translation published. Old draft cleanup needs retry.' : 'Translation published. Original captions preserved.'); onPublished(response); }
      }
    } catch (error) {
      if (current()) {
        setConsent(false); setStatus(null); clearDraft();
        setMessage(action === 'publish' ? 'Publication could not be confirmed. Close and reopen to refresh the authoritative captions before retrying.' : error instanceof Error ? error.message : 'Translation action could not be confirmed. Reopen to refresh.');
      }
    } finally { if (current()) { pending.current = false; setBusy(false); } }
  }

  if (!source.canEdit) return null;
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <ScrollView contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.title}>Translate caption drafts</Text>
      <Text style={styles.copy}>Portava's self-hosted worker translates existing captions. No managed provider receives them. Original video and captions stay unchanged until an explicit publish action.</Text>
      <Text style={styles.copy}>Translation needs separate permission. Transcription or dubbing permission does not authorize translation. No draft publishes automatically.</Text>
      <Text accessibilityRole="alert" style={styles.copy}>{stale ? 'The video or captions changed. Close and reopen before requesting or publishing translation.' : message}</Text>
      {status?.cleanupPending ? <Text style={styles.copy}>Draft storage cleanup needs retry; withdrawal still prevents access.</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`Translation language pair: ${pair ? `${pair.source} to ${pair.target}` : 'Unavailable'}`} disabled={busy || !ready || !status?.allowedPairs.length} onPress={() => { setPairIndex((value) => (value + 1) % status!.allowedPairs.length); setConsent(false); clearDraft(); }} style={styles.button}><Text style={styles.buttonText}>{pair ? `${pair.source} → ${pair.target}` : 'No validated language pairs'}</Text></Pressable>
      <Pressable accessibilityRole="checkbox" accessibilityLabel="I have permission to translate these captions locally" accessibilityState={{ checked: consent, disabled: busy || !ready }} disabled={busy || !ready} onPress={() => setConsent(!consent)} style={styles.button}><Text style={styles.buttonText}>{consent ? '☑' : '☐'} I have permission to translate these captions locally.</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Request subtitle translation draft" accessibilityState={{ disabled: busy || !ready || !pair || !consent, busy }} disabled={busy || !ready || !pair || !consent} onPress={() => void run('request')} style={styles.button}><Text style={styles.buttonText}>Request translation draft</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Refresh translation status" disabled={busy} onPress={() => void run('refresh')} style={styles.button}><Text style={styles.buttonText}>Refresh status</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Review translation draft" disabled={busy || !ready || status?.state !== 'completed'} onPress={() => void run('review')} style={styles.button}><Text style={styles.buttonText}>Review translation draft</Text></Pressable>
      {draft ? <>
        <Text style={styles.copy}>{draft.aiLabel}</Text>
        <Text style={styles.copy}>Publishing replaces any existing {draft.language} caption track. The original {draft.sourceLanguage} and other language tracks are preserved.</Text>
        <TextInput accessibilityLabel="Translated WebVTT captions" value={vtt} onChangeText={(value) => { setVtt(value); setReviewed(false); }} multiline editable={!busy} maxLength={262144} autoCorrect={false} autoCapitalize="none" style={styles.input} />
        <Pressable accessibilityRole="checkbox" accessibilityLabel="I reviewed these captions and have permission to publish them" accessibilityState={{ checked: reviewed, disabled: busy }} disabled={busy} onPress={() => setReviewed(!reviewed)} style={styles.button}><Text style={styles.buttonText}>{reviewed ? '☑' : '☐'} I reviewed these captions and have permission to publish them.</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Publish reviewed translation" accessibilityState={{ disabled: busy || !reviewed || !ready, busy }} disabled={busy || !reviewed || !ready} onPress={() => void run('publish')} style={styles.button}><Text style={styles.buttonText}>Publish reviewed translation</Text></Pressable>
      </> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={confirmRevoke ? 'Confirm revoke translation and erase drafts' : 'Revoke translation and erase drafts'} disabled={busy} onPress={() => confirmRevoke ? void run('revoke') : setConfirmRevoke(true)} style={styles.button}><Text style={styles.buttonText}>{confirmRevoke ? 'Confirm withdrawal and draft erasure' : 'Withdraw translation permission and erase drafts'}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Close subtitle translation" onPress={onClose} style={styles.button}><Text style={styles.buttonText}>Close</Text></Pressable>
    </ScrollView>
  </Modal>;
}

const styles = StyleSheet.create({
  sheet: { padding: 24, paddingTop: 60, gap: 16, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 24, color: '#111', fontWeight: '600' },
  copy: { fontSize: 16, color: '#111' },
  button: { minHeight: 44, justifyContent: 'center', borderRadius: 8, padding: 12, backgroundColor: '#111' },
  buttonText: { color: '#fff', fontSize: 16 },
  input: { minHeight: 220, borderWidth: 1, borderColor: '#555', borderRadius: 8, padding: 12, fontSize: 16, color: '#111' },
});
