import React, { useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, TextInput, StyleSheet } from 'react-native';
import { REPORT_REASON_LABELS, type ReportReason } from '../../services/reports';
import { color, space, radius, type as t } from '../../theme/tokens';

interface Props {
  visible: boolean;
  displayName: string;
  onSubmit: (reason: ReportReason, details?: string) => void;
  onCancel: () => void;
  loading?: boolean;
}

const REASONS = Object.entries(REPORT_REASON_LABELS) as [ReportReason, string][];

export function ReportUserSheet({ visible, displayName, onSubmit, onCancel, loading }: Props) {
  const [selected, setSelected] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');

  function handleSubmit() {
    if (!selected) return;
    onSubmit(selected, details.trim() || undefined);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>Report {displayName}</Text>
          <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
            {REASONS.map(([value, label]) => (
              <Pressable
                key={value}
                style={[styles.option, selected === value && styles.optionSelected]}
                onPress={() => setSelected(value)}
              >
                <Text style={[styles.optionText, selected === value && styles.optionTextSelected]}>
                  {label}
                </Text>
              </Pressable>
            ))}
            {selected === 'other' && (
              <TextInput
                style={styles.input}
                placeholder="Describe the issue…"
                placeholderTextColor={color.mute}
                value={details}
                onChangeText={setDetails}
                multiline
                numberOfLines={3}
              />
            )}
          </ScrollView>
          <View style={styles.row}>
            <Pressable style={[styles.btn, styles.cancel]} onPress={onCancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, styles.submit, (!selected || loading) && styles.btnDisabled]}
              onPress={handleSubmit}
              disabled={!selected || loading}
            >
              <Text style={styles.submitText}>{loading ? 'Sending…' : 'Submit'}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.xl,
    gap: space.md,
  },
  title: { ...t.heading, fontSize: 17, color: color.ink, textAlign: 'center' },
  option: {
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    marginBottom: space.sm,
  },
  optionSelected: { borderColor: color.signal, backgroundColor: color.signal + '11' },
  optionText: { fontSize: 14, color: color.ink },
  optionTextSelected: { color: color.signal, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
    fontSize: 14,
    color: color.ink,
    minHeight: 72,
    textAlignVertical: 'top',
    marginTop: space.sm,
  },
  row: { flexDirection: 'row', gap: space.md },
  btn: { flex: 1, alignItems: 'center', padding: space.md, borderRadius: radius.md },
  btnDisabled: { opacity: 0.4 },
  cancel: { backgroundColor: color.haze },
  submit: { backgroundColor: color.signal },
  cancelText: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  submitText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
});
