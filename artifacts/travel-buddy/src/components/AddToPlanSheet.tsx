import React, { useState } from 'react';
import {
  View, Text, TextInput, Pressable, Modal, ScrollView, StyleSheet,
} from 'react-native';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';
import { X, ChevronDown } from 'lucide-react-native';
import type { TripPlanItem, TripPlanCategory } from '../types/models.ts';
import { createPlanItem } from '../services/tripPlan.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { DatePickerField } from './DateTimePickerField';

// ── Category options ──────────────────────────────────────────────────────────

const CATEGORIES: { value: TripPlanCategory; label: string }[] = [
  { value: 'activity',      label: 'Activity' },
  { value: 'dining',        label: 'Dining' },
  { value: 'accommodation', label: 'Stay / Accommodation' },
  { value: 'transport',     label: 'Transport' },
  { value: 'meeting_point', label: 'Meetup / Meeting point' },
  { value: 'free_time',     label: 'Free time' },
  { value: 'other',         label: 'Other' },
];

// ── Props ─────────────────────────────────────────────────────────────────────

export interface AddToPlanSheetProps {
  visible: boolean;
  tripId: string;
  onClose: () => void;
  onAdded: (item: TripPlanItem) => void;
  /** Pre-filled values when adding from a place/meetup card */
  prefill?: {
    title?: string;
    category?: TripPlanCategory;
    locationName?: string;
    sourceType?: 'place' | 'meetup';
    sourceId?: string;
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AddToPlanSheet({ visible, tripId, onClose, onAdded, prefill }: AddToPlanSheetProps) {
  const [title, setTitle] = useState(prefill?.title ?? '');
  const [category, setCategory] = useState<TripPlanCategory>(prefill?.category ?? 'activity');
  const [dayDate, setDayDate] = useState<Date | null>(null);
  const [startsAt, setStartsAt] = useState<Date | null>(null);
  const [locationName, setLocationName] = useState(prefill?.locationName ?? '');
  const [notes, setNotes] = useState('');
  const [catPickerOpen, setCatPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const selectedCat = CATEGORIES.find((c) => c.value === category) ?? CATEGORIES[0];

  const reset = () => {
    setTitle(prefill?.title ?? '');
    setCategory(prefill?.category ?? 'activity');
    setDayDate(null);
    setStartsAt(null);
    setLocationName(prefill?.locationName ?? '');
    setNotes('');
    setError('');
    setCatPickerOpen(false);
  };

  const handleClose = () => { reset(); onClose(); };

  const handleSubmit = async () => {
    if (!title.trim()) { setError('Title is required'); return; }
    setError('');
    setSubmitting(true);
    try {
      const item = await createPlanItem(tripId, {
        title: title.trim(),
        category,
        sourceType: prefill?.sourceType ?? 'manual',
        sourceId: prefill?.sourceId,
        dayDate: dayDate ? dateToDayStr(dayDate) : undefined,
        startsAt: buildTimestamp(dayDate, startsAt),
        locationName: locationName.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onAdded(item);
      reset();
    } catch (e: any) {
      setError(e.message ?? 'Could not add item. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <KeyboardSafeScrollView>
        <Pressable style={sh.overlay} onPress={handleClose} />
        <View style={sh.sheet}>
          <View style={sh.handle} />
          <View style={sh.header}>
            <Text style={sh.headerTitle}>Add to Plan</Text>
            <Pressable onPress={handleClose} hitSlop={8}><X size={20} color={color.mute} /></Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={sh.body} keyboardShouldPersistTaps="handled">
            <Text style={sh.label}>Title <Text style={sh.req}>*</Text></Text>
            <TextInput
              style={sh.input}
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Dinner at Anzani"
              placeholderTextColor={color.faint}
              returnKeyType="next"
            />

            <Text style={sh.label}>Category</Text>
            <Pressable style={sh.picker} onPress={() => setCatPickerOpen(!catPickerOpen)}>
              <Text style={sh.pickerText}>{selectedCat.label}</Text>
              <ChevronDown size={16} color={color.mute} />
            </Pressable>
            {catPickerOpen && (
              <View style={sh.catList}>
                {CATEGORIES.map((c) => (
                  <Pressable
                    key={c.value}
                    style={[sh.catOption, c.value === category && sh.catOptionActive]}
                    onPress={() => { setCategory(c.value); setCatPickerOpen(false); }}
                  >
                    <Text style={[sh.catOptionText, c.value === category && sh.catOptionTextActive]}>
                      {c.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            <Text style={sh.label}>Date <Text style={sh.opt}>(optional)</Text></Text>
            <DatePickerField
              value={dayDate}
              onChange={setDayDate}
              onClear={() => { setDayDate(null); setStartsAt(null); }}
              placeholder="Select a date (optional)"
            />

            <Text style={sh.label}>Time <Text style={sh.opt}>(optional)</Text></Text>
            <DatePickerField
              mode="time"
              value={startsAt}
              onChange={setStartsAt}
              onClear={() => setStartsAt(null)}
              placeholder="Pick a time"
            />

            <Text style={sh.label}>Location <Text style={sh.opt}>(optional)</Text></Text>
            <TextInput
              style={sh.input}
              value={locationName}
              onChangeText={setLocationName}
              placeholder="e.g. Ayala Mall, Cebu"
              placeholderTextColor={color.faint}
            />

            <Text style={sh.label}>Notes <Text style={sh.opt}>(optional)</Text></Text>
            <TextInput
              style={[sh.input, sh.inputMulti]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Any extra details…"
              placeholderTextColor={color.faint}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />

            {error ? <Text style={sh.error}>{error}</Text> : null}

            <Pressable
              style={[sh.submitBtn, submitting && sh.submitBtnDisabled]}
              onPress={handleSubmit}
              disabled={submitting}
            >
              <Text style={sh.submitText}>{submitting ? 'Adding…' : 'Add to Trip Plan'}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" string from a Date (local timezone) */
function dateToDayStr(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** "HH:MM" 24-hour string from a Date */
function dateToHHMM(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function buildTimestamp(date: Date | null, time: Date | null): string | undefined {
  if (!date || !time) return undefined;
  return `${dateToDayStr(date)}T${dateToHHMM(time)}:00`;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const sh = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'transparent' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '90%',
    paddingBottom: 30,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  headerTitle: { ...t.heading, color: color.ink, fontSize: 17 },
  body: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.lg, gap: 4 },
  label: { ...t.small, fontWeight: '700', color: color.ink, marginTop: space.md, marginBottom: 4 },
  req: { color: color.signal },
  opt: { fontWeight: '400', color: color.mute },
  input: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    ...t.body, color: color.ink, backgroundColor: color.paperRaised,
  },
  inputMulti: { height: 80, paddingTop: space.sm },
  picker: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    backgroundColor: color.paperRaised,
  },
  pickerText: { ...t.body, color: color.ink },
  catList: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, overflow: 'hidden', marginTop: 2 },
  catOption: { paddingHorizontal: space.md, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: color.haze },
  catOptionActive: { backgroundColor: color.signal },
  catOptionText: { ...t.body, color: color.ink },
  catOptionTextActive: { color: color.onInk, fontWeight: '700' },
  error: { ...t.small, color: color.signal, marginTop: space.sm },
  submitBtn: { marginTop: space.lg, backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  submitBtnDisabled: { opacity: 0.6 },
  submitText: { ...t.bodyStrong, color: color.onInk, fontSize: 15 },
});
