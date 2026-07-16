import React from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../theme/tokens';

interface Props {
  visible: boolean;
  displayName: string;
  isRestricted: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

export function RestrictUserSheet({ visible, displayName, isRestricted, onConfirm, onCancel, loading }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>{isRestricted ? 'Unrestrict' : 'Restrict'} {displayName}?</Text>
          <Text style={styles.body}>
            {isRestricted
              ? 'Their interactions with you will be visible to others again.'
              : 'Their comments and messages will be hidden from others. They won\'t know they\'re restricted.'}
          </Text>
          <Pressable
            style={[styles.btn, styles.action, loading && styles.btnDisabled]}
            onPress={onConfirm}
            disabled={loading}
          >
            <Text style={styles.actionText}>
              {loading
                ? (isRestricted ? 'Unrestricting…' : 'Restricting…')
                : (isRestricted ? 'Unrestrict' : 'Restrict')}
            </Text>
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
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: space.xl,
    gap: space.md,
  },
  title: { ...t.heading, fontSize: 17, color: color.ink, textAlign: 'center' },
  body: { fontSize: 14, color: color.mute, textAlign: 'center', lineHeight: 20 },
  btn: { alignItems: 'center', padding: space.md, borderRadius: radius.md, backgroundColor: color.haze },
  btnDisabled: { opacity: 0.5 },
  action: { backgroundColor: color.deep },
  actionText: { ...t.bodyStrong, color: color.onInk, fontSize: 15 },
  cancelText: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
});
