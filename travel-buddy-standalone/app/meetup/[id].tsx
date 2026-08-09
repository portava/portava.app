/**
 * Meetup detail screen
 *
 * Shows: title, location, time options + poll, RSVP button,
 * attendee counts, and Add to Trip Plan for trip-scoped meetups.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, Alert, TextInput, Platform,
  AppState, type AppStateStatus, Modal, Linking, Animated, Switch,
} from 'react-native';
import { Avatar } from '../../src/components/ui/Avatar';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, MapPin, CalendarClock, Check, ThumbsUp, ThumbsDown,
  Minus, Plus, Trophy, Pencil, X, CheckCircle2, CalendarDays,
} from 'lucide-react-native';
import {
  getMeetup, rsvpMeetup, voteTimeOption, confirmTime,
  cancelMeetup, updateMeetup,
  type MeetupDetail, type TimeOptionVotes, type VoteValue, type RsvpStatus, type TimeBlock,
} from '../../src/services/meetups';
import { DatePickerField } from '../../src/components/DateTimePickerField';
import { useSession } from '../../src/context/SessionContext';
import { usePlanPicker } from '../../src/components/PlanPickerController';
import { RichText } from '../../src/components/RichText';
import { color, space, radius, type as t, shadow, avatar } from '../../src/theme/tokens';
import { addMeetupToCalendar } from '../../src/services/calendar';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../../src/hooks/useNavBarCollapse';

const TODAY_START = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const BLOCK_OPTIONS: { key: TimeBlock; label: string }[] = [
  { key: 'morning',   label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening',   label: 'Evening' },
  { key: 'late',      label: 'Late' },
];

function relDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function relDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const datePart = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const timePart = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${datePart} · ${timePart}`;
}

function combineDateTime(date: Date, time: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const h = String(time.getHours()).padStart(2, '0');
  const min = String(time.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day}T${h}:${min}:00`;
}

const BLOCK_LABELS: Record<string, string> = {
  morning: 'Morning (8–12)', afternoon: 'Afternoon (12–17)',
  evening: 'Evening (17–22)', late: 'Late night (22+)',
};

function formatProposedTime(timeStr: string): string {
  const parts = timeStr.split(':');
  const h = parseInt(parts[0] ?? '0', 10);
  const m = parseInt(parts[1] ?? '0', 10);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeOptionPill(opt: import('../../src/services/meetups').MeetupTimeOption): string {
  if (opt.proposedTime) return formatProposedTime(opt.proposedTime);
  if (opt.timeBlock) return BLOCK_LABELS[opt.timeBlock] ?? opt.timeBlock;
  return 'Time TBD';
}

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

function ConfirmedTimeBanner({ meetup }: { meetup: MeetupDetail }) {
  if (meetup.status !== 'confirmed') return null;

  const dateTime = meetup.startsAt
    ? relDateTime(meetup.startsAt)
    : meetup.approximateDate
      ? `${relDate(meetup.approximateDate)}${meetup.timeBlock ? ` · ${BLOCK_LABELS[meetup.timeBlock] ?? meetup.timeBlock}` : ''}`
      : null;

  return (
    <View style={cb.banner}>
      <View style={cb.iconWrap}>
        <CheckCircle2 size={22} color="#16A34A" />
      </View>
      <View style={cb.body}>
        <Text style={cb.heading}>Time Confirmed</Text>
        {dateTime ? (
          <Text style={cb.detail}>{dateTime}</Text>
        ) : null}
        {meetup.locationName ? (
          <View style={cb.locRow}>
            <MapPin size={12} color="#15803D" />
            <Text style={cb.locText}>{meetup.locationName}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
const cb = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#DCFCE7',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#86EFAC',
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  iconWrap: {
    marginTop: 1,
  },
  body: {
    flex: 1,
    gap: 3,
  },
  heading: {
    fontSize: 15,
    fontWeight: '800',
    color: '#14532D',
    letterSpacing: 0.1,
  },
  detail: {
    fontSize: 14,
    fontWeight: '700',
    color: '#15803D',
  },
  locRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 1,
  },
  locText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#15803D',
    flex: 1,
  },
});

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
  const { open: openPlanPicker, isAdded } = usePlanPicker();
  const navBarScrollHandler = useNavBarScrollHandler();

  const [meetup, setMeetup] = useState<MeetupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actioning, setActioning] = useState<string | null>(null);

  // Calendar
  const [calendarAdded, setCalendarAdded] = useState(false);
  const [calendarActioning, setCalendarActioning] = useState(false);
  const [showCalendarDenied, setShowCalendarDenied] = useState(false);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast() {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start();
  }

  // Reset calendar-added flag when navigating to a different meetup
  useEffect(() => {
    setCalendarAdded(false);
    toastOpacity.setValue(0);
  }, [id]);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editLocation, setEditLocation] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editDate, setEditDate] = useState<Date | null>(null);
  const [editExactTime, setEditExactTime] = useState<Date | null>(null);
  const [editTimeBlock, setEditTimeBlock] = useState<TimeBlock | null>(null);
  const [editFocusField, setEditFocusField] = useState<'title' | 'location'>('title');
  const [editAgeLimitEnabled, setEditAgeLimitEnabled] = useState(false);
  const [editMinAge, setEditMinAge] = useState('');
  const [editMaxAge, setEditMaxAge] = useState('');
  const locationInputRef = useRef<TextInput>(null);

  function startEdit(focusField: 'title' | 'location' = 'title') {
    if (!meetup) return;
    setEditTitle(meetup.title);
    setEditLocation(meetup.locationName ?? '');
    setEditDesc(meetup.description ?? '');
    if (meetup.approximateDate) {
      setEditDate(new Date(meetup.approximateDate + 'T12:00:00'));
    } else if (meetup.startsAt) {
      setEditDate(new Date(meetup.startsAt));
    } else {
      setEditDate(null);
    }
    setEditExactTime(meetup.startsAt ? new Date(meetup.startsAt) : null);
    setEditTimeBlock(meetup.startsAt ? null : (meetup.timeBlock ?? null));
    setEditAgeLimitEnabled(meetup.ageLimitEnabled ?? false);
    setEditMinAge(meetup.minAge != null ? String(meetup.minAge) : '');
    setEditMaxAge(meetup.maxAge != null ? String(meetup.maxAge) : '');
    setEditFocusField(focusField);
    setEditing(true);
  }

  useEffect(() => {
    if (editing && editFocusField === 'location') {
      const t = setTimeout(() => locationInputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [editing, editFocusField]);

  async function handleSaveEdit() {
    if (!id || !meetup || actioning) return;
    setActioning('edit');
    const newStartsAt = (editDate && editExactTime)
      ? combineDateTime(editDate, editExactTime)
      : null;
    const minAgeNum = editMinAge ? parseInt(editMinAge, 10) : undefined;
    const maxAgeNum = editMaxAge ? parseInt(editMaxAge, 10) : undefined;
    const res = await updateMeetup(id, {
      title:            editTitle.trim() || meetup.title,
      locationName:     editLocation.trim() || null,
      description:      editDesc.trim() || null,
      approximateDate:  editDate ? toISODate(editDate) : null,
      timeBlock:        editExactTime ? null : editTimeBlock,
      startsAt:         newStartsAt,
      ageLimitEnabled:  editAgeLimitEnabled,
      minAge:           editAgeLimitEnabled && minAgeNum ? minAgeNum : undefined,
      maxAge:           editAgeLimitEnabled && maxAgeNum ? maxAgeNum : undefined,
    });
    setActioning(null);
    if (res.ok) {
      setMeetup((prev) => prev ? {
        ...prev,
        title:            editTitle.trim() || prev.title,
        locationName:     editLocation.trim() || null,
        description:      editDesc.trim() || null,
        approximateDate:  editDate ? toISODate(editDate) : null,
        timeBlock:        editExactTime ? null : editTimeBlock,
        startsAt:         newStartsAt,
        ageLimitEnabled:  editAgeLimitEnabled,
        minAge:           editAgeLimitEnabled && minAgeNum ? minAgeNum : null,
        maxAge:           editAgeLimitEnabled && maxAgeNum ? maxAgeNum : null,
      } : prev);
      setEditing(false);
    } else {
      Alert.alert('Error', res.message ?? 'Could not save changes');
    }
  }

  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const res = await getMeetup(id);
    setLoading(false);
    if (res.ok && res.data) setMeetup(res.data);
    else setError(res.message ?? 'Failed to load meetup');
  }, [id]);

  const silentPoll = useCallback(async () => {
    if (!id || appStateRef.current !== 'active') return;
    const res = await getMeetup(id);
    if (!res.ok || !res.data) return;
    setMeetup((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        counts:         res.data!.counts,
        myRsvp:         res.data!.myRsvp ?? prev.myRsvp,
        timeOptions:    res.data!.timeOptions ?? prev.timeOptions,
        goingAttendees: res.data!.goingAttendees ?? prev.goingAttendees,
        totalGoing:     res.data!.totalGoing ?? prev.totalGoing,
      };
    });
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      appStateRef.current = next;
    });
    const timer = setInterval(silentPoll, 10_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [silentPoll]);

  async function handleRsvp(status: 'going' | 'maybe' | 'declined') {
    if (!id || actioning) return;
    setActioning(`rsvp_${status}`);
    const res = await rsvpMeetup(id, status);
    if (res.ok && res.data) {
      setMeetup((prev) => prev ? { ...prev, myRsvp: res.data!.status, counts: res.data!.counts } : prev);
    } else if (!res.ok && res.reason === 'dob_missing') {
      Alert.alert(
        'Date of birth required',
        'This meetup has an age limit. Add your date of birth to your profile to join.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Go to profile', onPress: () => router.push('/profile/edit' as any) },
        ],
      );
    } else {
      Alert.alert('Cannot join', res.message ?? 'Could not RSVP');
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

  async function handleAddToCalendar() {
    if (!meetup || calendarActioning || calendarAdded) return;
    setCalendarActioning(true);
    const result = await addMeetupToCalendar(meetup);
    setCalendarActioning(false);
    if (result.ok) {
      setCalendarAdded(true);
      showToast();
    } else if (result.reason === 'denied') {
      setShowCalendarDenied(true);
    } else {
      Alert.alert('Calendar error', result.message ?? 'Could not add event to calendar.');
    }
  }

  function handleAddToTrip() {
    if (!meetup || !id) return;
    openPlanPicker({
      id,
      type:          'meetup',
      title:         meetup.title,
      locationName:  meetup.locationName ?? undefined,
      confirmedTime: meetup.startsAt ?? undefined,
    });
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
        <Pressable onPress={() => { if (editing) { setEditing(false); } else { router.back(); } }} hitSlop={8}>
          {editing ? <X size={20} color={color.ink} /> : <ArrowLeft size={20} color={color.ink} />}
        </Pressable>
        <Text style={s.headerTitle} numberOfLines={1}>{editing ? 'Edit Meetup' : meetup.title}</Text>
        {editing ? (
          <Pressable
            style={[s.editSaveBtn, actioning === 'edit' && { opacity: 0.6 }]}
            onPress={handleSaveEdit}
            disabled={actioning === 'edit'}
          >
            {actioning === 'edit'
              ? <ActivityIndicator size="small" color={color.onInk} />
              : <Text style={s.editSaveBtnText}>Save</Text>
            }
          </Pressable>
        ) : meetup.isCreator && !isCancelled ? (
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Pressable style={s.editChip} onPress={() => startEdit()}>
              <Pencil size={13} color={color.ink} />
              <Text style={s.editChipText}>Edit</Text>
            </Pressable>
            <Pressable style={s.cancelChip} onPress={handleCancel} disabled={actioning === 'cancel'}>
              <Text style={s.cancelChipText}>Cancel</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} onScroll={navBarScrollHandler} scrollEventThrottle={16}>

        {/* Confirmed time banner — visible without scrolling on any phone */}
        <ConfirmedTimeBanner meetup={meetup} />

        {/* Status + title (edit mode or view mode) */}
        {editing ? (
          <KeyboardSafeScrollView>
            <View style={s.card}>
              <Text style={s.editLabel}>Title</Text>
              <TextInput
                style={s.editInput}
                value={editTitle}
                onChangeText={setEditTitle}
                placeholder="Meetup title"
                placeholderTextColor={color.faint}
                maxLength={200}
                autoFocus={editFocusField === 'title'}
              />
              <Text style={s.editLabel}>Location (optional)</Text>
              <TextInput
                ref={locationInputRef}
                style={s.editInput}
                value={editLocation}
                onChangeText={setEditLocation}
                placeholder="Where?"
                placeholderTextColor={color.faint}
                maxLength={300}
              />
              <View style={s.editLabelRow}>
                <Text style={s.editLabel}>Date (optional)</Text>
                {editDate && (
                  <Pressable onPress={() => { setEditDate(null); setEditExactTime(null); setEditTimeBlock(null); }}>
                    <Text style={s.clearTimeText}>Clear</Text>
                  </Pressable>
                )}
              </View>
              <DatePickerField
                value={editDate}
                onChange={setEditDate}
                minimumDate={TODAY_START}
                placeholder="Pick a date"
              />
              <Text style={s.editLabel}>Exact time (optional)</Text>
              <DatePickerField
                mode="time"
                value={editExactTime}
                onChange={(t) => { setEditExactTime(t); setEditTimeBlock(null); }}
                onClear={() => setEditExactTime(null)}
                placeholder="Pick a time"
              />
              <Text style={s.editLabel}>
                {editExactTime ? 'Time of day (overridden by exact time above)' : 'Time of day (optional)'}
              </Text>
              <View style={[s.blockRow, editExactTime ? { opacity: 0.35 } : null]}>
                {BLOCK_OPTIONS.map((opt) => {
                  const active = !editExactTime && editTimeBlock === opt.key;
                  return (
                    <Pressable
                      key={opt.key}
                      style={[s.blockBtn, active && s.blockBtnActive]}
                      onPress={() => { if (!editExactTime) setEditTimeBlock(active ? null : opt.key); }}
                    >
                      <Text style={[s.blockBtnText, active && s.blockBtnTextActive]}>
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={s.editLabel}>Description (optional)</Text>
              <TextInput
                style={[s.editInput, s.editInputMulti]}
                value={editDesc}
                onChangeText={setEditDesc}
                placeholder="Add details…"
                placeholderTextColor={color.faint}
                maxLength={1000}
                multiline
                numberOfLines={3}
              />
              <View style={s.ageLimitRow}>
                <Text style={s.editLabel}>Age limit</Text>
                <Switch
                  value={editAgeLimitEnabled}
                  onValueChange={setEditAgeLimitEnabled}
                  trackColor={{ true: color.signal }}
                />
              </View>
              {editAgeLimitEnabled && (
                <View style={s.ageRangeRow}>
                  <View style={s.ageRangeField}>
                    <Text style={s.ageRangeLabel}>Min age</Text>
                    <TextInput
                      style={s.ageRangeInput}
                      value={editMinAge}
                      onChangeText={setEditMinAge}
                      keyboardType="number-pad"
                      placeholder="e.g. 18"
                      placeholderTextColor={color.faint}
                      maxLength={3}
                    />
                  </View>
                  <View style={s.ageRangeField}>
                    <Text style={s.ageRangeLabel}>Max age (opt.)</Text>
                    <TextInput
                      style={s.ageRangeInput}
                      value={editMaxAge}
                      onChangeText={setEditMaxAge}
                      keyboardType="number-pad"
                      placeholder="no limit"
                      placeholderTextColor={color.faint}
                      maxLength={3}
                    />
                  </View>
                </View>
              )}
            </View>
          </KeyboardSafeScrollView>
        ) : (
          <View style={s.card}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm, flexWrap: 'wrap' }}>
              <View style={[s.statusPill, { backgroundColor: sc.bg }]}>
                <Text style={[s.statusText, { color: sc.fg }]}>{meetup.status.toUpperCase()}</Text>
              </View>
              {meetup.tripId && <Text style={s.scopeTag}>🗺 Trip meetup</Text>}
              {meetup.circleOwnerId && <Text style={s.scopeTag}>⭕ Circle meetup</Text>}
              {meetup.ageLimitEnabled && meetup.ageLimitLabel && (
                <View style={s.ageBadge}>
                  <Text style={s.ageBadgeText}>🔞 {meetup.ageLimitLabel}</Text>
                </View>
              )}
            </View>
            <Text style={s.title}>{meetup.title}</Text>
            {meetup.description ? (
              <RichText
                content={meetup.description}
                tags={meetup.descriptionTags}
                hashtagUsages={meetup.descriptionHashtags}
                style={s.desc}
              />
            ) : null}

            {/* Creator row */}
            {meetup.creator ? (
              <Pressable
                style={s.creatorRow}
                onPress={() => { if (meetup.creator?.handle) router.push(`/u/${meetup.creator.handle}` as any); }}
                disabled={!meetup.creator.handle}
              >
                <Avatar uri={meetup.creator.avatarUrl} name={meetup.creator.displayName} size={20} />
                <Text style={s.creatorName} numberOfLines={1}>
                  Organised by {meetup.creator.displayName ?? 'someone'}
                </Text>
              </Pressable>
            ) : (
              <Text style={s.creatorFallback}>Organised by someone</Text>
            )}

            {meetup.locationName ? (
              <View style={s.metaRow}>
                <MapPin size={14} color={color.mute} />
                <Text style={s.metaText}>{meetup.locationName}</Text>
              </View>
            ) : meetup.isCreator && meetup.status === 'confirmed' && !isCancelled ? (
              <View style={s.noDateRow}>
                <MapPin size={14} color={color.faint} />
                <Text style={s.noDateText}>No location set</Text>
                <Pressable style={s.noDateChip} onPress={() => startEdit('location')}>
                  <Text style={s.noDateChipText}>Add one?</Text>
                </Pressable>
              </View>
            ) : !meetup.isCreator ? (
              <View style={s.metaRow}>
                <MapPin size={14} color={color.faint} />
                <Text style={s.locTbdText}>Location TBD</Text>
              </View>
            ) : null}

            {(meetup.startsAt ?? meetup.approximateDate ?? meetup.timeBlock) ? (
              <View style={s.metaRow}>
                <CalendarClock size={14} color={color.mute} />
                <Text style={s.metaText}>
                  {meetup.startsAt
                    ? relDateTime(meetup.startsAt)
                    : meetup.approximateDate
                    ? `${relDate(meetup.approximateDate)}${meetup.timeBlock ? ` · ${BLOCK_LABELS[meetup.timeBlock] ?? meetup.timeBlock}` : ''}`
                    // Time-of-day was chosen but no calendar date — still show it
                    // honestly instead of falling through to "No date set".
                    : `${BLOCK_LABELS[meetup.timeBlock!] ?? meetup.timeBlock} · date TBD`
                  }
                </Text>
              </View>
            ) : meetup.isCreator && !isCancelled ? (
              <View style={s.noDateRow}>
                <CalendarClock size={14} color={color.faint} />
                <Text style={s.noDateText}>No date set</Text>
                <Pressable style={s.noDateChip} onPress={() => startEdit()}>
                  <Text style={s.noDateChipText}>Add</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        )}

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

        {/* Age requirement info card */}
        {meetup.ageLimitEnabled && (
          <View style={[s.card, s.ageGate]}>
            <Text style={s.ageGateTitle}>Age Requirement</Text>
            <Text style={s.ageGateText}>
              {meetup.ageLimitLabel
                ? `This meetup is restricted to ${meetup.ageLimitLabel.toLowerCase()}.`
                : 'This meetup has an age restriction.'}
              {' '}You must meet the requirement to RSVP.
            </Text>
          </View>
        )}

        {/* RSVP — single unconfirmed slot: 2 options only (Going / Can't go) */}
        {!isCancelled && isAuthed ? (
          <View style={s.card}>
            <Text style={s.sectionTitle}>Your RSVP</Text>
            <View style={s.rsvpRow}>
              {(meetup.timeOptions.length === 1 && !meetup.timeOptions[0].confirmed
                ? RSVP_OPTIONS.filter((o) => o.key !== 'maybe')
                : RSVP_OPTIONS
              ).map((opt) => {
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
                <Text style={s.optionBlock}>{timeOptionPill(meetup.timeOptions[0])}</Text>
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
                    <Text style={s.optionBlock}>{timeOptionPill(opt)}</Text>
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

        {/* Add to trip plan — only for confirmed meetups */}
        {meetup.status === 'confirmed' && isAuthed && (
          <Pressable
            style={[s.addPlanBtn, isAdded(meetup.id) && s.addPlanBtnAdded]}
            onPress={isAdded(meetup.id) ? undefined : handleAddToTrip}
            disabled={isAdded(meetup.id)}
          >
            {isAdded(meetup.id)
              ? <Check size={16} color={color.onInk} />
              : <Plus size={16} color={color.onInk} />
            }
            <Text style={s.addPlanBtnText}>
              {isAdded(meetup.id) ? 'In Plan ✓' : 'Add to Trip Plan'}
            </Text>
          </Pressable>
        )}

        {/* Add to Calendar — confirmed meetups with a known start time */}
        {meetup.status === 'confirmed' && !!meetup.startsAt && (
          Platform.OS === 'web' ? (
            <View style={[s.calBtn, s.calBtnDisabled]}>
              <CalendarDays size={16} color={color.haze} />
              <Text style={[s.calBtnText, s.calBtnTextDisabled]}>Not available on web</Text>
            </View>
          ) : (
            <Pressable
              style={[s.calBtn, calendarAdded && s.calBtnAdded]}
              onPress={handleAddToCalendar}
              disabled={calendarAdded || calendarActioning}
            >
              {calendarActioning ? (
                <ActivityIndicator size="small" color={calendarAdded ? color.onInk : color.signal} />
              ) : calendarAdded ? (
                <Check size={16} color={color.onInk} />
              ) : (
                <CalendarDays size={16} color={color.signal} />
              )}
              <Text style={[s.calBtnText, calendarAdded && s.calBtnTextAdded]}>
                {calendarAdded ? 'Added ✓' : 'Add to Calendar'}
              </Text>
            </Pressable>
          )
        )}

        {/* View trip */}
        {meetup.tripId && (
          <Pressable style={s.linkBtn} onPress={() => router.push(`/trip/${meetup.tripId}` as any)}>
            <Text style={s.linkBtnText}>View trip ›</Text>
          </Pressable>
        )}

        <NavBarFiller />
      </ScrollView>

      {/* Success toast */}
      <Animated.View style={[s.toast, { opacity: toastOpacity }]} pointerEvents="none">
        <Check size={14} color="#fff" />
        <Text style={s.toastText}>Added to your calendar</Text>
      </Animated.View>

      {/* Permission-denied bottom sheet */}
      <Modal
        visible={showCalendarDenied}
        transparent
        animationType="slide"
        onRequestClose={() => setShowCalendarDenied(false)}
      >
        <Pressable style={s.modalBackdrop} onPress={() => setShowCalendarDenied(false)} />
        <View style={[s.modalSheet, { paddingBottom: insets.bottom + space.md }]}>
          <View style={s.modalHandle} />
          <CalendarDays size={32} color={color.signal} style={{ alignSelf: 'center', marginBottom: space.sm }} />
          <Text style={s.modalTitle}>Calendar Access Required</Text>
          <Text style={s.modalBody}>
            Portava needs calendar permission to add this meetup.
            Open your device Settings and enable Calendar access for Portava.
          </Text>
          <Pressable
            style={s.modalSettingsBtn}
            onPress={() => { setShowCalendarDenied(false); Linking.openSettings(); }}
          >
            <Text style={s.modalSettingsBtnText}>Open Settings</Text>
          </Pressable>
          <Pressable style={s.modalDismissBtn} onPress={() => setShowCalendarDenied(false)}>
            <Text style={s.modalDismissText}>Not now</Text>
          </Pressable>
        </View>
      </Modal>

    </View>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised },
  headerTitle: { ...t.bodyStrong, color: color.ink, flex: 1, fontWeight: '700' },
  cancelChip: { paddingHorizontal: space.sm, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: '#DC2626' },
  cancelChipText: { ...t.small, color: '#DC2626', fontWeight: '700' },
  editChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper },
  editChipText: { ...t.small, color: color.ink, fontWeight: '700' },
  editSaveBtn: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: color.signal, minWidth: 52, alignItems: 'center', justifyContent: 'center' },
  editSaveBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },
  editLabel:      { ...t.small, color: color.mute, fontWeight: '600', marginBottom: 4, marginTop: space.sm },
  editInput:      { ...t.body, color: color.ink, backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: 42 },
  editInputMulti: { minHeight: 80, textAlignVertical: 'top', paddingTop: space.sm },
  blockRow:       { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  blockBtn:       { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper },
  blockBtnActive: { backgroundColor: color.signal, borderColor: color.signal },
  blockBtnText:   { ...t.small, fontWeight: '700', color: color.ink },
  blockBtnTextActive: { color: color.onInk },
  clearTimeText:  { ...t.small, color: color.signal, fontWeight: '700', textAlign: 'right', marginTop: 2 },
  editLabelRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  ageLimitRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: space.sm },
  ageRangeRow:    { flexDirection: 'row', gap: space.md, marginTop: space.xs },
  ageRangeField:  { flex: 1 },
  ageRangeLabel:  { ...t.small, color: color.mute, fontWeight: '600', marginBottom: 4 },
  ageRangeInput:  { ...t.body, color: color.ink, backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: 42, textAlign: 'center' },

  scroll: { padding: space.lg, gap: space.md, paddingBottom: space.xxxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  errText: { ...t.body, color: color.mute },
  retryBtn: { paddingHorizontal: space.xl, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal },
  retryText: { ...t.bodyStrong, color: color.signal },

  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm, ...shadow.card },
  statusPill: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill },
  statusText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  scopeTag: { ...t.small, color: color.mute, fontSize: 11 },
  ageBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#F59E0B' },
  ageBadgeText: { fontSize: 11, fontWeight: '700', color: '#92400E' },
  ageGate: { backgroundColor: '#FEF9C3', borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: '#FCD34D', gap: 6 },
  ageGateTitle: { ...t.bodyStrong, color: '#92400E', fontWeight: '700', fontSize: 13 },
  ageGateText: { ...t.small, color: '#78350F', fontSize: 12 },
  title: { ...t.title, color: color.ink, fontSize: 22 },
  desc: { ...t.body, color: color.mute, lineHeight: 20 },
  creatorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  creatorName: { ...t.small, color: color.mute, fontSize: 12, flex: 1 },
  creatorFallback: { ...t.small, color: color.faint, fontSize: 12, marginTop: 6 },
  sectionTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700', marginBottom: 4 },
  metaRow:        { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText:       { ...t.body, color: color.mute },
  noDateRow:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  noDateText:     { ...t.body, color: color.faint, flex: 1 },
  noDateChip:     { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper },
  noDateChipText: { ...t.small, color: color.signal, fontWeight: '700' },
  locTbdText:     { ...t.body, color: color.faint, fontStyle: 'italic' },

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
  voteBtn: { width: avatar.s34, height: avatar.s34, borderRadius: avatar.s34 / 2, alignItems: 'center', justifyContent: 'center' },
  confirmBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: '#16A34A', marginLeft: 'auto' },
  confirmBtnText: { ...t.small, color: '#16A34A', fontWeight: '700', fontSize: 11 },
  voteHint: { ...t.small, color: color.faint, fontSize: 11, marginTop: 4 },

  addPlanBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md },
  addPlanBtnAdded: { backgroundColor: color.deep, opacity: 0.75 },
  addPlanBtnText: { ...t.bodyStrong, color: color.onInk },
  linkBtn: { alignItems: 'center', paddingVertical: space.sm },
  linkBtnText: { ...t.bodyStrong, color: color.signal },

  calBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1.5, borderColor: color.signal, paddingVertical: space.md },
  calBtnAdded: { backgroundColor: color.signal, borderColor: color.signal },
  calBtnText: { ...t.bodyStrong, color: color.signal },
  calBtnTextAdded: { color: color.onInk },
  calBtnDisabled: { borderColor: color.haze, opacity: 0.55 },
  calBtnTextDisabled: { color: color.haze },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  modalSheet: { backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: space.xl, gap: space.md, ...shadow.card },
  modalHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.sm },
  modalTitle: { ...t.title, color: color.ink, fontWeight: '700', textAlign: 'center', fontSize: 18 },
  modalBody: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },
  modalSettingsBtn: { backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center' },
  modalSettingsBtnText: { ...t.bodyStrong, color: color.onInk },
  modalDismissBtn: { alignItems: 'center', paddingVertical: space.sm },
  modalDismissText: { ...t.body, color: color.mute },

  toast: { position: 'absolute', bottom: 80, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#16A34A', paddingHorizontal: space.lg, paddingVertical: space.sm + 2, borderRadius: radius.pill, ...shadow.card },
  toastText: { ...t.bodyStrong, color: '#fff', fontSize: 14 },
});
