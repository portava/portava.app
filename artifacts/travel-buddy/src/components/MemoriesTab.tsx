import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, Image, ScrollView,
  ActivityIndicator, Modal, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { MapPin, Lock, Globe, Users, Eye, EyeOff, Plus, X } from 'lucide-react-native';
import type { PassportMemory, MemoryVisibility } from '../services/passportStamps';
import {
  createPassportMemory,
  updatePassportMemory,
} from '../services/passportStamps';
import { SaveButton } from './SaveButton';
import { color, space, radius, type as t } from '../theme/tokens';

const CATEGORIES = [
  { key: 'city', label: '🏙 City' },
  { key: 'plan', label: '📅 Plan' },
  { key: 'food', label: '🍜 Food' },
  { key: 'adventure', label: '🧗 Adventure' },
  { key: 'culture', label: '🏛 Culture' },
  { key: 'hidden_gem', label: '💎 Gem' },
  { key: 'safe_return', label: '🛡 Safe Return' },
];

function verificationBadge(level: string): string {
  if (level === 'gps') return '📍';
  if (level === 'checkin') return '✅';
  if (level === 'safe_return') return '🛡';
  if (level === 'crew') return '👥';
  if (level === 'admin') return '⭐';
  return '';
}

function visibilityIcon(vis: MemoryVisibility) {
  if (vis === 'public') return <Globe size={12} color={color.success} />;
  if (vis === 'circle_only') return <Users size={12} color={color.signal} />;
  if (vis === 'trip_crew') return <Eye size={12} color={color.signal} />;
  return <Lock size={12} color={color.mute} />;
}

function visibilityLabel(vis: MemoryVisibility): string {
  if (vis === 'public') return 'Public';
  if (vis === 'circle_only') return 'Circle';
  if (vis === 'trip_crew') return 'Crew';
  return 'Private';
}

// ── Memory Card ───────────────────────────────────────────────────────────────

interface MemoryCardProps {
  memory: PassportMemory;
  onVisibilityChange: (id: string, v: MemoryVisibility) => void;
}

function MemoryCard({ memory, onVisibilityChange }: MemoryCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const badge = verificationBadge(memory.verificationLevel);
  const cat = CATEGORIES.find((c) => c.key === memory.category);

  return (
    <View style={mc.card}>
      {memory.photoUrl && (
        <Image source={{ uri: memory.photoUrl }} style={mc.photo} />
      )}
      <View style={mc.body}>
        <View style={mc.row}>
          {cat && <Text style={mc.catLabel}>{cat.label}</Text>}
          {badge ? <Text style={mc.badge}>{badge}</Text> : null}
        </View>
        <Text style={mc.title} numberOfLines={2}>{memory.title ?? 'Untitled memory'}</Text>
        {(memory.city || memory.country) && (
          <View style={mc.locationRow}>
            <MapPin size={12} color={color.mute} />
            <Text style={mc.locationText}>
              {[memory.city, memory.country].filter(Boolean).join(', ')}
            </Text>
          </View>
        )}
        {memory.description ? (
          <Text style={mc.desc} numberOfLines={2}>{memory.description}</Text>
        ) : null}
        <View style={mc.footer}>
          <Text style={mc.date}>
            {new Date(memory.earnedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
          </Text>
          <Pressable style={mc.visBadge} onPress={() => setMenuOpen(true)}>
            {visibilityIcon(memory.visibility)}
            <Text style={mc.visText}>{visibilityLabel(memory.visibility)}</Text>
          </Pressable>
          <SaveButton entityType="memory" entityId={memory.id} size={14} />
        </View>
      </View>

      {/* Visibility picker */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={mc.overlay} onPress={() => setMenuOpen(false)}>
          <View style={mc.menuBox}>
            <Text style={mc.menuTitle}>Memory visibility</Text>
            {(['public', 'circle_only', 'trip_crew', 'private'] as MemoryVisibility[]).map((v) => (
              <Pressable
                key={v}
                style={[mc.menuItem, memory.visibility === v && mc.menuItemActive]}
                onPress={() => { onVisibilityChange(memory.id, v); setMenuOpen(false); }}
              >
                {visibilityIcon(v)}
                <Text style={mc.menuItemText}>{visibilityLabel(v)}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

// ── Create Memory Modal ───────────────────────────────────────────────────────

interface CreateModalProps {
  visible: boolean;
  onClose: () => void;
  onCreated: (memory: PassportMemory) => void;
}

function CreateMemoryModal({ visible, onClose, onCreated }: CreateModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [category, setCategory] = useState('city');
  const [visibility, setVisibility] = useState<MemoryVisibility>('private');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!title.trim()) { setError('Title is required'); return; }
    setSaving(true);
    setError('');
    const res = await createPassportMemory({
      title: title.trim(),
      description: description.trim() || undefined,
      city: city.trim() || undefined,
      country: country.trim() || undefined,
      category,
      visibility,
    });
    setSaving(false);
    if (!res.ok) { setError(res.message); return; }
    onCreated(res.data);
    setTitle(''); setDescription(''); setCity(''); setCountry('');
    setCategory('city'); setVisibility('private');
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={cm.header}>
          <Text style={cm.title}>New Memory</Text>
          <Pressable onPress={onClose} hitSlop={8}><X size={22} color={color.ink} /></Pressable>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={cm.body} keyboardShouldPersistTaps="handled">
          <Text style={cm.label}>Title *</Text>
          <TextInput style={cm.input} value={title} onChangeText={setTitle} placeholder="A memorable moment…" placeholderTextColor={color.faint} maxLength={200} />

          <Text style={cm.label}>Description</Text>
          <TextInput style={[cm.input, cm.multiline]} value={description} onChangeText={setDescription} placeholder="Tell the story…" placeholderTextColor={color.faint} multiline maxLength={1000} textAlignVertical="top" />

          <View style={cm.row}>
            <View style={{ flex: 1 }}>
              <Text style={cm.label}>City</Text>
              <TextInput style={cm.input} value={city} onChangeText={setCity} placeholder="City" placeholderTextColor={color.faint} maxLength={100} />
            </View>
            <View style={{ width: space.md }} />
            <View style={{ flex: 1 }}>
              <Text style={cm.label}>Country</Text>
              <TextInput style={cm.input} value={country} onChangeText={setCountry} placeholder="Country" placeholderTextColor={color.faint} maxLength={100} />
            </View>
          </View>

          <Text style={cm.label}>Category</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cm.chips}>
            {CATEGORIES.map((c) => (
              <Pressable
                key={c.key}
                style={[cm.chip, category === c.key && cm.chipActive]}
                onPress={() => setCategory(c.key)}
              >
                <Text style={[cm.chipText, category === c.key && cm.chipTextActive]}>{c.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={cm.label}>Visibility</Text>
          <View style={cm.visRow}>
            {(['public', 'circle_only', 'trip_crew', 'private'] as MemoryVisibility[]).map((v) => (
              <Pressable
                key={v}
                style={[cm.visOption, visibility === v && cm.visOptionActive]}
                onPress={() => setVisibility(v)}
              >
                {visibilityIcon(v)}
                <Text style={[cm.visOptionText, visibility === v && cm.visOptionTextActive]}>
                  {visibilityLabel(v)}
                </Text>
              </Pressable>
            ))}
          </View>

          {error ? <Text style={cm.error}>{error}</Text> : null}
          <Pressable style={[cm.saveBtn, saving && cm.saveBtnDisabled]} onPress={handleSave} disabled={saving}>
            {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={cm.saveBtnText}>Save Memory</Text>}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Main MemoriesTab ──────────────────────────────────────────────────────────

interface MemoriesTabProps {
  memories: PassportMemory[];
  loading?: boolean;
  onReload: () => void;
}

export function MemoriesTab({ memories, loading, onReload }: MemoriesTabProps) {
  const [localMemories, setLocalMemories] = useState<PassportMemory[]>(memories);
  const [createOpen, setCreateOpen] = useState(false);

  React.useEffect(() => {
    setLocalMemories(memories);
  }, [memories]);

  const handleVisibilityChange = useCallback(async (id: string, vis: MemoryVisibility) => {
    setLocalMemories((prev) => prev.map((m) => m.id === id ? { ...m, visibility: vis } : m));
    await updatePassportMemory(id, { visibility: vis });
  }, []);

  const handleCreated = useCallback((memory: PassportMemory) => {
    setLocalMemories((prev) => [memory, ...prev]);
    onReload();
  }, [onReload]);

  if (loading) {
    return (
      <View style={mt.center}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  return (
    <View style={mt.wrap}>
      <View style={mt.headerRow}>
        <Text style={mt.heading}>Memories</Text>
        <Pressable style={mt.addBtn} onPress={() => setCreateOpen(true)}>
          <Plus size={16} color="#fff" />
          <Text style={mt.addBtnText}>Add</Text>
        </Pressable>
      </View>

      {localMemories.length === 0 ? (
        <View style={mt.empty}>
          <Text style={mt.emptyIcon}>📖</Text>
          <Text style={mt.emptyTitle}>No memories yet</Text>
          <Text style={mt.emptySub}>
            Memories are created when you check in, complete a Safe Return, or visit a new city.
            You can also add them manually.
          </Text>
          <Pressable style={mt.addBtnLarge} onPress={() => setCreateOpen(true)}>
            <Text style={mt.addBtnLargeText}>Add first memory</Text>
          </Pressable>
        </View>
      ) : (
        <View style={mt.list}>
          {localMemories.map((m) => (
            <MemoryCard key={m.id} memory={m} onVisibilityChange={handleVisibilityChange} />
          ))}
        </View>
      )}

      <CreateMemoryModal
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const mc = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze, overflow: 'hidden',
    marginBottom: space.md,
  },
  photo: { width: '100%', height: 140, backgroundColor: color.haze },
  body: { padding: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginBottom: 4 },
  catLabel: { fontFamily: 'Courier', fontSize: 10, color: color.mute, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  badge: { fontSize: 12 },
  title: { ...t.bodyStrong, color: color.ink, marginBottom: 4 },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  locationText: { ...t.small, color: color.mute },
  desc: { ...t.small, color: color.mute, marginBottom: 8 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  date: { ...t.small, color: color.mute },
  visBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.haze, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  visText: { fontSize: 11, color: color.mute, fontWeight: '600' },
  saveBtn: { padding: 4 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end', padding: space.lg },
  menuBox: { backgroundColor: color.paper, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  menuTitle: { ...t.bodyStrong, color: color.ink, marginBottom: space.xs },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderRadius: radius.md },
  menuItemActive: { backgroundColor: color.haze },
  menuItemText: { ...t.body, color: color.ink },
});

const cm = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.lg, borderBottomWidth: 1, borderColor: color.haze },
  title: { ...t.heading, color: color.ink, fontSize: 18 },
  body: { padding: space.lg, paddingBottom: 48 },
  label: { ...t.small, color: color.mute, fontWeight: '600', marginBottom: 6, marginTop: space.md },
  input: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, ...t.body, color: color.ink, backgroundColor: color.paperRaised },
  multiline: { height: 96, textAlignVertical: 'top' },
  row: { flexDirection: 'row', marginTop: space.sm },
  chips: { gap: space.sm, paddingBottom: space.xs },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  chipActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  chipText: { ...t.small, color: color.mute, fontWeight: '600' },
  chipTextActive: { color: color.signal },
  visRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  visOption: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  visOptionActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  visOptionText: { ...t.small, color: color.mute, fontWeight: '600' },
  visOptionTextActive: { color: color.signal },
  error: { ...t.small, color: color.signal, marginTop: space.sm },
  saveBtn: { backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md + 2, alignItems: 'center', marginTop: space.xl },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { ...t.bodyStrong, color: '#fff' },
});

const mt = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingTop: space.md },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: space.xxxl },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md },
  heading: { ...t.heading, color: color.ink },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.signal, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  addBtnText: { ...t.small, color: '#fff', fontWeight: '700' },
  empty: { paddingTop: space.xxxl, alignItems: 'center', gap: space.md },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { ...t.heading, color: color.ink },
  emptySub: { ...t.body, color: color.mute, textAlign: 'center', paddingHorizontal: space.lg },
  addBtnLarge: { marginTop: space.sm, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingVertical: space.md, paddingHorizontal: space.xl },
  addBtnLargeText: { ...t.bodyStrong, color: color.ink },
  list: { paddingBottom: space.xxxl },
});
