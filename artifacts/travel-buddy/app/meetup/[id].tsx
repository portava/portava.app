/**
 * Meetup detail screen
 *
 * Shows: title, location, time options + poll, RSVP button,
 * attendee counts, and Add to Trip Plan for trip-scoped meetups.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, Alert,
} from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, MapPin, CalendarClock, Users, Check, ThumbsUp, ThumbsDown,
  Minus, Plus, Trophy,
} from 'lucide-react-native';
import {
  getMeetup, rsvpMeetup, voteTimeOption, confirmTime,
  addMeetupToTripPlan, cancelMeetup,
  type MeetupDetail, type TimeOptionVotes, type VoteValue, type RsvpStatus,
} from '../../src/services/meetups';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

function relDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const BLOCK_LABELS: Record<string, string> = {
  morning: 'Morning (8–12)', afternoon: 'Afternoon (12–17)',
  evening: 'Evening (17–22)', late: 'Late night (22+)',
};

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  active:    { bg: '#E0F2FE', fg: '#0369A1' },
  confirmed: { bg: '#DCFCE7', fg: '#16A34A' },
  draft:     { bg: color.haze, fg: color.mute },
  cancelled: { bg: '#FEE2E2', fg: '#DC2626' },
};

const RSVP_OPTIONS: { key: 'going' | 'maybe' | 'declined'; label: string; emoji: string }[] = [
  { key: 'going',    label: 'Going',    emoji: '✅' },
  { key: 'maybe',   label: 'Maybe',    emoji: '🤔' },
  { key: 'declined', label: "Can't go", emoji: '❌' },
];

function VoteBar({ votes }: { votes: TimeOptionVotes }) {
  const total = votes.yes + votes.maybe + votes.no;
  if (total === 0) return <Text style={vb.none}>No votes yet</Text>;
  return (
    <View style={vb.row}>
      <View style={vb.item}><ThumbsUp size={11} color="#16A34A" /><Text style={[vb.num, { color: '#16A34A' }]}>{votes.yes}</Text></View>
      <View style={vb.item}><Minus size={11} color={color.mute} /><Text style={[vb.num, { color: color.mute }]}>{votes.maybe}</Text></View>
      <View style={vb.item}><ThumbsDown size={11} color='#DC2626' /><Text style={[vb.num, { color: '#DC2626' }]}>{votes.no}</Text></View>
    </View>
  );
}
const vb = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  num: { ...t.small, fontWeight: '700', fontSize: 11 },
  none: { ...t.small, color: color.faint, fontSize: 11 },
});

export default function MeetupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { isAuthed } = useSession();

  const [meetup, setMeetup] = useState<MeetupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioning, setActioning] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const res = await getMeetup(id);
    setLoading(false);
    if (res.ok && res.data) setMeetup(res.data);
    else setError(res.message ?? 'Failed to load meetup');
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleRsvp(status: 'going' | 'maybe' | 'declined') {
    if (!id || actioning) return;
    setActioning(`rsvp_${status}`);
    const res = await rsvpMeetup(id, status);
    if (res.ok && res.data) {
      setMeetup((prev) => prev ? { ...prev, myRsvp: res.data!.status, counts: res.data!.counts } : prev);
    } else {
      Alert.alert('Error', res.message ?? 'Could not RSVP');
    }
    setActioning(null);
  }

  async function handleVote(optionId: string, vote: VoteValue) {
    if (!id || actioning) return;
    setActioning(`vote_${optionId}_${vote}`);
    const res = await voteTimeOption(id, optionId, vote);
    if (res.ok && res.data) {
      setMeetup((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          timeOptions: prev.timeOptions.map((o) =>
            o.id === optionId ? { ...o, votes: res.data!.votes } : o
          ),
        };
      });
    } else {
      Alert.alert('Error', res.message ?? 'Could not record vote');
    }
    setActioning(null);
  }

  async function handleConfirmTime(optionId: string) {
    if (!id || actioning) return;
    Alert.alert('Confirm time?', 'This will mark the meetup as confirmed and notify all attendees.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm', style: 'default',
        onPress: async () => {
          setActioning(`confirm_${optionId}`);
          const res = await confirmTime(id, optionId);
          if (res.ok) {
            await load();
            Alert.alert('Confirmed!', 'The meetup time has been set.');
          } else {
            Alert.alert('Error', res.message ?? 'Could not confirm time');
          }
          setActioning(null);
        },
      },
    ]);
  }

  async function handleAddToTrip() {
    if (!meetup?.tripId || !id || actioning) return;
    setActioning('add_to_plan');
    const res = await addMeetupToTripPlan(id, meetup.tripId);
    setActioning(null);
    if (res.ok) {
      if (res.data?.idempotent) Alert.alert('Already added', 'This meetup is already in the trip plan.');
      else Alert.alert('Added!', 'Meetup has been added to the trip plan.');
    } else {
      Alert.alert('Error', res.message ?? 'Could not add to trip plan');
    }
  }

  async function handleCancel() {
    if (!id || actioning) return;
    Alert.alert('Cancel meetup?', 'All invitees will see this meetup as cancelled.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Cancel meetup', style: 'destructive',
        onPress: async () => {
          setActioning('cancel');
          const res = await cancelMeetup(id);
          setActioning(null);
          if (res.ok) { router.back(); }
          else Alert.alert('Error', res.message ?? 'Could not cancel meetup');
        },
      },
    ]);
  }

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (error || !meetup) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={[s.header, { paddingTop: insets.top + space.sm }]}>
          <Pressable onPress={() => router.back()} hitSlop={8}><ArrowLeft size={20} color={color.ink} /></Pressable>
          <Text style={s.headerTitle}>Meetup</Text>
        </View>
        <View style={s.center}>
          <Text style={s.errText}>{error ?? 'Meetup not found'}</Text>
          <Pressable style={s.retryBtn} onPress={load}><Text style={s.retryText}>Retry</Text></Pressable>
        </View>
      </View>
    );
  }

  const sc = STATUS_COLORS[meetup.status] ?? STATUS_COLORS.active;
  const isCancelled = meetup.status === 'cancelled';

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={[s.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={8}><ArrowLeft size={20} color={color.ink} /></Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>{meetup.title}</Text>
        {meetup.isCreator && !isCancelled && (
          <Pressable style={s.cancelChip} onPress={handleCancel} disabled={actioning === 'cancel'}>
            <Text style={s.cancelChipText}>Cancel meetup</Text>
          </Pressable>
        )}
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Status + title */}
        <View style={s.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm }}>
            <View style={[s.statusPill, { backgroundColor: sc.bg }]}>
              <Text style={[s.statusText, { color: sc.fg }]}>{meetup.status.toUpperCase()}</Text>
            </View>
            {meetup.tripId && <Text style={s.scopeTag}>🗺 Trip meetup</Text>}
            {meetup.circleOwnerId && <Text style={s.scopeTag}>⭕ Circle meetup</Text>}
          </View>
          <Text style={s.title}>{meetup.title}</Text>
          {meetup.description ? <Text style={s.desc}>{meetup.description}</Text> : null}

          {meetup.locationName ? (
            <View style={s.metaRow}>
              <MapPin size={14} color={color.mute} />
              <Text style={s.metaText}>{meetup.locationName}</Text>
            </View>
          ) : null}

          {(meetup.startsAt ?? meetup.approximateDate) ? (
            <View style={s.metaRow}>
              <CalendarClock size={14} color={color.mute} />
              <Text style={s.metaText}>
                {meetup.startsAt ? relDate(meetup.startsAt) : relDate(meetup.approximateDate ?? '')}
                {meetup.timeBlock ? ` · ${BLOCK_LABELS[meetup.timeBlock] ?? meetup.timeBlock}` : ''}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Attendee counts */}
        <View style={s.card}>
          <Text style={s.sectionTitle}>Responses</Text>
          <View style={s.countsRow}>
            {[
              { label: 'Going', count: meetup.counts.going, color: '#16A34A' },
              { label: 'Maybe', count: meetup.counts.maybe, color: color.mute },
              { label: "Can't go", count: meetup.counts.declined, color: '#DC2626' },
              { label: 'Pending', count: meetup.counts.pending, color: color.faint },
            ].map((c) => (
              <View key={c.label} style={s.countItem}>
                <Text style={[s.countNum, { color: c.color }]}>{c.count}</Text>
                <Text style={s.countLabel}>{c.label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* RSVP */}
        {!isCancelled && isAuthed ? (
          <View style={s.card}>
            <Text style={s.sectionTitle}>Your RSVP</Text>
            <View style={s.rsvpRow}>
              {RSVP_OPTIONS.map((opt) => {
                const isSelected = meetup.myRsvp === opt.key;
                const isLoading = actioning === `rsvp_${opt.key}`;
                return (
                  <Pressable
                    key={opt.key}
                    style={[s.rsvpBtn, isSelected && s.rsvpBtnActive]}
                    onPress={() => handleRsvp(opt.key)}
                    disabled={!!actioning}
                  >
                    {isLoading
                      ? <ActivityIndicator size="small" color={isSelected ? color.onInk : color.signal} />
                      : <Text style={s.rsvpEmoji}>{opt.emoji}</Text>
                    }
                    <Text style={[s.rsvpLabel, isSelected && s.rsvpLabelActive]}>{opt.label}</Text>
                    {isSelected && <Check size={12} color={color.onInk} />}
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}

        {/* Time: single proposed → skip voting, show direct RSVP prompt */}
        {meetup.timeOptions.length === 1 && !meetup.timeOptions[0].confirmed && !isCancelled ? (
          <View style={s.card}>
            <Text style={s.sectionTitle}>Proposed Time</Text>
            <View style={s.optionCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <CalendarClock size={14} color={color.signal} />
                <Text style={s.optionDate}>{relDate(meetup.timeOptions[0].proposedDate)}</Text>
                {meetup.timeOptions[0].timeBlock && (
                  <Text style={s.optionBlock}>
                    {BLOCK_LABELS[meetup.timeOptions[0].timeBlock] ?? meetup.timeOptions[0].timeBlock}
                  </Text>
                )}
              </View>
              {meetup.timeOptions[0].label ? <Text style={s.optionLabel}>{meetup.timeOptions[0].label}</Text> : null}
              <Text style={s.voteHint}>Use the RSVP section above to confirm attendance</Text>
            </View>
            {meetup.isCreator && (
              <Pressable
                style={[s.confirmBtn, { alignSelf: 'flex-end', marginTop: 4 }]}
                onPress={() => handleConfirmTime(meetup.timeOptions[0].id)}
                disabled={!!actioning}
              >
                {actioning === `confirm_${meetup.timeOptions[0].id}`
                  ? <ActivityIndicator size="small" color="#16A34A" />
                  : <Check size={12} color="#16A34A" />
                }
                <Text style={s.confirmBtnText}>Confirm time</Text>
              </Pressable>
            )}
          </View>
        ) : meetup.timeOptions.length > 0 ? (
          /* Multiple options (or already confirmed): show full voting poll */
          <View style={s.card}>
            <Text style={s.sectionTitle}>Time Poll</Text>
            {meetup.timeOptions.map((opt) => (
              <View key={opt.id} style={[s.optionCard, opt.confirmed && s.optionCardWinner]}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    {opt.confirmed && <Trophy size={13} color="#16A34A" />}
                    <Text style={s.optionDate}>{relDate(opt.proposedDate)}</Text>
                    {opt.timeBlock && <Text style={s.optionBlock}>{opt.timeBlock}</Text>}
                  </View>
                  {opt.label ? <Text style={s.optionLabel}>{opt.label}</Text> : null}
                  <VoteBar votes={opt.votes} />
                </View>
                {!isCancelled && !opt.confirmed && (
                  <View style={s.voteRow}>
                    {(['yes','maybe','no'] as VoteValue[]).map((v) => {
                      const icons: Record<VoteValue, React.ReactNode> = {
                        yes:   <ThumbsUp size={13} color={opt.votes.myVote === 'yes' ? color.onInk : '#16A34A'} />,
                        maybe: <Minus size={13} color={opt.votes.myVote === 'maybe' ? color.onInk : color.mute} />,
                        no:    <ThumbsDown size={13} color={opt.votes.myVote === 'no' ? color.onInk : '#DC2626'} />,
                      };
                      const isActive = opt.votes.myVote === v;
                      const bgMap: Record<VoteValue, string> = { yes: '#DCFCE7', maybe: color.haze, no: '#FEE2E2' };
                      return (
                        <Pressable
                          key={v}
                          style={[s.voteBtn, { backgroundColor: isActive ? color.signal : bgMap[v] }]}
                          onPress={() => handleVote(opt.id, v)}
                          disabled={!!actioning}
                        >
                          {actioning === `vote_${opt.id}_${v}`
                            ? <ActivityIndicator size="small" color={color.onInk} />
                            : icons[v]
                          }
                        </Pressable>
                      );
                    })}
                    {meetup.isCreator && (
                      <Pressable
                        style={s.confirmBtn}
                        onPress={() => handleConfirmTime(opt.id)}
                        disabled={!!actioning}
                      >
                        <Check size={12} color="#16A34A" />
                        <Text style={s.confirmBtnText}>Confirm</Text>
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            ))}
          </View>
        ) : null}

        {/* Add to trip plan */}
        {meetup.tripId && !isCancelled && (
          <Pressable
            style={[s.addPlanBtn, actioning === 'add_to_plan' && { opacity: 0.6 }]}
            onPress={handleAddToTrip}
            disabled={actioning === 'add_to_plan'}
          >
            {actioning === 'add_to_plan'
              ? <ActivityIndicator size="small" color={color.onInk} />
              : <Plus size={16} color={color.onInk} />
            }
            <Text style={s.addPlanBtnText}>Add to Trip Plan</Text>
          </Pressable>
        )}

        {/* View trip */}
        {meetup.tripId && (
          <Pressable style={s.linkBtn} onPress={() => router.push(`/trip/${meetup.tripId}` as any)}>
            <Text style={s.linkBtnText}>View trip ›</Text>
          </Pressable>
        )}

      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised },
  headerTitle: { ...t.bodyStrong, color: color.ink, flex: 1, fontWeight: '700' },
  cancelChip: { paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: '#DC2626' },
  cancelChipText: { ...t.small, color: '#DC2626', fontWeight: '700' },

  scroll: { padding: space.lg, gap: space.md, paddingBottom: space.xxxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  errText: { ...t.body, color: color.mute },
  retryBtn: { paddingHorizontal: space.xl, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal },
  retryText: { ...t.bodyStrong, color: color.signal },

  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm, ...shadow.card },
  statusPill: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill },
  statusText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  scopeTag: { ...t.small, color: color.mute, fontSize: 11 },
  title: { ...t.title, color: color.ink, fontSize: 22 },
  desc: { ...t.body, color: color.mute, lineHeight: 20 },
  sectionTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700', marginBottom: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { ...t.body, color: color.mute },

  countsRow: { flexDirection: 'row', gap: space.lg },
  countItem: { alignItems: 'center', gap: 2 },
  countNum: { ...t.title, fontSize: 22, fontWeight: '700' },
  countLabel: { ...t.small, color: color.mute, fontSize: 11 },

  rsvpRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  rsvpBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm + 2, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper, minHeight: 38 },
  rsvpBtnActive: { backgroundColor: color.signal, borderColor: color.signal },
  rsvpEmoji: { fontSize: 14 },
  rsvpLabel: { ...t.small, fontWeight: '700', color: color.ink },
  rsvpLabelActive: { color: color.onInk },

  optionCard: { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, marginBottom: space.sm, gap: space.sm },
  optionCardWinner: { borderColor: '#16A34A', backgroundColor: '#F0FDF4' },
  optionDate: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  optionBlock: { ...t.small, color: color.mute, backgroundColor: color.haze, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm, fontSize: 11 },
  optionLabel: { ...t.small, color: color.mute },
  voteRow: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  voteBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  confirmBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: '#16A34A', marginLeft: 'auto' },
  confirmBtnText: { ...t.small, color: '#16A34A', fontWeight: '700', fontSize: 11 },
  voteHint: { ...t.small, color: color.faint, fontSize: 11, marginTop: 4 },

  addPlanBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md },
  addPlanBtnText: { ...t.bodyStrong, color: color.onInk },
  linkBtn: { alignItems: 'center', paddingVertical: space.sm },
  linkBtnText: { ...t.bodyStrong, color: color.signal },
});
