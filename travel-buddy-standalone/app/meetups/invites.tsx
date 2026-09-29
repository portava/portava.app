/**
 * Meetup invites inbox — /meetups/invites (PLAT-F31)
 *
 * Reads GET /api/me/meetup-invites: pending invites (answer Going / Maybe /
 * Can't go through POST /api/meetups/:id/rsvp) and, for invites already
 * answered, a notice once the organiser has confirmed the time. Reached from
 * the Meetups header.
 *
 * States are true: loading; an error with Retry (the server answers an
 * unreadable inbox with an error, never an empty list); an empty inbox only
 * when the read succeeded and held nothing.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet, RefreshControl,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Inbox, CalendarClock, MapPin, CalendarCheck } from 'lucide-react-native';
import {
  getMyMeetupInvites, rsvpMeetup, type MeetupInvite, type RsvpStatus,
} from '../../src/services/meetups.ts';
import { splitMeetupInbox } from '../../src/lib/meetupInvites.ts';
import { Avatar } from '../../src/components/ui.tsx';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens.ts';

const BLOCK_LABEL: Record<string, string> = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', late: 'Late' };

function whenLine(m: NonNullable<MeetupInvite['meetup']>): string {
  if (m.startsAt) {
    const d = new Date(m.startsAt);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
      + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const block = m.timeBlock ? BLOCK_LABEL[m.timeBlock] ?? m.timeBlock : null;
  if (m.approximateDate) {
    const d = new Date(`${m.approximateDate}T12:00:00`);
    const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return block ? `${day} · ${block}` : day;
  }
  return block ? `${block} · time being voted on` : 'Time being voted on';
}

function inviterName(c: MeetupInvite['creator']): string {
  if (!c) return 'Someone';
  return c.name ?? (c.handle ? `@${c.handle}` : 'Someone');
}

export default function MeetupInvitesScreen() {
  const insets = useSafeAreaInsets();
  const [invites, setInvites] = useState<MeetupInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    const res = await getMyMeetupInvites();
    if (!res.ok || !Array.isArray(res.data?.invites)) setError(res.message ?? "We couldn't load your meetup invites.");
    else setInvites(res.data!.invites);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function answer(invite: MeetupInvite, status: Exclude<RsvpStatus, 'pending' | 'cancelled'>) {
    if (busy) return;
    setBusy(invite.inviteId);
    setRowError(null);
    const res = await rsvpMeetup(invite.meetupId, status);
    setBusy(null);
    if (!res.ok) { setRowError({ id: invite.inviteId, message: res.message ?? 'Your answer was not saved. Please try again.' }); return; }
    setInvites((prev) => prev.filter((i) => i.inviteId !== invite.inviteId));
    if (status !== 'declined') router.push(`/meetup/${invite.meetupId}` as any);
  }

  const { pending, confirmations } = splitMeetupInbox(invites);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Meetup Invites</Text>
        {pending.length > 0 && (
          <View style={styles.badge}><Text style={styles.badgeText}>{pending.length}</Text></View>
        )}
      </View>

      {loading ? (
        <View style={styles.center} testID="meetup-invites-loading"><ActivityIndicator color={color.signal} /></View>
      ) : error ? (
        <View style={styles.center} testID="meetup-invites-error">
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={() => load()} style={styles.retryBtn} accessibilityRole="button" accessibilityLabel="Retry">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : invites.length === 0 ? (
        <View style={styles.center} testID="meetup-invites-empty">
          <Inbox size={40} color={color.faint} />
          <Text style={styles.emptyTitle}>No meetup invites</Text>
          <Text style={styles.emptySub}>When a friend invites you to a meetup, it shows up here.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={color.signal} />}
        >
          {pending.map((inv) => {
            const m = inv.meetup;
            const isBusy = busy === inv.inviteId;
            return (
              <View key={inv.inviteId} style={styles.card} testID={`meetup-invite-${inv.inviteId}`}>
                <View style={styles.inviterRow}>
                  <Avatar uri={inv.creator?.avatarUrl ?? ''} size={28} />
                  <Text style={styles.inviterText}>
                    <Text style={styles.inviterName}>{inviterName(inv.creator)}</Text> invited you to a meetup
                  </Text>
                </View>
                {m && (
                  <Pressable onPress={() => router.push(`/meetup/${m.id}` as any)} accessibilityRole="link">
                    <Text style={styles.title} numberOfLines={2}>{m.title}</Text>
                    <View style={styles.metaRow}><CalendarClock size={12} color={color.mute} /><Text style={styles.metaText}>{whenLine(m)}</Text></View>
                    {m.locationName ? <View style={styles.metaRow}><MapPin size={12} color={color.mute} /><Text style={styles.metaText} numberOfLines={1}>{m.locationName}</Text></View> : null}
                  </Pressable>
                )}
                {rowError?.id === inv.inviteId ? <Text style={styles.rowError}>{rowError.message}</Text> : null}
                <View style={styles.actions}>
                  {isBusy ? <ActivityIndicator color={color.signal} /> : (
                    <>
                      <Pressable style={styles.goingBtn} onPress={() => answer(inv, 'going')} accessibilityRole="button" accessibilityLabel="Going">
                        <Text style={styles.goingText}>Going</Text>
                      </Pressable>
                      <Pressable style={styles.otherBtn} onPress={() => answer(inv, 'maybe')} accessibilityRole="button" accessibilityLabel="Maybe">
                        <Text style={styles.otherText}>Maybe</Text>
                      </Pressable>
                      <Pressable style={styles.otherBtn} onPress={() => answer(inv, 'declined')} accessibilityRole="button" accessibilityLabel="Can't go">
                        <Text style={styles.otherText}>Can't go</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              </View>
            );
          })}

          {confirmations.length > 0 && <Text style={styles.sectionLabel}>Time confirmed</Text>}
          {confirmations.map((inv) => inv.meetup ? (
            <Pressable
              key={inv.inviteId}
              style={[styles.card, styles.confirmCard]}
              onPress={() => router.push(`/meetup/${inv.meetupId}` as any)}
              accessibilityRole="link"
            >
              <View style={styles.inviterRow}>
                <CalendarCheck size={16} color={color.success} />
                <Text style={styles.title} numberOfLines={1}>{inv.meetup.title}</Text>
              </View>
              <Text style={styles.metaText}>{whenLine(inv.meetup)}{inv.status === 'maybe' ? ' · you said maybe' : ''}</Text>
            </Pressable>
          ) : null)}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: color.paper },
  header:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised, gap: space.md },
  backBtn:     { padding: 4 },
  headerTitle: { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  badge:       { backgroundColor: color.signal, minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText:   { ...t.small, color: color.onInk, fontWeight: '700', fontSize: 11 },
  center:      { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md },
  errorText:   { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn:    { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText:   { ...t.small, color: color.onInk, fontWeight: '700' },
  emptyTitle:  { ...t.title, color: color.ink, fontSize: 18, fontWeight: '800' },
  emptySub:    { ...t.body, color: color.mute, textAlign: 'center' },
  list:        { padding: space.lg, gap: space.md, paddingBottom: 130 },
  card:        { backgroundColor: color.paperRaised, borderRadius: radius.lg, padding: space.lg, gap: space.sm, ...shadow.card },
  confirmCard: { gap: 4 },
  inviterRow:  { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  inviterText: { ...t.small, color: color.mute, flex: 1 },
  inviterName: { fontWeight: '700', color: color.ink },
  title:       { ...t.body, color: color.ink, fontWeight: '700', fontSize: 16, flexShrink: 1 },
  metaRow:     { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaText:    { ...t.small, color: color.mute, flexShrink: 1 },
  rowError:    { ...t.small, color: '#DC2626' },
  actions:     { flexDirection: 'row', gap: space.sm, alignItems: 'center', minHeight: 36 },
  goingBtn:    { flex: 1, backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.sm, alignItems: 'center' },
  goingText:   { ...t.body, color: color.onInk, fontWeight: '700' },
  otherBtn:    { flex: 1, backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingVertical: space.sm, alignItems: 'center', borderWidth: 1, borderColor: color.haze },
  otherText:   { ...t.body, color: color.mute, fontWeight: '600' },
  sectionLabel:{ ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: space.sm },
});
