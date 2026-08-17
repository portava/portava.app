/**
 * Rent a Buddy — Admin Rollout Dashboard
 *
 * Screens: city rollout board, QA checklist, beta access manager,
 * global pause controls, metrics, and audit log.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet,
  Switch, Alert, ActivityIndicator, RefreshControl, TextInput,
} from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, Shield, Globe, Users, Settings, FileText, ChevronRight, ChevronDown, ChevronUp, CheckCircle, XCircle, AlertCircle, Pause, Play, BarChart3 } from 'lucide-react-native';
import { color, space, radius, type as t, shadow, dot} from '../../../src/theme/tokens';
import { ReasonPromptModal } from '../../../src/components/ReasonPromptModal';
import { supabase } from '../../../src/lib/supabase';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const headers = await authHeaders();
    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers: { ...headers, ...(opts.headers as any) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (body as any)?.message ?? `HTTP ${res.status}` };
    return { ok: true, data: body as T };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'network_error' };
  }
}

type CityStatus = 'disabled' | 'waitlist_only' | 'buddy_applications_open' | 'internal_testing' | 'beta_testing' | 'public_mvp' | 'paused' | 'suspended';

const STATUS_COLOR: Record<CityStatus, string> = {
  disabled:               '#999',
  waitlist_only:          '#F59E0B',
  buddy_applications_open:'#3B82F6',
  internal_testing:       '#8B5CF6',
  beta_testing:           '#EC4899',
  public_mvp:             '#10B981',
  paused:                 '#EF4444',
  suspended:              '#6B7280',
};

const STATUS_LABEL: Record<CityStatus, string> = {
  disabled:               'Disabled',
  waitlist_only:          'Waitlist Only',
  buddy_applications_open:'Apps Open',
  internal_testing:       'Internal Test',
  beta_testing:           'Beta',
  public_mvp:             'Live ✓',
  paused:                 'Paused',
  suspended:              'Suspended',
};

type Tab = 'cities' | 'beta' | 'qa' | 'controls' | 'audit';

// ── Status chip ───────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: CityStatus }) {
  return (
    <View style={[chipStyles.chip, { backgroundColor: STATUS_COLOR[status] + '22', borderColor: STATUS_COLOR[status] }]}>
      <Text style={[chipStyles.label, { color: STATUS_COLOR[status] }]}>{STATUS_LABEL[status]}</Text>
    </View>
  );
}
const chipStyles = StyleSheet.create({
  chip:  { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, borderWidth: 1 },
  label: { fontSize: 10, fontWeight: '700', fontFamily: 'Courier', letterSpacing: 0.5 },
});

// ── City Rollout Board ────────────────────────────────────────────────────────

function CityBoard() {
  const [cities, setCities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newCity, setNewCity] = useState('');
  const [adding, setAdding] = useState(false);
  const [overrideCity, setOverrideCity] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState('');
  const [cityMetrics, setCityMetrics] = useState<Record<string, any>>({});
  const [metricsLoading, setMetricsLoading] = useState<string | null>(null);
  const [metricsExpanded, setMetricsExpanded] = useState<string | null>(null);
  // Ref-based guard: prevents a second Alert confirm from firing a duplicate
  // POST while the first pause request is already in flight.
  const pausingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await apiFetch<{ cities: any[] }>('/api/admin/rent-buddy/rollout/cities');
    setLoading(false);
    if (r.ok) setCities(r.data.cities);
  }, []);

  useEffect(() => { load(); }, [load]);

  const advance = async (id: string, reason?: string) => {
    const r = await apiFetch<any>(`/api/admin/rent-buddy/rollout/cities/${id}/advance-status`, {
      method: 'POST',
      body: JSON.stringify(reason ? { overrideReason: reason } : {}),
    });
    if (!r.ok) {
      if ((r as any).error === 'qa_not_passed' || r.error?.includes('QA')) {
        Alert.alert('QA Not Passed', 'All QA checklist items must be passed before going live. Provide an override reason to bypass.', [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Override with reason',
            style: 'destructive',
            onPress: () => {
              setOverrideCity(id);
            },
          },
        ]);
      } else {
        Alert.alert('Error', bookingErrorCopy(r.error));
      }
    } else {
      load();
    }
  };

  const pause = (id: string) => {
    // Ignore the call entirely while a pause POST is already in flight.
    if (pausingRef.current) return;
    Alert.alert('Pause city?', 'New bookings will be blocked. Existing confirmed bookings remain accessible.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Pause', style: 'destructive',
        onPress: async () => {
          // Guard against two stacked alerts both confirming before the first
          // POST completes.
          if (pausingRef.current) return;
          pausingRef.current = true;
          try {
            await apiFetch(`/api/admin/rent-buddy/rollout/cities/${id}/pause`, { method: 'POST', body: '{}' });
          } finally {
            pausingRef.current = false;
          }
          load();
        },
      },
    ]);
  };

  const resume = async (id: string) => {
    await apiFetch(`/api/admin/rent-buddy/rollout/cities/${id}/resume`, { method: 'POST', body: JSON.stringify({ resumeStatus: 'public_mvp' }) });
    load();
  };

  const fetchMetrics = useCallback(async (cityId: string) => {
    if (metricsExpanded === cityId) { setMetricsExpanded(null); return; }
    if (cityMetrics[cityId]) { setMetricsExpanded(cityId); return; }
    setMetricsLoading(cityId);
    const r = await apiFetch<any>(`/api/admin/rent-buddy/rollout/cities/${cityId}/metrics`);
    setMetricsLoading(null);
    if (r.ok) {
      setCityMetrics(prev => ({ ...prev, [cityId]: r.data }));
      setMetricsExpanded(cityId);
    } else {
      Alert.alert('Metrics Error', (r as any).error || 'Could not load metrics.');
    }
  }, [cityMetrics, metricsExpanded]);

  const addCity = async () => {
    if (!newCity.trim()) return;
    setAdding(true);
    await apiFetch('/api/admin/rent-buddy/rollout/cities', { method: 'POST', body: JSON.stringify({ city: newCity.trim() }) });
    setNewCity('');
    setAdding(false);
    load();
  };

  if (loading) return <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} />;

  return (
    <View>
      {/* Add city */}
      <View style={bStyles.addRow}>
        <TextInput
          style={bStyles.addInput}
          placeholder="Add city…"
          placeholderTextColor={color.haze}
          value={newCity}
          onChangeText={setNewCity}
        />
        <Pressable style={bStyles.addBtn} onPress={addCity} disabled={adding}>
          <Text style={bStyles.addBtnText}>{adding ? '…' : '+ Add'}</Text>
        </Pressable>
      </View>

      {/* Override dialog */}
      {overrideCity && (
        <View style={bStyles.overrideCard}>
          <Text style={bStyles.overrideTitle}>QA Override Reason (required)</Text>
          <TextInput
            style={bStyles.overrideInput}
            placeholder="Enter override justification…"
            placeholderTextColor={color.haze}
            value={overrideReason}
            onChangeText={setOverrideReason}
            multiline
          />
          <View style={bStyles.overrideRow}>
            <Pressable style={bStyles.cancelBtn} onPress={() => { setOverrideCity(null); setOverrideReason(''); }}>
              <Text style={bStyles.cancelBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[bStyles.overrideBtn, !overrideReason.trim() && { opacity: 0.4 }]}
              onPress={async () => {
                if (!overrideReason.trim()) return;
                await advance(overrideCity, overrideReason);
                setOverrideCity(null);
                setOverrideReason('');
              }}
              disabled={!overrideReason.trim()}
            >
              <Text style={bStyles.overrideBtnText}>Confirm Override</Text>
            </Pressable>
          </View>
        </View>
      )}

      {cities.map(city => (
        <View key={city.id} style={bStyles.card}>
          <Pressable style={bStyles.cardHeader} onPress={() => setExpanded(e => e === city.id ? null : city.id)}>
            <View style={{ flex: 1 }}>
              <Text style={bStyles.cityName}>{city.city}{city.country ? `, ${city.country}` : ''}</Text>
              <StatusChip status={city.status} />
            </View>
            {expanded === city.id ? <ChevronUp size={16} color={color.mute} /> : <ChevronDown size={16} color={color.mute} />}
          </Pressable>

          {expanded === city.id && (
            <View style={bStyles.cardBody}>
              {city.target_launch_date && (
                <Text style={bStyles.meta}>Target launch: {city.target_launch_date}</Text>
              )}
              {city.notes && <Text style={bStyles.meta}>{city.notes}</Text>}

              <View style={bStyles.btnRow}>
                <Pressable style={bStyles.actionBtn} onPress={() => advance(city.id)}>
                  <ChevronRight size={13} color={color.onInk} />
                  <Text style={bStyles.actionBtnText}>Advance</Text>
                </Pressable>

                {city.status !== 'paused' ? (
                  <Pressable style={[bStyles.actionBtn, bStyles.dangerBtn]} onPress={() => pause(city.id)}>
                    <Pause size={13} color="#fff" />
                    <Text style={bStyles.actionBtnText}>Pause</Text>
                  </Pressable>
                ) : (
                  <Pressable style={[bStyles.actionBtn, bStyles.successBtn]} onPress={() => resume(city.id)}>
                    <Play size={13} color="#fff" />
                    <Text style={bStyles.actionBtnText}>Resume</Text>
                  </Pressable>
                )}

                <Pressable
                  style={[bStyles.actionBtn, { backgroundColor: '#6366F1' }]}
                  onPress={() => fetchMetrics(city.id)}
                >
                  {metricsLoading === city.id
                    ? <ActivityIndicator size={13} color="#fff" />
                    : <BarChart3 size={13} color="#fff" />}
                  <Text style={bStyles.actionBtnText}>{metricsLoading === city.id ? '…' : metricsExpanded === city.id ? 'Hide' : 'Metrics'}</Text>
                </Pressable>
              </View>

              {metricsExpanded === city.id && cityMetrics[city.id] && (
                <View style={mtrStyles.wrap}>
                  <Text style={mtrStyles.title}>City Metrics</Text>

                  <Text style={mtrStyles.section}>Graduation checklist</Text>
                  {Object.entries(cityMetrics[city.id].graduationChecklist ?? {}).map(([key, val]: [string, any]) => (
                    <View key={key} style={mtrStyles.row}>
                      {val
                        ? <CheckCircle size={12} color="#22C55E" />
                        : <XCircle size={12} color="#EF4444" />}
                      <Text style={[mtrStyles.rowLabel, { color: val ? '#22C55E' : '#EF4444' }]}>{key}</Text>
                    </View>
                  ))}

                  <Text style={mtrStyles.section}>Bookings</Text>
                  <Text style={mtrStyles.stat}>
                    Real: {cityMetrics[city.id].bookings?.real ?? 0}{'  '}
                    Test: {cityMetrics[city.id].bookings?.test ?? 0}{'  '}
                    Completed: {cityMetrics[city.id].bookings?.completed ?? 0}
                  </Text>
                  <Text style={mtrStyles.stat}>Revenue: ${(cityMetrics[city.id].revenue?.totalUsd ?? 0).toFixed(2)}</Text>

                  <Text style={mtrStyles.section}>Quality</Text>
                  <Text style={mtrStyles.stat}>
                    Avg rating: {cityMetrics[city.id].qualityMetrics?.avgRating != null
                      ? Number(cityMetrics[city.id].qualityMetrics.avgRating).toFixed(1)
                      : 'N/A'}{'  '}
                    Repeat rate: {Math.round((cityMetrics[city.id].qualityMetrics?.repeatRate ?? 0) * 100)}%
                  </Text>

                  <Text style={[mtrStyles.badge, {
                    color: cityMetrics[city.id].graduationReady ? '#22C55E' : '#EF4444',
                    borderColor: cityMetrics[city.id].graduationReady ? '#22C55E' : '#EF4444',
                  }]}>
                    {cityMetrics[city.id].graduationReady ? '✓ Ready for graduation' : '✗ Not yet ready for graduation'}
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>
      ))}
      {cities.length === 0 && (
        <Text style={{ ...t.body, color: color.mute, textAlign: 'center', marginTop: space.xl }}>No cities configured yet.</Text>
      )}
    </View>
  );
}

const bStyles = StyleSheet.create({
  addRow: { flexDirection: 'row', gap: space.sm, marginBottom: space.md },
  addInput: { flex: 1, height: 40, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, ...t.body, color: color.ink },
  addBtn: { backgroundColor: color.signal, borderRadius: radius.md, paddingHorizontal: space.lg, justifyContent: 'center' },
  addBtnText: { ...t.small, fontWeight: '700', color: color.onInk },
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, marginBottom: space.sm, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', padding: space.md, gap: space.sm },
  cityName: { ...t.bodyStrong, color: color.ink, marginBottom: 4 },
  cardBody: { borderTopWidth: 1, borderTopColor: color.haze, padding: space.md, gap: space.sm },
  meta: { ...t.small, color: color.mute },
  btnRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap', marginTop: space.sm },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.ink, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  actionBtnText: { ...t.small, fontWeight: '700', color: '#fff' },
  dangerBtn: { backgroundColor: '#EF4444' },
  successBtn: { backgroundColor: '#10B981' },
  overrideCard: { backgroundColor: '#FEF3C7', borderRadius: radius.md, borderWidth: 1, borderColor: '#F59E0B', padding: space.md, marginBottom: space.md },
  overrideTitle: { ...t.bodyStrong, color: color.ink, marginBottom: space.sm },
  overrideInput: { backgroundColor: color.paper, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze, padding: space.sm, ...t.body, color: color.ink, height: 72, textAlignVertical: 'top', marginBottom: space.sm },
  overrideRow: { flexDirection: 'row', gap: space.sm },
  cancelBtn: { flex: 1, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze, padding: space.sm, alignItems: 'center' },
  cancelBtnText: { ...t.bodyStrong, color: color.ink },
  overrideBtn: { flex: 1, borderRadius: radius.sm, backgroundColor: '#EF4444', padding: space.sm, alignItems: 'center' },
  overrideBtnText: { ...t.bodyStrong, color: '#fff' },
});

const mtrStyles = StyleSheet.create({
  wrap: { marginTop: space.md, backgroundColor: color.paper, borderRadius: radius.sm, padding: space.md, gap: 6, borderWidth: 1, borderColor: color.haze },
  title: { ...t.bodyStrong, color: color.ink, marginBottom: 2 },
  section: { ...t.small, fontWeight: '700', color: color.mute, marginTop: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowLabel: { ...t.small, flex: 1 },
  stat: { ...t.small, color: color.ink },
  badge: { ...t.small, fontWeight: '700', marginTop: 8, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start' },
});

// ── Beta Access Manager ───────────────────────────────────────────────────────

function BetaManager() {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState('');
  const [city, setCity] = useState('');
  const [granting, setGranting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await apiFetch<{ betaAccess: any[] }>('/api/admin/rent-buddy/beta-access');
    setLoading(false);
    if (r.ok) setEntries(r.data.betaAccess);
  }, []);

  useEffect(() => { load(); }, [load]);

  const grant = async () => {
    if (!userId.trim() || !city.trim()) return;
    setGranting(true);
    await apiFetch('/api/admin/rent-buddy/beta-access', {
      method: 'POST',
      body: JSON.stringify({ userId: userId.trim(), city: city.trim(), accessType: 'invited' }),
    });
    setUserId(''); setCity('');
    setGranting(false);
    load();
  };

  const revoke = async (id: string) => {
    Alert.alert('Revoke beta access?', 'This user will immediately lose beta access.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke', style: 'destructive',
        onPress: async () => {
          await apiFetch(`/api/admin/rent-buddy/beta-access/${id}/revoke`, { method: 'POST', body: '{}' });
          load();
        },
      },
    ]);
  };

  if (loading) return <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} />;

  return (
    <View>
      <View style={betaStyles.form}>
        <Text style={betaStyles.formTitle}>Grant Beta Access</Text>
        <TextInput style={betaStyles.input} placeholder="User ID" placeholderTextColor={color.haze} value={userId} onChangeText={setUserId} />
        <TextInput style={betaStyles.input} placeholder="City" placeholderTextColor={color.haze} value={city} onChangeText={setCity} />
        <Pressable style={[betaStyles.grantBtn, (!userId.trim() || !city.trim()) && { opacity: 0.4 }]} onPress={grant} disabled={granting || !userId.trim() || !city.trim()}>
          <Text style={betaStyles.grantBtnText}>{granting ? 'Granting…' : 'Grant Access'}</Text>
        </Pressable>
      </View>

      {entries.map(e => (
        <View key={e.id} style={betaStyles.row}>
          <View style={{ flex: 1 }}>
            <Text style={betaStyles.rowUser} numberOfLines={1}>{e.user_id}</Text>
            <Text style={betaStyles.rowCity}>{e.city} · {e.access_type}</Text>
          </View>
          <View style={[betaStyles.statusDot, { backgroundColor: e.status === 'active' ? '#10B981' : '#EF4444' }]} />
          {e.status === 'active' && (
            <Pressable style={betaStyles.revokeBtn} onPress={() => revoke(e.id)}>
              <Text style={betaStyles.revokeBtnText}>Revoke</Text>
            </Pressable>
          )}
        </View>
      ))}
      {entries.length === 0 && (
        <Text style={{ ...t.body, color: color.mute, textAlign: 'center', marginTop: space.xl }}>No beta access grants yet.</Text>
      )}
    </View>
  );
}

const betaStyles = StyleSheet.create({
  form: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, marginBottom: space.md, gap: space.sm },
  formTitle: { ...t.bodyStrong, color: color.ink },
  input: { height: 40, backgroundColor: color.paper, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, ...t.body, color: color.ink },
  grantBtn: { backgroundColor: color.signal, borderRadius: radius.md, padding: space.sm, alignItems: 'center' },
  grantBtnText: { ...t.bodyStrong, color: color.onInk },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, backgroundColor: color.paperRaised, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze, marginBottom: space.sm },
  rowUser: { ...t.small, color: color.ink, fontFamily: 'Courier' },
  rowCity: { ...t.small, color: color.mute, marginTop: 2 },
  statusDot: { width: dot.s8, height: dot.s8, borderRadius: dot.s8 / 2 },
  revokeBtn: { backgroundColor: '#EF444415', borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 4, borderWidth: 1, borderColor: '#EF4444' },
  revokeBtnText: { ...t.small, fontWeight: '700', color: '#EF4444' },
});

// ── Global Controls Panel ─────────────────────────────────────────────────────

function GlobalControlsPanel() {
  const [controls, setControls] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Ref-based guard: prevents a second toggle (or a stacked Alert confirm)
  // from firing a duplicate PATCH while one is already in flight.
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await apiFetch<{ controls: any }>('/api/admin/rent-buddy/global-controls');
    setLoading(false);
    if (r.ok) setControls(r.data.controls);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (field: string, val: boolean) => {
    // Ignore the flip entirely while a save is already in flight.
    if (savingRef.current) return;
    const msg = val ? `Enable "${field.replace(/_/g, ' ')}"?` : `Disable "${field.replace(/_/g, ' ')}"?`;
    Alert.alert('Confirm', msg, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm',
        style: val ? 'destructive' : 'default',
        onPress: async () => {
          // Guard against two stacked alerts both confirming before the first
          // PATCH completes.
          if (savingRef.current) return;
          savingRef.current = true;
          setSaving(true);
          try {
            await apiFetch('/api/admin/rent-buddy/global-controls', { method: 'PATCH', body: JSON.stringify({ [field]: val }) });
          } finally {
            savingRef.current = false;
            setSaving(false);
          }
          load();
        },
      },
    ]);
  };

  if (loading || !controls) return <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} />;

  const CONTROLS = [
    { field: 'all_bookings_paused',   label: 'Pause ALL bookings',       desc: 'Blocks all new bookings globally. Existing confirmed bookings stay accessible.' },
    { field: 'applications_paused',   label: 'Pause Buddy applications',  desc: 'Prevents new Buddy applications globally.' },
    { field: 'cash_balance_paused',   label: 'Pause cash balance',        desc: 'Blocks deposit+cash payment mode globally.' },
    { field: 'nightlife_paused',      label: 'Pause nightlife category',  desc: 'Blocks nightlife bookings globally.' },
    { field: 'force_full_in_app',     label: 'Force full in-app payment', desc: 'All bookings must use full in-app payment.' },
    { field: 'force_public_meetup',   label: 'Force public meetup',       desc: 'All meetups must be at public locations.' },
    { field: 'force_delayed_posting', label: 'Force delayed posting',     desc: 'All location-tagged posts during bookings are delayed.' },
  ] as const;

  return (
    <View style={gcStyles.wrap}>
      {saving && <ActivityIndicator color={color.signal} style={{ marginBottom: space.sm }} />}
      {CONTROLS.map(c => (
        <View key={c.field} style={gcStyles.row}>
          <View style={{ flex: 1 }}>
            <Text style={gcStyles.label}>{c.label}</Text>
            <Text style={gcStyles.desc}>{c.desc}</Text>
          </View>
          <Switch
            value={!!controls[c.field]}
            onValueChange={(val) => toggle(c.field, val)}
            trackColor={{ true: '#EF4444', false: color.haze }}
            thumbColor="#fff"
            disabled={saving}
          />
        </View>
      ))}
    </View>
  );
}

const gcStyles = StyleSheet.create({
  wrap: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  label: { ...t.bodyStrong, color: color.ink },
  desc:  { ...t.small, color: color.mute, marginTop: 2, lineHeight: 16 },
});

// ── QA Checklist Panel ────────────────────────────────────────────────────────

function QAPanel() {
  const [checklists, setChecklists] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Cross-platform failure-reason prompt (Alert.prompt is iOS-only — a
  // silent no-op on Android/web).
  const [failTarget, setFailTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await apiFetch<{ checklists: any[] }>('/api/admin/rent-buddy/qa/checklists');
    setLoading(false);
    if (r.ok) setChecklists(r.data.checklists);
  }, []);

  useEffect(() => { load(); }, [load]);

  const markPassed = async (id: string) => {
    await apiFetch(`/api/admin/rent-buddy/qa/checklists/${id}/mark-passed`, { method: 'POST', body: '{}' });
    load();
  };

  const failInFlight = useRef(false);

  const markFailed = (id: string) => {
    if (failInFlight.current) return; // in-flight guard: don't reopen the prompt mid-request
    setFailTarget(id);
  };

  const submitFailure = async (reason: string) => {
    const id = failTarget;
    setFailTarget(null);
    if (!id || !reason || failInFlight.current) return;
    failInFlight.current = true;
    try {
      await apiFetch(`/api/admin/rent-buddy/qa/checklists/${id}/mark-failed`, { method: 'POST', body: JSON.stringify({ reason }) });
      load();
    } finally {
      failInFlight.current = false;
    }
  };

  if (loading) return <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} />;

  const ITEMS = [
    'policy_scan_passed', 'safety_flow_passed', 'booking_flow_passed', 'telegraph_passed',
    'trust_score_passed', 'payment_flow_passed', 'moderation_passed', 'waitlist_flow_passed', 'buddy_application_passed',
  ];

  return (
    <View>
      {checklists.map(cl => (
        <View key={cl.id} style={qaStyles.card}>
          <View style={qaStyles.header}>
            <Text style={qaStyles.cityId}>City Rollout: {cl.city_rollout_id?.slice(0, 8)}…</Text>
            <View style={[qaStyles.statusBadge, { backgroundColor: cl.checklist_status === 'passed' ? '#10B981' : cl.checklist_status === 'failed' ? '#EF4444' : '#F59E0B' }]}>
              <Text style={qaStyles.statusText}>{cl.checklist_status?.toUpperCase()}</Text>
            </View>
          </View>

          {ITEMS.map(item => (
            <View key={item} style={qaStyles.item}>
              {cl[item]
                ? <CheckCircle size={14} color="#10B981" />
                : <XCircle size={14} color={color.haze} />
              }
              <Text style={[qaStyles.itemLabel, cl[item] && { color: color.ink }]}>
                {item.replace(/_passed$/, '').replace(/_/g, ' ')}
              </Text>
            </View>
          ))}

          <View style={qaStyles.actionRow}>
            <Pressable style={[qaStyles.btn, { backgroundColor: '#10B981' }]} onPress={() => markPassed(cl.id)}>
              <CheckCircle size={13} color="#fff" />
              <Text style={qaStyles.btnText}>Mark All Passed</Text>
            </Pressable>
            <Pressable style={[qaStyles.btn, { backgroundColor: '#EF4444' }]} onPress={() => markFailed(cl.id)}>
              <XCircle size={13} color="#fff" />
              <Text style={qaStyles.btnText}>Mark Failed</Text>
            </Pressable>
          </View>
        </View>
      ))}
      {checklists.length === 0 && (
        <Text style={{ ...t.body, color: color.mute, textAlign: 'center', marginTop: space.xl }}>No QA checklists yet. Create city rollouts first.</Text>
      )}

      <ReasonPromptModal
        visible={failTarget != null}
        title="Mark Failed"
        message="Enter failure reason:"
        confirmLabel="Mark Failed"
        destructive
        onCancel={() => setFailTarget(null)}
        onSubmit={submitFailure}
      />
    </View>
  );
}

const qaStyles = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, marginBottom: space.md, gap: space.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm },
  cityId: { ...t.small, color: color.mute, fontFamily: 'Courier' },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  statusText: { fontSize: 9, fontWeight: '700', color: '#fff', fontFamily: 'Courier', letterSpacing: 1 },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  itemLabel: { ...t.small, color: color.mute, textTransform: 'capitalize' },
  actionRow: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, borderRadius: radius.sm, padding: space.sm },
  btnText: { ...t.small, fontWeight: '700', color: '#fff' },
});

// ── Audit Log ─────────────────────────────────────────────────────────────────

function AuditLogPanel() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await apiFetch<{ logs: any[] }>('/api/admin/rent-buddy/audit-log');
    setLoading(false);
    if (r.ok) setLogs(r.data.logs);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <ActivityIndicator color={color.signal} style={{ marginTop: space.xl }} />;

  return (
    <View>
      {logs.map(log => (
        <View key={log.id} style={auditStyles.row}>
          <View style={auditStyles.actionDot} />
          <View style={{ flex: 1 }}>
            <Text style={auditStyles.action}>{log.action.replace(/_/g, ' ')}</Text>
            {(log.from_status || log.to_status) && (
              <Text style={auditStyles.status}>{log.from_status} → {log.to_status}</Text>
            )}
            {log.override_reason && (
              <Text style={auditStyles.override}>Override: {log.override_reason}</Text>
            )}
            <Text style={auditStyles.ts}>{new Date(log.created_at).toLocaleString()}</Text>
          </View>
        </View>
      ))}
      {logs.length === 0 && (
        <Text style={{ ...t.body, color: color.mute, textAlign: 'center', marginTop: space.xl }}>No audit log entries yet.</Text>
      )}
    </View>
  );
}

const auditStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.sm, padding: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  actionDot: { width: dot.s8, height: dot.s8, borderRadius: dot.s8 / 2, backgroundColor: color.signal, marginTop: 4 },
  action: { ...t.small, fontWeight: '700', color: color.ink, textTransform: 'capitalize' },
  status: { ...t.small, color: color.mute, marginTop: 2 },
  override: { ...t.small, color: '#F59E0B', marginTop: 2 },
  ts: { fontSize: 10, color: color.haze, marginTop: 2, fontFamily: 'Courier' },
});

// ── Main Screen ───────────────────────────────────────────────────────────────

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: 'cities',   label: 'Cities',    icon: Globe },
  { key: 'beta',     label: 'Beta',      icon: Users },
  { key: 'qa',       label: 'QA',        icon: CheckCircle },
  { key: 'controls', label: 'Controls',  icon: Settings },
  { key: 'audit',    label: 'Audit',     icon: FileText },
];

import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

export default function AdminRolloutDashboard() {
  useRequireAdmin();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('cities');
  const [refreshing, setRefreshing] = useState(false);

  return (
    <View style={[s.page, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/admin/' as any)}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Shield size={18} color={color.signal} />
        <Text style={s.headerTitle}>Rollout Dashboard</Text>
      </View>

      {/* Tab bar */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabBar} contentContainerStyle={s.tabBarContent}>
        {TABS.map(tb => {
          const Icon = tb.icon;
          const active = tab === tb.key;
          return (
            <Pressable key={tb.key} style={[s.tabItem, active && s.tabItemActive]} onPress={() => setTab(tb.key)}>
              <Icon size={14} color={active ? color.signal : color.mute} />
              <Text style={[s.tabLabel, active && s.tabLabelActive]}>{tb.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Content */}
      <ScrollView
        style={s.content}
        contentContainerStyle={{ padding: space.lg, paddingBottom: 40 + insets.bottom }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); setRefreshing(false); }} />}
        showsVerticalScrollIndicator={false}
      >
        {tab === 'cities'   && <CityBoard />}
        {tab === 'beta'     && <BetaManager />}
        {tab === 'qa'       && <QAPanel />}
        {tab === 'controls' && <GlobalControlsPanel />}
        {tab === 'audit'    && <AuditLogPanel />}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md, paddingTop: space.sm, backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...t.heading, color: color.ink },
  tabBar: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: color.haze },
  tabBarContent: { paddingHorizontal: space.md },
  tabItem: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, paddingVertical: space.md, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabItemActive: { borderBottomColor: color.signal },
  tabLabel: { ...t.small, fontWeight: '600', color: color.mute },
  tabLabelActive: { color: color.signal },
  content: { flex: 1 },
});
