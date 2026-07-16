import React from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  visible: boolean;
  displayName: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export function BlockUserConfirmSheet({ visible, displayName, onConfirm, onCancel, loading }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>Block {displayName}?</Text>
          <Text style={styles.body}>
            They won't be able to find your profile, send you messages, or see your content. They won't be notified.
          </Text>
          <Pressable
            style={[styles.btn, styles.destructive, loading && styles.btnDisabled]}
            onPress={onConfirm}
            disabled={loading}
          >
            <Text style={styles.destructiveText}>{loading ? 'Blocking…' : 'Block'}</Text>
          </Pressable>
          <Pressable style={styles.btn} onPress={onCancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
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
  title: {
    ...t.heading,
    fontSize: 17,
    color: color.ink,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 20,
  },
  btn: {
    alignItems: 'center',
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.haze,
  },
  btnDisabled: { opacity: 0.5 },
  destructive: { backgroundColor: '#FEE2E2' },
  destructiveText: { ...t.bodyStrong, color: '#DC2626', fontSize: 15 },
  cancelText: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
});
