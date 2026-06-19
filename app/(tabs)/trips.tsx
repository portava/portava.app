import React from 'react';
import { View, Text, ScrollView, Pressable, Image, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Plus, Users, CalendarDays, MapPin } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { Stamp } from '../../src/components/ui';
import { trips as mockTrips } from '../../src/data/cebu';
import { useSession } from '../../src/context/SessionContext';
import { useMyTrips } from '../../src/hooks/useBackend';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

export default function Trips() {
  const { configured, isAuthed } = useSession();
  const live = configured && isAuthed;
  const { data: realTrips, loading, error, reload } = useMyTrips();

  // refresh when returning to this screen
  React.useEffect(() => { if (live) reload(); }, [live, reload]);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader
        title="Trips"
        right={
          <Pressable style={styles.newBtn} onPress={() => router.push('/trip/new')}>
            <Plus size={16} color={color.onInk} />
            <Text style={styles.newBtnText}>New trip</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxxl }}>
        {live ? (
          <LiveTrips trips={realTrips} loading={loading} error={error} />
        ) : (
          mockTrips.map((tr) => (
            <Pressable key={tr.id} style={styles.card} onPress={() => router.push(`/trip/${tr.id}`)}>
              <Image source={{ uri: tr.coverUrl }} style={styles.cover} />
              <View style={styles.body}>
                <View style={styles.stampRow}>
                  <Stamp label={tr.destination.city} tone="deep" />
                  <Stamp label={tr.isPublic ? 'public' : 'private'} rotate={2} />
                </View>
                <Text style={styles.title}>{tr.title}</Text>
                <View style={styles.metaRow}><CalendarDays size={14} color={color.mute} /><Text style={styles.meta}>{tr.startDate} – {tr.endDate} · {tr.dayCount} days</Text></View>
                <View style={styles.metaRow}><Users size={14} color={color.mute} /><Text style={styles.meta}>{tr.collaborators.length + 1} travelers · {tr.savedPostIds.length} saved</Text></View>
              </View>
            </Pressable>
          ))
        )}
        <Pressable style={styles.empty} onPress={() => router.push('/trip/new')}>
          <Plus size={20} color={color.deep} />
          <Text style={styles.emptyText}>Start a new trip</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function LiveTrips({ trips, loading, error }: { trips: any[]; loading: boolean; error: string | null }) {
  if (loading) return <View style={styles.state}><ActivityIndicator color={color.signal} /></View>;
  if (error) return <View style={styles.state}><Text style={styles.stateText}>Couldn't load your trips. Pull to retry.</Text></View>;
  if (!trips.length) {
    return (
      <View style={styles.bigEmpty}>
        <MapPin size={28} color={color.deep} />
        <Text style={styles.bigEmptyTitle}>No trips yet</Text>
        <Text style={styles.bigEmptySub}>Create your first trip to start planning, saving places, and meeting travelers.</Text>
      </View>
    );
  }
  return (
    <>
      {trips.map((tr) => (
        <Pressable key={tr.id} style={styles.card} onPress={() => router.push(`/trip/${tr.id}`)}>
          {tr.coverUrl ? <Image source={{ uri: tr.coverUrl }} style={styles.cover} /> : <View style={[styles.cover, { backgroundColor: color.deep }]} />}
          <View style={styles.body}>
            <View style={styles.stampRow}>
              <Stamp label={tr.destinationCity} tone="deep" />
              <Stamp label={tr.visibility} rotate={2} />
            </View>
            <Text style={styles.title}>{tr.title}</Text>
            <View style={styles.metaRow}>
              <CalendarDays size={14} color={color.mute} />
              <Text style={styles.meta}>{tr.startDate ?? 'Dates TBD'}{tr.endDate ? ` – ${tr.endDate}` : ''} · {tr.status}</Text>
            </View>
          </View>
        </Pressable>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  newBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.ink, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill },
  newBtnText: { ...t.small, fontWeight: '700', color: color.onInk },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.lg, overflow: 'hidden', ...shadow.card },
  cover: { width: '100%', height: 150, backgroundColor: color.haze },
  body: { padding: space.lg, gap: space.sm },
  stampRow: { flexDirection: 'row', gap: space.sm },
  title: { ...t.title, color: color.ink },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { ...t.small, color: color.mute },
  empty: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.xl, borderRadius: radius.lg, borderWidth: 1.5, borderColor: color.haze, borderStyle: 'dashed' },
  emptyText: { ...t.body, color: color.deep, fontWeight: '600' },
  state: { padding: space.xxl, alignItems: 'center' },
  stateText: { ...t.small, color: color.mute },
  bigEmpty: { alignItems: 'center', gap: space.sm, padding: space.xxl, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze },
  bigEmptyTitle: { ...t.title, color: color.ink, fontSize: 18 },
  bigEmptySub: { ...t.small, color: color.mute, textAlign: 'center' },
});
