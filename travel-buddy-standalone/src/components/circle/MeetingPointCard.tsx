import React, { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Linking,
  Alert,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { MapPin, ExternalLink, Edit2, X, Check } from 'lucide-react-native';
import type { MeetingPoint } from '../../services/circle';
import { postMeetingPoint, patchMeetingPoint } from '../../services/circle';
import { color, radius, type as t } from '../../theme/tokens';

interface Props {
  meetingPoint: MeetingPoint | null;
  contextType: 'trip' | 'event';
  contextId: string;
  onUpdate: (mp: MeetingPoint) => void;
  showUpdateAction?: boolean;
}

interface EditState {
  venueLabel: string;
  approximateLabel: string;
  description: string;
}

export function MeetingPointCard({
  meetingPoint,
  contextType,
  contextId,
  onUpdate,
  showUpdateAction = false,
}: Props) {
  const [editOpen, setEditOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editState, setEditState] = useState<EditState>({
    venueLabel: '',
    approximateLabel: '',
    description: '',
  });

  if (!meetingPoint && !showUpdateAction) return null;

  function openEdit() {
    setEditState({
      venueLabel: meetingPoint?.venueLabel ?? '',
      approximateLabel: meetingPoint?.approximateLabel ?? '',
      description: meetingPoint?.description ?? '',
    });
    setEditOpen(true);
  }

  function openDirections() {
    if (!meetingPoint) return;
    const query = meetingPoint.venueLabel ?? meetingPoint.approximateLabel ?? '';
    if (!query) return;
    Linking.openURL(`https://maps.google.com/?q=${encodeURIComponent(query)}`).catch(() =>
      Alert.alert('Could not open maps', 'Please open your maps app manually.'),
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {
        venueLabel: editState.venueLabel.trim() || null,
        approximateLabel: editState.approximateLabel.trim() || null,
        description: editState.description.trim() || null,
      };
      const res = meetingPoint
        ? await patchMeetingPoint(contextType, contextId, payload)
        : await postMeetingPoint(contextType, contextId, payload);

      if (res.ok) {
        onUpdate(res.data);
        setEditOpen(false);
      } else if (res.status === 403) {
        Alert.alert('Not allowed', 'Only the host can update the meeting point.');
        setEditOpen(false);
      } else {
        Alert.alert('Could not save', 'Please try again.');
      }
    } catch {
      Alert.alert('Could not save', 'Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const hasDirections =
    meetingPoint && (meetingPoint.venueLabel || meetingPoint.approximateLabel);

  return (
    <>
      <View style={s.card}>
        <View style={s.iconWrap}>
          <MapPin size={18} color="#F57F17" />
        </View>
        <View style={s.body}>
          <Text style={s.heading}>Meeting point</Text>
          {meetingPoint ? (
            <>
              {meetingPoint.venueLabel ? (
                <Text style={s.venueName}>{meetingPoint.venueLabel}</Text>
              ) : null}
              {meetingPoint.approximateLabel ? (
                <Text style={s.areaLabel}>{meetingPoint.approximateLabel}</Text>
              ) : null}
              {meetingPoint.description ? (
                <Text style={s.description}>{meetingPoint.description}</Text>
              ) : null}
            </>
          ) : (
            <Text style={s.noMeeting}>No meeting point set yet</Text>
          )}
        </View>
        <View style={s.actions}>
          {hasDirections ? (
            <Pressable style={s.actionBtn} onPress={openDirections} hitSlop={8}>
              <ExternalLink size={16} color={color.signal} />
            </Pressable>
          ) : null}
          {showUpdateAction ? (
            <Pressable style={s.actionBtn} onPress={openEdit} hitSlop={8}>
              <Edit2 size={16} color={color.mute} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <Modal
        visible={editOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setEditOpen(false)}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={m.header}>
            <Pressable onPress={() => setEditOpen(false)} hitSlop={8}>
              <X size={22} color={color.ink} />
            </Pressable>
            <Text style={m.title}>
              {meetingPoint ? 'Update meeting point' : 'Set meeting point'}
            </Text>
            <Pressable onPress={handleSave} disabled={saving} hitSlop={8}>
              {saving ? (
                <ActivityIndicator size="small" color={color.signal} />
              ) : (
                <Check size={22} color={color.signal} />
              )}
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={m.body}
            keyboardShouldPersistTaps="handled"
          >
            <View style={m.field}>
              <Text style={m.fieldLabel}>Venue name</Text>
              <TextInput
                style={m.input}
                value={editState.venueLabel}
                onChangeText={(v) => setEditState((p) => ({ ...p, venueLabel: v }))}
                placeholder="e.g. Cloud 9 Bar, Gate A2"
                placeholderTextColor={color.faint}
              />
            </View>
            <View style={m.field}>
              <Text style={m.fieldLabel}>Area or landmark</Text>
              <TextInput
                style={m.input}
                value={editState.approximateLabel}
                onChangeText={(v) => setEditState((p) => ({ ...p, approximateLabel: v }))}
                placeholder="e.g. Makati CBD, near the fountain"
                placeholderTextColor={color.faint}
              />
            </View>
            <View style={m.field}>
              <Text style={m.fieldLabel}>Notes (optional)</Text>
              <TextInput
                style={[m.input, m.textarea]}
                value={editState.description}
                onChangeText={(v) => setEditState((p) => ({ ...p, description: v }))}
                placeholder="Extra directions or context…"
                placeholderTextColor={color.faint}
                multiline
                numberOfLines={3}
              />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: '#FFFDE7',
    borderRadius: radius.md,
    padding: 14,
    marginHorizontal: 16,
    borderWidth: 1,
    borderColor: '#FFF176',
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FFF8E1',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  body: { flex: 1, gap: 2 },
  heading: {
    ...t.small,
    color: '#F57F17',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  venueName: { ...t.body, fontWeight: '600', color: color.ink },
  areaLabel: { ...t.small, color: color.mute },
  description: { ...t.small, color: color.mute },
  noMeeting: { ...t.small, color: color.faint, fontStyle: 'italic' },
  actions: { flexDirection: 'row', gap: 4, paddingTop: 4 },
  actionBtn: { padding: 4 },
});

const m = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderColor: color.haze,
  },
  title: { ...t.body, fontWeight: '700', color: color.ink },
  body: { gap: 20, padding: 16 },
  field: { gap: 6 },
  fieldLabel: { ...t.small, color: color.mute, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: 12,
    ...t.body,
    color: color.ink,
    backgroundColor: '#fff',
  },
  textarea: { height: 80, textAlignVertical: 'top' },
});
