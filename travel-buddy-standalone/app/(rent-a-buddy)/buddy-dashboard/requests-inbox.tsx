import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Clock, Users, DollarSign, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState, TravelEmptyState } from '../../../src/components/primitives';
import { getMatchingRequests, type BuddyRequest } from '../../../src/services/rentABuddy';

function RequestCard({ item, onPress }: { item: BuddyRequest; onPress: () => void }) {
  const timeLeft = item.expiresAt
    ? Math.max(0, Math.round((new Date(item.expiresAt).getTime() - Date.now()) / 60000))
    : null;
  const hoursLeft = timeLeft != null ? Math.floor(timeLeft / 60) : null;
  const minsLeft = timeLeft != null ? timeLeft % 60 : null;
  const expiringSoon = timeLeft != null && timeLeft < 60;

  return (
    <Pressable style={c.card} onPress={onPress}>
      <View style={c.header}>
        <View style={c.categoryBadge}>
          <Text style={c.categoryText}>{item.category}</Text>
        </View>
        {timeLeft != null ? (
          <View style={[c.timeBadge, expiringSoon && c.timeBadgeUrgent]}>
            <Clock size={11} color={expiringSoon ? color.signal : color.mute} />
            <Text style={[c.timeText, expiringSoon && c.timeTextUrgent]}>
              {hoursLeft != null && hoursLeft > 0 ? `${hoursLeft}h ` : ''}{minsLeft}m left
            </Text>
          </View>
        ) : null}
      </View>

      <View style={c.row}>
        <MapPin size={14} color={color.mute} />
        <Text style={c.city}>{item.city}</Text>
        {item.languageNeeded ? <Text style={c.lang}>· {item.languageNeeded}</Text> : null}
      </View>

      <View style={c.statsRow}>
        <View style={c.stat}>
          <Clock size={13} color={color.mute} />
          <Text style={c.statLabel}>{item.durationMinutes / 60}h</Text>
        </View>
        {item.groupSize > 1 ? (
          <View style={c.stat}>
            <Users size={13} color={color.mute} />
            <Text style={c.statLabel}>{item.groupSize} people</Text>
          </View>
        ) : null}
        {item.budgetMaxUsd != null ? (
          <View style={c.stat}>
            <DollarSign size={13} color={color.mute} />
            <Text style={c.statLabel}>Up to ${item.budgetMaxUsd}/hr</Text>
          </View>
        ) : null}
      </View>

      {item.notes ? <Text style={c.notes} numberOfLines={2}>{item.notes}</Text> : null}

      <View style={c.offerBtn}>
        <Text style={c.offerBtnLabel}>Send Offer</Text>
      </View>
    </Pressable>
  );
}

export default function RequestsInbox() {
  const insets = useSafeAreaInsets();
  const [requests, setRequests] = useState<BuddyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const res = await getMatchingRequests();
    if (!silent) setLoading(false);
    setRefreshing(false);
    if (!res.ok) { setError(res.error); return; }
    setRequests(res.data.requests);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <TravelLoadingState label="Loading requests…" />;
  if (error) return <TravelErrorState title="Failed to load" sub={error} onRetry={() => load()} />;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <View>
          <Text style={s.title}>Traveler Requests</Text>
          <Text style={s.sub}>{requests.length} open in your city</Text>
        </View>
      </View>

      <FlatList
        data={requests}
        keyExtractor={(r) => r.id}
        contentContainerStyle={[s.list, { paddingBottom: insets.bottom + space.xxxl }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
        renderItem={({ item }) => (
          <RequestCard
            item={item}
            onPress={() => router.push({ pathname: '/(rent-a-buddy)/buddy-dashboard/offer-create', params: { requestId: item.id } } as any)}
          />
        )}
        ListEmptyComponent={
          <TravelEmptyState
            title="No matching requests"
            sub="When travelers post requests in your city and category, they'll appear here."
          />
        }
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: space.xs },
  title: { ...t.heading, color: color.ink },
  sub: { ...t.small, color: color.mute },
  list: { padding: space.lg, gap: space.md },
});

const c = StyleSheet.create({
  card: { backgroundColor: color.paper, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, marginBottom: space.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md },
  categoryBadge: { backgroundColor: `${color.deep}15`, borderRadius: 20, paddingHorizontal: 10, paddingVertical: 4 },
  categoryText: { ...t.small, color: color.deep, fontWeight: '700' },
  timeBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.haze, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 3 },
  timeBadgeUrgent: { backgroundColor: `${color.signal}15` },
  timeText: { ...t.small, color: color.mute },
  timeTextUrgent: { color: color.signal, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  city: { ...t.body, color: color.ink, fontWeight: '600' },
  lang: { ...t.small, color: color.mute },
  statsRow: { flexDirection: 'row', gap: space.lg, marginBottom: space.sm },
  stat: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  statLabel: { ...t.small, color: color.mute },
  notes: { ...t.small, color: color.mute, fontStyle: 'italic', marginBottom: space.md },
  offerBtn: { backgroundColor: color.deep, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center' },
  offerBtnLabel: { ...t.body, color: '#fff', fontWeight: '700' },
});
