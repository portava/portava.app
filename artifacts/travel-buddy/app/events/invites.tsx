/**
 * Event invites screen — /events/invites
 *
 * Shows pending event invites with accept / decline actions.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, RefreshControl,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Inbox, CalendarClock, MapPin } from 'lucide-react-native';
import {
  getMyEventInvites, acceptEventInvite, declineEventInvite,
  type EventInvite,
} from '../../src/services/events';
import { Avatar } from '../../src/components/ui';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import { formatEventLocation } from '../../src/lib/location/formatEventLocation';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'Date TBD';
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function EventInvitesScreen() {
  const insets = useSafeAreaInsets();
  const [invites, setInvites] = useState<EventInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    const res = await getMyEventInvites();
    if (!res.ok) setError(res.message ?? 'Failed to load invites');
    else setInvites(res.data?.invites ?? []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleAccept(invite: EventInvite) {
    setActionLoading(invite.id);
    const res = await acceptEventInvite(invite.eventId, invite.id);
    setActionLoading(null);
    if (res.ok) {
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
      router.push(`/event/${invite.eventId}` as any);
    }
  }

  async function handleDecline(invite: EventInvite) {
    setActionLoading(invite.id);
    const res = await declineEventInvite(invite.eventId, invite.id);
    setActionLoading(null);
    if (res.ok) setInvites((prev) => prev.filter((i) => i.id !== invite.id));
  }

  const pending = invites.filter((i) => i.status === 'pending');

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Event Invites</Text>
        {pending.length > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{pending.length}</Text>
          </View>
        )}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => load()} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : pending.length === 0 ? (
        <View style={styles.center}>
          <Inbox size={40} color={color.faint} />
          <Text style={styles.emptyTitle}>No pending invites</Text>
          <Text style={styles.emptySub}>Event invites from your friends will appear here.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={color.signal} />
          }
        >
          {pending.map((invite) => {
            const ev = invite.event;
            const busy = actionLoading === invite.id;
            return (
              <View key={invite.id} style={styles.card}>
                {invite.inviter && (
                  <View style={styles.inviterRow}>
                    <Avatar uri={invite.inviter.avatarUrl ?? ''} size={28} />
                    <Text style={styles.inviterText}>
                      <Text style={styles.inviterName}>
                        {invite.inviter.displayName ?? invite.inviter.handle ?? 'Someone'}
                      </Text>
                      {' '}invited you to an event
                    </Text>
                  </View>
                )}
                {ev && (
                  <Pressable onPress={() => router.push(`/event/${ev.id}` as any)}>
                    <Text style={styles.eventTitle} numberOfLines={2}>{ev.title}</Text>
                    {ev.startsAt && (
                      <View style={styles.metaRow}>
                        <CalendarClock size={12} color={color.mute} />
                        <Text style={styles.metaText}>{formatDate(ev.startsAt)}</Text>
                      </View>
                    )}
                    {ev.locationName && (
                      <View style={styles.metaRow}>
                        <MapPin size={12} color={color.mute} />
                        <Text style={styles.metaText} numberOfLines={1}>
                          {formatEventLocation(ev.locationName, ev.city)}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                )}
                <View style={styles.actions}>
                  <Pressable
                    style={[styles.acceptBtn, busy && { opacity: 0.6 }]}
                    onPress={() => handleAccept(invite)}
                    disabled={busy}
                  >
                    {busy
                      ? <ActivityIndicator size="small" color={color.onInk} />
                      : <Text style={styles.acceptBtnText}>Accept</Text>}
                  </Pressable>
                  <Pressable
                    style={[styles.declineBtn, busy && { opacity: 0.6 }]}
                    onPress={() => handleDecline(invite)}
                    disabled={busy}
                  >
                    <Text style={styles.declineBtnText}>Decline</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:     { flex: 1, backgroundColor: color.paper },
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised, gap: space.md },
  backBtn:       { padding: 4 },
  headerTitle:   { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  badge:         { backgroundColor: color.signal, minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText:     { ...t.small, color: color.onInk, fontWeight: '700', fontSize: 11 },
  center:        { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md },
  errorText:     { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn:      { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText:     { ...t.small, color: color.onInk, fontWeight: '700' },
  emptyTitle:    { ...t.title, color: color.ink, fontSize: 18, fontWeight: '800' },
  emptySub:      { ...t.body, color: color.mute, textAlign: 'center' },
  list:          { padding: space.lg, gap: space.md, paddingBottom: 130 },
  card:          { backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.lg, gap: space.md, ...shadow.card },
  inviterRow:    { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  inviterText:   { ...t.small, color: color.mute, flex: 1 },
  inviterName:   { fontWeight: '700', color: color.ink },
  eventTitle:    { ...t.body, color: color.ink, fontWeight: '700', fontSize: 16 },
  metaRow:       { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaText:      { ...t.small, color: color.mute, flex: 1 },
  actions:       { flexDirection: 'row', gap: space.sm },
  acceptBtn:     { flex: 1, backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.sm, alignItems: 'center' },
  acceptBtnText: { ...t.body, color: color.onInk, fontWeight: '700' },
  declineBtn:    { flex: 1, backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingVertical: space.sm, alignItems: 'center', borderWidth: 1, borderColor: color.haze },
  declineBtnText:{ ...t.body, color: color.mute, fontWeight: '600' },
});
