import React, { useEffect, useRef, useState } from 'react';
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { DisplayMediaImage } from '../ui/DisplayMediaImage.tsx';
import { usePrivateSurfaceKey } from '../../hooks/usePrivateSurfaceKey.ts';
import { captureMessagingOwnerRequest } from '../../services/messagingOwnerRequest.ts';
import { getImageUnderstandingStatus, requestImageUnderstanding, revokeImageUnderstanding, readImageUnderstanding, type ImageUnderstandingStatus } from '../../services/media/imageUnderstanding.ts';

export interface UnderstandingMedia { id: string; media_type: 'image' | 'video'; url: string; thumbnail_url?: string | null }
interface Props { media: UnderstandingMedia[]; onClose(): void }

export function ImageUnderstandingSheet(props: Props) {
  const scope = usePrivateSurfaceKey();
  return <UnderstandingEditor key={JSON.stringify([scope, props.media.map(item => [item.id, item.media_type, item.url, item.thumbnail_url])])} {...props} />;
}

function UnderstandingEditor({ media, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const item = media[index];
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <ScrollView contentContainerStyle={styles.sheet}>
      <Text accessibilityRole="header" style={styles.title}>Image understanding</Text>
      <Text style={styles.copy}>Optional AI suggestions for general travel scenes. You choose which media to process. Your post and its audience stay the same.</Text>
      {item ? <>
        <Text style={styles.copy}>{item.media_type === 'video' ? 'Video poster' : 'Photo'} {index + 1} of {media.length}</Text>
        <View style={styles.navigation}>
          <Pressable accessibilityRole="button" disabled={index === 0} accessibilityState={{ disabled: index === 0 }} style={styles.button} onPress={() => setIndex(value => value - 1)}><Text style={styles.buttonText}>Previous</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={index >= media.length - 1} accessibilityState={{ disabled: index >= media.length - 1 }} style={styles.button} onPress={() => setIndex(value => value + 1)}><Text style={styles.buttonText}>Next</Text></Pressable>
        </View>
        <SelectedMedia key={item.id} media={item} />
      </> : <Text style={styles.copy}>No supported media is available for this post.</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel="Close image understanding" style={styles.button} onPress={onClose}><Text style={styles.buttonText}>Close</Text></Pressable>
    </ScrollView>
  </Modal>;
}

function SelectedMedia({ media }: { media: UnderstandingMedia }) {
  const { width } = useWindowDimensions();
  const [status, setStatus] = useState<ImageUnderstandingStatus | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [message, setMessage] = useState('Checking availability…');
  const [tags, setTags] = useState<string[]>([]);
  const mounted = useRef(false);
  const owner = useRef(captureMessagingOwnerRequest());
  const pending = useRef<AbortController | null>(null);
  const active = () => AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  const current = () => mounted.current && active() && owner.current?.isCurrent() === true;

  async function perform(kind: 'refresh' | 'request' | 'revoke' | 'read') {
    if (!current() || pending.current) return;
    if (kind === 'request' && (!consent || !status?.processing.enabled || status.consent !== 'none')) return;
    const controller = new AbortController(); pending.current = controller;
    const valid = () => current() && pending.current === controller && !controller.signal.aborted;
    setBusy(true); setTags([]); setConsent(false);
    try {
      if (kind === 'request') {
        await requestImageUnderstanding(status!, controller.signal);
        if (valid()) { setStatus(null); setMessage('Requested. Refresh to check consent, then view suggestions when they are ready.'); }
      } else if (kind === 'revoke') {
        await revokeImageUnderstanding(media.id, controller.signal);
        if (valid()) { setStatus(null); setConfirmRevoke(false); setMessage('Consent withdrawn and stored suggestions removed. Your original media is unchanged.'); }
      } else if (kind === 'read') {
        if (!status || status.consent !== 'granted') return;
        const result = await readImageUnderstanding(status, controller.signal);
        if (valid()) { setTags(result.tags); setMessage(result.tags.length ? 'AI suggestions — unverified. These do not establish where or when this media was taken.' : 'No supported travel scenes were identified.'); }
      } else {
        const next = await getImageUnderstandingStatus(media.id, controller.signal);
        if (valid()) {
          setStatus(next); setConfirmRevoke(false);
          setMessage(next.consent === 'revoked' ? 'Consent was withdrawn for this media version.' : !next.processing.enabled ? 'Processing is not available right now. You can still withdraw consent.'
            : next.consent === 'granted' ? 'Processing was requested. View suggestions or refresh later.' : 'Review the processing details before you opt in.');
        }
      }
    } catch (error) {
      if (valid()) { setStatus(null); setMessage(error instanceof Error ? error.message : 'Could not confirm the action. Refresh to check its status.'); }
    } finally { if (pending.current === controller) { pending.current = null; if (mounted.current) setBusy(false); } }
  }

  useEffect(() => {
    mounted.current = true;
    void perform('refresh');
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') return;
      pending.current?.abort(); pending.current = null;
      setBusy(false); setStatus(null); setTags([]); setConsent(false); setConfirmRevoke(false);
      setMessage('Paused while the app was inactive. Refresh to check the latest state.');
    });
    return () => { mounted.current = false; pending.current?.abort(); pending.current = null; subscription.remove(); };
  }, []);

  const canConsent = !busy && status?.processing.enabled === true && status.consent === 'none';
  const preview = media.media_type === 'image' ? media.url : media.thumbnail_url;
  return <View style={styles.selected}>
    {preview ? <DisplayMediaImage uri={preview} width={Math.max(1, width - 48)} height={200} style={styles.preview} alt={media.media_type === 'image' ? 'Selected photo' : 'Selected video poster'} /> : null}
    {status ? <Text style={styles.copy}>{status.processing.disclosure}</Text> : null}
    <Text accessibilityRole="alert" style={styles.copy}>{message}</Text>
    {tags.map(tag => <Text key={tag} style={styles.copy}>{tag.replace(/_/g, ' ')}</Text>)}
    <Pressable accessibilityRole="checkbox" accessibilityLabel="I have permission to process this media using the displayed service" accessibilityState={{ checked: consent, disabled: !canConsent }} disabled={!canConsent} style={styles.button} onPress={() => setConsent(value => !value)}>
      <Text style={styles.buttonText}>{consent ? '☑' : '☐'} I have permission to process this media using the displayed service.</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canConsent || !consent, busy }} disabled={!canConsent || !consent} style={styles.button} onPress={() => void perform('request')}><Text style={styles.buttonText}>Request suggestions</Text></Pressable>
    {status?.consent === 'granted' ? <Pressable accessibilityRole="button" disabled={busy} style={styles.button} onPress={() => void perform('read')}><Text style={styles.buttonText}>View suggestions</Text></Pressable> : null}
    <Pressable accessibilityRole="button" disabled={busy} style={styles.button} onPress={() => void perform('refresh')}><Text style={styles.buttonText}>Refresh status</Text></Pressable>
    <Text style={styles.copy}>Withdrawing consent stops pending work and removes stored suggestions. A request already being processed may finish, but its result will not be saved.</Text>
    <Pressable accessibilityRole="button" disabled={busy} style={styles.button} onPress={() => confirmRevoke ? void perform('revoke') : setConfirmRevoke(true)}><Text style={styles.buttonText}>{confirmRevoke ? 'Confirm withdraw and remove suggestions' : 'Withdraw consent and remove suggestions'}</Text></Pressable>
  </View>;
}

const styles = StyleSheet.create({
  sheet: { padding: 24, paddingTop: 60, gap: 16, backgroundColor: '#fff', flexGrow: 1 },
  selected: { gap: 16 }, navigation: { flexDirection: 'row', gap: 12 },
  title: { fontSize: 24, color: '#111', fontWeight: '600' }, copy: { fontSize: 16, color: '#111' },
  button: { minHeight: 44, justifyContent: 'center', borderRadius: 8, padding: 12, backgroundColor: '#111' },
  buttonText: { color: '#fff', fontSize: 16 }, preview: { width: '100%', height: 200, borderRadius: 12 },
});
