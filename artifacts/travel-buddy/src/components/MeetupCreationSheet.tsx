/**
 * MeetupCreationSheet — bottom sheet for creating a meetup.
 *
 * Invite picker:
 *   - No context     → shows your friends list (flat)
 *   - tripId         → "Trip members" section (pre-selected, locked) +
 *                      "Other friends" section below
 *   - circleOwnerId  → "Circle members" section (pre-selected, locked) +
 *                      "Other friends" section below
 *
 * Group members are pre-selected and locked — they are the primary audience
 * for this meetup and will always be invited. Other friends are optional.
 *
 * Time proposals:
 *   - Off (default) → single approximate date + time-of-day block
 *   - On  → up to 5 date+block slots; addTimeOption called after creation
 *           Any slot failures are surfaced and the sheet stays open.
 *
 * Props:
 *   tripId        — pre-fill trip scope (optional)
 *   circleOwnerId — pre-fill circle scope (optional)
 *   onCreated     — callback after successful creation + time-slot posting
 *   onDismiss     — close the sheet
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView, Image,
} from 'react-native';
import {
  X, MapPin, CalendarClock, Users, Check, ChevronDown, ChevronUp,
  Plus, Trash2, Search,
} from 'lucide-react-native';
import { DatePickerField } from './DateTimePickerField';
import {
  createMeetup, addTimeOption,
  type MeetupSummary, type TimeBlock, type MeetupVisibility,
} from '../services/meetups';
import {
  getMyFriends, getTripInvitableUsers, getCircleInvitableUsers, type FriendUser,
} from '../services/friends';
import { color, space, radius, type as t } from '../theme/tokens';

// ── Types ─────────────────────────────────────────────────────────────────────

const BLOCKS: { key: TimeBlock; label: string }[] = [
  { key: 'morning',   label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening',   label: 'Evening' },
  { key: 'late',      label: 'Late night' },
];

interface TimeSlot { date: Date | null; block: TimeBlock | null; proposedTime: Date | null; }

interface Props {
  tripId?: string;
  circleOwnerId?: string;
  onCreated?: (meetup: MeetupSummary) => void;
  onDismiss: () => void;
  initialTitle?: string;
  initialLocation?: string;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function PersonAvatar({ user }: { user: FriendUser }) {
  if (user.avatarUrl) return <Image source={{ uri: user.avatarUrl }} style={sub.avatar} />;
  return (
    <View style={[sub.avatar, sub.avatarFallback]}>
      <Text style={sub.avatarInitial}>
        {(user.name?.[0] ?? user.handle?.[0] ?? '?').toUpperCase()}
      </Text>
    </View>
  );
}

function SelectedChips({
  users, lockedIds, onRemove,
}: { users: FriendUser[]; lockedIds: Set<string>; onRemove: (id: string) => void }) {
  if (users.length === 0) return null;
  return (
    <View style={sub.chips}>
      {users.map((u) => {
        const locked = lockedIds.has(u.id);
        return (
          <View key={u.id} style={[sub.chip, locked && sub.chipLocked]}>
            <PersonAvatar user={u} />
            <Text style={[sub.chipName, locked && sub.chipNameLocked]} numberOfLines={1}>
              {u.name || u.handle}
            </Text>
            {locked ? (
              <Check size={11} color={color.signal} />
            ) : (
              <Pressable onPress={() => onRemove(u.id)} hitSlop={8}>
                <X size={12} color={color.mute} />
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}

function BlockPicker({
  value, onChange, small,
}: { value: TimeBlock | null; onChange: (b: TimeBlock | null) => void; small?: boolean }) {
  return (
    <View style={[sub.blockRow, small && { gap: space.xs }]}>
      {BLOCKS.map((b) => {
        const active = value === b.key;
        return (
          <Pressable
            key={b.key}
            style={[sub.blockBtn, active && sub.blockBtnActive, small && sub.blockBtnSmall]}
            onPress={() => onChange(active ? null : b.key)}
          >
            <Text style={[sub.blockBtnText, active && sub.blockBtnTextActive,
              small && { fontSize: 11 }]}>{b.label}</Text>
            {active && <Check size={small ? 10 : 11} color={color.onInk} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const TODAY_START = new Date();
TODAY_START.setHours(0, 0, 0, 0);

function TimeSlotRow({
  slot, index, onChange, onRemove, canRemove,
}: {
  slot: TimeSlot; index: number;
  onChange: (s: TimeSlot) => void; onRemove: () => void; canRemove: boolean;
}) {
  const isPast = slot.date !== null && slot.date < TODAY_START;
  return (
    <View style={[sub.slotCard, isPast && sub.slotCardPast]}>
      <View style={sub.slotHeader}>
        <Text style={sub.slotNum}>Slot {index + 1}</Text>
        {isPast && <Text style={sub.slotPastWarning}>Date is in the past</Text>}
        {canRemove && (
          <Pressable onPress={onRemove} hitSlop={8}>
            <Trash2 size={14} color={color.mute} />
          </Pressable>
        )}
      </View>
      <DatePickerField
        value={slot.date}
        onChange={(d) => onChange({ ...slot, date: d })}
        minimumDate={TODAY_START}
        placeholder="Pick a date"
      />
      <View style={sub.slotTimeRow}>
        <View style={{ flex: 1 }}>
          <DatePickerField
            mode="time"
            value={slot.proposedTime}
            onChange={(t) => onChange({ ...slot, proposedTime: t, block: null })}
            onClear={() => onChange({ ...slot, proposedTime: null })}
            placeholder="Pick a time (optional)"
          />
        </View>
      </View>
      <View style={slot.proposedTime ? sub.blockRowDimmed : undefined}>
        <BlockPicker
          small
          value={slot.proposedTime ? null : slot.block}
          onChange={(b) => { if (!slot.proposedTime) onChange({ ...slot, block: b }); }}
        />
      </View>
      {slot.proposedTime && (
        <Text style={sub.slotTimeNote}>Block ignored — exact time set above</Text>
      )}
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function MeetupCreationSheet({
  tripId, circleOwnerId, onCreated, onDismiss, initialTitle, initialLocation,
}: Props) {

  // ── Details ──
  const [title, setTitle]           = useState(initialTitle ?? '');
  const [description, setDescription] = useState('');
  const [locationName, setLocationName] = useState(initialLocation ?? '');
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState<string | null>(null);

  // ── Invite section ──
  const [inviteOpen, setInviteOpen] = useState(false);
  const [groupMembers, setGroupMembers] = useState<FriendUser[]>([]);
  const [otherFollowers, setOtherFollowers] = useState<FriendUser[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesLoaded, setCandidatesLoaded] = useState(false);
  const [friendSearch, setFriendSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());

  // ── Time proposals ──
  const [proposeMode, setProposeMode] = useState(false);
  const [slots, setSlots] = useState<TimeSlot[]>([{ date: null, block: null, proposedTime: null }]);

  // ── Single-date (propose mode off) ──
  const [approximateDate, setApproximateDate] = useState<Date | null>(null);
  const [exactTime, setExactTime] = useState<Date | null>(null);
  const [timeBlock, setTimeBlock] = useState<TimeBlock | null>(null);

  const defaultVisibility: MeetupVisibility =
    tripId ? 'trip' : circleOwnerId ? 'circle' : 'invitees';

  // Load candidates:
  //   trip context   → groupMembers (locked, pre-selected) + otherFollowers
  //   circle context → groupMembers (locked, pre-selected) + otherFollowers
  //   plain          → otherFollowers only (friends list, flat)
  const loadCandidates = useCallback(async () => {
    if (candidatesLoaded || candidatesLoading) return;
    setCandidatesLoading(true);

    if (tripId) {
      const res = await getTripInvitableUsers(tripId);
      if (res.ok && res.data) {
        const { groupMembers: gm, otherFollowers: of_ } = res.data;
        setGroupMembers(gm);
        setOtherFollowers(of_);
        const ids = new Set(gm.map((u) => u.id));
        setLockedIds(ids);
        setSelectedIds(new Set(ids));
      }
    } else if (circleOwnerId) {
      const res = await getCircleInvitableUsers(circleOwnerId);
      if (res.ok && res.data) {
        const { groupMembers: gm, otherFollowers: of_ } = res.data;
        setGroupMembers(gm);
        setOtherFollowers(of_);
        const ids = new Set(gm.map((u) => u.id));
        setLockedIds(ids);
        setSelectedIds(new Set(ids));
      }
    } else {
      const res = await getMyFriends();
      const list = (res.ok && res.data) ? res.data.friends : [];
      setOtherFollowers(list);
    }

    setCandidatesLoading(false);
    setCandidatesLoaded(true);
  }, [candidatesLoaded, candidatesLoading, tripId, circleOwnerId]);

  useEffect(() => {
    if (inviteOpen) loadCandidates();
  }, [inviteOpen, loadCandidates]);

  const allCandidates = [...groupMembers, ...otherFollowers];
  const selectedCandidates = allCandidates.filter((c) => selectedIds.has(c.id));

  const filterUser = (c: FriendUser) => {
    if (!friendSearch) return true;
    const q = friendSearch.toLowerCase();
    return (c.name?.toLowerCase().includes(q) || c.handle?.toLowerCase().includes(q)) ?? false;
  };
  const filteredGroup   = groupMembers.filter(filterUser);
  const filteredOthers  = otherFollowers.filter(filterUser);

  function toggleCandidate(id: string) {
    if (lockedIds.has(id)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const hasContext = !!(tripId || circleOwnerId);
  const groupLabel = tripId ? 'Trip members' : 'Circle members';
  const hasCandidates = candidatesLoaded && (groupMembers.length > 0 || otherFollowers.length > 0);

  function addSlot() {
    if (slots.length >= 5) return;
    setSlots((prev) => [...prev, { date: null, block: null, proposedTime: null }]);
  }

  function removeSlot(i: number) {
    setSlots((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateSlot(i: number, s: TimeSlot) {
    setSlots((prev) => prev.map((x, idx) => (idx === i ? s : x)));
  }

  function toISODate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function combineDateTime(date: Date, time: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const h = String(time.getHours()).padStart(2, '0');
    const min = String(time.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day}T${h}:${min}:00`;
  }

  async function handleCreate() {
    const trimmed = title.trim();
    if (!trimmed) { setError('Please enter a title'); return; }

    // Validate: single-date mode — past date check
    if (!proposeMode && approximateDate && approximateDate < TODAY_START) {
      setError('The selected date is in the past. Please choose a future date.');
      return;
    }

    // Validate: propose mode — need at least one slot with a date
    const validSlots = proposeMode
      ? slots.filter((s) => s.date !== null)
      : [];

    if (proposeMode && validSlots.length === 0) {
      setError('Pick a date for at least one time slot.');
      return;
    }

    // Validate: propose mode — no past dates
    const pastSlots = validSlots.filter((s) => s.date! < TODAY_START);
    if (pastSlots.length > 0) {
      setError(`${pastSlots.length} slot${pastSlots.length > 1 ? 's are' : ' is'} in the past. Remove or update them first.`);
      return;
    }

    setSaving(true);
    setError(null);

    const res = await createMeetup({
      title: trimmed,
      description:     description.trim() || undefined,
      locationName:    locationName.trim() || undefined,
      approximateDate: (!proposeMode && approximateDate) ? toISODate(approximateDate) : undefined,
      timeBlock:       (!proposeMode && !exactTime && timeBlock) ? timeBlock : undefined,
      startsAt:        (!proposeMode && approximateDate && exactTime)
        ? combineDateTime(approximateDate, exactTime)
        : undefined,
      tripId,
      circleOwnerId,
      visibility:      defaultVisibility,
      inviteeIds:      selectedIds.size > 0 ? [...selectedIds] : undefined,
    });

    if (!res.ok || !res.data) {
      setSaving(false);
      setError(res.message ?? 'Could not create meetup');
      return;
    }

    const meetupId = res.data.id;

    // Post each valid time slot; collect any failures
    if (proposeMode && validSlots.length > 0) {
      const slotResults = await Promise.all(
        validSlots.map((slot) => {
          const pt = slot.proposedTime;
          const proposedTime = pt
            ? `${String(pt.getHours()).padStart(2, '0')}:${String(pt.getMinutes()).padStart(2, '0')}`
            : undefined;
          return addTimeOption(meetupId, {
            proposedDate: toISODate(slot.date!),
            proposedTime,
            timeBlock: proposedTime ? undefined : (slot.block ?? undefined),
          });
        }),
      );

      const failed = slotResults.filter((r) => !r.ok);
      if (failed.length > 0) {
        setSaving(false);
        setError(
          `Meetup created, but ${failed.length} time slot${failed.length > 1 ? 's' : ''} could not be saved. ` +
          `You can add them from the meetup page.`,
        );
        // Still proceed — meetup exists; partial slot failures are recoverable
        onCreated?.(res.data);
        return;
      }
    }

    setSaving(false);
    onCreated?.(res.data);
    onDismiss();
  }

  const inviteLabel = tripId ? 'Trip members' : circleOwnerId ? 'Circle members' : 'Friends';

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
              <Text style={s.sectionToggleText}>Invite {inviteLabel}</Text>
              {selectedIds.size > 0 && (
                <View style={s.countBadge}>
                  <Text style={s.countBadgeText}>{selectedIds.size}</Text>
                </View>
              )}
              <View style={{ flex: 1 }} />
              {inviteOpen
                ? <ChevronUp size={16} color={color.mute} />
                : <ChevronDown size={16} color={color.mute} />}
            </Pressable>

            {inviteOpen && (
              <View style={s.inviteBody}>
                <SelectedChips
                  users={selectedCandidates}
                  lockedIds={lockedIds}
                  onRemove={toggleCandidate}
                />
                {candidatesLoading ? (
                  <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.md }} />
                ) : !hasCandidates ? (
                  <Text style={s.emptyNote}>
                    {hasContext
                      ? 'No members found. You can still create the meetup.'
                      : 'No friends yet — connect with travelers first.'}
                  </Text>
                ) : (
                  <>
                    <View style={s.searchRow}>
                      <Search size={14} color={color.mute} />
                      <TextInput
                        style={s.searchInput}
                        placeholder="Search…"
                        placeholderTextColor={color.faint}
                        value={friendSearch}
                        onChangeText={setFriendSearch}
                        autoCapitalize="none"
                      />
                    </View>

                    {/* ── Group members section (trip / circle context) ── */}
                    {hasContext && filteredGroup.length > 0 && (
                      <>
                        <View style={s.sectionHeaderRow}>
                          <Text style={s.sectionHeaderText}>{groupLabel}</Text>
                          <Text style={s.sectionHeaderHint}>Always invited</Text>
                        </View>
                        <View style={s.candidateList}>
                          {filteredGroup.map((c) => (
                            <View key={c.id} style={[s.candidateRow, s.candidateRowLocked]}>
                              <PersonAvatar user={c} />
                              <View style={{ flex: 1 }}>
                                <Text style={s.candidateName} numberOfLines={1}>{c.name || c.handle}</Text>
                                {c.name && c.handle
                                  ? <Text style={s.candidateHandle} numberOfLines={1}>@{c.handle}</Text>
                                  : null}
                              </View>
                              <View style={s.checkboxLocked}>
                                <Check size={11} color={color.signal} />
                              </View>
                            </View>
                          ))}
                          {filteredGroup.length === 0 && friendSearch ? (
                            <Text style={s.emptyNote}>No match in {groupLabel.toLowerCase()}</Text>
                          ) : null}
                        </View>
                      </>
                    )}

                    {/* ── Other followers section ── */}
                    {filteredOthers.length > 0 && (
                      <>
                        {hasContext && (
                          <View style={s.sectionHeaderRow}>
                            <Text style={s.sectionHeaderText}>Other friends</Text>
                          </View>
                        )}
                        <View style={s.candidateList}>
                          {filteredOthers.map((c) => {
                            const selected = selectedIds.has(c.id);
                            return (
                              <Pressable
                                key={c.id}
                                style={[s.candidateRow, selected && s.candidateRowActive]}
                                onPress={() => toggleCandidate(c.id)}
                              >
                                <PersonAvatar user={c} />
                                <View style={{ flex: 1 }}>
                                  <Text style={s.candidateName} numberOfLines={1}>
                                    {c.name || c.handle}
                                  </Text>
                                  {c.name && c.handle
                                    ? <Text style={s.candidateHandle} numberOfLines={1}>@{c.handle}</Text>
                                    : null}
                                </View>
                                <View style={[s.checkbox, selected && s.checkboxActive]}>
                                  {selected && <Check size={11} color={color.onInk} />}
                                </View>
                              </Pressable>
                            );
                          })}
                          {filteredOthers.length === 0 && friendSearch ? (
                            <Text style={s.emptyNote}>No match for "{friendSearch}"</Text>
                          ) : null}
                        </View>
                      </>
                    )}

                    {/* Empty state: all followers already in the group */}
                    {hasContext && !friendSearch && candidatesLoaded && otherFollowers.length === 0 && (
                      <Text style={s.emptyNote}>
                        All your friends are already in this {tripId ? 'trip' : 'circle'}.
                      </Text>
                    )}

                    {/* No results at all for this search */}
                    {friendSearch && filteredGroup.length === 0 && filteredOthers.length === 0 && (
                      <Text style={s.emptyNote}>No match for "{friendSearch}"</Text>
                    )}
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
                ? 'Invitees vote on your proposed times — you confirm the winner.'
                : 'Off — set a single approximate date and time of day.'}
            </Text>

            {!proposeMode ? (
              <View style={s.singleDate}>
                <View style={s.labelRow}>
                  <CalendarClock size={12} color={color.mute} />
                  <Text style={s.label}>Approximate date</Text>
                </View>
                <DatePickerField
                  value={approximateDate}
                  onChange={setApproximateDate}
                  minimumDate={TODAY_START}
                  placeholder="Pick a date (optional)"
                />
                {approximateDate && approximateDate < TODAY_START && (
                  <Text style={s.fieldWarning}>This date is in the past</Text>
                )}
                <View style={s.timeLabelRow}>
                  <Text style={s.label}>Exact time</Text>
                  <Text style={s.labelHint}>(optional)</Text>
                </View>
                <DatePickerField
                  mode="time"
                  value={exactTime}
                  onChange={(t) => { setExactTime(t); setTimeBlock(null); }}
                  onClear={() => setExactTime(null)}
                  placeholder="Pick a time"
                />
                <Text style={s.label}>
                  {exactTime ? 'Time of day (overridden by exact time above)' : 'Time of day'}
                </Text>
                <BlockPicker
                  value={exactTime ? null : timeBlock}
                  onChange={(b) => { setTimeBlock(b); setExactTime(null); }}
                />
              </View>
            ) : (
              <View style={{ gap: space.sm }}>
                {slots.map((slot, i) => (
                  <TimeSlotRow
                    key={i}
                    slot={slot}
                    index={i}
                    onChange={(updated) => updateSlot(i, updated)}
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

            <Pressable
              style={[s.createBtn, saving && { opacity: 0.6 }]}
              onPress={handleCreate}
              disabled={saving}
            >
              {saving ? <ActivityIndicator size="small" color={color.onInk} /> : null}
              <Text style={s.createBtnText}>
                {saving
                  ? 'Creating…'
                  : selectedIds.size > 0
                  ? `Create & Invite ${selectedIds.size}`
                  : 'Create Meetup'}
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
  avatar:           { width: 32, height: 32, borderRadius: 16 },
  avatarFallback:   { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  avatarInitial:    { ...t.small, fontWeight: '700', color: color.ink, fontSize: 13 },
  chips:            { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.sm },
  chip:             { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.sm, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal, backgroundColor: color.paperRaised, maxWidth: 150 },
  chipName:         { ...t.small, color: color.signal, fontWeight: '700', fontSize: 11, flex: 1 },
  chipLocked:       { borderColor: color.haze, backgroundColor: color.paper },
  chipNameLocked:   { color: color.mute },
  blockRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  blockBtn:         { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper },
  blockBtnSmall:    { paddingHorizontal: space.sm, paddingVertical: 5 },
  blockBtnActive:   { backgroundColor: color.signal, borderColor: color.signal },
  blockBtnText:     { ...t.small, fontWeight: '700', color: color.ink },
  blockBtnTextActive: { color: color.onInk },
  slotCard:         { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.sm },
  slotCardPast:     { borderColor: '#FCA5A5', backgroundColor: '#FFF5F5' },
  slotHeader:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  slotNum:          { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  slotPastWarning:  { ...t.small, color: '#DC2626', fontSize: 11, flex: 1, textAlign: 'center' },
  slotTimeRow:      { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  blockRowDimmed:   { opacity: 0.35 },
  slotTimeNote:     { ...t.small, color: color.mute, fontSize: 10, fontStyle: 'italic' },
});

// ── Main styles ───────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  kav:              { position: 'absolute', bottom: 0, left: 0, right: 0 },
  backdrop:         { flex: 1, justifyContent: 'flex-end' },
  sheet:            { backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: color.haze, maxHeight: '92%' },
  sheetHead:        { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  sheetTitle:       { ...t.title, color: color.ink, fontSize: 18 },
  scopeBadge:       { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal },
  scopeText:        { ...t.small, color: color.signal, fontWeight: '700', fontSize: 11 },
  body:             { padding: space.lg, gap: space.md, paddingBottom: space.xxxl },
  labelRow:         { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label:            { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  timeLabelRow:     { flexDirection: 'row', alignItems: 'center', gap: 4 },
  labelHint:        { ...t.small, color: color.mute, fontSize: 11 },
  input:            { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: space.sm + 2, ...t.body, color: color.ink },
  divider:          { height: 1, backgroundColor: color.haze, marginVertical: space.xs },
  sectionToggle:    { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  sectionToggleText:{ ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  countBadge:       { backgroundColor: color.signal, borderRadius: 999, minWidth: 20, height: 20, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  countBadgeText:   { ...t.small, color: color.onInk, fontWeight: '800', fontSize: 11 },
  inviteBody:       { gap: space.sm, marginTop: space.xs },
  searchRow:        { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: space.sm },
  searchInput:      { flex: 1, ...t.body, color: color.ink, padding: 0 },
  candidateList:    { gap: 2, maxHeight: 240 },
  candidateRow:     { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent' },
  candidateRowActive: { backgroundColor: '#FFF0ED', borderColor: color.signal },
  candidateName:    { ...t.bodyStrong, color: color.ink, fontWeight: '600', fontSize: 14 },
  candidateHandle:  { ...t.small, color: color.mute, fontSize: 11 },
  checkbox:         { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paper },
  checkboxActive:   { backgroundColor: color.signal, borderColor: color.signal },
  checkboxLocked:   { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: color.signal, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  candidateRowLocked: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: 'transparent', opacity: 0.85 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4, paddingHorizontal: 2, marginTop: space.sm },
  sectionHeaderText:{ ...t.small, fontWeight: '700', color: color.signal, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionHeaderHint:{ ...t.small, color: color.mute, fontSize: 10, fontStyle: 'italic' },
  fieldWarning:     { ...t.small, color: '#DC2626', fontSize: 11, marginTop: -space.xs },
  emptyNote:        { ...t.small, color: color.faint, textAlign: 'center', paddingVertical: space.md },
  proposeHeader:    { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  proposeHint:      { ...t.small, color: color.mute, fontSize: 11, marginTop: -space.sm },
  toggle:           { width: 44, height: 26, borderRadius: 13, backgroundColor: color.haze, justifyContent: 'center', paddingHorizontal: 2 },
  toggleOn:         { backgroundColor: color.signal },
  toggleThumb:      { width: 22, height: 22, borderRadius: 11, backgroundColor: color.paperRaised },
  toggleThumbOn:    { alignSelf: 'flex-end' },
  singleDate:       { gap: space.md },
  addSlotBtn:       { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.signal },
  addSlotText:      { ...t.bodyStrong, color: color.signal, fontSize: 13 },
  errText:          { ...t.small, color: '#DC2626', textAlign: 'center' },
  createBtn:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md },
  createBtnText:    { ...t.bodyStrong, color: color.onInk },
});
