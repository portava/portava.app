import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, Pressable, Alert, Modal,
  TextInput, ScrollView, Switch,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Plus, Edit2, Trash2, X, Save, Minus } from 'lucide-react-native';
import {
  TravelButton, TravelCard, TravelChip, TravelLoadingState,
  TravelErrorState, TravelEmptyState,
} from '../../../src/components/primitives';
import { Stamp } from '../../../src/components/ui';
import { KeyboardSafeView } from '../../../src/components/ui/KeyboardSafeView';
import { color, space, radius, type as t, avatar } from '../../../src/theme/tokens';
import * as rentABuddy from '../../../src/services/rentABuddy';
import type { BuddyPackage, BuddyCategory } from '../../../src/services/rentABuddy';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'arrival', label: 'Arrival Support' },
  { value: 'city', label: 'City Tour' },
  { value: 'nightlife', label: 'Nightlife' },
  { value: 'food', label: 'Food & Markets' },
  { value: 'content', label: 'Content & Photo' },
  { value: 'nature', label: 'Nature & Adventure' },
  { value: 'culture', label: 'Culture & Arts' },
  { value: 'shopping', label: 'Shopping' },
];

interface PackageForm {
  title: string;
  description: string;
  category: string;
  durationH: number;
  priceUsd: number;
  maxGroup: number;
  stops: string[];
  meetupRules: string;
  isActive: boolean;
}

function emptyForm(): PackageForm {
  return {
    title: '',
    description: '',
    category: 'city',
    durationH: 2,
    priceUsd: 0,
    maxGroup: 4,
    stops: [''],
    meetupRules: '',
    isActive: true,
  };
}

function EditSheet({
  pkg,
  onClose,
  onSave,
}: {
  pkg: PackageForm;
  onClose: () => void;
  onSave: (form: PackageForm) => void;
}) {
  const [form, setForm] = useState<PackageForm>(pkg);
  const insets = useSafeAreaInsets();

  function update(patch: Partial<PackageForm>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  function canSave() {
    return form.title.trim().length > 0 && form.priceUsd > 0 && form.durationH > 0;
  }

  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} visible>
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={[sh.header, { paddingTop: insets.top + space.md }]}>
          <Text style={sh.title}>Package details</Text>
          <Pressable onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <X size={20} color={color.mute} />
          </Pressable>
        </View>
        <KeyboardSafeView
          offset={insets.top}
          contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + 120 }}
        >
          {/* Title */}
          <FieldLabel label="Package title" />
          <TextInput style={[fi.input, { marginBottom: space.lg }]} value={form.title} onChangeText={(v) => update({ title: v })} placeholder="e.g. Bangkok Night Market Tour" placeholderTextColor={color.haze} />

          {/* Description */}
          <FieldLabel label="Description" optional />
          <TextInput style={[fi.input, fi.multi, { marginBottom: space.lg }]} value={form.description} onChangeText={(v) => update({ description: v })} placeholder="What's special about this package?" placeholderTextColor={color.haze} multiline />

          {/* Category */}
          <FieldLabel label="Category" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: space.lg }}>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              {CATEGORIES.map((c) => (
                <TravelChip key={c.value} label={c.label} active={form.category === c.value} onPress={() => update({ category: c.value })} />
              ))}
            </View>
          </ScrollView>

          {/* Duration + Price */}
          <View style={{ flexDirection: 'row', gap: space.sm, marginBottom: space.lg }}>
            <View style={{ flex: 1 }}>
              <FieldLabel label="Duration (hours)" />
              <View style={num.row}>
                <Pressable style={num.btn} onPress={() => update({ durationH: Math.max(0.5, form.durationH - 0.5) })}>
                  <Minus size={14} color={color.ink} />
                </Pressable>
                <Text style={num.val}>{form.durationH}h</Text>
                <Pressable style={num.btn} onPress={() => update({ durationH: Math.min(24, form.durationH + 0.5) })}>
                  <Plus size={14} color={color.ink} />
                </Pressable>
              </View>
            </View>
            <View style={{ flex: 1 }}>
              <FieldLabel label="Price (USD)" />
              <TextInput
                style={fi.input}
                value={form.priceUsd > 0 ? String(form.priceUsd) : ''}
                onChangeText={(v) => update({ priceUsd: parseFloat(v) || 0 })}
                placeholder="e.g. 60"
                placeholderTextColor={color.haze}
                keyboardType="numeric"
              />
            </View>
          </View>

          {/* Max group */}
          <FieldLabel label="Max group size" />
          <View style={[num.row, { marginBottom: space.lg, alignSelf: 'flex-start' }]}>
            <Pressable style={num.btn} onPress={() => update({ maxGroup: Math.max(1, form.maxGroup - 1) })}>
              <Minus size={14} color={color.ink} />
            </Pressable>
            <Text style={num.val}>{form.maxGroup}</Text>
            <Pressable style={num.btn} onPress={() => update({ maxGroup: Math.min(20, form.maxGroup + 1) })}>
              <Plus size={14} color={color.ink} />
            </Pressable>
          </View>

          {/* Stops */}
          <FieldLabel label="Included stops" optional />
          {form.stops.map((stop, i) => (
            <View key={i} style={stop_.row}>
              <TextInput
                style={[fi.input, { flex: 1 }]}
                value={stop}
                onChangeText={(v) => {
                  const next = [...form.stops];
                  next[i] = v;
                  update({ stops: next });
                }}
                placeholder={`Stop ${i + 1}`}
                placeholderTextColor={color.haze}
              />
              {form.stops.length > 1 && (
                <Pressable onPress={() => update({ stops: form.stops.filter((_, j) => j !== i) })} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <X size={14} color={color.mute} />
                </Pressable>
              )}
            </View>
          ))}
          <Pressable style={addBtn.row} onPress={() => update({ stops: [...form.stops, ''] })}>
            <Plus size={13} color={color.signal} />
            <Text style={addBtn.text}>Add stop</Text>
          </Pressable>

          {/* Meetup rules */}
          <FieldLabel label="Meetup rules" optional />
          <TextInput style={[fi.input, fi.multi, { marginBottom: space.lg }]} value={form.meetupRules} onChangeText={(v) => update({ meetupRules: v })} placeholder="e.g. Meet at BTS Asok exit 3. I'll hold a sign." placeholderTextColor={color.haze} multiline />

          {/* Active */}
          <View style={sh.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={sh.toggleLabel}>Active</Text>
              <Text style={sh.toggleSub}>Travellers can see and book this package</Text>
            </View>
            <Switch value={form.isActive} onValueChange={(v) => update({ isActive: v })} trackColor={{ false: color.haze, true: color.success }} thumbColor={color.onInk} />
          </View>
        </KeyboardSafeView>

        <View style={[sh.footer, { paddingBottom: insets.bottom + space.md }]}>
          <TravelButton
            label="Save package"
            onPress={() => onSave(form)}
            variant={canSave() ? 'primary' : 'ghost'}
            full
            icon={<Save size={14} color={canSave() ? color.onInk : color.mute} />}
          />
        </View>
      </View>
    </Modal>
  );
}

function PackageCard({
  pkg,
  onEdit,
  onDelete,
}: {
  pkg: BuddyPackage;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <TravelCard style={{ padding: space.lg }}>
      <View style={pc.row}>
        <View style={{ flex: 1 }}>
          <Text style={pc.title}>{pkg.title}</Text>
          <Text style={pc.meta}>{pkg.category} · {pkg.durationH}h · up to {pkg.maxGroup} pax</Text>
        </View>
        <Text style={pc.price}>${pkg.priceUsd}</Text>
      </View>
      {pkg.description ? <Text style={pc.desc} numberOfLines={2}>{pkg.description}</Text> : null}
      <View style={pc.footer}>
        <View style={[pc.status, { backgroundColor: pkg.isActive ? '#E6F4ED' : color.haze }]}>
          <Text style={[pc.statusText, { color: pkg.isActive ? color.success : color.mute }]}>
            {pkg.isActive ? 'ACTIVE' : 'INACTIVE'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <Pressable style={pc.actionBtn} onPress={onEdit} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Edit2 size={15} color={color.deep} />
          </Pressable>
          <Pressable style={pc.actionBtn} onPress={onDelete} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Trash2 size={15} color={color.signal} />
          </Pressable>
        </View>
      </View>
    </TravelCard>
  );
}

export default function BuddyPackages() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [packages, setPackages] = useState<BuddyPackage[]>([]);
  const [editing, setEditing] = useState<{ pkg: BuddyPackage | null; form: PackageForm } | null>(null);
  const saveLockRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await rentABuddy.getDashboardPackages();
    setLoading(false);
    if (res.ok) setPackages(res.data.packages);
    else setError(res.error);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave(form: PackageForm) {
    if (!editing) return;
    if (saveLockRef.current) return;
    saveLockRef.current = true;
    const payload = {
      title: form.title,
      description: form.description || null,
      category: form.category,
      durationH: form.durationH,
      priceUsd: form.priceUsd,
      maxGroup: form.maxGroup,
      isActive: form.isActive,
      stops: form.stops.map((s) => s.trim()).filter(Boolean),
      meetupRules: form.meetupRules.trim() || null,
    };
    try {
      if (editing.pkg) {
        const res = await rentABuddy.updatePackage(editing.pkg.id, payload);
        if (!res.ok) { Alert.alert('Error', bookingErrorCopy(res.error)); return; }
        setPackages((prev) => prev.map((p) => p.id === editing.pkg!.id ? { ...p, ...payload } : p));
      } else {
        const res = await rentABuddy.createPackage(payload as any);
        if (!res.ok) { Alert.alert('Error', bookingErrorCopy(res.error)); return; }
        if (!res.data.pkg) { Alert.alert('Error', 'Could not create package'); return; }
        setPackages((prev) => [...prev, res.data.pkg!]);
      }
      setEditing(null);
    } finally {
      saveLockRef.current = false;
    }
  }

  async function handleDelete(id: string) {
    Alert.alert('Delete package?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          const res = await rentABuddy.deletePackage(id);
          if (res.ok) setPackages((prev) => prev.filter((p) => p.id !== id));
          else Alert.alert('Error', bookingErrorCopy(res.error));
        },
      },
    ]);
  }

  if (loading) return <TravelLoadingState label="Loading packages…" />;
  if (error) return <TravelErrorState title="Couldn't load packages" sub={error} onRetry={load} />;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Pressable onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <ArrowLeft size={20} color={color.onInk} />
        </Pressable>
        <Text style={s.headerTitle}>Packages</Text>
        <Pressable style={s.addBtn} onPress={() => setEditing({ pkg: null, form: emptyForm() })}>
          <Plus size={18} color={color.onInk} />
        </Pressable>
      </View>

      <FlatList
        data={packages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <PackageCard
            pkg={item}
            onEdit={() => setEditing({
              pkg: item,
              form: {
                title: item.title,
                description: item.description ?? '',
                category: item.category,
                durationH: item.durationH,
                priceUsd: item.priceUsd,
                maxGroup: item.maxGroup,
                stops: item.stops?.length ? item.stops : [''],
                meetupRules: item.meetupRules ?? '',
                isActive: item.isActive,
              },
            })}
            onDelete={() => handleDelete(item.id)}
          />
        )}
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + 48, gap: space.md }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <TravelEmptyState
            title="No packages yet"
            sub="Create your first package to let travellers book a fixed experience."
            action="Add package"
            onAction={() => setEditing({ pkg: null, form: emptyForm() })}
          />
        }
      />

      {editing && (
        <EditSheet pkg={editing.form} onClose={() => setEditing(null)} onSave={handleSave} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    backgroundColor: color.ink, flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.lg,
  },
  headerTitle: { ...t.heading, color: color.onInk, flex: 1 },
  addBtn: {
    width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2,
    backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center',
  },
});

const pc = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, marginBottom: space.xs },
  title: { ...t.bodyStrong, color: color.ink },
  meta: { ...t.small, color: color.mute, marginTop: 2 },
  price: { ...t.heading, color: color.success },
  desc: { ...t.small, color: color.mute, lineHeight: 17, marginBottom: space.sm },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm },
  status: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill },
  statusText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  actionBtn: { padding: 4 },
});

const sh = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingBottom: space.lg,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  title: { ...t.heading, color: color.ink },
  footer: {
    paddingHorizontal: space.lg, paddingTop: space.md,
    borderTopWidth: 1, borderTopColor: color.haze, backgroundColor: color.paper,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  toggleLabel: { ...t.bodyStrong, color: color.ink },
  toggleSub: { ...t.small, color: color.mute, marginTop: 2 },
});

const fi = StyleSheet.create({
  input: {
    borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.md,
    ...t.body, color: color.ink, backgroundColor: color.paperRaised,
  },
  multi: { height: 90, textAlignVertical: 'top' },
});

const num = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  btn: {
    width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, borderWidth: 1.5, borderColor: color.haze,
    alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised,
  },
  val: { ...t.heading, color: color.ink, minWidth: 48, textAlign: 'center', fontSize: 18 },
});

const stop_ = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
});

const addBtn = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.lg },
  text: { ...t.small, color: color.signal, fontWeight: '700' },
});

function FieldLabel({ label, optional }: { label: string; optional?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.xs }}>
      <Text style={{ ...t.bodyStrong, color: color.ink, fontSize: 13 }}>{label}</Text>
      {optional && <Text style={{ ...t.small, color: color.haze }}>(optional)</Text>}
    </View>
  );
}
