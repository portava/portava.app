/**
 * LayoverModeSheet — set up a layover session.
 *
 * Modern flow: universal airport autocomplete (IATA badges), real DATE +
 * time pickers in the airport's local time (overnight layovers supported),
 * live duration preview, then straight into the layover dashboard.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, Modal, ScrollView, Pressable, Switch,
  TextInput, StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  X, Plane, Clock, MapPin, AlertCircle, CalendarDays, Moon, BadgeCheck,
} from 'lucide-react-native';
import { GlobalTimePicker } from '../selectors/GlobalTimePicker.tsx';
import { GlobalCalendarPicker } from '../selectors/GlobalCalendarPicker.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  createLayoverSession,
  searchAirports,
  type AirportProfile,
  type CreateSessionPayload,
  type FlightType,
  type ComfortLevel,
} from '../../services/layover.ts';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Optional — the sheet always routes to the layover dashboard itself. */
  onSessionCreated?: (sessionId: string, safeReturnSuggested: boolean) => void;
  tripId?: string | null;
  initialCity?: string | null;
}

const VIBE_OPTIONS = [
  { key: 'food',        label: '🍜 Food' },
  { key: 'nightlife',   label: '🌙 Nightlife' },
  { key: 'shopping',    label: '🛍 Shopping' },
  { key: 'culture',     label: '🏛 Culture' },
  { key: 'rest',        label: '😴 Rest' },
  { key: 'meetups',     label: '🤝 Meetups' },
];

const COMFORT_OPTIONS: Array<{ key: ComfortLevel; label: string; desc: string }> = [
  { key: 'safe_only',   label: 'Play it safe', desc: 'Airport-only or right next door' },
  { key: 'moderate',    label: 'Balanced',     desc: 'Out and about with generous buffers' },
  { key: 'adventurous', label: 'Adventurous',  desc: 'Squeeze the most out of the window' },
];

function pad(n: number) { return n < 10 ? `0${n}` : String(n); }

function todayLocalDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Naive local parse — used only for duration preview (tz-independent diff). */
function parseWall(date: string | null, time: string | null): Date | null {
  if (!date || !time) return null;
  const [y, mo, dd] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  if ([y, mo, dd, h, mi].some((x) => Number.isNaN(x))) return null;
  return new Date(y, mo - 1, dd, h, mi, 0, 0);
}

function fmtDateLabel(date: string | null): string {
  if (!date) return 'Date';
  const d = parseWall(date, '12:00');
  return d ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : date;
}

function fmtTimeLabel(time: string | null): string {
  if (!time) return 'Time';
  const d = parseWall(todayLocalDate(), time);
  return d ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : time;
}

export function LayoverModeSheet({ visible, onClose, onSessionCreated, tripId, initialCity }: Props) {
  const router = useRouter();

  // Airport
  const [query, setQuery]             = useState(initialCity ?? '');
  const [results, setResults]         = useState<AirportProfile[]>([]);
  const [airport, setAirport]         = useState<AirportProfile | null>(null);
  const [searching, setSearching]     = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Times (airport-local wall time)
  const [arrDate, setArrDate] = useState<string | null>(null);
  const [arrTime, setArrTime] = useState<string | null>(null);
  const [depDate, setDepDate] = useState<string | null>(null);
  const [depTime, setDepTime] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<null | 'arrDate' | 'arrTime' | 'depDate' | 'depTime'>(null);

  // Prefs
  const [flightType, setFlightType]                   = useState<FlightType>('international');
  const [immigrationRequired, setImmigrationRequired] = useState(false);
  const [checkedBags, setCheckedBags]                 = useState(false);
  const [loungeAccess, setLoungeAccess]               = useState(false);
  const [wantsToLeave, setWantsToLeave]               = useState(true);
  const [comfortLevel, setComfortLevel]               = useState<ComfortLevel>('moderate');
  const [vibeChips, setVibeChips]                     = useState<string[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  // Debounced airport autocomplete
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (airport && query.startsWith(airport.iataCode)) return; // selection label, not a query
    if (q.length < 2) { setResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        setResults(await searchAirports(q));
      } finally {
        setSearching(false);
      }
    }, 280);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query, airport]);

  const selectAirport = (ap: AirportProfile) => {
    setAirport(ap);
    setResults([]);
    setQuery(`${ap.iataCode} — ${ap.name}`);
  };

  const clearAirport = () => {
    setAirport(null);
    setQuery('');
  };

  const preview = useMemo(() => {
    const a = parseWall(arrDate, arrTime);
    const d = parseWall(depDate, depTime);
    if (!a || !d) return null;
    const minutes = Math.round((d.getTime() - a.getTime()) / 60_000);
    if (minutes <= 0) return { minutes, label: 'Departure must be after arrival', invalid: true, overnight: false };
    if (minutes > 48 * 60) return { minutes, label: 'Layovers longer than 48h aren’t supported', invalid: true, overnight: false };
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const overnight = arrDate !== depDate;
    return {
      minutes,
      invalid: false,
      overnight,
      label: `${h}h${m > 0 ? ` ${m}m` : ''} on the ground${overnight ? ' · overnight' : ''}`,
    };
  }, [arrDate, arrTime, depDate, depTime]);

  const toggleVibe = (key: string) =>
    setVibeChips((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);

  const handleCreate = async () => {
    setError(null);
    if (!airport) {
      setError('Pick your airport from the search results — we need its timezone to get your times right.');
      return;
    }
    if (!arrDate || !arrTime || !depDate || !depTime) {
      setError('Pick the date and time for both arrival and departure.');
      return;
    }
    if (!preview || preview.invalid) {
      setError(preview?.label ?? 'Check your times.');
      return;
    }

    setLoading(true);
    try {
      const payload: CreateSessionPayload = {
        arrivalLocal:   `${arrDate}T${arrTime}`,
        departureLocal: `${depDate}T${depTime}`,
        flightType,
        immigrationRequired,
        checkedBags,
        loungeAccess,
        wantsToLeave,
        comfortLevel,
        vibeChips,
        tripId: tripId ?? null,
        ...(airport.id ? { airportId: airport.id, iata: airport.iataCode } : { iata: airport.iataCode }),
      };

      const result = await createLayoverSession(payload);
      onClose();
      onSessionCreated?.(result.session.id, result.safeReturnSuggested);
      router.push(`/layover/${result.session.id}` as any);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('feature_disabled') || msg.includes('not yet enabled')) {
        setError('Layover Mode is not yet enabled. Check back soon!');
      } else {
        setError('Could not start your layover. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const tzNote = airport
    ? `Times are local to ${airport.iataCode} (${airport.timezone})`
    : 'Pick an airport from the list so times use its local timezone';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onClose} style={styles.closeBtn} accessibilityLabel="Close" hitSlop={8}>
            <X size={22} color={color.mute} />
          </Pressable>
          <Text style={styles.title}>Layover Mode</Text>
          <View style={{ width: 38 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* Airport */}
          <Text style={styles.sectionLabel}>Where's your layover?</Text>
          <View style={styles.searchWrap}>
            <Plane size={16} color={color.faint} />
            <TextInput
              style={styles.searchInput}
              placeholder="Airport, city or IATA code (TPE, Tokyo…)"
              placeholderTextColor={color.faint}
              value={query}
              onChangeText={(v) => { setQuery(v); if (airport) setAirport(null); }}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            {searching
              ? <ActivityIndicator size="small" color={color.deep} />
              : airport
                ? <Pressable onPress={clearAirport} hitSlop={8}><X size={16} color={color.faint} /></Pressable>
                : null}
          </View>

          {results.length > 0 && !airport && (
            <View style={styles.resultsBox}>
              {results.slice(0, 6).map((ap) => (
                <Pressable key={`${ap.iataCode}-${ap.id ?? 'static'}`} style={styles.resultItem} onPress={() => selectAirport(ap)}>
                  <View style={styles.iataBadge}><Text style={styles.iataBadgeText}>{ap.iataCode}</Text></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.resultName} numberOfLines={1}>{ap.name}</Text>
                    <Text style={styles.resultCity} numberOfLines={1}>{ap.city}, {ap.country}</Text>
                  </View>
                  {ap.verified && <BadgeCheck size={15} color={color.deep} />}
                </Pressable>
              ))}
            </View>
          )}

          {airport && (
            <View style={styles.selectedCard}>
              <MapPin size={14} color={color.deep} />
              <Text style={styles.selectedText} numberOfLines={1}>
                {airport.city}, {airport.country} · {airport.timezone}
              </Text>
            </View>
          )}

          {/* Times */}
          <Text style={styles.sectionLabel}>You land</Text>
          <View style={styles.row}>
            <Pressable style={[styles.pickerBtn, { flex: 1.4 }]} onPress={() => setPickerFor('arrDate')}>
              <CalendarDays size={14} color={arrDate ? color.ink : color.faint} />
              <Text style={[styles.pickerText, !arrDate && styles.pickerPlaceholder]}>{fmtDateLabel(arrDate)}</Text>
            </Pressable>
            <Pressable style={[styles.pickerBtn, { flex: 1 }]} onPress={() => setPickerFor('arrTime')}>
              <Clock size={14} color={arrTime ? color.ink : color.faint} />
              <Text style={[styles.pickerText, !arrTime && styles.pickerPlaceholder]}>{fmtTimeLabel(arrTime)}</Text>
            </Pressable>
          </View>

          <Text style={styles.sectionLabel}>Your next flight leaves</Text>
          <View style={styles.row}>
            <Pressable style={[styles.pickerBtn, { flex: 1.4 }]} onPress={() => setPickerFor('depDate')}>
              <CalendarDays size={14} color={depDate ? color.ink : color.faint} />
              <Text style={[styles.pickerText, !depDate && styles.pickerPlaceholder]}>{fmtDateLabel(depDate)}</Text>
            </Pressable>
            <Pressable style={[styles.pickerBtn, { flex: 1 }]} onPress={() => setPickerFor('depTime')}>
              <Clock size={14} color={depTime ? color.ink : color.faint} />
              <Text style={[styles.pickerText, !depTime && styles.pickerPlaceholder]}>{fmtTimeLabel(depTime)}</Text>
            </Pressable>
          </View>

          <Text style={styles.tzNote}>{tzNote}</Text>

          {preview && (
            <View style={[styles.previewChip, preview.invalid && styles.previewChipBad]}>
              {preview.overnight
                ? <Moon size={13} color={preview.invalid ? '#C62828' : color.onInk} />
                : <Clock size={13} color={preview.invalid ? '#C62828' : color.onInk} />}
              <Text style={[styles.previewText, preview.invalid && styles.previewTextBad]}>{preview.label}</Text>
            </View>
          )}

          {/* Flight type */}
          <Text style={styles.sectionLabel}>Next flight is</Text>
          <View style={styles.segmented}>
            {(['domestic', 'international'] as FlightType[]).map((ft) => (
              <Pressable
                key={ft}
                style={[styles.segment, flightType === ft && styles.segmentActive]}
                onPress={() => setFlightType(ft)}
              >
                <Text style={[styles.segmentText, flightType === ft && styles.segmentTextActive]}>
                  {ft === 'domestic' ? 'Domestic' : 'International'}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Situation toggles */}
          <Text style={styles.sectionLabel}>Your situation</Text>
          <View style={styles.toggleCard}>
            {[
              { label: 'I go through immigration', value: immigrationRequired, set: setImmigrationRequired },
              { label: 'I have checked bags',       value: checkedBags,         set: setCheckedBags },
              { label: 'I have lounge access',      value: loungeAccess,        set: setLoungeAccess },
              { label: 'I want to leave the airport', value: wantsToLeave,      set: setWantsToLeave },
            ].map(({ label, value, set }, i, arr) => (
              <View key={label} style={[styles.toggleRow, i < arr.length - 1 && styles.toggleDivider]}>
                <Text style={styles.toggleLabel}>{label}</Text>
                <Switch
                  value={value}
                  onValueChange={set}
                  trackColor={{ true: color.deep, false: color.haze }}
                  thumbColor={Platform.OS === 'android' ? color.paperRaised : undefined}
                />
              </View>
            ))}
          </View>

          {/* Comfort */}
          <Text style={styles.sectionLabel}>Comfort level</Text>
          <View style={styles.comfortRow}>
            {COMFORT_OPTIONS.map((opt) => (
              <Pressable
                key={opt.key}
                style={[styles.comfortCard, comfortLevel === opt.key && styles.comfortCardActive]}
                onPress={() => setComfortLevel(opt.key)}
              >
                <Text style={[styles.comfortLabel, comfortLevel === opt.key && styles.comfortLabelActive]}>{opt.label}</Text>
                <Text style={styles.comfortDesc}>{opt.desc}</Text>
              </Pressable>
            ))}
          </View>

          {/* Vibes */}
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

          {error ? (
            <View style={styles.errorBox}>
              <AlertCircle size={14} color="#C62828" />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <Pressable
            style={[styles.submitBtn, loading && styles.submitBtnDisabled]}
            onPress={handleCreate}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color={color.onInk} />
              : <Text style={styles.submitBtnText}>Start layover</Text>}
          </Pressable>
        </ScrollView>
      </View>

      {/* Pickers */}
      <GlobalCalendarPicker
        mode="single"
        visible={pickerFor === 'arrDate'}
        title="Arrival date"
        value={arrDate}
        minDate={todayLocalDate(-1)}
        onConfirm={(v) => {
          setArrDate(v);
          if (v && !depDate) setDepDate(v);
          setPickerFor(null);
        }}
        onCancel={() => setPickerFor(null)}
      />
      <GlobalCalendarPicker
        mode="single"
        visible={pickerFor === 'depDate'}
        title="Departure date"
        value={depDate ?? arrDate}
        minDate={arrDate ?? todayLocalDate(-1)}
        onConfirm={(v) => { setDepDate(v); setPickerFor(null); }}
        onCancel={() => setPickerFor(null)}
      />
      <GlobalTimePicker
        visible={pickerFor === 'arrTime'}
        title="Arrival time"
        value={arrTime}
        onChange={(v) => setArrTime(v)}
        onClose={() => setPickerFor(null)}
      />
      <GlobalTimePicker
        visible={pickerFor === 'depTime'}
        title="Departure time"
        value={depTime}
        onChange={(v) => setDepTime(v)}
        onClose={() => setPickerFor(null)}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: color.paper },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  closeBtn:     { padding: space.xs },
  title:        { ...t.heading, color: color.ink },
  body:         { padding: space.lg, paddingBottom: 48 },
  sectionLabel: { ...t.stamp, color: color.mute, textTransform: 'uppercase', marginTop: space.xl, marginBottom: space.sm },

  searchWrap:   { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 2 },
  searchInput:  { flex: 1, ...t.body, color: color.ink, paddingVertical: space.md },
  resultsBox:   { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, marginTop: space.xs, overflow: 'hidden' },
  resultItem:   { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  iataBadge:    { backgroundColor: color.ink, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4, minWidth: 46, alignItems: 'center' },
  iataBadgeText:{ ...t.stamp, color: color.onInk },
  resultName:   { ...t.bodyStrong, color: color.ink },
  resultCity:   { ...t.small, color: color.mute },
  selectedCard: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: 'rgba(10,61,74,0.08)', borderRadius: radius.md, padding: space.md, marginTop: space.sm },
  selectedText: { ...t.small, color: color.deep, flex: 1 },

  row:          { flexDirection: 'row', gap: space.sm },
  pickerBtn:    { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.md },
  pickerText:   { ...t.body, color: color.ink, flexShrink: 1 },
  pickerPlaceholder: { color: color.faint },
  tzNote:       { ...t.small, color: color.faint, marginTop: space.sm },

  previewChip:  { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: color.deep, borderRadius: radius.pill ?? 999, paddingHorizontal: space.md, paddingVertical: 6, marginTop: space.md },
  previewChipBad: { backgroundColor: '#FDECEA' },
  previewText:  { ...t.small, color: color.onInk, fontWeight: '600' },
  previewTextBad: { color: '#C62828' },

  segmented:    { flexDirection: 'row', gap: space.sm },
  segment:      { flex: 1, paddingVertical: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, alignItems: 'center', backgroundColor: color.paperRaised },
  segmentActive: { backgroundColor: color.ink, borderColor: color.ink },
  segmentText:  { ...t.bodyStrong, color: color.mute },
  segmentTextActive: { color: color.onInk },

  toggleCard:   { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md },
  toggleRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: space.md },
  toggleDivider:{ borderBottomWidth: 1, borderBottomColor: color.haze },
  toggleLabel:  { ...t.body, color: color.ink, flex: 1, paddingRight: space.md },

  comfortRow:   { gap: space.sm },
  comfortCard:  { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, backgroundColor: color.paperRaised },
  comfortCardActive: { borderColor: color.deep, backgroundColor: 'rgba(10,61,74,0.08)' },
  comfortLabel: { ...t.bodyStrong, color: color.ink },
  comfortLabelActive: { color: color.deep },
  comfortDesc:  { ...t.small, color: color.mute, marginTop: 2 },

  chipRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip:         { borderWidth: 1, borderColor: color.haze, borderRadius: 999, paddingHorizontal: space.md, paddingVertical: 8, backgroundColor: color.paperRaised },
  chipActive:   { backgroundColor: color.ink, borderColor: color.ink },
  chipText:     { ...t.small, color: color.mute },
  chipTextActive: { color: color.onInk },

  errorBox:     { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, backgroundColor: '#FDECEA', borderRadius: radius.md, padding: space.md, marginTop: space.lg },
  errorText:    { ...t.small, color: '#C62828', flex: 1, fontWeight: '500' },

  submitBtn:    { backgroundColor: color.signal, borderRadius: radius.lg, paddingVertical: space.lg, alignItems: 'center', marginTop: space.xl },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 16 },
});
