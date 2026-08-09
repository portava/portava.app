/**
 * PassportManagerScreen — manage passports stored in the user's Portava account.
 * Accessed via Profile → Edit → Passports.
 *
 * Visual language: document-styled cards with monospace stamp accents.
 * Passport numbers are NEVER stored — prominently noted on the add/edit form.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Plus, X, ShieldCheck } from 'lucide-react-native';
import {
  SettingsScreen,
  SaveButton,
  FieldLabel,
  TextField,
  type SaveState,
} from '../../../src/components/settings/SettingsUI.tsx';
import { DatePickerField } from '../../../src/components/DatePickerField.tsx';
import { TravelEmptyState, TravelLoadingState } from '../../../src/components/primitives.tsx';
import {
  listMyPassports,
  addPassport,
  updatePassport,
  deletePassport,
  type TravelerPassport,
} from '../../../src/services/entryRequirements.ts';
import { PP } from '../../../src/theme/passportTokens.ts';
import { color, space, radius, type as t, avatar } from '../../../src/theme/tokens.ts';

// ── Country data ─────────────────────────────────────────────────────────────

interface Country {
  name: string;
  code: string;
}

const COUNTRIES: Country[] = [
  { name: 'Afghanistan', code: 'AF' },
  { name: 'Albania', code: 'AL' },
  { name: 'Algeria', code: 'DZ' },
  { name: 'Argentina', code: 'AR' },
  { name: 'Australia', code: 'AU' },
  { name: 'Austria', code: 'AT' },
  { name: 'Bangladesh', code: 'BD' },
  { name: 'Belgium', code: 'BE' },
  { name: 'Brazil', code: 'BR' },
  { name: 'Cambodia', code: 'KH' },
  { name: 'Canada', code: 'CA' },
  { name: 'Chile', code: 'CL' },
  { name: 'China', code: 'CN' },
  { name: 'Colombia', code: 'CO' },
  { name: 'Czech Republic', code: 'CZ' },
  { name: 'Denmark', code: 'DK' },
  { name: 'Egypt', code: 'EG' },
  { name: 'Ethiopia', code: 'ET' },
  { name: 'Finland', code: 'FI' },
  { name: 'France', code: 'FR' },
  { name: 'Germany', code: 'DE' },
  { name: 'Ghana', code: 'GH' },
  { name: 'Greece', code: 'GR' },
  { name: 'Hong Kong', code: 'HK' },
  { name: 'Hungary', code: 'HU' },
  { name: 'India', code: 'IN' },
  { name: 'Indonesia', code: 'ID' },
  { name: 'Iran', code: 'IR' },
  { name: 'Iraq', code: 'IQ' },
  { name: 'Ireland', code: 'IE' },
  { name: 'Israel', code: 'IL' },
  { name: 'Italy', code: 'IT' },
  { name: 'Japan', code: 'JP' },
  { name: 'Jordan', code: 'JO' },
  { name: 'Kenya', code: 'KE' },
  { name: 'Laos', code: 'LA' },
  { name: 'Malaysia', code: 'MY' },
  { name: 'Maldives', code: 'MV' },
  { name: 'Mexico', code: 'MX' },
  { name: 'Morocco', code: 'MA' },
  { name: 'Myanmar', code: 'MM' },
  { name: 'Nepal', code: 'NP' },
  { name: 'Netherlands', code: 'NL' },
  { name: 'New Zealand', code: 'NZ' },
  { name: 'Nigeria', code: 'NG' },
  { name: 'Norway', code: 'NO' },
  { name: 'Pakistan', code: 'PK' },
  { name: 'Peru', code: 'PE' },
  { name: 'Philippines', code: 'PH' },
  { name: 'Poland', code: 'PL' },
  { name: 'Portugal', code: 'PT' },
  { name: 'Romania', code: 'RO' },
  { name: 'Russia', code: 'RU' },
  { name: 'Saudi Arabia', code: 'SA' },
  { name: 'Singapore', code: 'SG' },
  { name: 'South Africa', code: 'ZA' },
  { name: 'South Korea', code: 'KR' },
  { name: 'Spain', code: 'ES' },
  { name: 'Sri Lanka', code: 'LK' },
  { name: 'Sweden', code: 'SE' },
  { name: 'Switzerland', code: 'CH' },
  { name: 'Taiwan', code: 'TW' },
  { name: 'Thailand', code: 'TH' },
  { name: 'Turkey', code: 'TR' },
  { name: 'Ukraine', code: 'UA' },
  { name: 'United Arab Emirates', code: 'AE' },
  { name: 'United Kingdom', code: 'GB' },
  { name: 'United States', code: 'US' },
  { name: 'Vietnam', code: 'VN' },
];

/** Convert ISO2 code to flag emoji via regional indicator symbols. */
function isoToFlag(code: string): string {
  if (!code || code.length !== 2) return '🌐';
  const offset = 0x1F1E6 - 65;
  return String.fromCodePoint(code.charCodeAt(0) + offset, code.charCodeAt(1) + offset);
}

/** Resolve display name for a passport's issuingCountry (ISO2 or name). */
function resolveCountryName(issuingCountry: string): { name: string; flag: string } {
  // Direct ISO2 match
  const byCode = COUNTRIES.find((c) => c.code === issuingCountry);
  if (byCode) return { name: byCode.name, flag: isoToFlag(byCode.code) };
  // Direct name match
  const byName = COUNTRIES.find((c) => c.name.toLowerCase() === issuingCountry.toLowerCase());
  if (byName) return { name: byName.name, flag: isoToFlag(byName.code) };
  // Fallback — show raw value
  return { name: issuingCountry, flag: issuingCountry.length === 2 ? isoToFlag(issuingCountry) : '🌐' };
}

/** Format expiry date string to human-readable short form. */
function fmtExpiry(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
}

// ── Form state ────────────────────────────────────────────────────────────────

interface FormState {
  country: Country | null;
  label: string;
  expiryDate: string;
  isPrimary: boolean;
}

const EMPTY_FORM: FormState = { country: null, label: '', expiryDate: '', isPrimary: false };

// ── Country Selector Modal ────────────────────────────────────────────────────

interface CountrySelectorProps {
  visible: boolean;
  onSelect: (c: Country) => void;
  onClose: () => void;
}

function CountrySelectorModal({ visible, onSelect, onClose }: CountrySelectorProps) {
  const [query, setQuery] = useState('');

  const filtered = query.trim()
    ? COUNTRIES.filter(
        (c) =>
          c.name.toLowerCase().includes(query.toLowerCase()) ||
          c.code.toLowerCase() === query.toLowerCase(),
      )
    : COUNTRIES;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={cs.root}>
        {/* Header */}
        <View style={cs.header}>
          <Text style={cs.title}>Select Country</Text>
          <Pressable style={cs.closeBtn} onPress={onClose} hitSlop={10} accessibilityLabel="Close">
            <X size={20} color={PP.ink} />
          </Pressable>
        </View>

        {/* Search */}
        <View style={cs.searchRow}>
          <TextInput
            style={cs.searchInput}
            placeholder="Country name or ISO code…"
            placeholderTextColor={PP.inkMuted + '99'}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            testID="country-search-input"
          />
        </View>

        {/* List */}
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.code}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={cs.listContent}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [cs.countryRow, pressed && { opacity: 0.7 }]}
              onPress={() => { onSelect(item); setQuery(''); }}
              testID={`country-option-${item.code}`}
            >
              <Text style={cs.countryFlag}>{isoToFlag(item.code)}</Text>
              <Text style={cs.countryName}>{item.name}</Text>
              <Text style={cs.countryCode}>{item.code}</Text>
            </Pressable>
          )}
          ItemSeparatorComponent={() => <View style={cs.sep} />}
        />
      </View>
    </Modal>
  );
}

const cs = StyleSheet.create({
  root: { flex: 1, backgroundColor: PP.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.lg, paddingVertical: space.lg,
    borderBottomWidth: 1, borderBottomColor: PP.borderLight,
  },
  title: { ...t.heading, color: PP.ink, flex: 1, textAlign: 'center' },
  closeBtn: {
    position: 'absolute', right: space.lg,
    width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2,
    backgroundColor: PP.paperDeep, alignItems: 'center', justifyContent: 'center',
  },
  searchRow: { paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: PP.borderLight },
  searchInput: {
    ...t.body, color: PP.ink,
    backgroundColor: PP.paperDeep,
    borderWidth: 1, borderColor: PP.border,
    borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.md,
    minHeight: 44,
  },
  listContent: { paddingBottom: 40 },
  countryRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 52,
  },
  countryFlag: { fontSize: 24, width: 34, textAlign: 'center' },
  countryName: { ...t.body, color: PP.ink, flex: 1, fontWeight: '500' },
  countryCode: { fontFamily: 'Courier', fontSize: 11, fontWeight: '700', color: PP.inkMuted, letterSpacing: 1 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: PP.borderLight, marginLeft: space.lg + 34 + space.md },
});

// ── Add / Edit Form Modal ─────────────────────────────────────────────────────

interface PassportFormProps {
  visible: boolean;
  initial: FormState;
  editingId: string | null;       // null = add, string = edit
  onSave: (form: FormState, id: string | null) => Promise<void>;
  onClose: () => void;
}

function PassportFormModal({ visible, initial, editingId, onSave, onClose }: PassportFormProps) {
  const [form, setForm] = useState<FormState>(initial);
  const [showCountrySelector, setShowCountrySelector] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');

  // Sync when the modal re-opens with new initial values
  useEffect(() => {
    if (visible) {
      setForm(initial);
      setSaveState('idle');
    }
  }, [visible, initial]);

  const isAdd = editingId === null;

  const handleSave = async () => {
    if (!form.country && isAdd) {
      Alert.alert('Select a country', 'Please choose the issuing country for this passport.');
      return;
    }
    setSaveState('saving');
    try {
      await onSave(form, editingId);
      setSaveState('saved');
      setTimeout(onClose, 800);
    } catch {
      setSaveState('error');
    }
  };

  return (
    <>
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <View style={fm.root}>
          {/* Header */}
          <View style={fm.header}>
            <Text style={fm.title}>{isAdd ? 'Add Passport' : 'Edit Passport'}</Text>
            <Pressable style={fm.closeBtn} onPress={onClose} hitSlop={10} accessibilityLabel="Close">
              <X size={20} color={PP.ink} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={fm.body} keyboardShouldPersistTaps="handled">
            {/* Privacy note */}
            <View style={fm.privacyNote} testID="privacy-note">
              <ShieldCheck size={16} color={color.success} />
              <Text style={fm.privacyText}>We never store passport numbers</Text>
            </View>

            {/* Country — only shown when adding; PATCH does not accept issuingCountry */}
            {isAdd ? (
              <View style={fm.field}>
                <FieldLabel>Issuing Country</FieldLabel>
                <Pressable
                  style={fm.countryPicker}
                  onPress={() => setShowCountrySelector(true)}
                  testID="country-picker-btn"
                  accessibilityRole="button"
                  accessibilityLabel={form.country ? form.country.name : 'Select country'}
                >
                  {form.country ? (
                    <>
                      <Text style={fm.selectedFlag}>{isoToFlag(form.country.code)}</Text>
                      <Text style={fm.selectedName}>{form.country.name}</Text>
                      <Text style={fm.selectedCode}>{form.country.code}</Text>
                    </>
                  ) : (
                    <Text style={fm.pickerPlaceholder}>Select country…</Text>
                  )}
                </Pressable>
              </View>
            ) : form.country ? (
              /* Edit mode: show country read-only */
              <View style={fm.field}>
                <FieldLabel>Issuing Country</FieldLabel>
                <View style={[fm.countryPicker, fm.countryPickerReadOnly]}>
                  <Text style={fm.selectedFlag}>{isoToFlag(form.country.code)}</Text>
                  <Text style={fm.selectedName}>{form.country.name}</Text>
                  <Text style={fm.selectedCode}>{form.country.code}</Text>
                </View>
              </View>
            ) : null}

            {/* Label */}
            <View style={fm.field}>
              <FieldLabel>Label <Text style={fm.optional}>(optional)</Text></FieldLabel>
              <TextField
                placeholder="e.g. Main, Second, Old"
                value={form.label}
                onChangeText={(v) => setForm((s) => ({ ...s, label: v }))}
                testID="label-input"
              />
            </View>

            {/* Expiry date */}
            <View style={fm.field}>
              <FieldLabel>Expiry Date <Text style={fm.optional}>(optional)</Text></FieldLabel>
              <DatePickerField
                value={form.expiryDate}
                onChange={(v) => setForm((s) => ({ ...s, expiryDate: v }))}
                placeholder="Select expiry date"
              />
            </View>

            {/* Set as primary */}
            <View style={fm.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={fm.toggleLabel}>Set as primary</Text>
                <Text style={fm.toggleSub}>Used by default for trip entry checks</Text>
              </View>
              <Switch
                value={form.isPrimary}
                onValueChange={(v) => setForm((s) => ({ ...s, isPrimary: v }))}
                trackColor={{ true: PP.inkLight, false: PP.paperShadow }}
                thumbColor="#FFFFFF"
              />
            </View>

            {/* Save */}
            <View style={fm.saveRow}>
              <SaveButton
                state={saveState}
                onPress={handleSave}
                label={isAdd ? 'Add passport' : 'Save changes'}
                testID="passport-form-save-btn"
              />
            </View>
          </ScrollView>
        </View>
      </Modal>

      <CountrySelectorModal
        visible={showCountrySelector}
        onSelect={(c) => { setForm((s) => ({ ...s, country: c })); setShowCountrySelector(false); }}
        onClose={() => setShowCountrySelector(false)}
      />
    </>
  );
}

const fm = StyleSheet.create({
  root: { flex: 1, backgroundColor: PP.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.lg, paddingVertical: space.lg,
    borderBottomWidth: 1, borderBottomColor: PP.borderLight,
  },
  title: { ...t.heading, color: PP.ink, flex: 1, textAlign: 'center' },
  closeBtn: {
    position: 'absolute', right: space.lg,
    width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2,
    backgroundColor: PP.paperDeep, alignItems: 'center', justifyContent: 'center',
  },
  body: { padding: space.lg, gap: space.xl, paddingBottom: 48 },
  privacyNote: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: '#F0FBF4',
    borderWidth: 1, borderColor: '#C4E8D4',
    borderRadius: radius.md, padding: space.md,
  },
  privacyText: { ...t.small, color: color.success, fontWeight: '600', flex: 1 },
  field: { gap: space.xs },
  optional: { fontWeight: '400', color: PP.inkMuted },
  countryPicker: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    borderWidth: 1, borderColor: PP.border, borderRadius: radius.sm,
    paddingHorizontal: space.md, paddingVertical: space.md,
    minHeight: 44, backgroundColor: '#FFFDF7',
  },
  selectedFlag: { fontSize: 20 },
  selectedName: { ...t.body, color: PP.ink, fontWeight: '500', flex: 1 },
  selectedCode: { fontFamily: 'Courier', fontSize: 11, fontWeight: '700', color: PP.inkMuted, letterSpacing: 1 },
  pickerPlaceholder: { ...t.body, color: PP.inkMuted + '99' },
  countryPickerReadOnly: { opacity: 0.6, backgroundColor: PP.paperShadow },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.sm,
  },
  toggleLabel: { ...t.body, color: PP.ink, fontWeight: '600' },
  toggleSub: { ...t.small, color: PP.inkMuted, marginTop: 2 },
  saveRow: { alignItems: 'flex-start', paddingTop: space.sm },
});

// ── Passport card ─────────────────────────────────────────────────────────────

interface PassportCardProps {
  passport: TravelerPassport;
  onEdit: () => void;
  onDelete: () => void;
}

function PassportCard({ passport, onEdit, onDelete }: PassportCardProps) {
  const { name, flag } = resolveCountryName(passport.issuingCountry);
  const expiry = fmtExpiry(passport.expiryDate);

  return (
    <View style={pc.card} testID={`passport-card-${passport.id}`}>
      {/* Top row: flag + country + badge */}
      <View style={pc.topRow}>
        <Text style={pc.flag}>{flag}</Text>
        <View style={{ flex: 1 }}>
          <Text style={pc.country}>{name}</Text>
          {passport.label ? <Text style={pc.label}>{passport.label}</Text> : null}
        </View>
        {passport.isPrimary ? (
          <View style={pc.primaryBadge}>
            <Text style={pc.primaryText}>Primary</Text>
          </View>
        ) : null}
      </View>

      {/* Expiry */}
      {expiry ? (
        <View style={pc.metaRow}>
          <Text style={pc.metaLabel}>EXPIRES</Text>
          <Text style={pc.metaValue}>{expiry}</Text>
        </View>
      ) : null}

      {/* Actions */}
      <View style={pc.actions}>
        <Pressable
          style={({ pressed }) => [pc.actionBtn, pressed && { opacity: 0.7 }]}
          onPress={onEdit}
          testID={`edit-passport-${passport.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${name} passport`}
        >
          <Text style={pc.actionText}>Edit</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [pc.actionBtn, pc.actionBtnDelete, pressed && { opacity: 0.7 }]}
          onPress={onDelete}
          testID={`delete-passport-${passport.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${name} passport`}
        >
          <Text style={[pc.actionText, pc.actionTextDelete]}>Delete</Text>
        </Pressable>
      </View>
    </View>
  );
}

const pc = StyleSheet.create({
  card: {
    backgroundColor: PP.paper,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: PP.border,
    padding: space.lg, gap: space.md,
    shadowColor: '#11110F', shadowOpacity: 0.06, shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 }, elevation: 2,
  },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  flag: { fontSize: 28, lineHeight: 34 },
  country: { ...t.bodyStrong, color: PP.ink },
  label: { ...t.small, color: PP.inkMuted, marginTop: 2 },
  primaryBadge: {
    backgroundColor: PP.goldLight, borderRadius: radius.pill,
    borderWidth: 1, borderColor: PP.gold + '80',
    paddingHorizontal: space.md, paddingVertical: 4,
  },
  primaryText: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: '#8A6800', letterSpacing: 1, textTransform: 'uppercase' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  metaLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: PP.inkMuted, letterSpacing: 1.2, textTransform: 'uppercase' },
  metaValue: { fontFamily: 'Courier', fontSize: 12, fontWeight: '500', color: PP.ink },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  actionBtn: {
    paddingHorizontal: space.md, paddingVertical: 7,
    borderRadius: radius.sm, borderWidth: 1, borderColor: PP.border,
    backgroundColor: PP.paperDeep,
  },
  actionBtnDelete: { borderColor: PP.seal + '60', backgroundColor: PP.sealLight },
  actionText: { ...t.small, color: PP.ink, fontWeight: '600' },
  actionTextDelete: { color: PP.seal },
});

// ── Main screen ───────────────────────────────────────────────────────────────

export default function PassportManagerScreen() {
  const [passports, setPassports] = useState<TravelerPassport[]>([]);
  const [loading, setLoading] = useState(true);

  // Form / modal state
  const [formVisible, setFormVisible] = useState(false);
  const [formInitial, setFormInitial] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await listMyPassports();
    setPassports(result);
    setLoading(false);
  }, []);

  // Refetch on every focus (returning from a sub-screen or after edits)
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // ── Handlers ────────────────────────────────────────────────────────────────

  const openAdd = () => {
    setEditingId(null);
    setFormInitial(EMPTY_FORM);
    setFormVisible(true);
  };

  const openEdit = (passport: TravelerPassport) => {
    const byCode = COUNTRIES.find((c) => c.code === passport.issuingCountry);
    const byName = COUNTRIES.find((c) => c.name.toLowerCase() === passport.issuingCountry.toLowerCase());
    const country = byCode ?? byName ?? { name: passport.issuingCountry, code: passport.issuingCountry };
    setEditingId(passport.id);
    setFormInitial({
      country,
      label: passport.label ?? '',
      expiryDate: passport.expiryDate ?? '',
      isPrimary: passport.isPrimary,
    });
    setFormVisible(true);
  };

  const handleSave = async (form: FormState, id: string | null) => {
    if (id === null) {
      // Add
      const result = await addPassport({
        issuingCountry: form.country!.code,
        label: form.label || undefined,
        expiryDate: form.expiryDate || null,
        isPrimary: form.isPrimary,
      });
      if (!result) throw new Error('Failed to add passport');
      await load();
    } else {
      // Update
      const result = await updatePassport(id, {
        label: form.label || undefined,
        expiryDate: form.expiryDate || null,
        isPrimary: form.isPrimary,
      });
      if (!result) throw new Error('Failed to update passport');
      await load();
    }
  };

  const handleDelete = (passport: TravelerPassport) => {
    if (passport.isPrimary) {
      Alert.alert(
        'Cannot delete primary passport',
        'Set another passport as primary first, then delete this one.',
        [{ text: 'OK' }],
      );
      return;
    }
    const { name } = resolveCountryName(passport.issuingCountry);
    Alert.alert(
      'Delete passport?',
      `Remove your ${name} passport? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deletePassport(passport.id);
            await load();
          },
        },
      ],
    );
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  const addButton = (
    <Pressable
      style={({ pressed }) => [scr.addBtn, pressed && { opacity: 0.7 }]}
      onPress={openAdd}
      accessibilityRole="button"
      accessibilityLabel="Add passport"
      testID="add-passport-btn"
    >
      <Plus size={18} color={PP.ink} />
    </Pressable>
  );

  return (
    <>
      <SettingsScreen
        title="Passports"
        subtitle="Saved for trip entry checks"
        right={addButton}
        contentStyle={{ padding: 0 }}
      >
        {loading ? (
          <TravelLoadingState label="Loading passports…" />
        ) : passports.length === 0 ? (
          <View style={scr.emptyWrap}>
            <TravelEmptyState
              title="No passports yet"
              sub="Add a passport so Portava can show visa requirements for your trips."
              action="Add passport"
              onAction={openAdd}
            />
            <View style={scr.privacyFooter}>
              <ShieldCheck size={14} color={color.success} />
              <Text style={scr.privacyFooterText}>We never store passport numbers</Text>
            </View>
          </View>
        ) : (
          <FlatList
            data={passports}
            keyExtractor={(item) => item.id}
            contentContainerStyle={scr.listContent}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <PassportCard
                passport={item}
                onEdit={() => openEdit(item)}
                onDelete={() => handleDelete(item)}
              />
            )}
            ItemSeparatorComponent={() => <View style={{ height: space.md }} />}
          />
        )}
      </SettingsScreen>

      <PassportFormModal
        visible={formVisible}
        initial={formInitial}
        editingId={editingId}
        onSave={handleSave}
        onClose={() => setFormVisible(false)}
      />
    </>
  );
}

const scr = StyleSheet.create({
  addBtn: {
    width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2,
    backgroundColor: PP.paperDeep, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: PP.border,
  },
  emptyWrap: { padding: space.lg, gap: space.lg },
  privacyFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, paddingVertical: space.sm,
  },
  privacyFooterText: { ...t.small, color: color.success, fontWeight: '600' },
  listContent: { padding: space.lg, paddingTop: space.xl },
});
