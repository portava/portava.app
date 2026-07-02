import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, ActivityIndicator,
  StyleSheet, Switch, Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, MapPin, CalendarDays, X } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { useSession } from '../../src/context/SessionContext';
import { useTrip } from '../../src/hooks/useBackend';
import { updateTrip } from '../../src/services/trips';
import { GlobalCalendarPicker } from '../../src/components/selectors/GlobalCalendarPicker';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { formatDisplayDate, fromISODate } from '../../src/lib/dateTime/formatters';
import type { Place } from '../../src/lib/location/placeTypes';
import type { TripVisibility } from '../../src/types/models';

const TRIP_TYPES = [
  'solo', 'friends', 'group', 'business', 'family', 'nightlife',
  'food', 'beach', 'adventure', 'digital_nomad', 'layover', 'weekend',
];

const VIS_OPTS: { key: TripVisibility; label: string }[] = [
  { key: 'private', label: 'Private' },
  { key: 'invite', label: 'Invite only' },
  { key: 'buddies', label: 'Friends' },
  { key: 'public', label: 'Public' },
];

const STATUS_OPTS = ['draft', 'planning', 'upcoming', 'active', 'completed', 'cancelled', 'archived'] as const;
type TripStatus = typeof STATUS_OPTS[number];

interface EditState {
  title: string;
  place: Place | null;
  startDate: string | null;
  endDate: string | null;
  visibility: TripVisibility;
  status: TripStatus;
  tripType: string | null;
  allowJoinRequests: boolean;
  showOnProfile: boolean;
  showExactDates: boolean;
  delayedPosting: boolean;
  tripNotes: string;
}

export default function EditTrip() {
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const { configured, isAuthed, userId } = useSession();
  const live = configured && isAuthed;

  const { data: trip, loading: tripLoading } = useTrip(live ? tripId : undefined);

  const [form, setForm] = useState<EditState>({
    title: '', place: null, startDate: null, endDate: null,
    visibility: 'private', status: 'planning', tripType: null,
    allowJoinRequests: false, showOnProfile: true, showExactDates: true,
    delayedPosting: false, tripNotes: '',
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calOpen, setCalOpen] = useState(false);
  const [placeOpen, setPlaceOpen] = useState(false);

  // Populate form when trip loads
  useEffect(() => {
    if (!trip) return;
    setForm({
      title: trip.title,
      place: trip.destinationCity
        ? {
            id: trip.destinationPlaceId ?? `${trip.destinationCity}-${trip.destinationCountry}`,
            name: trip.destinationCity,
            displayName: trip.destinationCountry
              ? `${trip.destinationCity}, ${trip.destinationCountry}`
              : trip.destinationCity,
            city: trip.destinationCity,
            country: trip.destinationCountry ?? undefined,
            lat: trip.destinationLat ?? undefined,
            lng: trip.destinationLng ?? undefined,
          } as any
        : null,
      startDate: trip.startDate,
      endDate: trip.endDate,
      visibility: trip.visibility,
      status: trip.status as TripStatus,
      tripType: trip.tripType,
      allowJoinRequests: trip.allowJoinRequests,
      showOnProfile: trip.showOnProfile,
      showExactDates: trip.showExactDates,
      delayedPosting: trip.delayedPostingDefault,
      tripNotes: trip.tripNotes ?? '',
    });
  }, [trip]);

  function upd(patch: Partial<EditState>) {
    setForm((s) => ({ ...s, ...patch }));
    setDirty(true);
  }

  const isOwner = trip?.ownerId === userId;

  async function handleSave() {
    if (!tripId || !form.title.trim()) {
      setError('Trip name is required.');
      return;
    }
    if (!live) { Alert.alert('Sign in required'); return; }
    setSaving(true); setError(null);
    try {
      const updated = await updateTrip(tripId, {
        title: form.title.trim(),
        destinationCity: form.place?.city ?? form.place?.name ?? trip?.destinationCity,
        destinationCountry: form.place?.country ?? trip?.destinationCountry ?? undefined,
        destinationLat: form.place?.lat ?? trip?.destinationLat ?? undefined,
        destinationLng: form.place?.lng ?? trip?.destinationLng ?? undefined,
        destinationPlaceId: form.place?.id ?? trip?.destinationPlaceId ?? undefined,
        startDate: form.startDate ?? undefined,
        endDate: form.endDate ?? undefined,
        visibility: form.visibility,
        status: form.status,
        tripType: form.tripType ?? undefined,
        allowJoinRequests: form.allowJoinRequests,
        showOnProfile: form.showOnProfile,
        showExactDates: form.showExactDates,
        delayedPostingDefault: form.delayedPosting,
        tripNotes: form.tripNotes || undefined,
      });
      if (!updated) throw new Error('Update failed. Please try again.');
      setDirty(false);
      router.back();
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    if (dirty) {
      Alert.alert('Discard changes?', 'You have unsaved changes.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => router.back() },
      ]);
    } else {
      router.back();
    }
  }

  if (!live) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ScreenHeader title="Edit Trip" back />
        <View style={s.empty}><Text style={s.emptyTxt}>Sign in to edit trips.</Text></View>
      </View>
    );
  }

  if (tripLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (!trip) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <ScreenHeader title="Edit Trip" back />
        <View style={s.empty}><Text style={s.emptyTxt}>Trip not found.</Text></View>
      </View>
    );
  }

  const sD = form.startDate ? fromISODate(form.startDate) : null;
  const eD = form.endDate ? fromISODate(form.endDate) : null;
  const dateLabel = sD && eD ? `${formatDisplayDate(sD)} – ${formatDisplayDate(eD)}`
    : sD ? `From ${formatDisplayDate(sD)}`
    : 'No dates set';

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader
        title="Edit Trip"
        back={false}
        left={
          <Pressable onPress={handleDiscard} hitSlop={8} style={s.headerBtn}>
            <ChevronLeft size={20} color={color.ink} />
          </Pressable>
        }
        right={
          <Pressable
            style={[s.saveBtn, saving && { opacity: 0.7 }]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator size="small" color={color.onInk} />
              : <Text style={s.saveBtnTxt}>Save</Text>}
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {error && <View style={s.errBanner}><Text style={s.errTxt}>{error}</Text></View>}

        {/* Title */}
        <View>
          <Text style={s.lbl}>Trip name</Text>
          <TextInput
            style={s.input} value={form.title} onChangeText={(v) => upd({ title: v })}
            placeholder="e.g. Tokyo June" placeholderTextColor={color.faint} autoCapitalize="words"
          />
        </View>

        {/* Destination */}
        <View>
          <Text style={s.lbl}>Destination</Text>
          <Pressable style={s.picker} onPress={() => setPlaceOpen(true)}>
            <MapPin size={15} color={form.place ? color.signal : color.faint} />
            <Text style={[s.pickerTxt, !form.place && s.ph]} numberOfLines={1}>
              {form.place?.displayName ?? 'Choose a city…'}
            </Text>
            {form.place && (
              <Pressable hitSlop={8} onPress={() => upd({ place: null })}><X size={14} color={color.mute} /></Pressable>
            )}
          </Pressable>
        </View>

        {/* Dates */}
        <View>
          <Text style={s.lbl}>Dates</Text>
          <Pressable style={s.picker} onPress={() => setCalOpen(true)}>
            <CalendarDays size={15} color={form.startDate ? color.signal : color.faint} />
            <Text style={[s.pickerTxt, !form.startDate && s.ph]} numberOfLines={1}>{dateLabel}</Text>
            {form.startDate && (
              <Pressable hitSlop={8} onPress={() => upd({ startDate: null, endDate: null })}><X size={14} color={color.mute} /></Pressable>
            )}
          </Pressable>
        </View>

        {/* Status */}
        <View>
          <Text style={s.lbl}>Status</Text>
          <View style={s.chips}>
            {STATUS_OPTS.map((st) => (
              <Pressable key={st} style={[s.chip, form.status === st && s.chipOn]} onPress={() => upd({ status: st })}>
                <Text style={[s.chipTxt, form.status === st && s.chipOnTxt]}>{st}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Visibility */}
        <View>
          <Text style={s.lbl}>Visibility</Text>
          <View style={s.chips}>
            {VIS_OPTS.map((opt) => (
              <Pressable key={opt.key} style={[s.chip, form.visibility === opt.key && s.chipOn]} onPress={() => upd({ visibility: opt.key })}>
                <Text style={[s.chipTxt, form.visibility === opt.key && s.chipOnTxt]}>{opt.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Trip type */}
        <View>
          <Text style={s.lbl}>Trip type</Text>
          <View style={s.chips}>
            {TRIP_TYPES.map((tp) => (
              <Pressable key={tp} style={[s.chip, form.tripType === tp && s.chipOn]} onPress={() => upd({ tripType: tp })}>
                <Text style={[s.chipTxt, form.tripType === tp && s.chipOnTxt]}>{tp.replace('_', ' ')}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Toggles */}
        <TRow label="Allow join requests" sub="Others can request to join" value={form.allowJoinRequests} onChange={(v) => upd({ allowJoinRequests: v })} />
        <TRow label="Show on profile" sub="Appear in your travel passport" value={form.showOnProfile} onChange={(v) => upd({ showOnProfile: v })} />
        <TRow label="Show exact dates" sub="Visible to permitted viewers" value={form.showExactDates} onChange={(v) => upd({ showExactDates: v })} />
        <TRow label="Delayed posting" sub="Posts publish after you return" value={form.delayedPosting} onChange={(v) => upd({ delayedPosting: v })} />

        {/* Notes */}
        <View>
          <Text style={s.lbl}>Trip notes (private)</Text>
          <TextInput
            style={[s.input, { height: 100, textAlignVertical: 'top' }]}
            value={form.tripNotes}
            onChangeText={(v) => upd({ tripNotes: v })}
            placeholder="Any notes for yourself…"
            placeholderTextColor={color.faint}
            multiline
          />
        </View>

        {/* Danger zone */}
        {isOwner && (
          <View style={s.danger}>
            <Text style={s.dangerTitle}>Danger zone</Text>
            <Pressable
              style={s.dangerBtn}
              onPress={() => {
                Alert.alert(
                  'Delete trip?',
                  'This will permanently delete the trip and all its data. This cannot be undone.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: async () => {
                        if (!tripId) return;
                        const { deleteTrip } = await import('../../src/services/trips');
                        const ok = await deleteTrip(tripId);
                        if (ok) { router.replace('/(tabs)/trips' as any); }
                        else { Alert.alert('Error', 'Could not delete trip.'); }
                      },
                    },
                  ],
                );
              }}
            >
              <Text style={s.dangerBtnTxt}>Delete this trip</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      <GlobalCalendarPicker
        mode="range" visible={calOpen}
        value={{ start: form.startDate, end: form.endDate }}
        allowPast
        onConfirm={({ start, end }) => { upd({ startDate: start, endDate: end }); setCalOpen(false); }}
        onCancel={() => setCalOpen(false)}
        title="Trip Dates"
      />

      <GlobalPlacePicker
        visible={placeOpen} title="Destination" allowGPS={false} usedFor="trip_destination"
        onSelect={(p) => { upd({ place: p }); setPlaceOpen(false); }}
        onClose={() => setPlaceOpen(false)}
      />
    </View>
  );
}

function TRow({ label, sub, value, onChange }: { label: string; sub: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.toggleRow}>
      <View style={{ flex: 1 }}>
        <Text style={s.toggleLbl}>{label}</Text>
        <Text style={s.toggleSub}>{sub}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: color.haze, true: color.ink }} thumbColor={color.onInk} />
    </View>
  );
}

const s = StyleSheet.create({
  scroll: { padding: space.lg, gap: space.lg, paddingBottom: space.xxxl },
  headerBtn: { paddingHorizontal: space.sm },
  saveBtn: { backgroundColor: color.ink, paddingHorizontal: space.lg, paddingVertical: 7, borderRadius: radius.pill },
  saveBtnTxt: { ...t.small, color: color.onInk, fontWeight: '700' as const },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  emptyTxt: { ...t.body, color: color.mute, textAlign: 'center' },
  errBanner: { backgroundColor: color.signal + '15', borderRadius: radius.md, padding: space.md },
  errTxt: { ...t.small, color: color.signal, fontWeight: '600' as const },
  lbl: { ...t.stamp, color: color.mute, marginBottom: space.sm, fontSize: 11, letterSpacing: 0.5 },
  input: { ...t.body, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  picker: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: space.sm, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 50 },
  pickerTxt: { flex: 1, ...t.body, color: color.ink },
  ph: { color: color.faint },
  chips: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.haze, backgroundColor: color.paperRaised },
  chipOn: { borderColor: color.ink, backgroundColor: color.ink },
  chipTxt: { ...t.small, color: color.ink, fontWeight: '600' as const },
  chipOnTxt: { color: color.onInk },
  toggleRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.md, borderWidth: 1, borderColor: color.haze },
  toggleLbl: { ...t.body, color: color.ink, fontWeight: '600' as const },
  toggleSub: { ...t.small, color: color.mute, marginTop: 2 },
  danger: { borderTopWidth: 1, borderTopColor: color.haze, paddingTop: space.lg, gap: space.md },
  dangerTitle: { ...t.small, color: color.mute, fontWeight: '700' as const, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
  dangerBtn: { borderWidth: 1.5, borderColor: color.signal, borderRadius: radius.lg, paddingVertical: space.md, alignItems: 'center' as const },
  dangerBtnTxt: { ...t.body, color: color.signal, fontWeight: '600' as const },
});
