/**
 * Admin — Airport profiles and caution zones (testing-mode WP-21, LAY-F16).
 *
 * Every layover flow needs its test airport seeded first. This screen:
 *   - lists airport profiles (GET /api/admin/airport/profiles), searchable by
 *     IATA code, name or city;
 *   - adds or updates one (POST /api/admin/airport/profiles — an upsert on the
 *     IATA code, so saving an existing code edits it);
 *   - lists and adds the caution zones of the selected airport
 *     (GET/POST /api/admin/airport/caution-zones).
 * Verified landside places and curated dwell stay API-only
 * (docs/ops/testing-mode-flows.md).
 *
 * Admin-only on the server (requireAdmin in routes/airport.ts). The server
 * refuses rather than serving an empty list when profiles cannot be read, and
 * this screen shows that refusal as an error with a retry.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { KeyboardSafeView } from '../../src/components/ui/KeyboardSafeView';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import {
  buildAirportProfileBody,
  buildCautionZoneBody,
  createCautionZone,
  listAirportProfiles,
  listCautionZones,
  upsertAirportProfile,
  type AirportProfile,
  type AirportProfileForm,
  type CautionZone,
  type CautionZoneForm,
} from '../../src/services/adminConsole';
import {
  AdminButton,
  AdminEmpty,
  AdminError,
  AdminHeader,
  AdminLoading,
  adminStyles as a,
} from '../../src/components/admin/AdminConsoleParts';

const SHOWN = 30;
const ZONE_TYPES: CautionZoneForm['zoneType'][] = ['caution_zone', 'safety_zone', 'no_go_zone'];

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; rows: T[] };

const EMPTY_PROFILE: AirportProfileForm = { iataCode: '', name: '', city: '', country: '', countryCode: '', timezone: '', lat: '', lng: '', verified: false };

function formOf(p: AirportProfile): AirportProfileForm {
  return {
    iataCode: p.iata_code, name: p.name ?? '', city: p.city ?? '', country: p.country ?? '',
    countryCode: p.country_code ?? '', timezone: p.timezone ?? '',
    lat: p.lat === null || p.lat === undefined ? '' : String(p.lat),
    lng: p.lng === null || p.lng === undefined ? '' : String(p.lng),
    verified: Boolean(p.verified),
  };
}

function Field({ label, value, onChange, testID, keyboard }: { label: string; value: string; onChange: (v: string) => void; testID: string; keyboard?: 'decimal-pad' | 'number-pad' }) {
  return (
    <>
      <Text style={a.label}>{label}</Text>
      <TextInput style={a.input} value={value} onChangeText={onChange} autoCapitalize="none" autoCorrect={false}
        keyboardType={keyboard ?? 'default'} accessibilityLabel={label} testID={testID} />
    </>
  );
}

export default function AdminAirportsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();

  useEffect(() => {
    if (!sessionLoading && !isAuthed) router.replace('/(auth)/sign-in' as any);
  }, [isAuthed, sessionLoading]);

  const [profiles, setProfiles] = useState<Load<AirportProfile>>({ state: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [zones, setZones] = useState<Load<CautionZone> | null>(null);

  const [form, setForm] = useState<AirportProfileForm>(EMPTY_PROFILE);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [zoneForm, setZoneForm] = useState<CautionZoneForm>({ iataCode: '', name: '', zoneType: 'caution_zone', centerLat: '', centerLng: '', radiusMeters: '1000', note: '' });
  const [zoneError, setZoneError] = useState<string | null>(null);
  const [zoneSaving, setZoneSaving] = useState(false);

  const load = useCallback(async () => {
    setProfiles({ state: 'loading' });
    const r = await listAirportProfiles();
    setProfiles(r.ok ? { state: 'ready', rows: r.data } : { state: 'error', message: r.error });
  }, []);

  const loadZones = useCallback(async (iata: string) => {
    setZones({ state: 'loading' });
    const r = await listCautionZones(iata);
    setZones(r.ok ? { state: 'ready', rows: r.data } : { state: 'error', message: r.error });
  }, []);

  useEffect(() => {
    if (!sessionLoading && isAuthed) void load();
  }, [load, isAuthed, sessionLoading]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    if (selected) await loadZones(selected);
    setRefreshing(false);
  }, [load, loadZones, selected]);

  const matches = useMemo(() => {
    if (profiles.state !== 'ready') return [];
    const q = search.trim().toLowerCase();
    const rows = q
      ? profiles.rows.filter((p) => [p.iata_code, p.name, p.city].some((v) => (v ?? '').toLowerCase().includes(q)))
      : profiles.rows;
    return rows;
  }, [profiles, search]);

  const select = useCallback((p: AirportProfile) => {
    setSelected(p.iata_code);
    setForm(formOf(p));
    setZoneForm((z) => ({ ...z, iataCode: p.iata_code, centerLat: p.lat == null ? '' : String(p.lat), centerLng: p.lng == null ? '' : String(p.lng) }));
    setNotice(null);
    void loadZones(p.iata_code);
  }, [loadZones]);

  const save = useCallback(async () => {
    setFormError(null);
    setNotice(null);
    const built = buildAirportProfileBody(form);
    if (!built.ok) { setFormError(built.error); return; }
    setSaving(true);
    const r = await upsertAirportProfile(built.body);
    setSaving(false);
    if (!r.ok) { setFormError(r.error); return; }
    setNotice(`Saved ${built.body.iataCode}.`);
    setSelected(built.body.iataCode);
    setZoneForm((z) => ({ ...z, iataCode: built.body.iataCode }));
    void load();
    void loadZones(built.body.iataCode);
  }, [form, load, loadZones]);

  const addZone = useCallback(async () => {
    setZoneError(null);
    const built = buildCautionZoneBody(zoneForm);
    if (!built.ok) { setZoneError(built.error); return; }
    setZoneSaving(true);
    const r = await createCautionZone(built.body);
    setZoneSaving(false);
    if (!r.ok) { setZoneError(r.error); return; }
    setZoneForm((z) => ({ ...z, name: '', note: '' }));
    void loadZones(built.body.iataCode);
  }, [zoneForm, loadZones]);

  const set = (k: keyof AirportProfileForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const setZ = (k: keyof CautionZoneForm) => (v: string) => setZoneForm((z) => ({ ...z, [k]: v }));

  return (
    <View style={[a.screen, { paddingTop: insets.top }]}>
      <AdminHeader title="Airports" subtitle="Profiles and caution zones for layover testing" />
      <KeyboardSafeView
        contentContainerStyle={a.body}
        scrollViewProps={{ refreshControl: <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> }}
      >
        <TextInput style={a.input} value={search} onChangeText={setSearch} placeholder="Search by IATA, name or city"
          autoCapitalize="none" autoCorrect={false} accessibilityLabel="Search airports" testID="airports-search" />

        {profiles.state === 'loading' && <AdminLoading testID="airports-loading" />}
        {profiles.state === 'error' && (
          <AdminError message={`Couldn't load airport profiles: ${profiles.message}`} onRetry={() => void load()} testID="airports-error" />
        )}
        {profiles.state === 'ready' && profiles.rows.length === 0 && (
          <AdminEmpty message="No airport profile exists yet. Add the test airport below." testID="airports-empty" />
        )}
        {profiles.state === 'ready' && profiles.rows.length > 0 && matches.length === 0 && (
          <AdminEmpty message={`No airport matches “${search.trim()}”.`} testID="airports-nomatch" />
        )}
        {profiles.state === 'ready' && matches.length > SHOWN && (
          <Text style={a.meta}>Showing {SHOWN} of {matches.length} — search to narrow.</Text>
        )}
        {matches.slice(0, SHOWN).map((p) => (
          <View key={p.id} style={a.card} testID={`airport-${p.iata_code}`}>
            <Text style={a.cardTitle}>{p.iata_code} · {p.name}</Text>
            <Text style={a.meta}>{[p.city, p.country].filter(Boolean).join(', ')}{p.verified ? ' · verified' : ''}</Text>
            <View style={a.row}>
              <AdminButton label={selected === p.iata_code ? 'Selected' : 'Select'} tone={selected === p.iata_code ? 'primary' : 'neutral'}
                onPress={() => select(p)} testID={`airport-select-${p.iata_code}`} />
            </View>
          </View>
        ))}

        <Text style={a.sectionTitle}>{selected ? `Edit ${selected}` : 'Add an airport'}</Text>
        <View style={a.card}>
          <Field label="IATA code" value={form.iataCode} onChange={set('iataCode')} testID="airport-iata" />
          <Field label="Name" value={form.name} onChange={set('name')} testID="airport-name" />
          <Field label="City" value={form.city} onChange={set('city')} testID="airport-city" />
          <Field label="Country" value={form.country} onChange={set('country')} testID="airport-country" />
          <Field label="Country code" value={form.countryCode} onChange={set('countryCode')} testID="airport-cc" />
          <Field label="Timezone (IANA, optional)" value={form.timezone} onChange={set('timezone')} testID="airport-tz" />
          <Field label="Latitude" value={form.lat} onChange={set('lat')} keyboard="decimal-pad" testID="airport-lat" />
          <Field label="Longitude" value={form.lng} onChange={set('lng')} keyboard="decimal-pad" testID="airport-lng" />
          <View style={a.row}>
            <AdminButton label={form.verified ? 'Verified: yes' : 'Verified: no'} onPress={() => setForm((f) => ({ ...f, verified: !f.verified }))} testID="airport-verified" />
            <AdminButton label={saving ? 'Saving…' : 'Save airport'} tone="primary" disabled={saving} onPress={() => void save()} testID="airport-save" />
            {!!selected && <AdminButton label="New airport" onPress={() => { setSelected(null); setForm(EMPTY_PROFILE); setZones(null); }} testID="airport-new" />}
          </View>
          {!!formError && <Text style={a.formError} accessibilityRole="alert" testID="airport-form-error">{formError}</Text>}
          {!!notice && <Text style={a.notice} accessibilityLiveRegion="polite" testID="airport-notice">{notice}</Text>}
        </View>

        {!!selected && (
          <>
            <Text style={a.sectionTitle}>Caution zones at {selected}</Text>
            {zones?.state === 'loading' && <AdminLoading testID="zones-loading" />}
            {zones?.state === 'error' && (
              <AdminError message={`Couldn't load caution zones: ${zones.message}`} onRetry={() => void loadZones(selected)} testID="zones-error" />
            )}
            {zones?.state === 'ready' && zones.rows.length === 0 && <AdminEmpty message={`No caution zones at ${selected}.`} testID="zones-empty" />}
            {zones?.state === 'ready' && zones.rows.map((z) => (
              <View key={z.id} style={a.card} testID={`zone-${z.id}`}>
                <Text style={a.cardTitle}>{z.name}</Text>
                <Text style={a.meta}>{z.zone_type.replace(/_/g, ' ')} · {z.radius_meters} m · {z.center_lat}, {z.center_lng}</Text>
                {!!z.metadata?.note && <Text style={a.meta}>{z.metadata.note}</Text>}
              </View>
            ))}
            <View style={a.card}>
              <Field label="Zone name" value={zoneForm.name} onChange={setZ('name')} testID="zone-name" />
              <View style={a.row}>
                {ZONE_TYPES.map((t) => (
                  <AdminButton key={t} label={t.replace(/_/g, ' ')} tone={zoneForm.zoneType === t ? 'primary' : 'neutral'}
                    onPress={() => setZoneForm((z) => ({ ...z, zoneType: t }))} testID={`zone-type-${t}`} />
                ))}
              </View>
              <Field label="Centre latitude" value={zoneForm.centerLat} onChange={setZ('centerLat')} keyboard="decimal-pad" testID="zone-lat" />
              <Field label="Centre longitude" value={zoneForm.centerLng} onChange={setZ('centerLng')} keyboard="decimal-pad" testID="zone-lng" />
              <Field label="Radius (metres, 50–50000)" value={zoneForm.radiusMeters} onChange={setZ('radiusMeters')} keyboard="number-pad" testID="zone-radius" />
              <Field label="Note (optional)" value={zoneForm.note} onChange={setZ('note')} testID="zone-note" />
              <View style={a.row}>
                <AdminButton label={zoneSaving ? 'Adding…' : 'Add zone'} tone="primary" disabled={zoneSaving} onPress={() => void addZone()} testID="zone-add" />
              </View>
              {!!zoneError && <Text style={a.formError} accessibilityRole="alert" testID="zone-error">{zoneError}</Text>}
            </View>
          </>
        )}
      </KeyboardSafeView>
    </View>
  );
}
