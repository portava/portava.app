/**
 * Settings → Emergency Contacts
 *
 * List, add, edit, and remove profile-level emergency contacts.
 * These contacts are reused every time you start a Safe Return session.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable,
  TextInput, Alert, ActivityIndicator, Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { KeyboardSafeScrollView } from '../../../src/components/ui/KeyboardSafeView';
import { Phone, Mail, User, Plus, Trash2, Edit2, ShieldCheck, X } from 'lucide-react-native';
import { AppHeader } from '../../../src/components/ui/AppHeader';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import {
  listEmergencyContacts,
  addEmergencyContact,
  updateEmergencyContact,
  deleteEmergencyContact,
  type EmergencyContact,
  type EmergencyContactInput,
} from '../../../src/services/emergencyContacts';
import { useSession } from '../../../src/context/SessionContext';
import { useNavBarScrollHandler } from '../../../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../../../src/hooks/useNavBarCollapse';

// ── Method labels ─────────────────────────────────────────────────────────────

const METHOD_LABELS: Record<string, string> = {
  in_app: 'In-app',
  sms:    'SMS',
  email:  'Email',
};

const METHODS: Array<{ value: 'in_app' | 'sms' | 'email'; label: string }> = [
  { value: 'in_app', label: 'In-app' },
  { value: 'sms',    label: 'SMS' },
  { value: 'email',  label: 'Email' },
];

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <View style={styles.empty}>
      <ShieldCheck size={36} color={color.mute} />
      <Text style={styles.emptyTitle}>No emergency contacts yet</Text>
      <Text style={styles.emptyBody}>
        Add trusted people who should be alerted if you miss a Safe Return check-in. You control when and how they're notified.
      </Text>
      <Pressable style={styles.emptyBtn} onPress={onAdd}>
        <Plus size={15} color={color.onInk} />
        <Text style={styles.emptyBtnText}>Add a contact</Text>
      </Pressable>
    </View>
  );
}

// ── Contact row ───────────────────────────────────────────────────────────────

function ContactRow({
  contact,
  onEdit,
  onDelete,
}: {
  contact: EmergencyContact;
  onEdit: (c: EmergencyContact) => void;
  onDelete: (c: EmergencyContact) => void;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <User size={18} color={color.deep} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName}>{contact.name}</Text>
        {contact.label ? <Text style={styles.rowLabel}>{contact.label}</Text> : null}
        <View style={styles.rowMeta}>
          {contact.phone ? (
            <View style={styles.metaItem}>
              <Phone size={11} color={color.mute} />
              <Text style={styles.metaText}>{contact.phone}</Text>
            </View>
          ) : null}
          {contact.email ? (
            <View style={styles.metaItem}>
              <Mail size={11} color={color.mute} />
              <Text style={styles.metaText}>{contact.email}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.methodBadge}>
          Notify via {METHOD_LABELS[contact.notifyMethod] ?? contact.notifyMethod}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <Pressable
          style={styles.actionBtn}
          onPress={() => onEdit(contact)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${contact.name}`}
        >
          <Edit2 size={15} color={color.deep} />
        </Pressable>
        <Pressable
          style={styles.actionBtn}
          onPress={() => onDelete(contact)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${contact.name}`}
        >
          <Trash2 size={15} color={color.signal} />
        </Pressable>
      </View>
    </View>
  );
}

// ── Add / Edit modal ──────────────────────────────────────────────────────────

interface FormState {
  name: string;
  label: string;
  phone: string;
  email: string;
  notifyMethod: 'in_app' | 'sms' | 'email';
}

const BLANK_FORM: FormState = {
  name: '', label: '', phone: '', email: '', notifyMethod: 'in_app',
};

function fromContact(c: EmergencyContact): FormState {
  return {
    name:          c.name,
    label:         c.label,
    phone:         c.phone ?? '',
    email:         c.email ?? '',
    notifyMethod:  c.notifyMethod,
  };
}

function EditModal({
  visible,
  editing,
  onSave,
  onClose,
  saving,
}: {
  visible: boolean;
  editing: EmergencyContact | null;
  onSave: (form: FormState) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<FormState>(BLANK_FORM);

  useEffect(() => {
    setForm(editing ? fromContact(editing) : BLANK_FORM);
  }, [editing, visible]);

  function field<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    if (!form.name.trim()) {
      Alert.alert('Name required', 'Please enter a name for this contact.');
      return;
    }
    onSave(form);
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardSafeScrollView offset={insets.top} style={{ backgroundColor: color.paper }}>
        <View style={styles.modalHeader}>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close">
            <X size={20} color={color.ink} />
          </Pressable>
          <Text style={styles.modalTitle}>{editing ? 'Edit contact' : 'Add contact'}</Text>
          <Pressable onPress={handleSave} disabled={saving} hitSlop={8}>
            {saving
              ? <ActivityIndicator size="small" color={color.deep} />
              : <Text style={styles.modalSave}>Save</Text>}
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Name *</Text>
            <TextInput
              style={styles.input}
              value={form.name}
              onChangeText={(v) => field('name', v)}
              placeholder="Full name"
              placeholderTextColor={color.faint}
              maxLength={200}
              autoCapitalize="words"
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Label (optional)</Text>
            <TextInput
              style={styles.input}
              value={form.label}
              onChangeText={(v) => field('label', v)}
              placeholder="e.g. Partner, Mum, Best friend"
              placeholderTextColor={color.faint}
              maxLength={100}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Phone (optional)</Text>
            <TextInput
              style={styles.input}
              value={form.phone}
              onChangeText={(v) => field('phone', v)}
              placeholder="+1 555 000 0000"
              placeholderTextColor={color.faint}
              keyboardType="phone-pad"
              maxLength={30}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Email (optional)</Text>
            <TextInput
              style={styles.input}
              value={form.email}
              onChangeText={(v) => field('email', v)}
              placeholder="contact@example.com"
              placeholderTextColor={color.faint}
              keyboardType="email-address"
              autoCapitalize="none"
              maxLength={200}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>How to notify them</Text>
            <View style={styles.methodRow}>
              {METHODS.map((m) => {
                const active = form.notifyMethod === m.value;
                return (
                  <Pressable
                    key={m.value}
                    style={[styles.methodChip, active && styles.methodChipActive]}
                    onPress={() => field('notifyMethod', m.value)}
                    accessibilityRole="radio"
                    accessibilityLabel={m.label}
                    accessibilityState={{ checked: active }}
                  >
                    <Text style={[styles.methodChipText, active && styles.methodChipTextActive]}>
                      {m.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.methodNote}>
              {form.notifyMethod === 'in_app'
                ? "They'll receive a notification inside Portava (must have the app)."
                : form.notifyMethod === 'sms'
                ? 'An SMS will be sent to their phone number when you miss a check-in.'
                : 'An email will be sent when you miss a check-in.'}
            </Text>
          </View>
        </ScrollView>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function EmergencyContactsScreen() {
  const { isAuthed, configured } = useSession();
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [loading, setLoading]   = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing]   = useState<EmergencyContact | null>(null);
  const [saving, setSaving]     = useState(false);
  const saveLock = useRef(false);
  const navBarScrollHandler = useNavBarScrollHandler();

  const load = useCallback(async () => {
    const result = await listEmergencyContacts();
    setContacts(result.contacts);
  }, []);

  useEffect(() => {
    if (!(configured && isAuthed)) { setLoading(false); return; }
    load().then(() => setLoading(false));
  }, [configured, isAuthed, load]);

  function openAdd() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(c: EmergencyContact) {
    setEditing(c);
    setModalOpen(true);
  }

  function handleDelete(c: EmergencyContact) {
    Alert.alert(
      `Remove ${c.name}?`,
      'They will no longer be notified during Safe Return sessions.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            const res = await deleteEmergencyContact(c.id);
            if (res.ok) {
              setContacts((prev) => prev.filter((x) => x.id !== c.id));
            } else {
              Alert.alert('Error', 'Could not remove contact. Try again.');
            }
          },
        },
      ],
    );
  }

  async function handleSave(form: FormState) {
    if (saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    try {
      if (editing) {
        const res = await updateEmergencyContact(editing.id, {
          name:          form.name.trim(),
          label:         form.label.trim(),
          phone:         form.phone.trim() || null,
          email:         form.email.trim() || null,
          notifyMethod:  form.notifyMethod,
        });
        if (res.ok && res.contact) {
          setContacts((prev) => prev.map((c) => c.id === editing.id ? res.contact! : c));
          setModalOpen(false);
        } else {
          Alert.alert('Error', res.error ?? 'Could not save contact. Try again.');
        }
      } else {
        const res = await addEmergencyContact({
          name:          form.name.trim(),
          label:         form.label.trim(),
          phone:         form.phone.trim() || null,
          email:         form.email.trim() || null,
          notifyMethod:  form.notifyMethod,
          sortOrder:     contacts.length,
        });
        if (res.ok && res.contact) {
          setContacts((prev) => [...prev, res.contact!]);
          setModalOpen(false);
        } else {
          Alert.alert('Error', res.error ?? 'Could not add contact. Try again.');
        }
      }
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }

  return (
    <View style={styles.root}>
      <AppHeader
        variant="detail"
        title="Emergency Contacts"
        onBack={router.back}
        rightActions={contacts.length > 0 && contacts.length < 10 ? [
          { icon: <Plus size={18} color={color.deep} />, onPress: openAdd, accessibilityLabel: 'Add emergency contact' },
        ] : []}
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.deep} />
        </View>
      ) : contacts.length === 0 ? (
        <EmptyState onAdd={openAdd} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          onScroll={navBarScrollHandler}
          scrollEventThrottle={16}
        >
          <Text style={styles.hint}>
            🔒 These contacts are only notified when you miss a Safe Return check-in — and only if you choose to alert them during setup.
          </Text>

          {contacts.map((c) => (
            <ContactRow key={c.id} contact={c} onEdit={openEdit} onDelete={handleDelete} />
          ))}

          {contacts.length < 10 && (
            <Pressable style={styles.addRowBtn} onPress={openAdd}>
              <Plus size={15} color={color.deep} />
              <Text style={styles.addRowText}>Add another contact</Text>
            </Pressable>
          )}

          {contacts.length >= 10 && (
            <Text style={styles.limitNote}>Maximum 10 contacts reached.</Text>
          )}

          <NavBarFiller />
        </ScrollView>
      )}

      <EditModal
        visible={modalOpen}
        editing={editing}
        onSave={handleSave}
        onClose={() => setModalOpen(false)}
        saving={saving}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list:   { padding: space.lg, gap: space.sm, paddingBottom: 40 },

  hint: {
    ...t.small, color: '#2D6A4F', fontSize: 11, lineHeight: 17,
    backgroundColor: '#F0F7F4', borderRadius: radius.md,
    padding: space.md, marginBottom: space.sm,
  },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  emptyTitle: { ...t.bodyStrong, color: color.ink, fontSize: 16, marginTop: space.md, textAlign: 'center' },
  emptyBody:  { ...t.small, color: color.mute, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: space.sm },
  emptyBtn: {
    marginTop: space.lg,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: color.deep, borderRadius: radius.pill,
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  emptyBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },

  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    padding: space.md,
  },
  rowIcon: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: color.deep + '18',
    alignItems: 'center', justifyContent: 'center',
    marginTop: 1,
  },
  rowName:  { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  rowLabel: { ...t.small, color: color.mute, fontSize: 11, marginTop: 1 },
  rowMeta:  { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaText: { ...t.small, color: color.mute, fontSize: 11 },
  methodBadge: {
    ...t.small, color: color.deep, fontSize: 11,
    marginTop: 4, fontWeight: '500',
  },
  rowActions: { flexDirection: 'column', gap: 8, paddingLeft: 4 },
  actionBtn: { padding: 4 },

  addRowBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: color.deep + '40', borderStyle: 'dashed',
    borderRadius: radius.md, padding: space.md, marginTop: space.xs,
  },
  addRowText: { ...t.bodyStrong, color: color.deep, fontSize: 13 },

  limitNote: { ...t.small, color: color.mute, fontSize: 11, textAlign: 'center', marginTop: space.sm },

  addBtn: { padding: 4 },

  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  modalTitle: { ...t.bodyStrong, color: color.ink, fontSize: 16 },
  modalSave:  { ...t.bodyStrong, color: color.deep, fontSize: 15 },
  modalBody:  { padding: space.lg, gap: space.md, paddingBottom: 60 },

  field:      { gap: 6 },
  fieldLabel: { ...t.small, color: color.mute, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    backgroundColor: color.paperRaised,
    borderWidth: 1, borderColor: color.haze,
    borderRadius: radius.md, padding: space.md,
    ...t.body, color: color.ink, fontSize: 15,
  },
  methodRow: { flexDirection: 'row', gap: space.sm },
  methodChip: {
    flex: 1, alignItems: 'center', paddingVertical: space.sm,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    backgroundColor: color.paperRaised,
  },
  methodChipActive: {
    borderColor: color.deep,
    backgroundColor: color.deep + '12',
  },
  methodChipText:       { ...t.small, color: color.mute, fontSize: 13 },
  methodChipTextActive: { ...t.bodyStrong, color: color.deep, fontSize: 13 },
  methodNote: { ...t.small, color: color.mute, fontSize: 12, lineHeight: 17, marginTop: 4 },
});
