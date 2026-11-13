import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppHeader } from '../src/components/ui/AppHeader.tsx';
import { DisplayMediaImage } from '../src/components/ui/DisplayMediaImage.tsx';
import { SharedVideoPlayer } from '../src/components/ui/SharedVideoPlayer.tsx';
import { usePrivateSurfaceKey } from '../src/hooks/usePrivateSurfaceKey.ts';
import { captureMessagingOwnerRequest } from '../src/services/messagingOwnerRequest.ts';
import { color } from '../src/theme/tokens.ts';
import { createGenerationDraft, deleteGenerationDraft, generationRequestId, getGenerationDrafts, previewGenerationDraft, subscribeGenerationDrafts, type GeneratedDraft, type GenerationAvailability, type GenerationRequest } from '../src/services/media/generation.ts';

export default function CreateAiPage() {
  const scope = usePrivateSurfaceKey();
  return <CreationStudio key={scope} />;
}
function CreationStudio() {
  const { width } = useWindowDimensions();
  const [availability, setAvailability] = useState<GenerationAvailability | null>(null);
  const [kind, setKind] = useState<'image' | 'video'>('image');
  const [ratio, setRatio] = useState<'16:9' | '9:16' | '1:1'>('16:9');
  const [prompt, setPrompt] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Checking availability…');
  const [preview, setPreview] = useState<(GeneratedDraft & { url: string }) | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const pendingIntent = useRef<GenerationRequest | null>(null);
  const pending = useRef<AbortController | null>(null);
  const refreshPending = useRef(false);
  const owner = useRef(captureMessagingOwnerRequest());
  const mounted = useRef(false);
  const current = () => mounted.current && AppState.currentState !== 'background' && AppState.currentState !== 'inactive' && owner.current?.isCurrent() === true;
  const run = async (action: 'refresh' | 'create' | 'preview' | 'delete' | 'save', id?: string) => {
    if (!current()) return;
    if (pending.current) { if (action === 'refresh') refreshPending.current = true; return; }
    if (action === 'create' && (!consent || !availability?.[kind] || prompt.trim().length < 3)) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true);
    const valid = () => current() && pending.current === controller && !controller.signal.aborted;
    try {
      if (action === 'create') {
        // Preserve the exact intent after a lost response. Retry never mints a new billable request.
        pendingIntent.current ??= { requestId: generationRequestId(), kind, prompt: prompt.trim(), aspectRatio: ratio, consentVersion: availability!.policyVersion };
        const result = await createGenerationDraft(pendingIntent.current, controller.signal);
        if (!valid()) return;
        pendingIntent.current = null; setUncertain(false); setConsent(false); setPrompt('');
        setMessage('Draft queued. You can leave this screen while it generates.');
        setAvailability(value => value ? { ...value, jobs: [result, ...value.jobs.filter(j => j.id !== result.id)].slice(0, 20) } : value);
      } else if (action === 'refresh') {
        const next = await getGenerationDrafts(controller.signal);
        if (!valid()) return;
        setAvailability(next);
        if (pendingIntent.current && next.jobs.some(j => j.requestId === pendingIntent.current?.requestId)) {
          pendingIntent.current = null; setUncertain(false); setConsent(false); setPrompt('');
          setMessage('Your request was received. Its draft is listed below.');
        } else setMessage(next.enabled ? '' : 'AI creation is not available yet. Existing drafts remain private.');
      } else if (action === 'delete' && id) {
        await deleteGenerationDraft(id, controller.signal);
        if (!valid()) return;
        setPreview(null); setAvailability(value => value ? { ...value, jobs: value.jobs.map(j => j.id === id ? { ...j, state: 'deleting' } : j) } : value);
        setMessage('Removal requested. Generation already in progress may finish before provider cleanup completes.');
      } else if (id) {
        const result = await previewGenerationDraft(id, controller.signal);
        if (!valid()) return;
        if (action === 'save') await Linking.openURL(result.url);
        else setPreview(result);
      }
    } catch (error) {
      if (valid()) {
        if (action === 'create') setUncertain(true);
        if (action === 'refresh') setAvailability(null);
        setMessage(error instanceof Error ? error.message : 'Could not confirm the action. Refresh to check your drafts.');
      }
    } finally { if (pending.current === controller) {
      pending.current = null; if (mounted.current) setBusy(false);
      if (refreshPending.current && current()) { refreshPending.current = false; void run('refresh'); }
    } }
  };
  useEffect(() => {
    mounted.current = true; void run('refresh');
    const connect = () => subscribeGenerationDrafts(() => { if (current()) void run('refresh'); }, () => { if (current()) setMessage('Live updates are disconnected. Reconnect or refresh to check your drafts.'); });
    let disconnect = connect();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') { disconnect(); disconnect = connect(); void run('refresh'); return; }
      disconnect();
      pending.current?.abort(); pending.current = null; setPreview(null); setConsent(false); setBusy(false);
    });
    return () => { mounted.current = false; pending.current?.abort(); disconnect(); subscription.remove(); };
    // Session changes remount this private surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!preview) return;
    const expiry = setTimeout(() => setPreview(null), 55000);
    return () => clearTimeout(expiry);
  }, [preview]);
  const locked = busy || uncertain;
  const canCreate = !busy && consent && availability?.[kind] === true && prompt.trim().length >= 3;
  return <SafeAreaView edges={['bottom']} style={styles.screen}>
    <AppHeader variant="detail" title="AI creation" onBack={() => router.back()} />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Imagine something new</Text>
      <Text style={styles.copy}>Create an image or a silent 5-second video. Preview it privately, then save it when you’re happy with it.</Text>
      <View style={styles.row}>{(['image', 'video'] as const).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: kind === value, disabled: locked }} disabled={locked} onPress={() => { setKind(value); setConsent(false); }} style={[styles.choice, kind === value && styles.selected]}><Text style={styles.copy}>{value === 'image' ? 'Image' : 'Video · 5s'}</Text></Pressable>)}</View>
      <TextInput accessibilityLabel="Describe your AI creation" style={styles.input} placeholder="A playful illustrated beach picnic at sunset…" placeholderTextColor={color.mute} multiline maxLength={2000} value={prompt} editable={!locked} onChangeText={text => { setPrompt(text); setConsent(false); }} />
      <View style={styles.row}>{(['16:9', '9:16', '1:1'] as const).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: ratio === value, disabled: locked }} disabled={locked} style={[styles.choice, ratio === value && styles.selected]} onPress={() => setRatio(value)}><Text style={styles.copy}>{value}</Text></Pressable>)}</View>
      <Text style={styles.copy}>{availability?.disclosure ?? 'Your prompt will be processed by Higgsfield. Generated media is illustrative and does not verify a real place or visit.'}</Text>
      {availability && <Text style={styles.copy}>{availability.models[kind].label} · estimated provider cost ${availability.models[kind].estimateUsd.toFixed(4)} per draft, within Portava’s creation allowance.</Text>}
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: consent, disabled: busy || !availability?.[kind] }} disabled={busy || !availability?.[kind]} style={styles.choice} onPress={() => setConsent(v => !v)}><Text style={styles.copy}>{consent ? '✓ ' : '○ '}I agree to send this prompt for AI generation.</Text></Pressable>
      <Pressable accessibilityRole="button" disabled={!canCreate} accessibilityState={{ disabled: !canCreate }} style={[styles.primary, !canCreate && styles.disabled]} onPress={() => void run('create')}><Text style={styles.primaryText}>{uncertain ? 'Retry same request' : 'Create private draft'}</Text></Pressable>
      {!!message && <Text accessibilityLiveRegion="polite" style={styles.copy}>{message}</Text>}
      <View style={styles.row}><Text style={styles.title}>Your drafts</Text><Pressable accessibilityRole="button" disabled={busy} style={styles.choice} onPress={() => void run('refresh')}><Text style={styles.copy}>Refresh</Text></Pressable></View>
      {availability?.jobs.length === 0 && <Text style={styles.copy}>Your generated drafts will appear here.</Text>}
      {availability?.jobs.map(job => <View key={job.id} style={styles.card}>
        <Text style={styles.copy}>AI {job.kind} · {job.state}</Text>
        <Text style={styles.copy}>Expires {new Date(job.expiresAt).toLocaleDateString()}</Text>
        {preview?.id === job.id && (job.kind === 'image' ? <DisplayMediaImage uri={preview.url} width={Math.max(1, width - 74)} height={280} style={styles.preview} resizeMode="contain" alt="AI-generated image preview" /> : <SharedVideoPlayer uri={preview.url} autoplay={false} style={styles.preview} />)}
        <View style={styles.row}>
          {job.state === 'ready' && <><Pressable accessibilityRole="button" disabled={busy} style={styles.choice} onPress={() => void run('preview', job.id)}><Text style={styles.copy}>Preview</Text></Pressable><Pressable accessibilityRole="button" disabled={busy} style={styles.choice} onPress={() => void run('save', job.id)}><Text style={styles.copy}>Open to save</Text></Pressable></>}
          {job.state !== 'deleting' && <Pressable accessibilityRole="button" disabled={busy} style={styles.choice} onPress={() => void run('delete', job.id)}><Text style={styles.copy}>Delete</Text></Pressable>}
        </View>
      </View>)}
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper }, content: { padding: 20, gap: 16, paddingBottom: 48 },
  title: { color: color.ink, fontSize: 23, fontWeight: '700' }, copy: { color: color.ink, fontSize: 15, lineHeight: 22 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  input: { color: color.ink, backgroundColor: '#fff', borderColor: color.haze, borderWidth: 1, borderRadius: 16, minHeight: 130, padding: 16, textAlignVertical: 'top', fontSize: 17 },
  choice: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 11, borderWidth: 1, borderColor: color.haze, borderRadius: 14 },
  selected: { borderColor: color.ink, backgroundColor: color.haze }, primary: { backgroundColor: color.ink, borderRadius: 18, padding: 16, alignItems: 'center' },
  primaryText: { color: color.onInk, fontSize: 17, fontWeight: '700' }, disabled: { opacity: 0.45 },
  card: { borderColor: color.haze, borderWidth: 1, borderRadius: 18, padding: 16, gap: 12 }, preview: { width: '100%', height: 280 },
});
