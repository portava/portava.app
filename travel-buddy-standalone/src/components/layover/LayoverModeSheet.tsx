/**
 * LayoverModeSheet
 *
 * Bottom sheet for setting up a layover session.
 * Entry from Discovery, Trip screen, Plan screen, City Pulse, or floating button.
 */
import React, { useState } from 'react';
import {
  View, Text, Modal, ScrollView, Pressable, Switch,
  TextInput, StyleSheet, ActivityIndicator,
} from 'react-native';
import { X, Plane, Clock, MapPin, AlertCircle } from 'lucide-react-native';
import {
  createLayoverSession,
  searchAirports,
  type AirportProfile,
  type CreateSessionPayload,
  type FlightType,
  type ComfortLevel,
} from '../../services/layover';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  onClose: () => void;
  onSessionCreated?: (sessionId: string, safeReturnSuggested: boolean) => void;
  tripId?: string | null;
  initialCity?: string | null;
}

// ── Vibe chips ────────────────────────────────────────────────────────────────

const VIBE_OPTIONS = [
  { key: 'food',        label: '🍜 Food' },
  { key: 'nightlife',   label: '🌙 Nightlife' },
  { key: 'shopping',    label: '🛍 Shopping' },
  { key: 'culture',     label: '🏛 Culture' },
  { key: 'rest',        label: '😴 Rest' },
  { key: 'meetups',     label: '🤝 Meetups' },
  { key: 'hidden_gems', label: '💎 Hidden Gems' },
];

const COMFORT_OPTIONS: Array<{ key: ComfortLevel; label: string; desc: string }> = [
  { key: 'safe_only',  label: 'Safe only',   desc: 'Airport-only or very close activities' },
  { key: 'moderate',   label: 'Moderate',    desc: 'Some outside options with good buffers' },
  { key: 'adventurous',label: 'Adventurous', desc: 'Explore the city — tight but doable' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function LayoverModeSheet({ visible, onClose, onSessionCreated, tripId, initialCity }: Props) {
  const [step, setStep] = useState<'airport' | 'time' | 'prefs'>('airport');

  // Airport
  const [airportQuery, setAirportQuery]     = useState(initialCity ?? '');
  const [airportResults, setAirportResults] = useState<AirportProfile[]>([]);
  const [selectedAirport, setSelectedAirport] = useState<AirportProfile | null>(null);
  const [searching, setSearching]           = useState(false);

  // Time
  const [arrivalHour,   setArrivalHour]   = useState('');
  const [departureHour, setDepartureHour] = useState('');
  const [flightType, setFlightType]       = useState<FlightType>('international');

  // Options
  const [immigrationRequired, setImmigrationRequired] = useState(false);
  const [checkedBags, setCheckedBags]                 = useState(false);
  const [loungeAccess, setLoungeAccess]               = useState(false);
  const [wantsToLeave, setWantsToLeave]               = useState(true);
  const [comfortLevel, setComfortLevel]               = useState<ComfortLevel>('moderate');
  const [vibeChips, setVibeChips]                     = useState<string[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const toggleVibe = (key: string) => {
    setVibeChips((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const handleAirportSearch = async () => {
    if (airportQuery.trim().length < 2) return;
    setSearching(true);
    try {
      const results = await searchAirports(airportQuery);
      setAirportResults(results);
    } finally {
      setSearching(false);
    }
  };

  const buildDatetime = (hourStr: string, offsetHours = 0): string | null => {
    const hour = parseInt(hourStr, 10);
    if (isNaN(hour) || hour < 0 || hour > 23) return null;
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    if (offsetHours) d.setTime(d.getTime() + offsetHours * 3_600_000);
    return d.toISOString();
  };

  const handleCreate = async () => {
    setError(null);
    const arrival   = buildDatetime(arrivalHour);
    const departure = buildDatetime(departureHour);

    if (!arrival || !departure) {
      setError('Please enter valid arrival and departure hours (0–23).');
      return;
    }
    if (new Date(departure) <= new Date(arrival)) {
      setError('Departure must be after arrival.');
      return;
    }

    setLoading(true);
    try {
      const payload: CreateSessionPayload = {
        arrivalTime:   arrival,
        departureTime: departure,
        flightType,
        immigrationRequired,
        checkedBags,
        loungeAccess,
        wantsToLeave,
        comfortLevel,
        vibeChips,
        tripId: tripId ?? null,
        ...(selectedAirport?.id
          ? { airportId: selectedAirport.id }
          : {
              manualAirportName: (selectedAirport?.name ?? airportQuery) || null,
              manualCity:        selectedAirport?.city ?? initialCity ?? null,
              manualCountry:     selectedAirport?.country ?? null,
              manualIata:        selectedAirport?.iataCode ?? null,
            }),
      };

      const result = await createLayoverSession(payload);
      onSessionCreated?.(result.session.id, result.safeReturnSuggested);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('feature_disabled') || msg.includes('not yet enabled')) {
        setError('Layover Mode is not yet enabled. Check back soon!');
      } else {
        setError('Could not start layover session. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close">
            <X size={22} color="#666" />
          </Pressable>
          <Text style={styles.title}>Layover Mode</Text>
          <View style={{ width: 38 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* Step: Airport */}
          <Text style={styles.sectionLabel}><Plane size={14} color="#666" /> Airport</Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="IATA code or city (e.g. TPE, Tokyo)"
              value={airportQuery}
              onChangeText={setAirportQuery}
              onSubmitEditing={handleAirportSearch}
              returnKeyType="search"
              autoCapitalize="characters"
            />
            <Pressable style={styles.searchBtn} onPress={handleAirportSearch}>
              {searching
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.searchBtnText}>Search</Text>}
            </Pressable>
          </View>

          {airportResults.length > 0 && (
            <View style={styles.resultsBox}>
              {airportResults.map((ap) => (
                <Pressable
                  key={ap.iataCode}
                  style={[styles.resultItem, selectedAirport?.iataCode === ap.iataCode && styles.resultItemSelected]}
                  onPress={() => { setSelectedAirport(ap); setAirportResults([]); setAirportQuery(`${ap.iataCode} — ${ap.name}`); }}
                >
                  <Text style={styles.resultCode}>{ap.iataCode}</Text>
                  <Text style={styles.resultName}>{ap.name}</Text>
                  <Text style={styles.resultCity}>{ap.city}, {ap.country}</Text>
                </Pressable>
              ))}
            </View>
          )}

          {selectedAirport && (
            <View style={styles.selectedBadge}>
              <MapPin size={13} color="#2196F3" />
              <Text style={styles.selectedBadgeText}>{selectedAirport.name} · {selectedAirport.city}</Text>
            </View>
          )}

          {/* Time */}
          <Text style={styles.sectionLabel}><Clock size={14} color="#666" /> Time window</Text>
          <View style={styles.row}>
            <View style={styles.halfField}>
              <Text style={styles.fieldLabel}>Arrival hour (0–23)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 14"
                keyboardType="number-pad"
                value={arrivalHour}
                onChangeText={setArrivalHour}
              />
            </View>
            <View style={styles.halfField}>
              <Text style={styles.fieldLabel}>Departure hour (0–23)</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 20"
                keyboardType="number-pad"
                value={departureHour}
                onChangeText={setDepartureHour}
              />
            </View>
          </View>

          {/* Flight type */}
          <Text style={styles.sectionLabel}>Flight type</Text>
          <View style={styles.segmented}>
            {(['domestic', 'international'] as FlightType[]).map((ft) => (
              <Pressable
                key={ft}
                style={[styles.segment, flightType === ft && styles.segmentActive]}
                onPress={() => setFlightType(ft)}
              >
                <Text style={[styles.segmentText, flightType === ft && styles.segmentTextActive]}>
                  {ft === 'domestic' ? '🛫 Domestic' : '🌍 International'}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Toggles */}
          <Text style={styles.sectionLabel}>Your situation</Text>
          {[
            { label: 'Immigration required',  value: immigrationRequired, set: setImmigrationRequired },
            { label: 'Checked bags',           value: checkedBags,         set: setCheckedBags },
            { label: 'Lounge access',          value: loungeAccess,        set: setLoungeAccess },
            { label: 'Want to leave airport',  value: wantsToLeave,        set: setWantsToLeave },
          ].map(({ label, value, set }) => (
            <View key={label} style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>{label}</Text>
              <Switch value={value} onValueChange={set} trackColor={{ true: '#2196F3' }} />
            </View>
          ))}

          {/* Comfort level */}
          <Text style={styles.sectionLabel}>Comfort level</Text>
          {COMFORT_OPTIONS.map((opt) => (
            <Pressable
              key={opt.key}
              style={[styles.comfortOption, comfortLevel === opt.key && styles.comfortOptionActive]}
              onPress={() => setComfortLevel(opt.key)}
            >
              <Text style={[styles.comfortLabel, comfortLevel === opt.key && styles.comfortLabelActive]}>{opt.label}</Text>
              <Text style={styles.comfortDesc}>{opt.desc}</Text>
            </Pressable>
          ))}

          {/* Vibe chips */}
          <Text style={styles.sectionLabel}>What are you into?</Text>
          <View style={styles.chipRow}>
            {VIBE_OPTIONS.map((v) => (
              <Pressable
                key={v.key}
                style={[styles.chip, vibeChips.includes(v.key) && styles.chipActive]}
                onPress={() => toggleVibe(v.key)}
              >
                <Text style={[styles.chipText, vibeChips.includes(v.key) && styles.chipTextActive]}>{v.label}</Text>
              </Pressable>
            ))}
          </View>

          {/* Warning */}
          {!selectedAirport && !initialCity && (
            <View style={styles.warningBox}>
              <AlertCircle size={14} color="#E65100" />
              <Text style={styles.warningText}>Airport name used for city-level search only. Exact location not required.</Text>
            </View>
          )}

          {/* Inline error */}
          {error ? (
            <View style={styles.errorBox}>
              <AlertCircle size={14} color="#C62828" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* Submit */}
          <Pressable
            style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
            onPress={handleCreate}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.submitBtnText}>Start Layover Mode</Text>}
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#fff' },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#eee' },
  closeBtn:     { padding: 8 },
  title:        { fontSize: 17, fontWeight: '600', color: '#1a1a1a' },
  body:         { padding: 16, paddingBottom: 40 },
  sectionLabel: { fontSize: 13, fontWeight: '600', color: '#666', marginTop: 20, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  row:          { flexDirection: 'row', gap: 8 },
  halfField:    { flex: 1 },
  fieldLabel:   { fontSize: 12, color: '#888', marginBottom: 4 },
  input:        { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, fontSize: 15, backgroundColor: '#fafafa' },
  searchBtn:    { backgroundColor: '#2196F3', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  searchBtnText:{ color: '#fff', fontWeight: '600', fontSize: 14 },
  resultsBox:   { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, marginTop: 4, overflow: 'hidden' },
  resultItem:   { padding: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  resultItemSelected: { backgroundColor: '#E3F2FD' },
  resultCode:   { fontSize: 15, fontWeight: '700', color: '#1a1a1a' },
  resultName:   { fontSize: 13, color: '#444', marginTop: 2 },
  resultCity:   { fontSize: 12, color: '#888', marginTop: 1 },
  selectedBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#E3F2FD', borderRadius: 6, padding: 8, marginTop: 6 },
  selectedBadgeText: { fontSize: 13, color: '#1565C0' },
  segmented:    { flexDirection: 'row', gap: 8 },
  segment:      { flex: 1, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#ddd', alignItems: 'center' },
  segmentActive: { backgroundColor: '#2196F3', borderColor: '#2196F3' },
  segmentText:  { fontSize: 14, color: '#444' },
  segmentTextActive: { color: '#fff', fontWeight: '600' },
  toggleRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f5f5f5' },
  toggleLabel:  { fontSize: 15, color: '#333' },
  comfortOption: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 12, marginBottom: 8 },
  comfortOptionActive: { borderColor: '#2196F3', backgroundColor: '#E3F2FD' },
  comfortLabel: { fontSize: 15, fontWeight: '600', color: '#333' },
  comfortLabelActive: { color: '#1565C0' },
  comfortDesc:  { fontSize: 12, color: '#888', marginTop: 2 },
  chipRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip:         { borderWidth: 1, borderColor: '#ddd', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive:   { backgroundColor: '#2196F3', borderColor: '#2196F3' },
  chipText:     { fontSize: 13, color: '#555' },
  chipTextActive: { color: '#fff' },
  warningBox:   { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FFF3E0', borderRadius: 8, padding: 10, marginTop: 12 },
  warningText:  { fontSize: 12, color: '#E65100', flex: 1 },
  errorBox:     { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#FFEBEE', borderRadius: 8, padding: 12, marginTop: 12 },
  errorText:    { fontSize: 13, color: '#C62828', flex: 1, fontWeight: '500' },
  submitBtn:    { backgroundColor: '#2196F3', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 24 },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
