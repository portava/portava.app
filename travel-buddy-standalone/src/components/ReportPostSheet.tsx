import React, { useState } from 'react';
import {
  View, Text, Pressable, StyleSheet,
  Modal, Alert, ActivityIndicator, ScrollView, TextInput,
} from 'react-native';
import { X } from 'lucide-react-native';
import { reportContent, type ReasonCode } from '../services/reports';
import { color, space, radius, type as t } from '../theme/tokens';
import {
  INITIAL_REPORT_SHEET_STATE,
  canSubmitReport,
  resetReportSheet,
  REPORT_POST_REASONS,
} from './ReportPostSheet.state';

export { REPORT_POST_REASONS };

export function ReportPostSheet({
  postId,
  visible,
  onClose,
}: {
  postId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const [reason, setReason]       = useState<ReasonCode | null>(INITIAL_REPORT_SHEET_STATE.reason);
  const [detail, setDetail]       = useState(INITIAL_REPORT_SHEET_STATE.detail);
  const [submitting, setSubmitting] = useState(INITIAL_REPORT_SHEET_STATE.submitting);
  const [done, setDone]           = useState(INITIAL_REPORT_SHEET_STATE.done);

  function reset() {
    const s = resetReportSheet();
    setReason(s.reason);
    setDetail(s.detail);
    setSubmitting(s.submitting);
    setDone(s.done);
  }

  function handleClose() {
    onClose();
    reset();
  }

  async function submit() {
    if (!canSubmitReport({ reason, detail, submitting, done })) return;
    setSubmitting(true);
    const res = await reportContent({
      target_type: 'post',
      target_id: postId,
      reason_code: reason!,
      reason_detail: detail.trim() || undefined,
    });
    setSubmitting(false);
    if (res.ok) {
      setDone(true);
      setTimeout(() => handleClose(), 2500);
    } else {
      Alert.alert('Error', res.error ?? 'Could not submit report');
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
      <View style={rps.overlay}>
        <Pressable style={{ flex: 1 }} onPress={handleClose} />
        <View style={rps.sheet}>
          <View style={rps.handle} />
          {done ? (
            <View style={rps.doneWrap}>
              <Text style={rps.doneIcon}>✓</Text>
              <Text style={rps.doneTitle}>Report submitted</Text>
              <Text style={rps.doneSub}>Thank you — our team will review this shortly.</Text>
            </View>
          ) : (
            <>
              <View style={rps.header}>
                <Text style={rps.title}>Report post</Text>
                <Pressable onPress={handleClose} hitSlop={8}>
                  <X size={20} color={color.ink} />
                </Pressable>
              </View>
              <Text style={rps.sub}>Why are you reporting this post?</Text>
              <ScrollView showsVerticalScrollIndicator={false}>
                {REPORT_POST_REASONS.map((r) => (
                  <Pressable
                    key={r.code}
                    style={[rps.reasonRow, reason === r.code && rps.reasonRowSelected]}
                    onPress={() => setReason(r.code)}
                  >
                    <Text style={[rps.reasonLabel, reason === r.code && rps.reasonLabelSelected]}>
                      {r.label}
                    </Text>
                    {reason === r.code && <Text style={rps.check}>✓</Text>}
                  </Pressable>
                ))}
                {reason === 'other' && (
                  <TextInput
                    style={rps.detailInput}
                    placeholder="Tell us more (optional)"
                    placeholderTextColor={color.mute}
                    value={detail}
                    onChangeText={setDetail}
                    multiline
                    maxLength={500}
                  />
                )}
              </ScrollView>
              <Pressable
                style={[rps.submitBtn, !canSubmitReport({ reason, detail, submitting, done }) && rps.submitBtnDisabled]}
                onPress={submit}
                disabled={!canSubmitReport({ reason, detail, submitting, done })}
              >
                {submitting
                  ? <ActivityIndicator size="small" color={color.onInk} />
                  : <Text style={rps.submitLabel}>Submit report</Text>}
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const rps = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: color.paperRaised, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: space.lg, paddingBottom: 34, paddingTop: space.sm, maxHeight: '80%',
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.sm },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 15 },
  sub: { ...t.small, color: color.mute, marginBottom: space.md },
  reasonRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 11, paddingHorizontal: space.sm,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, marginBottom: 6,
  },
  reasonRowSelected: { borderColor: color.signal, backgroundColor: `${color.signal}08` },
  reasonLabel: { ...t.body, color: color.ink },
  reasonLabelSelected: { color: color.signal, fontWeight: '700' },
  check: { color: color.signal, fontWeight: '700', fontSize: 14 },
  detailInput: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, ...t.body, color: color.ink, minHeight: 80, marginBottom: space.sm,
  },
  submitBtn: {
    marginTop: space.md, backgroundColor: color.signal,
    borderRadius: radius.md, paddingVertical: 13, alignItems: 'center',
  },
  submitBtnDisabled: { opacity: 0.45 },
  submitLabel: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  doneWrap: { alignItems: 'center', paddingVertical: space.xl },
  doneIcon: { fontSize: 40, marginBottom: space.sm },
  doneTitle: { ...t.title, color: color.ink, fontWeight: '700', marginBottom: 4 },
  doneSub: { ...t.body, color: color.mute, textAlign: 'center' },
});
