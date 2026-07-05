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
import { MapPin, ExternalLink, Edit2, X, Check, Search } from 'lucide-react-native';
import type { MeetingPoint } from '../../services/circle';
import { postMeetingPoint, patchMeetingPoint } from '../../services/circle';
import { GlobalPlacePicker } from '../selectors/GlobalPlacePicker';
import type { Place } from '../../lib/location/placeTypes';
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
  /** Coordinates from place-picker selection; null until host picks a venue. */
  lat: number | null;
  lng: number | null;
}

export function MeetingPointCard({
  meetingPoint,
  contextType,
  contextId,
  onUpdate,
  showUpdateAction = false,
}: Props) {
  const [editOpen, setEditOpen] = useState(false);
  const [placePickerOpen, setPlacePickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editState, setEditState] = useState<EditState>({
    venueLabel: '',
    approximateLabel: '',
    description: '',
    lat: null,
    lng: null,
  });

  if (!meetingPoint && !showUpdateAction) return null;

  function openEdit() {
    setEditState({
      venueLabel: meetingPoint?.venueLabel ?? '',
      approximateLabel: meetingPoint?.approximateLabel ?? '',
      description: meetingPoint?.description ?? '',
      lat: meetingPoint?.lat ?? null,
      lng: meetingPoint?.lng ?? null,
    });
    setEditOpen(true);
  }

  function handlePlaceSelect(place: Place) {
    setEditState((p) => ({
      ...p,
      venueLabel: place.displayName ?? place.name,
      lat: place.lat,
      lng: place.lng,
    }));
    setPlacePickerOpen(false);
  }

  function openDirections() {
    if (!meetingPoint) return;
    let url: string;
    if (meetingPoint.lat !== null && meetingPoint.lng !== null) {
      // Coordinate-based directions URL — opens routing to the exact venue pin.
      url = `https://maps.google.com/maps?daddr=${meetingPoint.lat},${meetingPoint.lng}`;
    } else {
      // Fallback: text search when coordinates are not yet persisted (V1 DB has no coordinate columns).
      const query = meetingPoint.venueLabel ?? meetingPoint.approximateLabel ?? '';
      if (!query) return;
      url = `https://maps.google.com/?q=${encodeURIComponent(query)}`;
    }
    Linking.openURL(url).catch(() =>
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
        // Merge in local coordinates from place-picker (backend V1 cannot persist them yet).
        onUpdate({ ...res.data, lat: editState.lat, lng: editState.lng });
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

      {/* Host edit sheet */}
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
            {/* Venue search — tapping opens GlobalPlacePicker */}
            <View style={m.field}>
              <Text style={m.fieldLabel}>Venue</Text>
              <Pressable style={m.searchRow} onPress={() => setPlacePickerOpen(true)}>
                <Search size={15} color={color.mute} />
                <Text
                  style={[m.searchText, !editState.venueLabel && m.searchPlaceholder]}
                  numberOfLines={1}
                >
                  {editState.venueLabel || 'Search for a venue…'}
                </Text>
              </Pressable>
              {editState.lat !== null && editState.lng !== null && (
                <Text style={m.coordHint}>📍 Coordinates saved — directions will open to exact pin.</Text>
              )}
            </View>

            <View style={m.field}>
              <Text style={m.fieldLabel}>Area or landmark (optional)</Text>
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

      {/* Venue search picker */}
      <GlobalPlacePicker
        visible={placePickerOpen}
        onSelect={handlePlaceSelect}
        onClose={() => setPlacePickerOpen(false)}
        title="Search meeting point venue"
        allowGPS={false}
        placeholder="Search bar, café, landmark…"
        usedFor="circle_meeting_point"
      />
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
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: color.signal,
    borderRadius: radius.md,
    padding: 12,
    backgroundColor: '#fff',
  },
  searchText: { ...t.body, color: color.ink, flex: 1 },
  searchPlaceholder: { color: color.faint },
  coordHint: { ...t.small, color: '#2E7D32', marginTop: 2 },
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
