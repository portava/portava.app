import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { archiveSharedMoment, getSharedMoment, getSharedMomentFeed, leaveSharedMoment, type SharedMomentDetail, type SharedMomentFeedItem } from '../../src/services/sharedMoments.ts';
import { CachedImage } from '../../src/components/CachedImage.tsx';
import { color, radius, space, type as t, typography } from '../../src/theme/tokens.ts';

export default function SharedMomentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>(); const momentId = Array.isArray(id) ? id[0] : id;
  const [detail, setDetail] = useState<SharedMomentDetail | null | undefined>(undefined);
  const [feed, setFeed] = useState<SharedMomentFeedItem[]>([]);
  const load = useCallback(async () => { if (!momentId) return; const next = await getSharedMoment(momentId); setDetail(next); if (next) setFeed((await getSharedMomentFeed(momentId))?.items ?? []); }, [momentId]);
  useEffect(() => { void load(); }, [load]);
  const leave = async () => { if (momentId && await leaveSharedMoment(momentId)) router.back(); else Alert.alert('Couldn’t leave Moment'); };
  const archive = async () => { if (momentId && await archiveSharedMoment(momentId)) void load(); else Alert.alert('Couldn’t archive Moment'); };
  if (detail === undefined) return <SafeAreaView style={styles.safe}><ActivityIndicator style={styles.loader} color={color.signal} /></SafeAreaView>;
  if (!detail) return <SafeAreaView style={styles.safe}><View style={styles.center}><Text style={styles.title}>This Moment is unavailable</Text><Text style={styles.body}>You may need an invitation before it can be opened.</Text></View></SafeAreaView>;
  const canManage = detail.moment.role === 'owner' || detail.moment.role === 'manager';
  return <SafeAreaView style={styles.safe} edges={['bottom']}><Stack.Screen options={{ title: detail.moment.title, headerShown: true }} /><ScrollView contentContainerStyle={styles.content}>
    <Text style={styles.heading}>{detail.moment.title}</Text>{detail.moment.description ? <Text style={styles.body}>{detail.moment.description}</Text> : null}
    <Text style={styles.member}>{detail.members.length} people joined by choice</Text>
    <View style={styles.chat}><Text style={styles.title}>Moment chat</Text><Text style={styles.body}>{detail.chat.available ? 'Chat is available for this Moment.' : detail.chat.reason}</Text></View>
    <Text style={styles.section}>Approved contributions</Text>{feed.length ? feed.map((item) => <View key={item.id} style={styles.card}>{item.thumbnailUrl || item.mediaUrl ? <CachedImage source={{ uri: item.thumbnailUrl ?? item.mediaUrl ?? '' }} style={styles.image} /> : null}<Text style={styles.body}>{item.caption ?? 'Shared a contribution'}</Text></View>) : <Text style={styles.body}>Approved contributions will appear here. Source posts remain private unless they are already safe for you to view.</Text>}
    {detail.moment.status === 'active' ? <View style={styles.actions}>{canManage ? <Pressable onPress={archive} style={styles.secondary}><Text style={styles.secondaryText}>Archive Moment</Text></Pressable> : <Pressable onPress={leave} style={styles.secondary}><Text style={styles.secondaryText}>Leave Moment</Text></Pressable>}</View> : <Text style={styles.member}>Archived</Text>}
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.paper }, loader: { flex: 1 }, center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space.xl }, content: { padding: space.lg, gap: space.md },
  heading: { ...t.heading, color: color.ink }, title: { ...t.bodyStrong, color: color.ink }, body: { ...typography.body, color: color.mute }, member: { ...typography.caption, color: color.signal },
  chat: { borderLeftWidth: 3, borderLeftColor: color.signal, paddingLeft: space.md, gap: space.xs }, section: { ...t.bodyStrong, color: color.ink, marginTop: space.md },
  card: { backgroundColor: color.paperRaised, borderColor: color.haze, borderWidth: 1, borderRadius: radius.md, overflow: 'hidden', padding: space.md, gap: space.sm }, image: { width: '100%', height: 200, borderRadius: radius.sm },
  actions: { marginTop: space.lg }, secondary: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, alignItems: 'center' }, secondaryText: { ...t.bodyStrong, color: color.deep },
});