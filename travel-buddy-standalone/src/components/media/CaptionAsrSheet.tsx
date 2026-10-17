import React, { useEffect, useRef, useState } from 'react';
import { Modal, ScrollView, Text, Pressable, StyleSheet } from 'react-native';
import { getCaptionAsrStatus, requestCaptionAsr, revokeCaptionAsr, type CaptionSource, type CaptionAsrStatus } from '../../services/media/captions.ts';

export function CaptionAsrSheet({ source, onClose, onRevoked }: { source: CaptionSource; onClose: () => void; onRevoked: () => void }) {
  const [status, setStatus] = useState<CaptionAsrStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [message, setMessage] = useState('Checking local transcription availability…');
  const mounted = useRef(false);
  const pending = useRef(false);
  const sourceEpoch = useRef(0);
  const statusRequest = useRef(0);
  useEffect(() => {
    const abort = new AbortController();
    const request = ++statusRequest.current;
    sourceEpoch.current += 1;
    mounted.current = true;
    pending.current = false;
    setStatus(null);
    setConsent(false);
    setLanguage('');
    setBusy(false);
    setConfirmRevoke(false);
    setMessage('Checking local transcription availability…');
    getCaptionAsrStatus(source, abort.signal).then((value) => {
      if (!abort.signal.aborted && request === statusRequest.current) { setStatus(value); setMessage(value.enabled ? `Transcription: ${value.state.replace(/_/g, ' ')}` : 'Local transcription is unavailable until its model and languages are validated.'); }
    }).catch(() => { if (!abort.signal.aborted && request === statusRequest.current) setMessage('Transcription status unavailable. You can still stop transcription and erase drafts.'); });
    return () => { sourceEpoch.current += 1; mounted.current = false; abort.abort(); };
  }, [source.assetId, source.version, source.revisionKey]);

  const stale = status && (status.sourceVersion !== source.version || status.revisionKey !== source.revisionKey);
  async function submit(revoking: boolean) {
    if (pending.current || !revoking && (!consent || !status?.enabled || stale)) return;
    const requestEpoch = sourceEpoch.current;
    statusRequest.current += 1;
    const isCurrent = () => mounted.current && sourceEpoch.current === requestEpoch;
    pending.current = true;
    setBusy(true);
    try {
      if (revoking) {
        const result = await revokeCaptionAsr(source);
        if (isCurrent()) {
          setConsent(false);
          setConfirmRevoke(false);
          setStatus(null);
          setMessage(result.cleanupPending ? 'Consent revoked and processing stopped. Draft storage cleanup needs retry.' : 'Consent revoked. Generated drafts deleted. Published captions are unchanged.');
          onRevoked();
          try {
            const refreshed = await getCaptionAsrStatus(source);
            if (isCurrent()) setStatus(refreshed);
          } catch {
            if (isCurrent()) setMessage((value) => `${value} Reopen to refresh consent status before requesting another draft.`);
          }
        }
      } else {
        const result = await requestCaptionAsr(source, language, consent, status!.consentEpoch);
        if (isCurrent()) {
          setStatus(result);
          setConsent(false);
          setMessage(`Transcription: ${result.state.replace(/_/g, ' ')}. Review the generated draft before publishing; captions are not automatic.`);
        }
      }
    } catch (error) {
      if (isCurrent()) {
        setConsent(false);
        setStatus(null);
        setMessage(error instanceof Error ? error.message : 'Transcription action could not be confirmed. Reopen to refresh consent status.');
      }
    } finally { if (isCurrent()) { pending.current = false; setBusy(false); } }
  }

  const canRequest = status?.enabled && !stale && consent && !busy;
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <ScrollView contentContainerStyle={styles.sheet}>
      <Text accessibilityRole="header" style={styles.title}>Generate a caption draft</Text>
      <Text style={styles.copy}>Portava's self-hosted worker processes this video's audio for AI transcription. No managed transcription provider receives it. The original video and published captions are unchanged.</Text>
      <Text style={styles.copy}>You must have permission from the people speaking. Review every cue before publishing; speech and language accuracy are not guaranteed.</Text>
      <Text accessibilityRole="alert" style={styles.copy}>{stale ? 'The video or captions changed. Close and reopen this video before requesting transcription.' : message}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Transcription language: ${language || 'Detect language'}`} disabled={busy || !status?.enabled} onPress={() => {
        const languages = ['', ...(status?.languages ?? [])];
        setLanguage(languages[(languages.indexOf(language) + 1) % languages.length]);
        setConsent(false);
      }} style={styles.button}><Text style={styles.buttonText}>Language: {language || 'Detect language'}</Text></Pressable>
      <Pressable accessibilityRole="checkbox" accessibilityLabel="I have permission to transcribe this video's audio locally" accessibilityState={{ checked: consent, disabled: busy }} disabled={busy} onPress={() => setConsent(!consent)} style={styles.button}><Text style={styles.buttonText}>{consent ? '☑' : '☐'} I have permission to transcribe this video's audio locally.</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Request local caption draft" accessibilityState={{ disabled: !canRequest, busy }} disabled={!canRequest} onPress={() => void submit(false)} style={styles.button}><Text style={styles.buttonText}>Request local caption draft</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={confirmRevoke ? 'Confirm stop transcription and delete drafts' : 'Stop transcription and delete drafts'} accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => confirmRevoke ? void submit(true) : setConfirmRevoke(true)} style={styles.button}><Text style={styles.buttonText}>{confirmRevoke ? 'Confirm stop and delete drafts' : 'Stop transcription and delete drafts'}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Close transcription request" onPress={onClose} style={styles.button}><Text style={styles.buttonText}>Close</Text></Pressable>
    </ScrollView>
  </Modal>;
}

const styles = StyleSheet.create({
  sheet: { padding: 24, paddingTop: 60, gap: 16, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 24, color: '#111', fontWeight: '600' },
  copy: { fontSize: 16, color: '#111' },
  button: { minHeight: 44, justifyContent: 'center', borderRadius: 8, padding: 12, backgroundColor: '#111' },
  buttonText: { color: '#fff', fontSize: 16 },
});
