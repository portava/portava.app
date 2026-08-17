/**
 * request-buddy.tsx — open-marketplace screen (Mode B only).
 *
 * Opened without `buddyId` from marketplace.tsx. Lets the traveller post an
 * open request that any eligible buddy can respond to. Submits via
 * createRequest() → navigates to the offers screen.
 *
 * Per-buddy booking (Mode A) was retired. All specific-buddy "Book" entry
 * points now route to `/(rent-a-buddy)/checkout`.
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert, Switch,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { GlobalPlacePicker } from '../../src/components/selectors/GlobalPlacePicker';
import type { Place } from '../../src/lib/location/placeTypes';
import { ArrowLeft, Send } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { TravelChip } from '../../src/components/primitives';
import { createRequest, bookingErrorCopy } from '../../src/services/rentABuddy';

// ── Open-request form (Mode B) ─────────────────────────────────────────────

const OPEN_CATEGORIES = ['city', 'nightlife', 'language', 'arrival', 'content', 'shopping', 'food', 'adventure', 'other'];
const DURATIONS = [
  { label: '1h', value: 60 }, { label: '2h', value: 120 }, { label: '3h', value: 180 },
  { label: 'Half day', value: 240 }, { label: 'Full day', value: 480 },
];
const BUDGET_OPTS = [
  { label: 'Under $20/hr', min: 0,   max: 20   },
  { label: '$20–$40/hr',  min: 20,  max: 40   },
  { label: '$40–$70/hr',  min: 40,  max: 70   },
  { label: 'Open budget', min: null, max: null  },
];
const POLICY_TEXT = "Requests must be for legitimate travel services only. Escort, adult, romantic, or illegal service requests are not permitted and result in a permanent ban.";

function OpenRequestForm() {
  const insets = useSafeAreaInsets();
  const [city, setCity]                       = useState('');
  const [cityCoords, setCityCoords]           = useState<{ lat: number; lng: number } | null>(null);
  const [cityPickerOpen, setCityPickerOpen]   = useState(false);
  const [category, setCategory]               = useState('city');
  const [durationMinutes, setDurationMinutes] = useState(120);
  const [budgetIdx, setBudgetIdx]             = useState(1);
  const [language, setLanguage]               = useState('');
  const [groupSize, setGroupSize]             = useState(1);
  const [notes, setNotes]                     = useState('');
  const [publicOnly, setPublicOnly]           = useState(false);
  const [loading, setLoading]                 = useState(false);

  const budget = BUDGET_OPTS[budgetIdx];

  const submit = useCallback(async () => {
    if (!city.trim()) { Alert.alert('Missing city', 'Please enter the city for your request.'); return; }
    setLoading(true);
    const result = await createRequest({
      city: city.trim(),
      lat: cityCoords?.lat,
      lng: cityCoords?.lng,
      category, durationMinutes, groupSize,
      budgetMinUsd: budget.min ?? undefined,
      budgetMaxUsd: budget.max ?? undefined,
      languageNeeded: language.trim() || undefined,
      safetyPrefs: { publicOnly },
      notes: notes.trim() || undefined,
    });
    setLoading(false);
    if (!result.ok) { Alert.alert('Error', bookingErrorCopy(result.error)); return; }
    Alert.alert(
      'Request Posted!',
      'Eligible Buddies in your city will see your request and can send you offers.',
      [{ text: 'View Offers', onPress: () => router.replace({ pathname: '/(rent-a-buddy)/offers' as any, params: { requestId: result.data.request.id } }) }]
    );
  }, [city, cityCoords, category, durationMinutes, groupSize, budget, language, publicOnly, notes]);

  return (
    <KeyboardSafeScrollView style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Request a Buddy</Text>
      </View>
      <ScrollView style={s.body} contentContainerStyle={s.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={s.notice}>{POLICY_TEXT}</Text>

        <Text style={s.label}>City *</Text>
        <Pressable onPress={() => setCityPickerOpen(true)}>
          <Text style={[s.input, !city && { color: color.mute }]} numberOfLines={1}>
            {city || 'e.g. Tokyo, Barcelona…'}
          </Text>
        </Pressable>
        <GlobalPlacePicker
          visible={cityPickerOpen}
          onClose={() => setCityPickerOpen(false)}
          onSelect={(place: Place) => {
            setCity(place.city ?? place.name);
            setCityCoords(place.lat != null && place.lng != null ? { lat: place.lat, lng: place.lng } : null);
          }}
          mode="city"
          title="Which city?"
          usedFor="buddy_request"
        />

        <Text style={s.label}>Category *</Text>
        <View style={s.chips}>
          {OPEN_CATEGORIES.map((cat) => (
            <TravelChip key={cat} label={cat.charAt(0).toUpperCase() + cat.slice(1)} active={category === cat} onPress={() => setCategory(cat)} />
          ))}
        </View>

        <Text style={s.label}>Duration</Text>
        <View style={s.chips}>
          {DURATIONS.map((d) => (
            <TravelChip key={d.value} label={d.label} active={durationMinutes === d.value} onPress={() => setDurationMinutes(d.value)} />
          ))}
        </View>

        <Text style={s.label}>Budget</Text>
        <View style={s.chips}>
          {BUDGET_OPTS.map((b, i) => (
            <TravelChip key={i} label={b.label} active={budgetIdx === i} onPress={() => setBudgetIdx(i)} />
          ))}
        </View>

        <Text style={s.label}>Group size</Text>
        <View style={s.row}>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <Pressable key={n} style={[s.numBtn, groupSize === n && s.numBtnSel]} onPress={() => setGroupSize(n)}>
              <Text style={[s.numLabel, groupSize === n && s.numLabelSel]}>{n < 6 ? String(n) : '6+'}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={s.label}>Language needed (optional)</Text>
        <TextInput style={s.input} placeholder="e.g. English, Spanish…" placeholderTextColor={color.mute} value={language} onChangeText={setLanguage} />

        <Text style={s.label}>Additional notes</Text>
        <TextInput style={[s.input, s.textarea]} placeholder="Describe what you're looking for…" placeholderTextColor={color.mute} value={notes} onChangeText={setNotes} multiline numberOfLines={4} textAlignVertical="top" />

        <View style={s.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.toggleLabel}>Public meetup only</Text>
            <Text style={s.toggleSub}>Require all Buddies to meet in public places</Text>
          </View>
          <Switch value={publicOnly} onValueChange={setPublicOnly} trackColor={{ false: color.haze, true: color.deep }} />
        </View>

        <Pressable style={[s.submitBtn, (loading || !city.trim()) && s.submitBtnDisabled]} onPress={submit} disabled={loading || !city.trim()}>
          <Send size={16} color="#fff" />
          <Text style={s.submitBtnLabel}>{loading ? 'Posting…' : 'Post Request'}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardSafeScrollView>
  );
}

// ── Entry point ───────────────────────────────────────────────────────────

export default function RequestBuddy() {
  return <OpenRequestForm />;
}

// ── Styles ────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:              { flex: 1, backgroundColor: color.paper },
  header:            { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn:           { padding: space.xs },
  title:             { ...t.heading, color: color.ink },
  body:              { flex: 1 },
  content:           { padding: space.lg, paddingBottom: 60 },
  notice:            { ...t.small, color: color.mute, backgroundColor: color.haze, padding: space.md, borderRadius: radius.sm, marginBottom: space.lg, lineHeight: 18 },
  label:             { ...t.small, color: color.mute, fontWeight: '600', marginBottom: space.sm, marginTop: space.lg },
  input:             { ...t.body, color: color.ink, backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: color.haze, marginBottom: space.sm },
  textarea:          { minHeight: 72 },
  chips:             { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  row:               { flexDirection: 'row', gap: space.sm },
  numBtn:            { width: 44, height: 44, borderRadius: radius.sm, borderWidth: 1.5, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  numBtnSel:         { borderColor: color.deep, backgroundColor: `${color.deep}12` },
  numLabel:          { ...t.body, color: color.ink },
  numLabelSel:       { color: color.deep, fontWeight: '700' },
  toggleRow:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.lg, padding: space.lg, backgroundColor: color.haze, borderRadius: radius.md },
  toggleLabel:       { ...t.body, color: color.ink, fontWeight: '600' },
  toggleSub:         { ...t.small, color: color.mute },
  submitBtn:         { marginTop: space.xl, backgroundColor: color.deep, borderRadius: radius.md, paddingVertical: space.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnLabel:    { ...t.body, color: '#fff', fontWeight: '700' },
});
