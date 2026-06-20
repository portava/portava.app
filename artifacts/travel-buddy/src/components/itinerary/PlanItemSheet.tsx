import React, { useState } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, TextInput,
  KeyboardAvoidingView, Platform, Alert, StyleSheet,
} from 'react-native';
import {
  MapPin, Clock, Tag, FileText, AlertTriangle, Pencil, Trash2, X, CheckCircle2,
} from 'lucide-react-native';
import type { TripPlanItem, TripPlanItemStatus, TripPlanCategory } from '../../types/models';
import { updatePlanItem, removePlanItem } from '../../services/tripPlan';
import { color, space, radius, type as t } from '../../theme/tokens';

// ── Category / status maps ────────────────────────────────────────────────────

const CAT_LABEL: Record<TripPlanCategory, string> = {
  accommodation: 'Stay',
  activity:      'Activity',
  dining:        'Dining',
  transport:     'Transport',
  free_time:     'Free time',
  meeting_point: 'Meetup',
  other:         'Other',
};

const CAT_COLOR: Record<TripPlanCategory, { bg: string; fg: string }> = {
  accommodation: { bg: '#E2EDF0', fg: color.deep },
  activity:      { bg: '#E3F1EA', fg: color.success },
  dining:        { bg: '#FCE9E4', fg: color.signal },
  transport:     { bg: '#EFE7FA', fg: '#7A4DBF' },
  free_time:     { bg: '#F5F0E8', fg: '#8B6914' },
  meeting_point: { bg: '#FFF0D0', fg: '#B07000' },
  other:         { bg: color.haze, fg: color.mute },
};

const STATUS_LABEL: Record<TripPlanItemStatus, string> = {
  confirmed: 'Confirmed',
  tentative: 'Tentative',
  done:      'Done',
  cancelled: 'Cancelled',
};

const STATUS_COLOR: Record<TripPlanItemStatus, { bg: string; fg: string }> = {
  confirmed: { bg: '#E3F1EA', fg: color.success },
  tentative: { bg: '#F5F0E8', fg: '#8B6914' },
  done:      { bg: color.haze, fg: color.mute },
  cancelled: { bg: '#FCE9E4', fg: '#B0291A' },
};

const WARN_LABEL: Record<string, string> = {
  time_overlap:       '⚠ Time conflict with another item',
  duplicate:          '⚠ Duplicate source item in plan',
  outside_trip_dates: '⚠ Scheduled outside trip dates',
};

const STATUS_OPTIONS: TripPlanItemStatus[] = ['tentative', 'confirmed', 'done', 'cancelled'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDateTime(isoDate: string | null, isoTime: string | null): string | null {
  const d = isoDate ? new Date(isoDate + 'T00:00:00') : null;
  if (!d || isNaN(d.getTime())) return null;
  const datePart = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  if (!isoTime) return datePart;
  const t = new Date(isoTime);
  if (isNaN(t.getTime())) return datePart;
  return `${datePart}, ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

// ── Edit form ─────────────────────────────────────────────────────────────────

function EditForm({
  item, tripId, onSaved, onCancel,
}: {
  item: TripPlanItem;
  tripId: string;
  onSaved: (updated: TripPlanItem) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [dayDate, setDayDate] = useState(item.dayDate ?? '');
  const [startsAt, setStartsAt] = useState(
    item.startsAt
      ? new Date(item.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : ''
  );
  const [status, setStatus] = useState<TripPlanItemStatus>(item.status);
  const [notes, setNotes] = useState(item.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const handleSave = async () => {
    if (!title.trim()) { setErr('Title is required'); return; }
    setErr('');
    setSubmitting(true);
    try {
      const updated = await updatePlanItem(tripId, item.id, {
        title: title.trim(),
        dayDate: dayDate.trim() || null,
        startsAt: dayDate.trim() && startsAt.trim() ? `${dayDate.trim()}T${startsAt.trim()}:00` : null,
        status,
        notes: notes.trim() || null,
      });
      onSaved(updated);
    } catch (e: any) {
      setErr(e.message ?? 'Could not save');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={ef.wrap}>
      <View style={ef.row}>
        <Text style={ef.sectionLabel}>Edit Item</Text>
        <Pressable onPress={onCancel} hitSlop={8}>
          <X size={18} color={color.mute} />
        </Pressable>
      </View>

      <Text style={ef.label}>Title</Text>
      <TextInput style={ef.input} value={title} onChangeText={setTitle} placeholderTextColor={color.faint} />

      <Text style={ef.label}>Date <Text style={ef.opt}>(YYYY-MM-DD)</Text></Text>
      <TextInput style={ef.input} value={dayDate} onChangeText={setDayDate} placeholder="e.g. 2026-07-15" placeholderTextColor={color.faint} keyboardType="numbers-and-punctuation" />

      <Text style={ef.label}>Time <Text style={ef.opt}>(HH:MM, 24-hour)</Text></Text>
      <TextInput style={ef.input} value={startsAt} onChangeText={setStartsAt} placeholder="e.g. 19:30" placeholderTextColor={color.faint} keyboardType="numbers-and-punctuation" />

      <Text style={ef.label}>Status</Text>
      <View style={ef.statusRow}>
        {STATUS_OPTIONS.map((s) => (
          <Pressable key={s} style={[ef.statusChip, status === s && ef.statusChipActive]} onPress={() => setStatus(s)}>
            <Text style={[ef.statusChipText, status === s && ef.statusChipTextActive]}>{STATUS_LABEL[s]}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={ef.label}>Notes <Text style={ef.opt}>(optional)</Text></Text>
      <TextInput
        style={[ef.input, ef.inputMulti]} value={notes} onChangeText={setNotes}
        placeholder="Any extra details…" placeholderTextColor={color.faint}
        multiline numberOfLines={3} textAlignVertical="top"
      />

      {err ? <Text style={ef.error}>{err}</Text> : null}

      <Pressable style={[ef.saveBtn, submitting && ef.saveBtnDim]} onPress={handleSave} disabled={submitting}>
        <Text style={ef.saveText}>{submitting ? 'Saving…' : 'Save Changes'}</Text>
      </Pressable>
    </View>
  );
}

// ── Main sheet ────────────────────────────────────────────────────────────────

export interface PlanItemSheetProps {
  item: TripPlanItem | null;
  tripId: string;
  currentUserId: string;
  isOwner: boolean;
  onClose: () => void;
  onUpdated: (updated: TripPlanItem) => void;
  onRemoved: (id: string) => void;
}

export function PlanItemSheet({
  item, tripId, currentUserId, isOwner, onClose, onUpdated, onRemoved,
}: PlanItemSheetProps) {
  const [editing, setEditing] = useState(false);

  if (!item) return null;

  const canAct = isOwner || item.creatorId === currentUserId;
  const cat = CAT_COLOR[item.category] ?? CAT_COLOR.other;
  const st  = STATUS_COLOR[item.status] ?? STATUS_COLOR.tentative;
  const dateTimeStr = fmtDateTime(item.dayDate, item.startsAt);

  const handleRemove = () => {
    Alert.alert('Remove item', 'Remove this item from the trip plan?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          try {
            await removePlanItem(tripId, item.id);
            onRemoved(item.id);
            onClose();
          } catch (e: any) {
            Alert.alert('Error', e.message ?? 'Could not remove item');
          }
        },
      },
    ]);
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={sh.overlay} onPress={onClose} />
        <View style={sh.sheet}>
          <View style={sh.handle} />

          {/* Header */}
          <View style={sh.header}>
            <Pressable onPress={onClose} hitSlop={8} style={sh.closeBtn}>
              <X size={20} color={color.mute} />
            </Pressable>
            {canAct && !editing && (
              <View style={sh.actionBtns}>
                <Pressable style={sh.editBtn} onPress={() => setEditing(true)}>
                  <Pencil size={14} color={color.deep} />
                  <Text style={sh.editBtnText}>Edit</Text>
                </Pressable>
                <Pressable style={sh.removeBtn} onPress={handleRemove}>
                  <Trash2 size={14} color={color.signal} />
                  <Text style={sh.removeBtnText}>Remove</Text>
                </Pressable>
              </View>
            )}
          </View>

          <ScrollView
            contentContainerStyle={sh.body}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {editing ? (
              <EditForm
                item={item}
                tripId={tripId}
                onSaved={(updated) => { setEditing(false); onUpdated(updated); }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
                {/* Warnings */}
                {item.warnings.length > 0 && (
                  <View style={sh.warnBox}>
                    {item.warnings.map((w) => (
                      <View key={w} style={sh.warnRow}>
                        <AlertTriangle size={13} color="#B07000" />
                        <Text style={sh.warnText}>{WARN_LABEL[w] ?? w}</Text>
                      </View>
                    ))}
                  </View>
                )}

                {/* Title */}
                <Text style={sh.title}>{item.title}</Text>

                {/* Badges */}
                <View style={sh.badgeRow}>
                  <View style={[sh.badge, { backgroundColor: cat.bg }]}>
                    <Text style={[sh.badgeText, { color: cat.fg }]}>{CAT_LABEL[item.category] ?? 'Other'}</Text>
                  </View>
                  <View style={[sh.badge, { backgroundColor: st.bg }]}>
                    <Text style={[sh.badgeText, { color: st.fg }]}>{STATUS_LABEL[item.status] ?? item.status}</Text>
                  </View>
                  {item.sourceType !== 'manual' && (
                    <View style={[sh.badge, { backgroundColor: color.haze }]}>
                      <Tag size={10} color={color.mute} />
                      <Text style={[sh.badgeText, { color: color.mute }]}>
                        {item.sourceType === 'meetup' ? 'From Meetup' : 'From Place'}
                      </Text>
                    </View>
                  )}
                </View>

                {/* Date / time */}
                {dateTimeStr && (
                  <View style={sh.field}>
                    <Clock size={14} color={color.mute} style={sh.fieldIcon} />
                    <Text style={sh.fieldText}>{dateTimeStr}</Text>
                  </View>
                )}

                {/* Location */}
                {item.locationName && (
                  <View style={sh.field}>
                    <MapPin size={14} color={color.mute} style={sh.fieldIcon} />
                    <Text style={sh.fieldText}>{item.locationName}</Text>
                    {item.locationIsPrivate && (
                      <Text style={sh.privateTag}> · Private</Text>
                    )}
                  </View>
                )}

                {/* Notes */}
                {item.notes && (
                  <View style={sh.notesBox}>
                    <View style={sh.field}>
                      <FileText size={14} color={color.mute} style={sh.fieldIcon} />
                      <Text style={sh.notesLabel}>Notes</Text>
                    </View>
                    <Text style={sh.notesText}>{item.notes}</Text>
                  </View>
                )}

                {/* Source ID for non-manual items */}
                {item.sourceId && (
                  <Text style={sh.sourceHint}>Source ID: {item.sourceId}</Text>
                )}

                {/* Status quick-change */}
                {canAct && (
                  <View style={sh.statusSection}>
                    <Text style={sh.statusLabel}>Status</Text>
                    <View style={sh.statusRow}>
                      {STATUS_OPTIONS.filter((s) => s !== item.status).map((s) => {
                        const sc = STATUS_COLOR[s];
                        return (
                          <Pressable
                            key={s}
                            style={[sh.statusChip, { backgroundColor: sc.bg }]}
                            onPress={async () => {
                              try {
                                const updated = await updatePlanItem(tripId, item.id, { status: s });
                                onUpdated(updated);
                              } catch {}
                            }}
                          >
                            <CheckCircle2 size={11} color={sc.fg} />
                            <Text style={[sh.statusChipText, { color: sc.fg }]}>
                              Mark {STATUS_LABEL[s]}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                )}
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const sh = StyleSheet.create({
  overlay:       { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet:         { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '90%' },
  handle:        { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginTop: 10, marginBottom: 4 },
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.sm },
  closeBtn:      { padding: 4 },
  actionBtns:    { flexDirection: 'row', gap: 8, marginLeft: 'auto' },
  editBtn:       { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#E9F0FB', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  editBtnText:   { ...t.small, color: color.deep, fontWeight: '600' },
  removeBtn:     { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FDEAEA', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  removeBtnText: { ...t.small, color: color.signal, fontWeight: '600' },
  body:          { paddingHorizontal: space.lg, paddingBottom: 40, gap: 12 },
  warnBox:       { backgroundColor: '#FFF8E7', borderRadius: radius.md, padding: 10, gap: 4 },
  warnRow:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  warnText:      { ...t.small, color: '#8B6914', flex: 1 },
  title:         { ...t.title, fontSize: 20, color: color.ink },
  badgeRow:      { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge:         { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText:     { ...t.small, fontWeight: '600', fontSize: 11 },
  field:         { flexDirection: 'row', alignItems: 'center', gap: 6 },
  fieldIcon:     {},
  fieldText:     { ...t.body, color: color.ink, flex: 1 },
  privateTag:    { ...t.small, color: color.mute },
  notesBox:      { gap: 4 },
  notesLabel:    { ...t.small, color: color.mute, fontWeight: '600' },
  notesText:     { ...t.body, color: color.ink, lineHeight: 22 },
  sourceHint:    { ...t.small, color: color.faint },
  statusSection: { gap: 8, marginTop: 4 },
  statusLabel:   { ...t.small, color: color.mute, fontWeight: '600' },
  statusRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  statusChip:    { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  statusChipText:{ ...t.small, fontWeight: '600', fontSize: 11 },
});

const ef = StyleSheet.create({
  wrap:             { gap: 10 },
  row:              { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  sectionLabel:     { ...t.title, fontSize: 16, color: color.ink },
  label:            { ...t.small, color: color.mute, fontWeight: '600', marginTop: 2 },
  opt:              { fontWeight: '400', color: color.faint },
  input:            { backgroundColor: color.haze, borderRadius: radius.md, padding: 10, ...t.body, color: color.ink },
  inputMulti:       { minHeight: 72 },
  statusRow:        { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  statusChip:       { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: color.haze },
  statusChipActive: { backgroundColor: color.deep },
  statusChipText:   { ...t.small, color: color.mute, fontWeight: '600' },
  statusChipTextActive: { color: '#fff' },
  error:            { ...t.small, color: color.signal },
  saveBtn:          { backgroundColor: color.deep, borderRadius: radius.md, padding: 13, alignItems: 'center', marginTop: 4 },
  saveBtnDim:       { opacity: 0.55 },
  saveText:         { ...t.body, color: '#fff', fontWeight: '700' },
});
