import React from 'react';
import {
  View, Text, ScrollView, Pressable, Image,
  ActivityIndicator, StyleSheet, Alert,
} from 'react-native';
import { router } from 'expo-router';
import {
  Plus, Users, CalendarDays, MapPin, CalendarClock,
  ChevronRight, Check, X, UserCircle,
} from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { Stamp } from '../../src/components/ui';
import { trips as mockTrips } from '../../src/data/cebu';
import { useSession } from '../../src/context/SessionContext';
import { useMyTrips, usePendingTripInvites } from '../../src/hooks/useBackend';
import { useUnreadCounts } from '../../src/hooks/useMessaging';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import { acceptTripInvite, declineTripInvite, type TripInvite } from '../../src/services/trips';

function MeetupsShortcut({ count }: { count: number }) {
  const label = count > 9 ? '9+' : count > 0 ? String(count) : null;
  return (
    <Pressable style={styles.meetupsCard} onPress={() => router.push('/meetups' as any)}>
      <View>
        <View style={styles.meetupsIcon}>
          <CalendarClock size={18} color={color.onInk} />
        </View>
        {label ? (
          <View style={styles.meetupsBadge}>
            <Text style={styles.meetupsBadgeText}>{label}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.meetupsText}>
        <Text style={styles.meetupsTitle}>Meetups</Text>
        <Text style={styles.meetupsSub}>View and plan get-togethers</Text>
      </View>
      <ChevronRight size={18} color={color.mute} />
    </Pressable>
  );
}

function InviteCard({ invite, onDone }: { invite: TripInvite; onDone: () => void }) {
  const [busy, setBusy] = React.useState<'accept' | 'decline' | null>(null);

  async function handle(action: 'accept' | 'decline') {
    setBusy(action);
    try {
      if (action === 'accept') {
        await acceptTripInvite(invite.tripId);
      } else {
        await declineTripInvite(invite.tripId);
      }
      onDone();
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Something went wrong. Please try again.');
      setBusy(null);
    }
  }

  const dateStr = invite.startDate
    ? invite.endDate
      ? `${invite.startDate} – ${invite.endDate}`
      : invite.startDate
    : 'Dates TBD';

  const destination = invite.destinationCountry
    ? `${invite.destinationCity}, ${invite.destinationCountry}`
    : invite.destinationCity;

  return (
    <View style={styles.inviteCard}>
      {invite.coverUrl ? (
        <Image source={{ uri: invite.coverUrl }} style={styles.inviteCover} />
      ) : (
        <View style={[styles.inviteCover, styles.inviteCoverPlaceholder]}>
          <MapPin size={22} color={color.onInk} />
        </View>
      )}
      <View style={styles.inviteBody}>
        <View style={styles.inviteInviterRow}>
          {invite.inviter?.avatarUrl ? (
            <Image source={{ uri: invite.inviter.avatarUrl }} style={styles.inviterAvatar} />
          ) : (
            <View style={styles.inviterAvatarPlaceholder}>
              <UserCircle size={14} color={color.mute} />
            </View>
          )}
          <Text style={styles.inviterLabel} numberOfLines={1}>
            <Text style={styles.inviterName}>{invite.inviter?.name ?? 'Someone'}</Text>
            {' invited you'}
          </Text>
        </View>
        <Text style={styles.inviteTitle} numberOfLines={1}>{invite.tripTitle}</Text>
        <View style={styles.inviteMeta}>
          <MapPin size={12} color={color.mute} />
          <Text style={styles.inviteMetaText} numberOfLines={1}>{destination}</Text>
        </View>
        <View style={styles.inviteMeta}>
          <CalendarDays size={12} color={color.mute} />
          <Text style={styles.inviteMetaText}>{dateStr}</Text>
        </View>
        <View style={styles.inviteActions}>
          <Pressable
            style={[styles.inviteBtn, styles.inviteBtnDecline]}
            onPress={() => handle('decline')}
            disabled={busy !== null}
          >
            {busy === 'decline'
              ? <ActivityIndicator size={14} color={color.mute} />
              : <X size={14} color={color.mute} />}
            <Text style={styles.inviteBtnDeclineText}>Decline</Text>
          </Pressable>
          <Pressable
            style={[styles.inviteBtn, styles.inviteBtnAccept]}
            onPress={() => handle('accept')}
            disabled={busy !== null}
          >
            {busy === 'accept'
              ? <ActivityIndicator size={14} color={color.onInk} />
              : <Check size={14} color={color.onInk} />}
            <Text style={styles.inviteBtnAcceptText}>Accept</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function PendingInvitesSection({ onAccepted }: { onAccepted: () => void }) {
  const { invites, reload } = usePendingTripInvites();

  if (!invites.length) return null;

  async function handleDone() {
    await reload();
    onAccepted();
  }

  return (
    <View style={styles.inviteSection}>
      <Text style={styles.inviteSectionTitle}>Trip Invites</Text>
      {invites.map((inv) => (
        <InviteCard key={inv.tripId} invite={inv} onDone={handleDone} />
      ))}
    </View>
  );
}

export default function Trips() {
  const { configured, isAuthed } = useSession();
  const live = configured && isAuthed;
  const { data: realTrips, loading, error, reload } = useMyTrips();
  const { meetups: meetupCount } = useUnreadCounts();

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
        <MeetupsShortcut count={meetupCount} />
        {live && <PendingInvitesSection onAccepted={reload} />}
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
  meetupsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.md,
    ...shadow.card,
    borderWidth: 1,
    borderColor: color.haze,
  },
  meetupsIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meetupsText: {
    flex: 1,
    gap: 2,
  },
  meetupsTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontWeight: '700',
  },
  meetupsSub: {
    ...t.small,
    color: color.mute,
  },
  meetupsBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  meetupsBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    lineHeight: 11,
  },
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

  inviteSection: { gap: space.sm },
  inviteSectionTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  inviteCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
    ...shadow.card,
  },
  inviteCover: { width: '100%', height: 90 },
  inviteCoverPlaceholder: {
    backgroundColor: color.deep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inviteBody: { padding: space.md, gap: space.sm },
  inviteInviterRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inviterAvatar: { width: 20, height: 20, borderRadius: 10 },
  inviterAvatarPlaceholder: { width: 20, height: 20, borderRadius: 10, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  inviterLabel: { ...t.small, color: color.mute, flex: 1 },
  inviterName: { fontWeight: '600', color: color.ink },
  inviteTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  inviteMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  inviteMetaText: { ...t.small, color: color.mute },
  inviteActions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  inviteBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  inviteBtnDecline: {
    backgroundColor: color.haze,
  },
  inviteBtnDeclineText: { ...t.small, color: color.mute, fontWeight: '600' },
  inviteBtnAccept: {
    backgroundColor: color.ink,
  },
  inviteBtnAcceptText: { ...t.small, color: color.onInk, fontWeight: '700' },
});
