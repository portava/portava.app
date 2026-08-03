import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFeatureFlags } from '../../../src/context/FeatureFlagsContext.tsx';
import { createSharedMoment, listSharedMoments, type SharedMoment } from '../../../src/services/sharedMoments.ts';
import { color, radius, space, type as t, typography } from '../../../src/theme/tokens.ts';

export default function PlaceMomentsScreen() {
  const { id, placeDayId } = useLocalSearchParams<{ id: string; placeDayId?: string }>();
  const placeId = Array.isArray(id) ? id[0] : id;
  const dayId = Array.isArray(placeDayId) ? placeDayId[0] : placeDayId;
  const { isEnabled } = useFeatureFlags();
  const available = isEnabled('external_places_enabled') && isEnabled('place_days_enabled') && isEnabled('shared_moments_enabled');
  const [moments, setMoments] = useState<SharedMoment[] | null>(null);
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => setMoments((await listSharedMoments(dayId))?.moments ?? []), [dayId]);
  useEffect(() => { if (available) void load(); }, [available, load]);
  const create = async () => {
    if (!title.trim() || creating) return;
    setCreating(true);
    const result = await createSharedMoment({ title: title.trim(), placeId, placeDayId: dayId });
    setCreating(false);
    if (!result) { Alert.alert('Couldn’t create Moment', 'Please try again.'); return; }
    setTitle('');
    router.push(`/shared-moments/${result.moment.id}` as any);
  };

  return <SafeAreaView style={styles.safe} edges={['bottom']}>
    <Stack.Screen options={{ title: 'Shared Moments', headerShown: true }} />
    {!available ? <View style={styles.center}><Text style={styles.title}>Shared Moments are unavailable</Text><Text style={styles.body}>This space opens when Live Places and Shared Moments are enabled.</Text></View> :
      moments === null ? <View style={styles.center}><ActivityIndicator color={color.signal} /></View> :
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>Gather travel activity intentionally</Text>
        <Text style={styles.body}>Nothing is added or shared until a person chooses it.</Text>
        <View style={styles.create}><TextInput value={title} onChangeText={setTitle} placeholder="Name this Moment" placeholderTextColor={color.faint} style={styles.input} maxLength={140} /><Pressable testID="create-shared-moment" onPress={create} style={[styles.button, (!title.trim() || creating) && styles.disabled]} disabled={!title.trim() || creating}><Text style={styles.buttonText}>{creating ? 'Creating…' : 'Create'}</Text></Pressable></View>
        {moments.length === 0 ? <View style={styles.empty}><Text style={styles.title}>No Shared Moments yet</Text><Text style={styles.body}>Start one for people who want to contribute together.</Text></View> :
          moments.map((moment) => <Pressable key={moment.id} style={styles.card} onPress={() => router.push(`/shared-moments/${moment.id}` as any)}><Text style={styles.title}>{moment.title}</Text>{moment.description ? <Text style={styles.body}>{moment.description}</Text> : null}<Text style={styles.meta}>{moment.role === 'owner' ? 'You manage this Moment' : 'Member'}</Text></Pressable>)}
      </ScrollView>}
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.paper }, content: { padding: space.lg, gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl }, heading: { ...t.heading, color: color.ink },
  title: { ...t.bodyStrong, color: color.ink }, body: { ...typography.body, color: color.mute, textAlign: 'center' },
  create: { gap: space.sm, marginTop: space.sm }, input: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, ...typography.body, color: color.ink },
  button: { backgroundColor: color.signal, borderRadius: radius.md, padding: space.md, alignItems: 'center' }, disabled: { opacity: .5 }, buttonText: { ...t.bodyStrong, color: color.paper },
  empty: { padding: space.xl, gap: space.sm, alignItems: 'center' }, card: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: space.xs },
  meta: { ...typography.caption, color: color.signal },
});