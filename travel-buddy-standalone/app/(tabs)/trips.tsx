import React, { useState, useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { postCompassFrontloadEvent } from '../../src/services/compass';
import {
  View, Text, ScrollView, Pressable, Image,
  ActivityIndicator, StyleSheet, Alert, SectionList,
} from 'react-native';
import { router } from 'expo-router';
import { NotificationBell } from '../../src/components/NotificationBell';
import {
  Plus, Users, CalendarDays, MapPin, CalendarClock,
  ChevronRight, Check, X, UserCircle, Plane, Clock3,
  FileText, CheckCheck,
} from 'lucide-react-native';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { Stamp } from '../../src/components/ui';
import { trips as mockTrips } from '../../src/data/cebu';
import { useSession } from '../../src/context/SessionContext';
import { useMyTrips, usePendingTripInvites, useIncomingJoinRequests } from '../../src/hooks/useBackend';
import { useUnreadCounts } from '../../src/hooks/useMessaging';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import {
  acceptTripInvite, declineTripInvite, approveJoinRequest, declineJoinRequest,
  type TripInvite, type JoinRequest, type TripRow,
} from '../../src/services/trips';

/* ─── Status helpers ─────────────────────────────────────────────────────────── */

function statusColor(status: string): string {
  switch (status) {
    case 'active': return '#1A8C4E';
    case 'planning': case 'upcoming': return color.signal;
    case 'draft': return color.mute;
    case 'completed': return color.deep;
    case 'cancelled': case 'archived': return color.faint;
    default: return color.mute;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'active': return 'Active';
    case 'planning': return 'Planning';
    case 'upcoming': return 'Upcoming';
    case 'draft': return 'Draft';
    case 'completed': return 'Completed';
    case 'cancelled': return 'Cancelled';
    case 'archived': return 'Archived';
    default: return status;
  }
}

function sectionOrder(status: string): number {
  switch (status) {
    case 'active': return 0;
    case 'planning': case 'upcoming': return 1;
    case 'draft': return 2;
    case 'completed': return 3;
    case 'cancelled': case 'archived': return 4;
    default: return 5;
  }
}

function buildSections(trips: TripRow[]): { title: string; status: string; data: TripRow[] }[] {
  const groups: Record<string, TripRow[]> = {};
  for (const trip of trips) {
    const key = trip.status === 'upcoming' ? 'planning' : trip.status;
    if (!groups[key]) groups[key] = [];
    groups[key].push(trip);
  }
  const sectionTitles: Record<string, string> = {
    active: 'Active',
    planning: 'Upcoming',
    draft: 'Drafts',
    completed: 'Past',
    cancelled: 'Cancelled',
  };
  return Object.entries(groups)
    .map(([status, data]) => ({
      title: sectionTitles[status] ?? status,
      status,
      data,
    }))
    .sort((a, b) => sectionOrder(a.status) - sectionOrder(b.status));
}

/* ─── Meetups shortcut ───────────────────────────────────────────────────────── */

function MeetupsShortcut({ count }: { count: number }) {
  const label = count > 9 ? '9+' : count > 0 ? String(count) : null;
  return (
    <Pressable style={styles.meetupsCard} onPress={() => router.push('/meetups' as any)}>
      <View>
        <View style={styles.meetupsIcon}><CalendarClock size={18} color={color.onInk} /></View>
        {label ? <View style={styles.meetupsBadge}><Text style={styles.meetupsBadgeText}>{label}</Text></View> : null}
      </View>
      <View style={styles.meetupsText}>
        <Text style={styles.meetupsTitle}>Meetups</Text>
        <Text style={styles.meetupsSub}>View and plan get-togethers</Text>
      </View>
      <ChevronRight size={18} color={color.mute} />
    </Pressable>
  );
}

/* ─── Invite card ────────────────────────────────────────────────────────────── */

function InviteCard({ invite, onDone }: { invite: TripInvite; onDone: () => void }) {
  const [busy, setBusy] = React.useState<'accept' | 'decline' | null>(null);

  async function handle(action: 'accept' | 'decline') {
    setBusy(action);
    try {
      if (action === 'accept') { await acceptTripInvite(invite.tripId); }
      else { await declineTripInvite(invite.tripId); }
      onDone();
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Something went wrong. Please try again.');
      setBusy(null);
    }
  }

  const dateStr = invite.startDate
    ? invite.endDate ? `${invite.startDate} – ${invite.endDate}` : invite.startDate
    : 'Dates TBD';
  const destination = invite.destinationCountry
    ? `${invite.destinationCity}, ${invite.destinationCountry}`
    : invite.destinationCity;

  return (
    <View style={styles.inviteCard}>
      {invite.coverUrl
        ? <Image source={{ uri: invite.coverUrl }} style={styles.inviteCover} />
        : <View style={[styles.inviteCover, styles.inviteCoverPH]}><MapPin size={22} color={color.onInk} /></View>}
      <View style={styles.inviteBody}>
        <View style={styles.inviteRow}>
          {invite.inviter?.avatarUrl
            ? <Image source={{ uri: invite.inviter.avatarUrl }} style={styles.inviterAv} />
            : <View style={styles.inviterAvPH}><UserCircle size={14} color={color.mute} /></View>}
          <Text style={styles.inviterLabel} numberOfLines={1}>
            <Text style={styles.inviterName}>{invite.inviter?.name ?? 'Someone'}</Text>{' invited you'}
          </Text>
        </View>
        <Text style={styles.inviteTitle} numberOfLines={1}>{invite.tripTitle}</Text>
        <View style={styles.inviteMeta}><MapPin size={12} color={color.mute} /><Text style={styles.inviteMetaTxt} numberOfLines={1}>{destination}</Text></View>
        <View style={styles.inviteMeta}><CalendarDays size={12} color={color.mute} /><Text style={styles.inviteMetaTxt}>{dateStr}</Text></View>
        <View style={styles.inviteActions}>
          <Pressable style={[styles.inviteBtn, styles.inviteBtnDec]} onPress={() => handle('decline')} disabled={busy !== null}>
            {busy === 'decline' ? <ActivityIndicator size={14} color={color.mute} /> : <X size={14} color={color.mute} />}
            <Text style={styles.inviteBtnDecTxt}>Decline</Text>
          </Pressable>
          <Pressable style={[styles.inviteBtn, styles.inviteBtnAcc]} onPress={() => handle('accept')} disabled={busy !== null}>
            {busy === 'accept' ? <ActivityIndicator size={14} color={color.onInk} /> : <Check size={14} color={color.onInk} />}
            <Text style={styles.inviteBtnAccTxt}>Accept</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/* ─── Join request card ──────────────────────────────────────────────────────── */

function JoinRequestCard({ req, onDone }: { req: JoinRequest; onDone: () => void }) {
  const [busy, setBusy] = React.useState<'approve' | 'decline' | null>(null);

  async function handle(action: 'approve' | 'decline') {
    setBusy(action);
    try {
      if (action === 'approve') await approveJoinRequest(req.tripId, req.requestId);
      else await declineJoinRequest(req.tripId, req.requestId);
      onDone();
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Something went wrong.');
      setBusy(null);
    }
  }

  return (
    <View style={styles.jrCard}>
      {req.requester?.avatarUrl
        ? <Image source={{ uri: req.requester.avatarUrl }} style={styles.jrAv} />
        : <View style={styles.jrAvPH}><UserCircle size={20} color={color.mute} /></View>}
      <View style={{ flex: 1 }}>
        <Text style={styles.jrName} numberOfLines={1}>{req.requester?.name ?? req.requester?.handle ?? 'Someone'}</Text>
        <Text style={styles.jrMeta} numberOfLines={1}>Wants to join · {req.tripTitle}</Text>
      </View>
      <View style={styles.jrBtns}>
        <Pressable style={styles.jrDec} onPress={() => handle('decline')} disabled={busy !== null}>
          {busy === 'decline' ? <ActivityIndicator size={12} color={color.mute} /> : <X size={14} color={color.mute} />}
        </Pressable>
        <Pressable style={styles.jrAcc} onPress={() => handle('approve')} disabled={busy !== null}>
          {busy === 'approve' ? <ActivityIndicator size={12} color={color.onInk} /> : <Check size={14} color={color.onInk} />}
        </Pressable>
      </View>
    </View>
  );
}

/* ─── Pending invites section ────────────────────────────────────────────────── */

function PendingInvitesSection({ onAccepted }: { onAccepted: () => void }) {
  const { invites, reload } = usePendingTripInvites();
  if (!invites.length) return null;
  async function handleDone() { await reload(); onAccepted(); }
  return (
    <View style={styles.sectionWrap}>
      <Text style={styles.sectionTitle}>Trip Invites</Text>
      {invites.map((inv) => <InviteCard key={inv.tripId} invite={inv} onDone={handleDone} />)}
    </View>
  );
}

/* ─── Join requests section ──────────────────────────────────────────────────── */

function JoinRequestsSection({ onDone }: { onDone: () => void }) {
  const { requests, loading, reload } = useIncomingJoinRequests();
  if (loading || !requests.length) return null;
  async function handleDone() { await reload(); onDone(); }
  return (
    <View style={styles.sectionWrap}>
      <Text style={styles.sectionTitle}>Join Requests</Text>
      {requests.map((r) => <JoinRequestCard key={r.requestId} req={r} onDone={handleDone} />)}
    </View>
  );
}

/* ─── Trip card ──────────────────────────────────────────────────────────────── */

function TripCard({ trip }: { trip: TripRow }) {
  const sc = statusColor(trip.status);
  const dest = trip.destinationCountry
    ? `${trip.destinationCity}, ${trip.destinationCountry}`
    : trip.destinationCity;
  const dates = trip.startDate
    ? trip.endDate ? `${trip.startDate} – ${trip.endDate}` : `From ${trip.startDate}`
    : 'Dates TBD';
  return (
    <Pressable style={styles.card} onPress={() => router.push(`/trip/${trip.id}`)}>
      {trip.coverUrl
        ? <Image source={{ uri: trip.coverUrl }} style={styles.cover} />
        : <View style={[styles.cover, styles.coverPH]}><MapPin size={20} color={color.onInk} /></View>}
      <View style={styles.body}>
        <View style={styles.cardTop}>
          <View style={[styles.statusPill, { backgroundColor: sc + '18', borderColor: sc + '60' }]}>
            <Text style={[styles.statusTxt, { color: sc }]}>{statusLabel(trip.status)}</Text>
          </View>
          <Stamp label={trip.visibility} rotate={-1} />
        </View>
        <Text style={styles.cardTitle} numberOfLines={1}>{trip.title}</Text>
        <View style={styles.cardMeta}><MapPin size={12} color={color.mute} /><Text style={styles.cardMetaTxt} numberOfLines={1}>{dest}</Text></View>
        <View style={styles.cardMeta}><CalendarDays size={12} color={color.mute} /><Text style={styles.cardMetaTxt}>{dates}</Text></View>
      </View>
    </Pressable>
  );
}

/* ─── Section list ───────────────────────────────────────────────────────────── */

const SECTION_ICONS: Record<string, React.ReactNode> = {
  Active: <CheckCheck size={14} color={color.signal} />,
  Upcoming: <Plane size={14} color={color.signal} />,
  Drafts: <FileText size={14} color={color.mute} />,
  Past: <Clock3 size={14} color={color.mute} />,
  Cancelled: <X size={14} color={color.faint} />,
};

function SectionedTrips({ trips }: { trips: TripRow[] }) {
  const sections = buildSections(trips);
  if (!sections.length) {
    return (
      <View style={styles.bigEmpty}>
        <MapPin size={28} color={color.deep} />
        <Text style={styles.bigEmptyTitle}>No trips yet</Text>
        <Text style={styles.bigEmptySub}>Create your first trip to start planning and meeting travelers.</Text>
      </View>
    );
  }
  return (
    <>
      {sections.map((sec) => (
        <View key={sec.status} style={styles.sectionWrap}>
          <View style={styles.sectionHead}>
            {SECTION_ICONS[sec.title] ?? null}
            <Text style={styles.sectionTitle}>{sec.title}</Text>
            <Text style={styles.sectionCount}>{sec.data.length}</Text>
          </View>
          {sec.data.map((trip) => <TripCard key={trip.id} trip={trip} />)}
        </View>
      ))}
    </>
  );
}

/* ─── Main screen ────────────────────────────────────────────────────────────── */

export default function Trips() {
  const { configured, isAuthed } = useSession();
  const live = configured && isAuthed;
  const { data: realTrips, loading, error, reload } = useMyTrips();
  const { meetups: meetupCount } = useUnreadCounts();
  const [layoverOpen, setLayoverOpen] = useState(false);

  useFocusEffect(useCallback(() => {
    postCompassFrontloadEvent({ eventType: 'navigation', screen: 'trips' }).catch(() => {});
  }, []));

  React.useEffect(() => { if (live) reload(); }, [live, reload]);

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader
        title="Trips"
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <NotificationBell />
            <Pressable style={styles.newBtn} onPress={() => router.push('/trip/new')}>
              <Plus size={16} color={color.onInk} />
              <Text style={styles.newBtnTxt}>New trip</Text>
            </Pressable>
          </View>
        }
      />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxxl }} showsVerticalScrollIndicator={false}>
        <MeetupsShortcut count={meetupCount} />

        <Pressable style={styles.layoverBanner} onPress={() => setLayoverOpen(true)}>
          <Plane size={16} color="#1565C0" />
          <Text style={styles.layoverTxt}>Got a layover? Plan activities, check safety & more →</Text>
        </Pressable>

        {live && <PendingInvitesSection onAccepted={reload} />}
        {live && <JoinRequestsSection onDone={reload} />}

        {live ? (
          loading
            ? <View style={styles.state}><ActivityIndicator color={color.signal} /></View>
            : error
            ? <View style={styles.state}><Text style={styles.stateTxt}>Couldn't load trips. Pull to retry.</Text></View>
            : <SectionedTrips trips={realTrips} />
        ) : (
          <View style={styles.sectionWrap}>
            {mockTrips.map((tr) => (
              <Pressable key={tr.id} style={styles.card} onPress={() => router.push(`/trip/${tr.id}`)}>
                <Image source={{ uri: tr.coverUrl }} style={styles.cover} />
                <View style={styles.body}>
                  <View style={styles.cardTop}>
                    <Stamp label={tr.destination.city} tone="deep" />
                    <Stamp label={tr.isPublic ? 'public' : 'private'} rotate={2} />
                  </View>
                  <Text style={styles.cardTitle}>{tr.title}</Text>
                  <View style={styles.cardMeta}><CalendarDays size={12} color={color.mute} /><Text style={styles.cardMetaTxt}>{tr.startDate} – {tr.endDate}</Text></View>
                  <View style={styles.cardMeta}><Users size={12} color={color.mute} /><Text style={styles.cardMetaTxt}>{tr.collaborators.length + 1} travelers</Text></View>
                </View>
              </Pressable>
            ))}
          </View>
        )}

        <Pressable style={styles.emptyAdd} onPress={() => router.push('/trip/new')}>
          <Plus size={20} color={color.deep} />
          <Text style={styles.emptyAddTxt}>Start a new trip</Text>
        </Pressable>
      </ScrollView>

      <LayoverModeSheet visible={layoverOpen} onClose={() => setLayoverOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  newBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: color.ink, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill },
  newBtnTxt: { ...t.small, fontWeight: '700', color: color.onInk },

  meetupsCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.md, ...shadow.card, borderWidth: 1, borderColor: color.haze },
  meetupsIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  meetupsText: { flex: 1, gap: 2 },
  meetupsTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' as const },
  meetupsSub: { ...t.small, color: color.mute },
  meetupsBadge: { position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  meetupsBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700' as const, lineHeight: 11 },

  layoverBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#E3F2FD', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10 },
  layoverTxt: { flex: 1, fontSize: 13, fontWeight: '500' as const, color: '#1565C0' },

  sectionWrap: { gap: space.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  sectionTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' as const, flex: 1 },
  sectionCount: { ...t.small, color: color.mute, fontWeight: '600' as const },

  card: { backgroundColor: color.paperRaised, borderRadius: radius.lg, overflow: 'hidden', ...shadow.card, borderWidth: 1, borderColor: color.haze },
  cover: { width: '100%', height: 130 },
  coverPH: { backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  body: { padding: space.md, gap: space.sm },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1 },
  statusTxt: { fontSize: 11, fontWeight: '700' as const },
  cardTitle: { ...t.title, color: color.ink, fontSize: 16 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  cardMetaTxt: { ...t.small, color: color.mute },

  state: { padding: space.xxl, alignItems: 'center' },
  stateTxt: { ...t.small, color: color.mute },
  bigEmpty: { alignItems: 'center', gap: space.sm, padding: space.xxl, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze },
  bigEmptyTitle: { ...t.title, color: color.ink, fontSize: 18 },
  bigEmptySub: { ...t.small, color: color.mute, textAlign: 'center' },

  emptyAdd: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.xl, borderRadius: radius.lg, borderWidth: 1.5, borderColor: color.haze, borderStyle: 'dashed' },
  emptyAddTxt: { ...t.body, color: color.deep, fontWeight: '600' as const },

  inviteCard: { backgroundColor: color.paperRaised, borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: color.haze, ...shadow.card },
  inviteCover: { width: '100%', height: 90 },
  inviteCoverPH: { backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  inviteBody: { padding: space.md, gap: space.sm },
  inviteRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inviterAv: { width: 20, height: 20, borderRadius: 10 },
  inviterAvPH: { width: 20, height: 20, borderRadius: 10, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  inviterLabel: { ...t.small, color: color.mute, flex: 1 },
  inviterName: { fontWeight: '600' as const, color: color.ink },
  inviteTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700' as const },
  inviteMeta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  inviteMetaTxt: { ...t.small, color: color.mute },
  inviteActions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  inviteBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: space.sm, borderRadius: radius.md },
  inviteBtnDec: { backgroundColor: color.haze },
  inviteBtnDecTxt: { ...t.small, color: color.mute, fontWeight: '600' as const },
  inviteBtnAcc: { backgroundColor: color.ink },
  inviteBtnAccTxt: { ...t.small, color: color.onInk, fontWeight: '700' as const },

  jrCard: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.md, borderWidth: 1, borderColor: color.haze },
  jrAv: { width: 38, height: 38, borderRadius: 19 },
  jrAvPH: { width: 38, height: 38, borderRadius: 19, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  jrName: { ...t.bodyStrong, color: color.ink, fontWeight: '600' as const },
  jrMeta: { ...t.small, color: color.mute },
  jrBtns: { flexDirection: 'row', gap: 8 },
  jrDec: { width: 32, height: 32, borderRadius: 16, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  jrAcc: { width: 32, height: 32, borderRadius: 16, backgroundColor: color.ink, alignItems: 'center', justifyContent: 'center' },
});
