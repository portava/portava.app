import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, Pressable, Alert, Modal,
  TextInput, Switch, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Plus, Edit2, Trash2, X, Save } from 'lucide-react-native';
import {
  TravelButton, TravelCard, TravelLoadingState,
  TravelErrorState, TravelEmptyState,
} from '../../../src/components/primitives';
import { KeyboardSafeView } from '../../../src/components/ui/KeyboardSafeView';
import { color, space, radius, type as t, avatar } from '../../../src/theme/tokens';
import * as rentABuddy from '../../../src/services/rentABuddy';
import type { BuddyAddon } from '../../../src/services/rentABuddy';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

const PRESET_ADDONS: Array<{ title: string; description: string; defaultPrice: number }> = [
  { title: 'Extra Hour', description: 'Extend the booking by one additional hour', defaultPrice: 25 },
  { title: 'Photo Package', description: 'Dedicated photo stops and guided photography', defaultPrice: 20 },
  { title: 'Translation Support', description: 'Real-time translation at restaurants, shops, and venues', defaultPrice: 15 },
  { title: 'Reservation Help', description: 'Restaurant or venue reservations made on your behalf', defaultPrice: 10 },
  { title: 'Arrival Setup', description: 'SIM card, transport card, and local cash exchange', defaultPrice: 15 },
  { title: 'Custom Itinerary', description: 'Personalised itinerary prepared before your arrival', defaultPrice: 30 },
  { title: 'Group Upgrade', description: 'Accommodate an additional 2 people beyond the standard group', defaultPrice: 35 },
];

interface AddonForm {
  title: string;
  description: string;
  priceUsd: number;
  isActive: boolean;
  isCustom: boolean;
}

function emptyForm(): AddonForm {
  return { title: '', description: '', priceUsd: 0, isActive: true, isCustom: false };
}

function EditSheet({
  form: initial,
  onClose,
  onSave,
}: {
  form: AddonForm;
  onClose: () => void;
  onSave: (f: AddonForm) => void;
}) {
  const [form, setForm] = useState<AddonForm>(initial);
  const insets = useSafeAreaInsets();
  function update(patch: Partial<AddonForm>) { setForm((f) => ({ ...f, ...patch })); }
  function canSave() { return form.title.trim().length > 0 && form.priceUsd > 0; }

  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} visible>
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={[sh.header, { paddingTop: insets.top + space.md }]}>
          <Text style={sh.title}>Add-on details</Text>
          <Pressable onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <X size={20} color={color.mute} />
          </Pressable>
        </View>
        <KeyboardSafeView
          offset={insets.top}
          contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + 120 }}
        >
          {/* Preset picker (only for new items) */}
          {!form.isCustom && (
            <View style={{ marginBottom: space.xl }}>
              <Text style={sh.presetLabel}>Pick a preset</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  {PRESET_ADDONS.map((p) => (
                    <Pressable
                      key={p.title}
                      style={[preset.card, form.title === p.title && preset.cardActive]}
                      onPress={() => update({ title: p.title, description: p.description, priceUsd: p.defaultPrice })}
                    >
                      <Text style={[preset.text, form.title === p.title && preset.textActive]}>{p.title}</Text>
                      <Text style={preset.price}>${p.defaultPrice}</Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
              <Pressable style={addBtn.row} onPress={() => update({ isCustom: true, title: '', description: '' })}>
                <Plus size={13} color={color.signal} />
                <Text style={addBtn.text}>Create custom add-on</Text>
              </Pressable>
            </View>
          )}

          {/* Title */}
          <Text style={sh.fieldLabel}>Title</Text>
          <TextInput
            style={[fi.input, { marginBottom: space.lg }]}
            value={form.title}
            onChangeText={(v) => update({ title: v })}
            placeholder="e.g. VIP Club Access"
            placeholderTextColor={color.haze}
          />

          {/* Description */}
          <Text style={sh.fieldLabel}>Description <Text style={{ color: color.haze, fontWeight: '400' }}>(optional)</Text></Text>
          <TextInput
            style={[fi.input, fi.multi, { marginBottom: space.lg }]}
            value={form.description}
            onChangeText={(v) => update({ description: v })}
            placeholder="What does this add-on include?"
            placeholderTextColor={color.haze}
            multiline
          />

          {/* Price */}
          <Text style={sh.fieldLabel}>Price (USD)</Text>
          <TextInput
            style={[fi.input, { marginBottom: space.lg }]}
            value={form.priceUsd > 0 ? String(form.priceUsd) : ''}
            onChangeText={(v) => update({ priceUsd: parseFloat(v) || 0 })}
            placeholder="e.g. 20"
            placeholderTextColor={color.haze}
            keyboardType="numeric"
          />

          {/* Active */}
          <View style={sh.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={sh.toggleLabel}>Active</Text>
              <Text style={sh.toggleSub}>Travellers can add this to their booking</Text>
            </View>
            <Switch
              value={form.isActive}
              onValueChange={(v) => update({ isActive: v })}
              trackColor={{ false: color.haze, true: color.success }}
              thumbColor={color.onInk}
            />
          </View>
        </KeyboardSafeView>
        <View style={[sh.footer, { paddingBottom: insets.bottom + space.md }]}>
          <TravelButton
            label="Save add-on"
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

function AddonCard({ addon, onEdit, onDelete }: { addon: BuddyAddon; onEdit: () => void; onDelete: () => void }) {
  return (
    <TravelCard style={{ padding: space.lg }}>
      <View style={ac.row}>
        <View style={{ flex: 1 }}>
          <Text style={ac.title}>{addon.title}</Text>
          {addon.description ? <Text style={ac.desc}>{addon.description}</Text> : null}
        </View>
        <Text style={ac.price}>${addon.priceUsd}</Text>
      </View>
      <View style={ac.footer}>
        <View style={[ac.status, { backgroundColor: addon.isActive ? '#E6F4ED' : color.haze }]}>
          <Text style={[ac.statusText, { color: addon.isActive ? color.success : color.mute }]}>
            {addon.isActive ? 'ACTIVE' : 'INACTIVE'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <Pressable onPress={onEdit} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Edit2 size={15} color={color.deep} />
          </Pressable>
          <Pressable onPress={onDelete} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Trash2 size={15} color={color.signal} />
          </Pressable>
        </View>
      </View>
    </TravelCard>
  );
}

export default function BuddyAddons() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addons, setAddons] = useState<BuddyAddon[]>([]);
  const [editing, setEditing] = useState<{ addon: BuddyAddon | null; form: AddonForm } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await rentABuddy.getDashboardAddons();
    setLoading(false);
    if (res.ok) setAddons(res.data.addons);
    else setError(res.error);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave(form: AddonForm) {
    if (!editing) return;
    const payload = { title: form.title, description: form.description || null, priceUsd: form.priceUsd, isActive: form.isActive };
    if (editing.addon) {
      const res = await rentABuddy.updateAddon(editing.addon.id, payload);
      if (!res.ok) { Alert.alert('Error', bookingErrorCopy(res.error)); return; }
      setAddons((prev) => prev.map((a) => a.id === editing.addon!.id ? { ...a, ...payload } : a));
    } else {
      const res = await rentABuddy.createAddon({ title: form.title, description: form.description || null, priceUsd: form.priceUsd });
      if (!res.ok) { Alert.alert('Error', bookingErrorCopy(res.error)); return; }
      if (!res.data.addon) { Alert.alert('Error', 'Could not create add-on'); return; }
      setAddons((prev) => [...prev, res.data.addon!]);
    }
    setEditing(null);
  }

  async function handleDelete(id: string) {
    Alert.alert('Delete add-on?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          const res = await rentABuddy.deleteAddon(id);
          if (res.ok) setAddons((prev) => prev.filter((a) => a.id !== id));
          else Alert.alert('Error', bookingErrorCopy(res.error));
        },
      },
    ]);
  }

  if (loading) return <TravelLoadingState label="Loading add-ons…" />;
  if (error) return <TravelErrorState title="Couldn't load add-ons" sub={error} onRetry={load} />;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Pressable onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <ArrowLeft size={20} color={color.onInk} />
        </Pressable>
        <Text style={s.headerTitle}>Add-ons</Text>
        <Pressable style={s.addBtn} onPress={() => setEditing({ addon: null, form: emptyForm() })}>
          <Plus size={18} color={color.onInk} />
        </Pressable>
      </View>

      <FlatList
        data={addons}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <AddonCard
            addon={item}
            onEdit={() => setEditing({
              addon: item,
              form: {
                title: item.title,
                description: item.description ?? '',
                priceUsd: item.priceUsd,
                isActive: item.isActive,
                isCustom: true,
              },
            })}
            onDelete={() => handleDelete(item.id)}
          />
        )}
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + 48, gap: space.md }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <TravelEmptyState
            title="No add-ons yet"
            sub="Add extras that travellers can include in any booking — like extra hours or a photo package."
            action="Add first add-on"
            onAction={() => setEditing({ addon: null, form: emptyForm() })}
          />
        }
      />

      {editing && (
        <EditSheet form={editing.form} onClose={() => setEditing(null)} onSave={handleSave} />
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

const ac = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, marginBottom: space.xs },
  title: { ...t.bodyStrong, color: color.ink },
  desc: { ...t.small, color: color.mute, marginTop: 2, lineHeight: 17 },
  price: { ...t.heading, color: color.success, fontSize: 18 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm },
  status: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill },
  statusText: { fontFamily: 'Courier', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
});

const sh = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingBottom: space.lg,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  title: { ...t.heading, color: color.ink },
  presetLabel: { ...t.bodyStrong, color: color.ink, marginBottom: space.sm },
  fieldLabel: { ...t.bodyStrong, color: color.ink, fontSize: 13, marginBottom: space.xs },
  footer: {
    paddingHorizontal: space.lg, paddingTop: space.md,
    borderTopWidth: 1, borderTopColor: color.haze, backgroundColor: color.paper,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  toggleLabel: { ...t.bodyStrong, color: color.ink },
  toggleSub: { ...t.small, color: color.mute, marginTop: 2 },
});

const preset = StyleSheet.create({
  card: {
    padding: space.md, borderRadius: radius.md, borderWidth: 1.5,
    borderColor: color.haze, backgroundColor: color.paperRaised,
    minWidth: 130, gap: 4,
  },
  cardActive: { borderColor: color.signal, backgroundColor: '#FFF3F0' },
  text: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  textActive: { color: color.signal },
  price: { ...t.small, color: color.mute },
});

const fi = StyleSheet.create({
  input: {
    borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.md,
    ...t.body, color: color.ink, backgroundColor: color.paperRaised,
  },
  multi: { height: 80, textAlignVertical: 'top' },
});

const addBtn = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.md },
  text: { ...t.small, color: color.signal, fontWeight: '700' },
});
