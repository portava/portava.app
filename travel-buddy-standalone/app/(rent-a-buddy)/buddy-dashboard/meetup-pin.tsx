/**
 * Buddy dashboard — Meetup spot pin.
 *
 * Lets a buddy set / adjust / clear their approximate meetup-base pin
 * (neighbourhood-level, never a home address). Saves via
 * PATCH /api/rent-a-buddy/me/profile — both coordinates or both null.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, Alert, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, MapPin, Trash2, ShieldCheck } from 'lucide-react-native';
import {
  TravelCard, TravelButton, TravelLoadingState, TravelErrorState,
} from '../../../src/components/primitives';
import { MapLocationPicker } from '../../../src/components/location/MapLocationPicker';
import type { Place } from '../../../src/lib/location/placeTypes';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import {
  getMyBuddyProfile, updateMyBuddyProfile, bookingErrorCopy
} from '../../../src/services/rentABuddy';
import { roundMeetupPin, buildMeetupPinPatch } from '../../../src/lib/meetupPin.ts';

export default function BuddyMeetupPin() {
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Saved pin (as currently persisted on the profile).
  const [savedLat, setSavedLat] = useState<number | null>(null);
  const [savedLng, setSavedLng] = useState<number | null>(null);

  // Draft pin (pending save). Mirrors saved values until the user picks.
  const [draftLat, setDraftLat] = useState<number | null>(null);
  const [draftLng, setDraftLng] = useState<number | null>(null);
  const [draftLabel, setDraftLabel] = useState<string | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await getMyBuddyProfile();
    if (!res.ok) {
      setLoadError(res.error);
    } else {
      const p = res.data.profile;
      const lat = typeof p?.meetupBaseLat === 'number' ? p.meetupBaseLat : null;
      const lng = typeof p?.meetupBaseLng === 'number' ? p.meetupBaseLng : null;
      setSavedLat(lat);
      setSavedLng(lng);
      setDraftLat(lat);
      setDraftLng(lng);
      setDraftLabel(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const hasDraftPin = draftLat != null && draftLng != null;
  const dirty = draftLat !== savedLat || draftLng !== savedLng;

  const handlePicked = useCallback((place: Place) => {
    setPickerOpen(false);
    // Round to ~3 decimal places (≈110 m) so the stored pin is genuinely
    // approximate — neighbourhood-level, never an exact address.
    const rounded = roundMeetupPin(place.lat, place.lng);
    if (!rounded) return;
    setDraftLat(rounded.lat);
    setDraftLng(rounded.lng);
    setDraftLabel(place.displayName ?? place.name ?? null);
  }, []);

  async function save() {
    if (saving) return;
    setSaving(true);
    const res = await updateMyBuddyProfile(buildMeetupPinPatch(draftLat, draftLng));
    setSaving(false);
    if (!res.ok) {
      Alert.alert('Could not save', bookingErrorCopy(res.error, 'Please try again.'));
      return;
    }
    setSavedLat(draftLat);
    setSavedLng(draftLng);
    Alert.alert(
      hasDraftPin ? 'Meetup spot saved' : 'Meetup spot cleared',
      hasDraftPin
        ? 'Travellers will now see distances measured from this approximate area.'
        : 'Distances will fall back to your city centre.',
    );
  }

  function clearDraft() {
    setDraftLat(null);
    setDraftLng(null);
    setDraftLabel(null);
  }

  if (loading) return <TravelLoadingState label="Loading your meetup spot…" />;
  if (loadError) return <TravelErrorState sub={loadError} onRetry={() => { void load(); }} />;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Pressable onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <ArrowLeft size={20} color={color.onInk} />
        </Pressable>
        <Text style={s.headerTitle}>Meetup spot</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + 120 }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.intro}>
          Pin the general area where you usually meet travellers — a neighbourhood,
          landmark, or transit hub. Search results use it to show how far you are
          from a traveller.
        </Text>

        {/* Privacy note */}
        <TravelCard style={s.privacyCard}>
          <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' }}>
            <ShieldCheck size={18} color={color.success} style={{ marginTop: 2 }} />
            <View style={{ flex: 1 }}>
              <Text style={s.privacyTitle}>Approximate area only</Text>
              <Text style={s.privacyBody}>
                This pin marks a rough area, never your home address. It's rounded to
                about 100 m and only used for distance estimates — travellers never see
                the exact point.
              </Text>
            </View>
          </View>
        </TravelCard>

        {/* Current pin */}
        <TravelCard style={{ padding: space.md, marginBottom: space.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <MapPin size={20} color={hasDraftPin ? color.signal : color.haze} />
            <View style={{ flex: 1 }}>
              {hasDraftPin ? (
                <>
                  <Text style={s.pinTitle}>
                    {draftLabel ?? 'Pinned meetup area'}
                  </Text>
                  <Text style={s.pinCoords}>
                    {draftLat!.toFixed(3)}, {draftLng!.toFixed(3)}
                    {dirty ? '  ·  not saved yet' : ''}
                  </Text>
                </>
              ) : (
                <>
                  <Text style={s.pinTitle}>No meetup spot pinned</Text>
                  <Text style={s.pinCoords}>
                    {dirty ? 'Pin will be cleared when you save' : 'Distances use your city centre'}
                  </Text>
                </>
              )}
            </View>
            {hasDraftPin && (
              <Pressable onPress={clearDraft} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Trash2 size={18} color={color.mute} />
              </Pressable>
            )}
          </View>
        </TravelCard>

        <TravelButton
          label={hasDraftPin ? 'Adjust pin on map' : 'Drop a pin on the map'}
          onPress={() => setPickerOpen(true)}
          variant="secondary"
          full
          icon={<MapPin size={14} color={color.ink} />}
        />
      </ScrollView>

      <View style={[s.footer, { paddingBottom: insets.bottom + space.md }]}>
        <TravelButton
          label={saving ? 'Saving…' : 'Save meetup spot'}
          onPress={save}
          variant={dirty ? 'primary' : 'ghost'}
          full
          icon={saving ? <ActivityIndicator size="small" color={color.onInk} /> : undefined}
        />
      </View>

      <MapLocationPicker
        visible={pickerOpen}
        initialLat={draftLat ?? undefined}
        initialLng={draftLng ?? undefined}
        onConfirm={handlePicked}
        onCancel={() => setPickerOpen(false)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    backgroundColor: color.ink, flexDirection: 'row',
    alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.lg,
  },
  headerTitle: { ...t.heading, color: color.onInk, flex: 1 },
  intro: { ...t.body, color: color.mute, marginBottom: space.lg, lineHeight: 22 },
  privacyCard: {
    padding: space.md, marginBottom: space.lg,
    backgroundColor: '#E8F5EE',
  },
  privacyTitle: { ...t.bodyStrong, color: color.ink, marginBottom: 2 },
  privacyBody: { ...t.small, color: color.mute, lineHeight: 17 },
  pinTitle: { ...t.bodyStrong, color: color.ink },
  pinCoords: { ...t.small, color: color.mute, marginTop: 2 },
  footer: {
    paddingHorizontal: space.lg, paddingTop: space.md,
    borderTopWidth: 1, borderTopColor: color.haze,
    backgroundColor: color.paper,
  },
});
