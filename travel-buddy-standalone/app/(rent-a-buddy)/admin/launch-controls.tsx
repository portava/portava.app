/**
 * Rent a Buddy — Admin launch controls editor (testing mode, lane tm-rab,
 * PLAT-F55).
 *
 * `rent_buddy_launch_controls` is the per country / city / category booking
 * policy enforceBookingCreationGates reads: whether bookings are open, whether
 * the location is waitlist-only, minimum ages, and whether a verified ID or
 * phone is required. The routes existed; the editor did not, so the policy was
 * API-only. It is DENY-BY-DEFAULT: once any control exists, a booking that no
 * enabled control covers is refused (`location_unavailable`). The screen says
 * so up front, because adding the first control closes every other location.
 *
 * Payment fields on the row (full_payment_required, min_deposit_pct) are not
 * edited here: no payment is taken through the app, and payment policy waits
 * on an owner decision.
 *
 * A failed read is an error with retry (the server now answers 5xx instead of
 * an empty list); every change is sent to the server and the list re-read —
 * nothing is shown as saved that the server did not confirm.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, Pressable, Alert, RefreshControl, Modal, TextInput, Switch, StyleSheet } from 'react-native';
import { Plus, Minus, Info } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { KeyboardSafeScrollView } from '../../../src/components/ui/KeyboardSafeView';
import {
  getLaunchControls, createLaunchControl, updateLaunchControl,
  type LaunchControl, type LaunchControlInput,
} from '../../../src/services/rentABuddyAdmin';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';
import { RabAdminScaffold, adminListState, adminCard as c } from '../../../src/components/rentabuddy/RabAdminScaffold';

type BoolField = 'enabled' | 'waitlistOnly' | 'requireIdVerification' | 'requirePhoneVerification';
const BOOL_FIELDS: ReadonlyArray<{ field: BoolField; col: keyof LaunchControl; label: string }> = [
  { field: 'enabled', col: 'enabled', label: 'Bookings open' },
  { field: 'waitlistOnly', col: 'waitlist_only', label: 'Waitlist only' },
  { field: 'requireIdVerification', col: 'require_id_verification', label: 'Require verified ID' },
  { field: 'requirePhoneVerification', col: 'require_phone_verification', label: 'Require verified phone' },
];

function keyLabel(lc: LaunchControl): string {
  const parts = [lc.country_code ?? 'any country', lc.city ?? 'any city', lc.category ?? 'any category'];
  return parts.join(' · ');
}

function NewControlSheet({ visible, onClose, onCreate }: {
  visible: boolean;
  onClose: () => void;
  onCreate: (input: LaunchControlInput) => void;
}) {
  const [countryCode, setCountryCode] = useState('');
  const [city, setCity] = useState('');
  const [category, setCategory] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [requireId, setRequireId] = useState(true);
  const [requirePhone, setRequirePhone] = useState(true);
  useEffect(() => {
    if (visible) { setCountryCode(''); setCity(''); setCategory(''); setEnabled(true); setRequireId(true); setRequirePhone(true); }
  }, [visible]);
  const hasKey = countryCode.trim() || city.trim() || category.trim();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardSafeScrollView>
        <View style={m.overlay}>
          <View style={m.sheet}>
            <Text style={m.title}>New launch control</Text>
            <Text style={m.sub}>A control applies to the country, city and category you give; leave one blank to mean "any".</Text>
            <TextInput style={m.input} value={countryCode} onChangeText={(v) => setCountryCode(v.toUpperCase().slice(0, 2))} placeholder="Country code (e.g. PT)" placeholderTextColor={color.mute} autoCapitalize="characters" testID="lc-country" />
            <TextInput style={m.input} value={city} onChangeText={setCity} placeholder="City (e.g. Lisbon)" placeholderTextColor={color.mute} testID="lc-city" />
            <TextInput style={m.input} value={category} onChangeText={setCategory} placeholder="Category (e.g. city, food, nightlife)" placeholderTextColor={color.mute} autoCapitalize="none" testID="lc-category" />
            <View style={m.switchRow}><Text style={m.label}>Bookings open</Text><Switch value={enabled} onValueChange={setEnabled} testID="lc-new-enabled" /></View>
            <View style={m.switchRow}><Text style={m.label}>Require verified ID</Text><Switch value={requireId} onValueChange={setRequireId} /></View>
            <View style={m.switchRow}><Text style={m.label}>Require verified phone</Text><Switch value={requirePhone} onValueChange={setRequirePhone} /></View>
            <View style={c.actions}>
              <Pressable style={[c.btn, { flex: 1 }]} onPress={onClose}><Text style={c.btnText}>Cancel</Text></Pressable>
              <Pressable
                style={[c.btn, c.btnPrimary, { flex: 1 }, !hasKey && { opacity: 0.4 }]}
                disabled={!hasKey}
                testID="lc-create"
                onPress={() => onCreate({
                  countryCode: countryCode.trim() || null,
                  city: city.trim() || null,
                  category: category.trim() || null,
                  enabled,
                  requireIdVerification: requireId,
                  requirePhoneVerification: requirePhone,
                })}
              >
                <Text style={c.btnTextPrimary}>Create</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

export default function AdminLaunchControls() {
  useRequireAdmin();
  const [rows, setRows] = useState<LaunchControl[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const lock = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const res = await getLaunchControls();
    if (!silent) setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setRows(res.data);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const patch = useCallback(async (lc: LaunchControl, change: Partial<LaunchControlInput>) => {
    if (lock.current) return;
    lock.current = true;
    setSaving(lc.id);
    try {
      const r = await updateLaunchControl(lc.id, change);
      if (!r.ok) { Alert.alert("That didn't save", bookingErrorCopy(r.error, 'Please try again.')); return; }
      await load(true);
    } finally {
      lock.current = false;
      setSaving(null);
    }
  }, [load]);

  const create = useCallback(async (input: LaunchControlInput) => {
    setCreating(false);
    const r = await createLaunchControl(input);
    if (!r.ok) { Alert.alert("Couldn't create the control", bookingErrorCopy(r.error, 'Please try again.')); return; }
    await load(true);
  }, [load]);

  const confirmCreate = (input: LaunchControlInput) => {
    if (rows.length === 0) {
      Alert.alert(
        'Create the first launch control?',
        'Launch controls are deny-by-default: once this exists, bookings in every location it does not cover are refused until you add controls for them.',
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Create', onPress: () => { void create(input); } }],
      );
      return;
    }
    void create(input);
  };

  const state = adminListState({
    loading, error, count: rows.length, onRetry: () => { void load(); },
    loadingLabel: 'Loading launch controls…',
    emptyTitle: 'No launch controls yet',
    emptySub: 'With none configured, launch controls refuse nothing — the city rollout and the other gates still apply. Adding the first control makes this deny-by-default.',
  });

  return (
    <RabAdminScaffold title="Launch controls" subtitle="Per-location booking policy (rent_buddy_launch_controls)">
      <View style={s.notice}>
        <Info size={14} color={color.deep} />
        <Text style={s.noticeText}>
          Deny-by-default: when any control exists, a booking no enabled control covers is refused. Age and ID/phone rules apply only where a control matches.
        </Text>
      </View>
      <View style={s.toolbar}>
        <Pressable style={[c.btn, c.btnPrimary]} onPress={() => setCreating(true)} testID="lc-new">
          <Plus size={15} color={color.onInk} />
          <Text style={c.btnTextPrimary}>New control</Text>
        </Pressable>
      </View>
      {state ?? (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={c.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(true); setRefreshing(false); }} />}
          renderItem={({ item }) => {
            const busy = saving === item.id;
            return (
              <View style={[c.card, busy && { opacity: 0.6 }]} testID={`lc-${item.id}`}>
                <Text style={c.title}>{keyLabel(item)}</Text>
                {BOOL_FIELDS.map(({ field, col, label }) => (
                  <View key={field} style={s.switchRow}>
                    <Text style={s.label}>{label}</Text>
                    <Switch
                      value={Boolean(item[col])}
                      disabled={busy}
                      onValueChange={(v) => { void patch(item, { [field]: v }); }}
                      testID={`lc-${item.id}-${field}`}
                    />
                  </View>
                ))}
                {([['minAge', 'min_age', 'Minimum age'], ['nightlifeMinAge', 'nightlife_min_age', 'Nightlife minimum age']] as const).map(([field, col, label]) => (
                  <View key={field} style={s.switchRow}>
                    <Text style={s.label}>{label}</Text>
                    <View style={c.row}>
                      <Pressable style={c.btn} disabled={busy || item[col] <= 18} onPress={() => { void patch(item, { [field]: item[col] - 1 }); }} testID={`lc-${item.id}-${field}-down`}>
                        <Minus size={14} color={color.ink} />
                      </Pressable>
                      <Text style={s.age}>{item[col]}</Text>
                      <Pressable style={c.btn} disabled={busy} onPress={() => { void patch(item, { [field]: item[col] + 1 }); }} testID={`lc-${item.id}-${field}-up`}>
                        <Plus size={14} color={color.ink} />
                      </Pressable>
                    </View>
                  </View>
                ))}
                {item.notes ? <Text style={c.meta}>Notes: {item.notes}</Text> : null}
                <Text style={c.meta}>Updated {new Date(item.updated_at).toLocaleString()}</Text>
              </View>
            );
          }}
        />
      )}
      <NewControlSheet visible={creating} onClose={() => setCreating(false)} onCreate={confirmCreate} />
    </RabAdminScaffold>
  );
}

const s = StyleSheet.create({
  notice: { flexDirection: 'row', gap: space.sm, marginHorizontal: space.lg, marginTop: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  noticeText: { ...t.small, color: color.ink, flex: 1 },
  toolbar: { flexDirection: 'row', paddingHorizontal: space.lg, paddingTop: space.md },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 2 },
  label: { ...t.body, color: color.ink },
  age: { ...t.bodyStrong, color: color.ink, minWidth: 28, textAlign: 'center' },
});

const m = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: color.paper, padding: space.lg, gap: space.md, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  title: { ...t.title, color: color.ink },
  sub: { ...t.small, color: color.mute },
  input: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, color: color.ink },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { ...t.body, color: color.ink },
});
