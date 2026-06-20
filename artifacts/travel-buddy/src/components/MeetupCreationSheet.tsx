/**
 * MeetupCreationSheet — bottom sheet for creating a meetup.
 *
 * Props:
 *   tripId        — pre-fill trip scope (optional)
 *   circleOwnerId — pre-fill circle scope (optional)
 *   onCreated     — callback after successful creation
 *   onDismiss     — close the sheet
 */
import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator,
  KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { X, MapPin, CalendarClock, Users, Check } from 'lucide-react-native';
import { createMeetup, type MeetupSummary, type TimeBlock, type MeetupVisibility } from '../services/meetups';
import { color, space, radius, type as t } from '../theme/tokens';

const BLOCKS: { key: TimeBlock; label: string }[] = [
  { key: 'morning', label: 'Morning' },
  { key: 'afternoon', label: 'Afternoon' },
  { key: 'evening', label: 'Evening' },
  { key: 'late', label: 'Late night' },
];

interface Props {
  tripId?: string;
  circleOwnerId?: string;
  onCreated?: (meetup: MeetupSummary) => void;
  onDismiss: () => void;
}

export function MeetupCreationSheet({ tripId, circleOwnerId, onCreated, onDismiss }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [locationName, setLocationName] = useState('');
  const [approximateDate, setApproximateDate] = useState(''); // YYYY-MM-DD
  const [timeBlock, setTimeBlock] = useState<TimeBlock | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultVisibility: MeetupVisibility = tripId ? 'trip' : circleOwnerId ? 'circle' : 'invitees';

  async function handleCreate() {
    const trimmed = title.trim();
    if (!trimmed) { setError('Please enter a title'); return; }
    setSaving(true);
    setError(null);

    const res = await createMeetup({
      title: trimmed,
      description: description.trim() || undefined,
      locationName: locationName.trim() || undefined,
      approximateDate: approximateDate.trim() || undefined,
      timeBlock: timeBlock ?? undefined,
      tripId,
      circleOwnerId,
      visibility: defaultVisibility,
    });

    setSaving(false);
    if (res.ok && res.data) {
      onCreated?.(res.data);
      onDismiss();
    } else {
      setError(res.message ?? 'Could not create meetup');
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={s.kav}
    >
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
            {/* Title */}
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

            {/* Location (text only — no GPS) */}
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

            {/* Approx date */}
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

            {/* Time block */}
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

            {/* Description */}
            <Text style={s.label}>Description (optional)</Text>
            <TextInput
              style={[s.input, { minHeight: 72, textAlignVertical: 'top' }]}
              placeholder="What's the plan?"
              placeholderTextColor={color.faint}
              value={description}
              onChangeText={setDescription}
              maxLength={1000}
              multiline
            />

            {error ? <Text style={s.errText}>{error}</Text> : null}

            <Pressable style={[s.createBtn, saving && { opacity: 0.6 }]} onPress={handleCreate} disabled={saving}>
              {saving ? <ActivityIndicator size="small" color={color.onInk} /> : null}
              <Text style={s.createBtnText}>{saving ? 'Creating…' : 'Create Meetup'}</Text>
            </Pressable>

            <Text style={s.hint}>Tip: you can add invitees and propose time slots after creating.</Text>
          </ScrollView>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  kav: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderColor: color.haze, maxHeight: '90%' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  sheetTitle: { ...t.title, color: color.ink, fontSize: 18 },
  scopeBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal },
  scopeText: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 11 },
  body: { padding: space.lg, gap: space.md, paddingBottom: space.xxxl },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  input: { backgroundColor: color.paper, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: space.sm + 2, ...t.body, color: color.ink },
  blockRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  blockBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper },
  blockBtnActive: { backgroundColor: color.signal, borderColor: color.signal },
  blockBtnText: { ...t.small, fontWeight: '700', color: color.ink },
  blockBtnTextActive: { color: color.onInk },
  errText: { ...t.small, color: '#DC2626', textAlign: 'center' },
  createBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md },
  createBtnText: { ...t.bodyStrong, color: color.onInk },
  hint: { ...t.small, color: color.faint, textAlign: 'center', fontSize: 11 },
});
