import React, { useState, useRef, useEffect } from 'react';
import { Modal, View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { saveCaptionTrack, deleteCaptionTrack, publishCaptionDraft, type CaptionSource, type CaptionTrackResult } from '../../services/media/captions.ts';

export function CaptionAuthoringSheet({ source, initialVtt, initialLanguage = 'und', draftId, onClose, onSaved }: {
  source: CaptionSource;
  initialVtt: string | null;
  initialLanguage?: string;
  draftId?: string;
  onClose: () => void;
  onSaved: (result: CaptionTrackResult) => void;
}) {
  const [vtt, setVtt] = useState(initialVtt ?? 'WEBVTT\n\n00:00.000 --> 00:01.000\n');
  const [consent, setConsent] = useState(false);
  const [language, setLanguage] = useState(initialLanguage);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function submit(deleting: boolean) {
    if (pending.current || (!deleting && !consent)) return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    try {
      const result = deleting ? await deleteCaptionTrack(source) : draftId ? await publishCaptionDraft(source, draftId, vtt, consent) : await saveCaptionTrack(source, vtt, consent, language);
      if (mounted.current) onSaved(result);
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : 'Captions could not be saved.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <ScrollView contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.title}>Timed captions</Text>
      {draftId ? <Text style={styles.copy}>AI transcription — review every cue before publishing. Language and speech accuracy are not guaranteed.</Text> : null}
      <Text style={styles.copy}>Type or paste WebVTT for this video. Captions share the video's audience. No audio is sent to a transcription provider.</Text>
      <Text style={styles.copy}>Measured video length: {(source.durationMs / 1000).toFixed(1)} seconds.</Text>
      <TextInput accessibilityLabel="Caption language code" value={language} onChangeText={setLanguage} editable={!busy && !draftId} maxLength={35} autoCapitalize="none" autoCorrect={false} style={styles.language} />
      <TextInput accessibilityLabel="WebVTT timed captions" multiline textAlignVertical="top" value={vtt} onChangeText={setVtt} editable={!busy} maxLength={262144} style={styles.input} autoCorrect={false} autoCapitalize="none" />
      <Pressable accessibilityRole="checkbox" accessibilityLabel="I have permission to share these captions with this video's audience" accessibilityState={{ checked: consent, disabled: busy }} disabled={busy} onPress={() => setConsent(!consent)} style={styles.button}>
        <Text style={styles.buttonText}>{consent ? '☑' : '☐'} I have permission to share these captions with this video's audience.</Text>
      </Pressable>
      {message ? <Text accessibilityRole="alert" style={styles.copy}>{message}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Save timed captions" accessibilityState={{ disabled: !consent || busy, busy }} disabled={!consent || busy} onPress={() => void submit(false)} style={styles.button}><Text style={styles.buttonText}>{busy ? 'Saving…' : 'Save timed captions'}</Text></Pressable>
      {initialVtt !== null && !draftId ? <Pressable accessibilityRole="button" accessibilityLabel={confirmDelete ? 'Confirm delete captions' : 'Delete captions'} accessibilityState={{ disabled: busy }} disabled={busy} onPress={() => confirmDelete ? void submit(true) : setConfirmDelete(true)} style={styles.button}><Text style={styles.buttonText}>{confirmDelete ? 'Confirm delete captions' : 'Delete all caption tracks'}</Text></Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Close caption editor" onPress={onClose} style={styles.button}><Text style={styles.buttonText}>Close</Text></Pressable>
    </ScrollView>
  </Modal>;
}

const styles = StyleSheet.create({
  sheet: { padding: 24, paddingTop: 60, gap: 16, backgroundColor: '#fff', flexGrow: 1 },
  title: { fontSize: 24, color: '#111', fontWeight: '600' },
  copy: { fontSize: 16, color: '#111' },
  input: { minHeight: 220, borderWidth: 1, borderColor: '#555', borderRadius: 8, padding: 12, fontSize: 16, color: '#111' },
  language: { minHeight: 44, borderWidth: 1, borderColor: '#555', padding: 12, color: '#111', fontSize: 16 },
  button: { minHeight: 44, justifyContent: 'center', borderRadius: 8, padding: 12, backgroundColor: '#111' },
  buttonText: { color: '#fff', fontSize: 16 },
});
