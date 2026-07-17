/**
 * ReasonPromptModal — cross-platform replacement for Alert.prompt.
 *
 * Alert.prompt is iOS-only (a silent no-op on Android and web), so any flow
 * that needs a free-text reason must use this modal instead. Pattern mirrors
 * the reject-reason modal in app/admin/stamps/[catalogId].tsx.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export function ReasonPromptModal({
  visible,
  title,
  message,
  placeholder = 'Reason',
  confirmLabel = 'Confirm',
  requireValue = true,
  destructive = false,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  message?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** When true (default) the confirm button is disabled until text is entered. */
  requireValue?: boolean;
  destructive?: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  // Guards against a fast double-tap on the confirm button firing onSubmit
  // twice before the parent closes the modal.
  const submittedRef = useRef(false);

  // Reset the input (and the submit-once guard) each time the modal opens.
  useEffect(() => {
    if (visible) {
      setValue('');
      submittedRef.current = false;
    }
  }, [visible]);

  const trimmed = value.trim();
  const disabled = requireValue && !trimmed;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card} testID="reason-modal">
          <Text style={styles.title}>{title}</Text>
          {message ? <Text style={styles.subtitle}>{message}</Text> : null}
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            placeholderTextColor="#9CA3AF"
            multiline
            autoFocus
            testID="reason-input"
          />
          <View style={styles.btnRow}>
            <Pressable style={[styles.btn, styles.btnCancel]} onPress={onCancel} testID="reason-cancel-btn">
              <Text style={styles.btnCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.btn, destructive ? styles.btnDestructive : styles.btnConfirm, disabled && styles.btnDisabled]}
              onPress={() => {
                if (disabled || submittedRef.current) return;
                submittedRef.current = true;
                onSubmit(trimmed);
              }}
              disabled={disabled}
              testID="reason-confirm-btn"
            >
              <Text style={styles.btnConfirmText}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop:      { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: 24 },
  card:          { backgroundColor: '#fff', borderRadius: 12, padding: 16, gap: 10 },
  title:         { fontSize: 16, fontWeight: '700', color: '#111827' },
  subtitle:      { fontSize: 13, color: '#6B7280' },
  input:         { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, padding: 10, minHeight: 72, color: '#111827', textAlignVertical: 'top' },
  btnRow:        { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  btn:           { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  btnCancel:     { backgroundColor: '#F3F4F6' },
  btnCancelText: { color: '#111827', fontSize: 13, fontWeight: '700' },
  btnConfirm:    { backgroundColor: '#3B82F6' },
  btnDestructive:{ backgroundColor: '#EF4444' },
  btnConfirmText:{ color: '#fff', fontSize: 13, fontWeight: '700' },
  btnDisabled:   { opacity: 0.5 },
});

export default ReasonPromptModal;
