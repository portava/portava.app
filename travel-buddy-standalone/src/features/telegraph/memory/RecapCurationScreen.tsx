import { MessageSourcePreview } from './MessageSourcePreview.tsx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePrivateSurfaceKey } from '../../../hooks/usePrivateSurfaceKey.ts';
import { useMediaSurfaceActivity } from '../../../hooks/useMediaSurfaceActivity.ts';
import { captureMessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import { useTelegraphPalette } from '../theme/telegraphTheme.ts';
import { draftSavedMessage, fetchRecapChoices, saveMessageAsMemoryDraft, type MemoryDraft, type RecapChoices, type RecapMode } from './memoryApi.ts';

interface Props { threadId: string; planId?: string | null; mode: RecapMode }
export function RecapCurationScreen(props: Props) {
  const scope = usePrivateSurfaceKey();
  return <OwnedSelection key={`${scope}:${props.threadId}:${props.planId}:${props.mode}`} {...props} />;
}

function OwnedSelection({ threadId, planId, mode }: Props) {
  const p = useTelegraphPalette();
  const insets = useSafeAreaInsets();
  const controller = useRef<AbortController | null>(null);
  const activity = useMediaSurfaceActivity(() => controller.current?.abort());
  const owner = useMemo(() => captureMessagingOwnerRequest(), []);
  const [choices, setChoices] = useState<RecapChoices | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, retry] = useState(0);
  const [selected, select] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [saved, setSaved] = useState<Record<string, MemoryDraft>>({});
  const current = () => Boolean(owner?.isCurrent() && activity.isCurrent() && !controller.current?.signal.aborted);

  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    setChoices(null); select(null); setError(null); setLoading(true); setBusy(false);
    if (!owner || !activity.active) { setLoading(false); return () => abort.abort(); }
    void fetchRecapChoices(threadId, mode, planId, { owner, signal: abort.signal, isCurrent: activity.isCurrent }).then(result => {
      if (abort.signal.aborted || !owner.isCurrent() || !activity.isCurrent()) return;
      if (result.ok) setChoices(result.data.choices ?? { mode, items: [], people: [], truncated: false });
      else setError(result.message ?? 'Could not load this recap. Try again.');
      setLoading(false);
    });
    return () => abort.abort();
  }, [threadId, planId, mode, revision, owner, activity.active, activity.epoch, activity.isCurrent]);

  const title = mode === 'memory' ? 'Choose a Memory' : mode === 'photos' ? 'Choose photos to share' : 'People from this plan';
  const chosen = choices?.items.find(item => item.messageId === selected);
  const draft = selected ? saved[selected] : undefined;
  const save = async () => {
    if (!current() || !owner || !selected || !chosen || locked.current || draft) return;
    locked.current = true; setBusy(true); setError(null);
    try {
      const result = await saveMessageAsMemoryDraft(selected, undefined, { owner, signal: controller.current?.signal, isCurrent: activity.isCurrent });
      if (!current()) return;
      if (result.ok) setSaved(prev => ({ ...prev, [selected]: result.data.draft }));
      else setError(result.message ?? 'Could not create the draft. Try again.');
    } finally { locked.current = false; if (current()) setBusy(false); }
  };

  return <View style={[s.page, { backgroundColor: p.surface, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
    <View style={s.header}><Button label="Back" onPress={() => router.back()} /><Text accessibilityRole="header" style={[s.title, { color: p.recvText }]}>{title}</Text></View>
    {!activity.active ? null : <ScrollView contentContainerStyle={s.content}>
      <Text style={{ color: p.mute }}>{mode === 'people'
        ? 'These people responded to the plan. Choose a profile to follow someone you met; an RSVP does not confirm attendance.'
        : mode === 'photos' ? 'Choose one photo, video, or album, then choose a conversation. Nothing is shared automatically.'
          : 'Choose one item to start a private Memory draft. You can review and edit it before publishing.'}</Text>
      {loading && <ActivityIndicator accessibilityLabel="Loading recap choices" color={p.operational} />}
      {error && <View accessibilityLiveRegion="polite"><Text style={{ color: p.recvText }}>{error}</Text><Button label="Retry" onPress={() => retry(n => n + 1)} disabled={busy} /></View>}
      {choices && !loading && (mode === 'people' ? choices.people.length === 0 : choices.items.length === 0) && <Text style={{ color: p.mute }}>No available items for this plan.</Text>}
      {mode === 'people' ? choices?.people.map(person => <View key={person.userId} style={[s.item, { borderColor: p.hairline }]}>
        <Text style={{ color: p.recvText }}>{person.label}</Text>
        <Button label={`View ${person.label}'s profile`} onPress={() => { if (current()) router.push({ pathname: '/u/[id]', params: { id: person.userId } } as never); }} />
      </View>) : choices?.items.map((item, index) => <Pressable key={item.messageId} accessibilityRole="radio"
        accessibilityLabel={`${item.label} ${index + 1}`} accessibilityState={{ checked: selected === item.messageId, disabled: busy }} disabled={busy}
        onPress={() => { if (current()) { select(item.messageId); setError(null); } }}
        style={[s.item, { borderColor: selected === item.messageId ? p.operational : p.hairline, backgroundColor: p.surfaceRaised }]}>
        <Text style={{ color: p.recvText }}>{item.label} {index + 1}{saved[item.messageId] ? ' · Draft created' : ''}</Text>
        <Text style={{ color: p.mute }}>{new Date(item.createdAt).toLocaleString()}</Text>
      </Pressable>)}
      {choices?.truncated && <Text style={{ color: p.mute }}>Showing the most recent available items.</Text>}
      {chosen && <MessageSourcePreview threadId={threadId} planId={planId} mode={mode} messageId={chosen.messageId} />}
      {chosen && mode === 'memory' && (draft ? <View><Text accessibilityLiveRegion="polite" style={{ color: p.recvText }}>{draftSavedMessage(draft)}</Text>
        <Button label="Open draft" onPress={() => { if (current()) router.push({ pathname: '/memory/[id]', params: { id: draft.id } } as never); }} /></View>
        : <Button label={busy ? 'Creating draft…' : 'Create private draft'} disabled={busy || !choices?.memoryEnabled} onPress={() => void save()} />)}
      {mode === 'memory' && choices && !choices.memoryEnabled && <Text style={{ color: p.mute }}>Saving to Memory is currently unavailable.</Text>}
      {mode === 'photos' && choices && (!choices.sharingEnabled ? <Text style={{ color: p.mute }}>Photo forwarding is currently unavailable.</Text>
        : <Button label="Choose a conversation" disabled={!chosen || busy} onPress={() => { if (current() && chosen) router.push({ pathname: '/messages/conversation-tools', params: { threadId, messageId: chosen.messageId, mode: 'forward' } } as never); }} />)}
    </ScrollView>}
  </View>;
}
function Button({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  const p = useTelegraphPalette();
    return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
      onPress={onPress} style={[s.button, { backgroundColor: p.chipFill, opacity: disabled ? 0.5 : 1 }]}><Text style={{ color: p.recvText, fontWeight: '600' }}>{label}</Text></Pressable>;
  }
const s = StyleSheet.create({ page: { flex: 1 }, header: { padding: 16, gap: 12 }, title: { fontSize: 23, fontWeight: '700' },
  content: { padding: 20, gap: 16 }, item: { padding: 16, borderWidth: 1, borderRadius: 14, gap: 8 },
  button: { minHeight: 44, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 16, alignItems: 'center', justifyContent: 'center' } });
