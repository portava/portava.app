/**
 * MeetupCreationSheet — bottom sheet for creating a meetup.
 *
 * Steps:
 *   1. Details  — title, location, description
 *   2. Invite   — searchable friend/member picker (optional)
 *   3. Times    — propose up to 5 date+block slots (optional toggle)
 *
 * Props:
 *   tripId        — pre-fill trip scope (optional)
 *   circleOwnerId — pre-fill circle scope (optional)
 *   onCreated     — callback after successful creation
 *   onDismiss     — close the sheet
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView, Image,
} from 'react-native';
import { X, MapPin, CalendarClock, Users, Check, ChevronDown, ChevronUp, Plus, Trash2, Search } from 'lucide-react-native';
import { createMeetup, addTimeOption, type MeetupSummary, type TimeBlock, type MeetupVisibility } from '../services/meetups';
import { getMyFriends, type FriendRow } from '../services/friends';
import { color, space, radius, type as t } from '../theme/tokens';

const BLOCKS: { key: TimeBlock; label: string }[] = [
  { key: 'morning',   label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening',   label: 'Evening' },
  { key: 'late',      label: 'Late night' },
];

interface TimeSlot { date: string; block: TimeBlock | null; }

interface Props {
  tripId?: string;
  circleOwnerId?: string;
  onCreated?: (meetup: MeetupSummary) => void;
  onDismiss: () => void;
  initialTitle?: string;
  initialLocation?: string;
}

// ── Small sub-components ─────────────────────────────────────────────────────

function FriendAvatar({ user }: { user: FriendRow }) {
  if (user.avatarUrl) return <Image source={{ uri: user.avatarUrl }} style={sub.avatar} />;
  return (
    <View style={[sub.avatar, sub.avatarFallback]}>
      <Text style={sub.avatarInitial}>{(user.name?.[0] ?? user.handle?.[0] ?? '?').toUpperCase()}</Text>
    </View>
  );
}

function SelectedChips({ users, onRemove }: { users: FriendRow[]; onRemove: (id: string) => void }) {
  if (users.length === 0) return null;
  return (
    <View style={sub.chips}>
      {users.map((u) => (
        <View key={u.id} style={sub.chip}>
          <FriendAvatar user={u} />
          <Text style={sub.chipName} numberOfLines={1}>{u.name || u.handle}</Text>
          <Pressable onPress={() => onRemove(u.id)} hitSlop={8}>
            <X size={12} color={color.mute} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function TimeSlotRow({
  slot, index, onChange, onRemove, canRemove,
}: {
  slot: TimeSlot; index: number; onChange: (s: TimeSlot) => void; onRemove: () => void; canRemove: boolean;
}) {
  return (
    <View style={sub.slotCard}>
      <View style={sub.slotHeader}>
        <Text style={sub.slotNum}>Slot {index + 1}</Text>
        {canRemove && (
          <Pressable onPress={onRemove} hitSlop={8}>
            <Trash2 size={14} color={color.mute} />
          </Pressable>
        )}
      </View>
      <View style={sub.slotDateRow}>
        <CalendarClock size={12} color={color.mute} />
        <TextInput
          style={sub.slotDateInput}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={color.faint}
          value={slot.date}
          onChangeText={(v) => onChange({ ...slot, date: v })}
          maxLength={10}
          keyboardType="numbers-and-punctuation"
        />
      </View>
      <View style={sub.blockRow}>
        {BLOCKS.map((b) => {
          const active = slot.block === b.key;
          return (
            <Pressable
              key={b.key}
              style={[sub.blockBtn, active && sub.blockBtnActive]}
              onPress={() => onChange({ ...slot, block: active ? null : b.key })}
            >
              <Text style={[sub.blockBtnText, active && sub.blockBtnTextActive]}>{b.label}</Text>
              {active && <Check size={10} color={color.onInk} />}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function MeetupCreationSheet({
  tripId, circleOwnerId, onCreated, onDismiss, initialTitle, initialLocation,
}: Props) {
  // Details
  const [title, setTitle] = useState(initialTitle ?? '');
  const [description, setDescription] = useState('');
  const [locationName, setLocationName] = useState(initialLocation ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Invite section
  const [inviteOpen, setInviteOpen] = useState(false);
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [friendSearch, setFriendSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Time proposals
  const [proposeMode, setProposeMode] = useState(false);
  const [slots, setSlots] = useState<TimeSlot[]>([{ date: '', block: null }]);

  // Legacy single-date (when propose mode is off)
  const [approximateDate, setApproximateDate] = useState('');
  const [timeBlock, setTimeBlock] = useState<TimeBlock | null>(null);

  const defaultVisibility: MeetupVisibility = tripId ? 'trip' : circleOwnerId ? 'circle' : 'invitees';

  // Load friends lazily when invite section opens
  const loadFriends = useCallback(async () => {
    if (friends.length > 0 || friendsLoading) return;
    setFriendsLoading(true);
    const res = await getMyFriends();
    setFriendsLoading(false);
    if (res.ok && res.data) setFriends(res.data.friends);
  }, [friends.length, friendsLoading]);

  useEffect(() => {
    if (inviteOpen) loadFriends();
  }, [inviteOpen, loadFriends]);

  const selectedFriends = friends.filter((f) => selectedIds.has(f.id));

  const filteredFriends = friends.filter((f) => {
    const q = friendSearch.toLowerCase();
    return (
      (f.name?.toLowerCase().includes(q) || f.handle?.toLowerCase().includes(q)) ?? false
    );
  });

  function toggleFriend(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addSlot() {
    if (slots.length >= 5) return;
    setSlots((prev) => [...prev, { date: '', block: null }]);
  }

  function removeSlot(i: number) {
    setSlots((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateSlot(i: number, s: TimeSlot) {
    setSlots((prev) => prev.map((x, idx) => (idx === i ? s : x)));
  }

  async function handleCreate() {
    const trimmed = title.trim();
    if (!trimmed) { setError('Please enter a title'); return; }

    if (proposeMode) {
      const validSlots = slots.filter((s) => s.date.match(/^\d{4}-\d{2}-\d{2}$/));
      if (validSlots.length === 0) {
        setError('Add at least one valid date (YYYY-MM-DD) to your time proposals.');
        return;
      }
    }

    setSaving(true);
    setError(null);

    const res = await createMeetup({
      title: trimmed,
      description: description.trim() || undefined,
      locationName: locationName.trim() || undefined,
      approximateDate: (!proposeMode && approximateDate.trim()) ? approximateDate.trim() : undefined,
      timeBlock: (!proposeMode && timeBlock) ? timeBlock : undefined,
      tripId,
      circleOwnerId,
      visibility: defaultVisibility,
      inviteeIds: selectedIds.size > 0 ? [...selectedIds] : undefined,
    });

    if (!res.ok || !res.data) {
      setSaving(false);
      setError(res.message ?? 'Could not create meetup');
      return;
    }

    const meetupId = res.data.id;

    // Post time slots if in propose mode
    if (proposeMode) {
      const validSlots = slots.filter((s) => s.date.match(/^\d{4}-\d{2}-\d{2}$/));
      for (const slot of validSlots) {
        await addTimeOption(meetupId, {
          proposedDate: slot.date,
          timeBlock: slot.block ?? undefined,
        });
      }
    }

    setSaving(false);
    onCreated?.(res.data);
    onDismiss();
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={s.kav}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          {/* Header */}
          <View style={s.sheetHead}>
            <Text style={s.sheetTitle}>New Meetup</Text>
            {(tripId || circleOwnerId) && (
              <View style={s.scopeBadge}>
                <Users size={11} color={color.signal} />
                <Text style={s.scopeText}>{tripId ? 'Trip' : 'Circle'}</Text>
              </View>
            )}
            <View style={{ flex: 1 }} />
            <Pressable onPress={onDismiss} hitSlop={8}><X size={20} color={color.ink} /></Pressable>
          </View>

          <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">

            {/* ── Details ── */}
            <Text style={s.label}>Title *</Text>
            <TextInput
              style={s.input}
              placeholder="e.g. Sunset drinks at a rooftop bar"
              placeholderTextColor={color.faint}
              value={title}
              onChangeText={setTitle}
              maxLength={200}
              autoFocus
            />

            <View style={s.labelRow}>
              <MapPin size={12} color={color.mute} />
              <Text style={s.label}>Location</Text>
            </View>
            <TextInput
              style={s.input}
              placeholder="e.g. Mango Square, Cebu"
              placeholderTextColor={color.faint}
              value={locationName}
              onChangeText={setLocationName}
              maxLength={300}
            />

            <Text style={s.label}>Description (optional)</Text>
            <TextInput
              style={[s.input, { minHeight: 60, textAlignVertical: 'top' }]}
              placeholder="What's the plan?"
              placeholderTextColor={color.faint}
              value={description}
              onChangeText={setDescription}
              maxLength={1000}
              multiline
            />

            {/* ── Invite people ── */}
            <View style={s.divider} />
            <Pressable style={s.sectionToggle} onPress={() => setInviteOpen((v) => !v)}>
              <Users size={14} color={color.ink} />
              <Text style={s.sectionToggleText}>Invite people</Text>
              {selectedIds.size > 0 && (
                <View style={s.countBadge}><Text style={s.countBadgeText}>{selectedIds.size}</Text></View>
              )}
              <View style={{ flex: 1 }} />
              {inviteOpen ? <ChevronUp size={16} color={color.mute} /> : <ChevronDown size={16} color={color.mute} />}
            </Pressable>

            {inviteOpen && (
              <View style={s.inviteBody}>
                <SelectedChips users={selectedFriends} onRemove={(id) => toggleFriend(id)} />
                {friendsLoading ? (
                  <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.md }} />
                ) : friends.length === 0 ? (
                  <Text style={s.emptyNote}>No friends yet — connect with travelers first.</Text>
                ) : (
                  <>
                    <View style={s.searchRow}>
                      <Search size={14} color={color.mute} />
                      <TextInput
                        style={s.searchInput}
                        placeholder="Search friends…"
                        placeholderTextColor={color.faint}
                        value={friendSearch}
                        onChangeText={setFriendSearch}
                        autoCapitalize="none"
                      />
                    </View>
                    <View style={s.friendList}>
                      {filteredFriends.map((f) => {
                        const selected = selectedIds.has(f.id);
                        return (
                          <Pressable
                            key={f.id}
                            style={[s.friendRow, selected && s.friendRowActive]}
                            onPress={() => toggleFriend(f.id)}
                          >
                            <FriendAvatar user={f} />
                            <View style={{ flex: 1 }}>
                              <Text style={s.friendName} numberOfLines={1}>{f.name || f.handle}</Text>
                              {f.name && f.handle ? <Text style={s.friendHandle} numberOfLines={1}>@{f.handle}</Text> : null}
                            </View>
                            <View style={[s.checkbox, selected && s.checkboxActive]}>
                              {selected && <Check size={11} color={color.onInk} />}
                            </View>
                          </Pressable>
                        );
                      })}
                      {filteredFriends.length === 0 && friendSearch ? (
                        <Text style={s.emptyNote}>No friends match "{friendSearch}"</Text>
                      ) : null}
                    </View>
                  </>
                )}
              </View>
            )}

            {/* ── Time proposals ── */}
            <View style={s.divider} />
            <View style={s.proposeHeader}>
              <CalendarClock size={14} color={color.ink} />
              <Text style={s.sectionToggleText}>Propose times</Text>
              <View style={{ flex: 1 }} />
              <Pressable
                style={[s.toggle, proposeMode && s.toggleOn]}
                onPress={() => setProposeMode((v) => !v)}
              >
                <View style={[s.toggleThumb, proposeMode && s.toggleThumbOn]} />
              </Pressable>
            </View>
            <Text style={s.proposeHint}>
              {proposeMode
                ? 'Invitees will vote on your proposed times. You confirm the winner.'
                : 'Off — set a single approximate date and time of day.'}
            </Text>

            {!proposeMode ? (
              <View style={s.singleDate}>
                <View style={s.labelRow}>
                  <CalendarClock size={12} color={color.mute} />
                  <Text style={s.label}>Approximate date (YYYY-MM-DD)</Text>
                </View>
                <TextInput
                  style={s.input}
                  placeholder="e.g. 2026-07-04"
                  placeholderTextColor={color.faint}
                  value={approximateDate}
                  onChangeText={setApproximateDate}
                  maxLength={10}
                  keyboardType="numbers-and-punctuation"
                />
                <Text style={s.label}>Time of day</Text>
                <View style={s.blockRow}>
                  {BLOCKS.map((b) => {
                    const active = timeBlock === b.key;
                    return (
                      <Pressable
                        key={b.key}
                        style={[s.blockBtn, active && s.blockBtnActive]}
                        onPress={() => setTimeBlock(active ? null : b.key)}
                      >
                        <Text style={[s.blockBtnText, active && s.blockBtnTextActive]}>{b.label}</Text>
                        {active && <Check size={11} color={color.onInk} />}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : (
              <View style={{ gap: space.sm }}>
                {slots.map((slot, i) => (
                  <TimeSlotRow
                    key={i}
                    slot={slot}
                    index={i}
                    onChange={(s) => updateSlot(i, s)}
                    onRemove={() => removeSlot(i)}
                    canRemove={slots.length > 1}
                  />
                ))}
                {slots.length < 5 && (
                  <Pressable style={s.addSlotBtn} onPress={addSlot}>
                    <Plus size={14} color={color.signal} />
                    <Text style={s.addSlotText}>Add another time ({slots.length}/5)</Text>
                  </Pressable>
                )}
              </View>
            )}

            {/* ── Error + Submit ── */}
            {error ? <Text style={s.errText}>{error}</Text> : null}

            <Pressable style={[s.createBtn, saving && { opacity: 0.6 }]} onPress={handleCreate} disabled={saving}>
              {saving ? <ActivityIndicator size="small" color={color.onInk} /> : null}
              <Text style={s.createBtnText}>
                {saving ? 'Creating…' : selectedIds.size > 0 ? `Create & Invite ${selectedIds.size}` : 'Create Meetup'}
              </Text>
            </Pressable>

          </ScrollView>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// ── Sub-styles ────────────────────────────────────────────────────────────────

const sub = StyleSheet.create({
  avatar: { width: 32, height: 32, borderRadius: 16 },
  avatarFallback: { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.sm },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.sm, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal, backgroundColor: color.paperRaised, maxWidth: 150 },
  chipName: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 11, flex: 1 },
  slotCard: { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm },
  slotHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  slotNum: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  slotDateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  slotDateInput: { flex: 1, backgroundColor: color.paperRaised, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.sm, paddingVertical: 7, ...t.body, color: color.ink, fontSize: 14 },
  blockRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  blockBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: space.sm, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  blockBtnActive: { backgroundColor: color.signal, borderColor: color.signal },
  blockBtnText: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 11 },
  blockBtnTextActive: { color: color.onInk },
});

// ── Main styles ───────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  kav: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: color.haze, maxHeight: '92%' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  sheetTitle: { ...t.title, color: color.ink, fontSize: 18 },
  scopeBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal },
  scopeText: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 11 },
  body: { padding: space.lg, gap: space.md, paddingBottom: space.xxxl },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  input: { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: space.sm + 2, ...t.body, color: color.ink },

  divider: { height: 1, backgroundColor: color.haze, marginVertical: space.xs },

  sectionToggle: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  sectionToggleText: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  countBadge: { backgroundColor: color.signal, borderRadius: 999, minWidth: 20, height: 20, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  countBadgeText: { ...t.small, color: color.onInk, fontWeight: '800', fontSize: 11 },

  inviteBody: { gap: space.sm, marginTop: space.xs },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: space.sm },
  searchInput: { flex: 1, ...t.body, color: color.ink, padding: 0 },
  friendList: { gap: 2, maxHeight: 240 },
  friendRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent' },
  friendRowActive: { backgroundColor: '#FFF0ED', borderColor: color.signal },
  friendName: { ...t.bodyStrong, color: color.ink, fontWeight: '600', fontSize: 14 },
  friendHandle: { ...t.small, color: color.mute, fontSize: 11 },
  checkbox: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paper },
  checkboxActive: { backgroundColor: color.signal, borderColor: color.signal },
  emptyNote: { ...t.small, color: color.faint, textAlign: 'center', paddingVertical: space.md },

  proposeHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  proposeHint: { ...t.small, color: color.mute, fontSize: 11, marginTop: -space.sm },
  toggle: { width: 44, height: 26, borderRadius: 13, backgroundColor: color.haze, justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn: { backgroundColor: color.signal },
  toggleThumb: { width: 22, height: 22, borderRadius: 11, backgroundColor: color.paperRaised },
  toggleThumbOn: { alignSelf: 'flex-end' },

  singleDate: { gap: space.md },
  blockRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  blockBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper },
  blockBtnActive: { backgroundColor: color.signal, borderColor: color.signal },
  blockBtnText: { ...t.small, fontWeight: '700', color: color.ink },
  blockBtnTextActive: { color: color.onInk },

  addSlotBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.signal },
  addSlotText: { ...t.bodyStrong, color: color.signal, fontSize: 13 },

  errText: { ...t.small, color: '#DC2626', textAlign: 'center' },
  createBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md },
  createBtnText: { ...t.bodyStrong, color: color.onInk },
});
