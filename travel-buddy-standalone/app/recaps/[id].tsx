import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { getPlaceRecap, recapAction, type PlaceRecapDetail } from '../../src/services/placeRecaps.ts';
import { CachedImage } from '../../src/components/CachedImage.tsx';
import { color, radius, space, type as t, typography } from '../../src/theme/tokens.ts';

export default function RecapDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>(); const recapId = Array.isArray(id) ? id[0] : id;
  const [detail, setDetail] = useState<PlaceRecapDetail | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const requestGeneration = useRef(0);
  const load = useCallback(async () => {
    if (!recapId) return;
    const generation = ++requestGeneration.current;
    setDetail(undefined); setLoadError(null);
    const result = await getPlaceRecap(recapId);
    if (generation !== requestGeneration.current) return;
    setDetail(result.data); setLoadError(result.error);
  }, [recapId]);
  useFocusEffect(useCallback(() => { void load(); return () => { requestGeneration.current += 1; }; }, [load]));
  const act = async (action: 'review' | 'publish' | 'regenerate' | 'archive' | 'restore') => {
    if (!recapId || acting) return;
    setActing(true);
    const result = await recapAction(recapId, action);
    setActing(false);
    if (!result) { Alert.alert('Couldn’t update recap', 'Please try again.'); return; } void load();
  };
  if (detail === undefined) return <SafeAreaView style={styles.safe}><ActivityIndicator color={color.signal} style={styles.loader} /></SafeAreaView>;
  if (!detail || !detail.version) {
    const message = loadError === 'disabled' ? 'Recaps are not enabled for this place yet.'
      : loadError === 'removed' ? 'This recap was removed from your archive.'
        : loadError === 'network' ? 'Check your connection and try again.'
          : 'This recap is unavailable right now.';
    return <SafeAreaView style={styles.safe}><View style={styles.center}><Text style={styles.title}>This recap is unavailable</Text><Text style={styles.body}>{message}</Text>{loadError === 'network' || loadError === 'server' ? <Button label="Try again" onPress={() => void load()} /> : null}</View></SafeAreaView>;
  }
  const version = detail.version; const canReview = version.status === 'draft'; const canPublish = version.status === 'reviewed';
  return <SafeAreaView style={styles.safe} edges={['bottom']}><Stack.Screen options={{ title: 'Travel recap', headerShown: true }} /><ScrollView contentContainerStyle={styles.content}>
    <Text style={styles.eyebrow}>VERSION {version.version_number} · {version.status.toUpperCase()}</Text><Text style={styles.heading}>{version.title}</Text>
    <Text style={styles.body}>{version.summary || 'Draft recap — review the suggested chapters before publishing.'}</Text>
    {detail.chapters.map((chapter) => <View key={chapter.id} style={styles.card}><Text style={styles.title}>{chapter.title}</Text><Text style={styles.body}>{chapter.body}</Text>{chapter.origin === 'compass_suggested' ? <Text style={styles.note}>Compass suggestion grounded in selected sources</Text> : null}</View>)}
    {detail.snapshots.filter((s) => s.snapshot_kind === 'post').map((source) => <View key={`${source.source_id}-snapshot`} style={styles.card}>{source.payload.thumbnailUrl ?? source.payload.mediaUrl ? <CachedImage source={{ uri: source.payload.thumbnailUrl ?? source.payload.mediaUrl! }} style={styles.image} /> : null}<Text style={styles.body}>{source.payload.caption ?? 'Archived source snapshot'}</Text></View>)}
    <Text style={styles.note}>Published versions preserve their captured place and media details. Regenerating creates a new draft; it never changes published history.</Text>
    <View style={styles.actions}>{canReview ? <Button label="Review suggestions" disabled={acting} onPress={() => act('review')} /> : null}{canPublish ? <Button label="Publish recap" disabled={acting} onPress={() => act('publish')} /> : null}<Button label="Create new version" disabled={acting} muted onPress={() => act('regenerate')} />{detail.recap.status === 'archived' ? <Button label="Restore recap" disabled={acting} muted onPress={() => act('restore')} /> : <Button label="Archive recap" disabled={acting} muted onPress={() => act('archive')} />}</View>
  </ScrollView></SafeAreaView>;
}
function Button({ label, onPress, muted = false, disabled = false }: { label: string; onPress: () => void; muted?: boolean; disabled?: boolean }) { return <Pressable disabled={disabled} onPress={onPress} style={[styles.button, muted && styles.muted, disabled && styles.disabled]}><Text style={[styles.buttonText, muted && styles.mutedText]}>{label}</Text></Pressable>; }
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: color.paper }, loader: { flex: 1 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }, content: { padding: space.lg, gap: space.md }, eyebrow: { ...typography.caption, color: color.signal }, heading: { ...t.heading, color: color.ink }, title: { ...t.bodyStrong, color: color.ink }, body: { ...typography.body, color: color.mute }, note: { ...typography.caption, color: color.mute }, card: { padding: space.md, gap: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised }, image: { height: 180, width: '100%', borderRadius: radius.sm }, actions: { gap: space.sm, marginTop: space.md }, button: { padding: space.md, alignItems: 'center', borderRadius: radius.md, backgroundColor: color.signal }, muted: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze }, disabled: { opacity: 0.5 }, buttonText: { ...t.bodyStrong, color: color.paper }, mutedText: { color: color.deep } });