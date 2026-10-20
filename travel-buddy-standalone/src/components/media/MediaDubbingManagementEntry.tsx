import React, { useEffect, useRef, useState } from 'react';
import { AppState, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../context/SessionContext.tsx';
import { resolveCaptionSource, type CaptionSource } from '../../services/media/captions.ts';
import { subscribeDubbingAuth } from '../../services/media/dubbing.ts';
import { MediaDubbingManagement } from './MediaDubbingManagement.tsx';

export function MediaDubbingManagementEntry({ source, active, onWithdrawn }: { source: string; active: boolean; onWithdrawn: () => void }) {
  const { userId, isAuthed } = useSession();
  if (!active || !isAuthed || !userId) return null;
  return <OwnerEntry key={JSON.stringify([source, userId])} source={source} userId={userId} onWithdrawn={onWithdrawn} />;
}

function OwnerEntry({ source, userId, onWithdrawn }: { source: string; userId: string; onWithdrawn: () => void }) {
  const [opened, setOpened] = useState(false);
  const [descriptor, setDescriptor] = useState<CaptionSource | null>(null);
  const [message, setMessage] = useState('');
  const pending = useRef<AbortController | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const foreground = useRef(AppState.currentState === 'active');
  const cancel = () => {
    pending.current?.abort(); pending.current = null;
    if (deadline.current !== null) clearTimeout(deadline.current);
    deadline.current = null;
  };
  const close = () => { cancel(); setOpened(false); setDescriptor(null); setMessage(''); };
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeDubbingAuth(close);
    const listener = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (!foreground.current) close();
    });
    return () => { mounted.current = false; cancel(); unsubscribe(); listener.remove(); };
  }, []);
  async function open() {
    if (!foreground.current || pending.current) return;
    cancel(); setOpened(true); setDescriptor(null); setMessage('Checking owner permission…');
    const controller = new AbortController(); pending.current = controller;
    deadline.current = setTimeout(() => {
      if (pending.current !== controller) return;
      cancel(); if (mounted.current) setMessage('Owner permission could not be confirmed. Close and try again.');
    }, 10_000);
    try {
      const value = await resolveCaptionSource(source, controller.signal, { forDubbingManagement: true });
      if (controller.signal.aborted || pending.current !== controller || !mounted.current) return;
      if (!value.canEdit) throw new Error('not_owner');
      setDescriptor(value); setMessage('');
    } catch {
      if (!controller.signal.aborted && pending.current === controller && mounted.current) setMessage('Only the current video owner can manage AI audio. Permission could not be confirmed.');
    } finally { if (pending.current === controller) cancel(); }
  }
  return <>
    <Pressable style={styles.open} accessibilityRole="button" accessibilityLabel="Manage AI audio permission" onPress={() => { void open(); }}><Text style={styles.light}>AI audio privacy</Text></Pressable>
    <Modal visible={opened} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.shade}><ScrollView style={styles.sheet}>
        {descriptor ? <MediaDubbingManagement source={descriptor} userId={userId} open={opened} onClose={close} onWithdrawn={onWithdrawn} /> : <>
          <Text accessibilityLiveRegion="polite">{message}</Text>
          <Pressable style={styles.close} accessibilityRole="button" accessibilityLabel="Close AI audio privacy" onPress={close}><Text>Close</Text></Pressable>
        </>}
      </ScrollView></View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  open: { position: 'absolute', top: 12, right: 12, backgroundColor: '#111', minHeight: 44, padding: 12, borderRadius: 6 },
  light: { color: '#fff', fontSize: 14 },
  shade: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#0008', paddingTop: 64 },
  sheet: { flexGrow: 0, backgroundColor: '#fff', padding: 16, maxHeight: '85%' },
  close: { minHeight: 44, padding: 12, alignSelf: 'flex-end' },
});
