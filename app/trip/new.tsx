import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, ActivityIndicator, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { useSession } from '../../src/context/SessionContext';
import { createTrip } from '../../src/services/trips';
import { color, space, radius, type as t } from '../../src/theme/tokens';

export default function NewTrip() {
  const { configured, isAuthed } = useSession();
  const live = configured && isAuthed;
  const [title, setTitle] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    if (!title.trim() || !city.trim()) { setError('Add a trip name and destination city.'); return; }
    if (!live) { router.replace('/trip/t_1'); return; } // mock fallback
    setBusy(true);
    try {
      const trip = await createTrip({
        title: title.trim(),
        destinationCity: city.trim(),
        destinationCountry: country.trim() || undefined,
        startDate: start.trim() || undefined,
        endDate: end.trim() || undefined,
        status: 'planning',
        visibility: 'private',
      });
      if (!trip) { setError('Could not create the trip. Try again.'); return; }
      router.replace(`/trip/${trip.id}`);
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="New trip" back />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
        <Field label="Trip name" placeholder="Visayas, June" value={title} onChange={setTitle} />
        <Field label="Destination city" placeholder="Cebu" value={city} onChange={setCity} />
        <Field label="Country (optional)" placeholder="Philippines" value={country} onChange={setCountry} />
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <View style={{ flex: 1 }}><Field label="Start (YYYY-MM-DD)" placeholder="2026-06-20" value={start} onChange={setStart} /></View>
          <View style={{ flex: 1 }}><Field label="End (YYYY-MM-DD)" placeholder="2026-06-27" value={end} onChange={setEnd} /></View>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!live ? <Text style={styles.hint}>Sign in to save trips to your account.</Text> : null}

        <Pressable style={[styles.create, busy && { opacity: 0.7 }]} onPress={create} disabled={busy}>
          {busy ? <ActivityIndicator color={color.onInk} /> : <Text style={styles.createText}>Create trip</Text>}
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Field({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} placeholder={placeholder} placeholderTextColor={color.faint} value={value} onChangeText={onChange} autoCapitalize="words" />
    </View>
  );
}

const styles = StyleSheet.create({
  label: { ...t.stamp, fontFamily: 'Courier', color: color.mute, marginBottom: space.sm },
  input: { ...t.body, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  error: { ...t.small, color: color.signal, fontWeight: '600' },
  hint: { ...t.small, color: color.mute },
  create: { backgroundColor: color.ink, paddingVertical: space.md, borderRadius: radius.pill, alignItems: 'center', marginTop: space.sm },
  createText: { ...t.body, fontWeight: '700', color: color.onInk },
});
