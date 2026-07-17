/**
 * SuggestedMemoryModal
 *
 * Surfaces a pending passport memory suggestion to the user.
 * Shows: proposed title, city/country, why it was suggested, verification badge,
 * a visibility selector, and Save / Edit / Skip actions.
 * Nothing goes public until the user explicitly saves it.
 */
import React, { useState } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet,
  TextInput, ActivityIndicator,
} from 'react-native';
import { KeyboardSafeView } from './ui/KeyboardSafeView.tsx';
import { X, MapPin, Globe, Users, Eye, Lock, Shield } from 'lucide-react-native';
import type { PassportMemory, MemoryVisibility } from '../services/passportStamps.ts';
import { acceptPassportSuggestion, dismissPassportSuggestion } from '../services/passportStamps.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';

function verificationLabel(level: string): string {
  if (level === 'gps') return 'GPS verified';
  if (level === 'checkin') return 'Check-in verified';
  if (level === 'safe_return') return 'Safe Return verified';
  if (level === 'crew') return 'Trip Crew verified';
  if (level === 'admin') return 'Admin verified';
  return '';
}

function verificationBadgeEmoji(level: string): string {
  if (level === 'gps') return '📍';
  if (level === 'checkin') return '✅';
  if (level === 'safe_return') return '🛡';
  if (level === 'crew') return '👥';
  if (level === 'admin') return '⭐';
  return '';
}

const VISIBILITY_OPTIONS: { value: MemoryVisibility; label: string; icon: React.ReactNode; desc: string }[] = [
  { value: 'private', label: 'Private', icon: <Lock size={14} color={color.mute} />, desc: 'Only you' },
  { value: 'trip_crew', label: 'Crew only', icon: <Eye size={14} color={color.signal} />, desc: 'Trip members' },
  { value: 'circle_only', label: 'Circle', icon: <Users size={14} color={color.signal} />, desc: 'Trusted circle' },
  { value: 'public', label: 'Public', icon: <Globe size={14} color={color.success} />, desc: 'Everyone' },
];

interface Props {
  suggestion: PassportMemory | null;
  visible: boolean;
  onClose: () => void;
  onAccepted: (id: string) => void;
  onDismissed: (id: string) => void;
}

export function SuggestedMemoryModal({ suggestion, visible, onClose, onAccepted, onDismissed }: Props) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [visibility, setVisibility] = useState<MemoryVisibility>('private');
  const [saving, setSaving] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [error, setError] = useState('');

  React.useEffect(() => {
    if (suggestion) {
      setTitle(suggestion.title ?? '');
      setVisibility('private');
      setEditing(false);
      setError('');
    }
  }, [suggestion]);

  if (!suggestion) return null;

  const badge = verificationBadgeEmoji(suggestion.verificationLevel);
  const verLabel = verificationLabel(suggestion.verificationLevel);

  const handleSave = async () => {
    if (!suggestion) return;
    setSaving(true);
    setError('');
    const res = await acceptPassportSuggestion(suggestion.id, {
      title: title.trim() || undefined,
      visibility,
    });
    setSaving(false);
    if (!res.ok) { setError(res.message); return; }
    onAccepted(suggestion.id);
    onClose();
  };

  const handleDismiss = async () => {
    if (!suggestion) return;
    setDismissing(true);
    await dismissPassportSuggestion(suggestion.id);
    setDismissing(false);
    onDismissed(suggestion.id);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardSafeView>
        <View style={s.header}>
          <View style={s.headerLeft}>
            <Shield size={18} color={color.signal} />
            <Text style={s.headerTitle}>Memory suggestion</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={8}><X size={22} color={color.ink} /></Pressable>
        </View>

        <View style={s.body}>

          {/* Why suggested */}
          {suggestion.suggestionReason && (
            <View style={s.reasonBox}>
              <Text style={s.reasonLabel}>Why we're suggesting this</Text>
              <Text style={s.reasonText}>{suggestion.suggestionReason}</Text>
              {badge && verLabel ? (
                <View style={s.verRow}>
                  <Text style={s.verBadge}>{badge}</Text>
                  <Text style={s.verText}>{verLabel}</Text>
                </View>
              ) : null}
            </View>
          )}

          {/* Location */}
          {(suggestion.city || suggestion.country) && (
            <View style={s.locationRow}>
              <MapPin size={14} color={color.mute} />
              <Text style={s.locationText}>
                {[suggestion.city, suggestion.country].filter(Boolean).join(', ')}
              </Text>
            </View>
          )}

          {/* Title */}
          <Text style={s.fieldLabel}>Memory title</Text>
          {editing ? (
            <TextInput
              style={s.input}
              value={title}
              onChangeText={setTitle}
              placeholder="What would you call this moment?"
              placeholderTextColor={color.faint}
              maxLength={200}
              autoFocus
            />
          ) : (
            <Pressable style={s.titleDisplay} onPress={() => setEditing(true)}>
              <Text style={s.titleText}>{title || suggestion.title || 'Untitled memory'}</Text>
              <Text style={s.editHint}>Tap to edit</Text>
            </Pressable>
          )}

          {/* Visibility picker */}
          <Text style={s.fieldLabel}>Who can see this?</Text>
          <Text style={s.fieldSub}>Nothing goes public until you choose and save.</Text>
          <View style={s.visGrid}>
            {VISIBILITY_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                style={[s.visOption, visibility === opt.value && s.visOptionActive]}
                onPress={() => setVisibility(opt.value)}
              >
                {opt.icon}
                <Text style={[s.visLabel, visibility === opt.value && s.visLabelActive]}>{opt.label}</Text>
                <Text style={s.visDesc}>{opt.desc}</Text>
              </Pressable>
            ))}
          </View>

          {error ? <Text style={s.error}>{error}</Text> : null}

          {/* Actions */}
          <View style={s.actions}>
            <Pressable
              style={[s.saveBtn, saving && s.btnDisabled]}
              onPress={handleSave}
              disabled={saving || dismissing}
            >
              {saving
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={s.saveBtnText}>Save memory</Text>}
            </Pressable>

            <Pressable
              style={[s.skipBtn, dismissing && s.btnDisabled]}
              onPress={handleDismiss}
              disabled={saving || dismissing}
            >
              {dismissing
                ? <ActivityIndicator color={color.mute} size="small" />
                : <Text style={s.skipBtnText}>Skip this one</Text>}
            </Pressable>
          </View>

          <Text style={s.note}>
            Saved memories appear in your Passport. Skipped suggestions are discarded.
          </Text>
        </View>
      </KeyboardSafeView>
    </Modal>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: space.lg, borderBottomWidth: 1, borderColor: color.haze,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  headerTitle: { ...t.bodyStrong, color: color.ink },
  body: { padding: space.lg, paddingBottom: 48 },

  reasonBox: {
    backgroundColor: '#FFF8F0', borderRadius: radius.lg,
    borderWidth: 1, borderColor: '#FCDEA8',
    padding: space.md, marginBottom: space.lg, gap: 6,
  },
  reasonLabel: { fontFamily: 'Courier', fontSize: 9, color: '#B08020', fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  reasonText: { ...t.body, color: color.ink },
  verRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  verBadge: { fontSize: 12 },
  verText: { ...t.small, color: color.mute },

  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: space.md },
  locationText: { ...t.small, color: color.mute },

  fieldLabel: { ...t.bodyStrong, color: color.ink, marginBottom: 4, marginTop: space.md },
  fieldSub: { ...t.small, color: color.mute, marginBottom: space.sm },
  input: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, ...t.body, color: color.ink, backgroundColor: color.paperRaised,
  },
  titleDisplay: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, backgroundColor: color.paperRaised, gap: 2,
  },
  titleText: { ...t.bodyStrong, color: color.ink },
  editHint: { ...t.small, color: color.mute },

  visGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  visOption: {
    flexDirection: 'column', alignItems: 'center', gap: 4,
    padding: space.md, borderRadius: radius.lg, borderWidth: 1,
    borderColor: color.haze, backgroundColor: color.paperRaised,
    minWidth: '45%', flex: 1,
  },
  visOptionActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  visLabel: { ...t.small, color: color.ink, fontWeight: '700' },
  visLabelActive: { color: color.signal },
  visDesc: { fontSize: 10, color: color.mute },

  error: { ...t.small, color: color.signal, marginTop: space.sm },

  actions: { gap: space.sm, marginTop: space.xl },
  saveBtn: {
    backgroundColor: color.signal, borderRadius: radius.pill,
    paddingVertical: space.md + 2, alignItems: 'center',
  },
  saveBtnText: { ...t.bodyStrong, color: '#fff' },
  skipBtn: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill,
    paddingVertical: space.md, alignItems: 'center',
  },
  skipBtnText: { ...t.body, color: color.mute },
  btnDisabled: { opacity: 0.5 },
  note: { ...t.small, color: color.faint, textAlign: 'center', marginTop: space.md },
});
