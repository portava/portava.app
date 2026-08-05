/**
 * ConfirmSheet — the generic in-app confirmation modal.
 *
 * QA round 2, minor F: `app/layover/[id].tsx` used a raw `window.confirm()` on web
 * ("End this layover? Your plan stays saved."), which renders the browser chrome
 * instead of the app's visual language and blocks the JS thread while open.
 * The app already had exactly one confirm modal —
 * `src/components/interaction/BlockUserConfirmSheet.tsx` — but its copy is
 * hard-coded to blocking a user, so it could not be reused. This is that same
 * component with the copy lifted into props.
 *
 * Native code paths can keep using `Alert.alert` (it is the platform idiom);
 * this exists so web has an equivalent that looks like the rest of Portava.
 */
import React from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

export interface ConfirmSheetProps {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm action in the destructive (red) treatment. */
  destructive?: boolean;
  /** Disables the confirm button and swaps in `loadingLabel`. */
  loading?: boolean;
  loadingLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
  loadingLabel,
  onConfirm,
  onCancel,
}: ConfirmSheetProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel={cancelLabel}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>{title}</Text>
          {body ? <Text style={styles.body}>{body}</Text> : null}
          <Pressable
            style={[styles.btn, destructive && styles.destructive, loading && styles.btnDisabled]}
            onPress={onConfirm}
            disabled={loading}
            accessibilityRole="button"
          >
            <Text style={destructive ? styles.destructiveText : styles.confirmText}>
              {loading ? (loadingLabel ?? `${confirmLabel}…`) : confirmLabel}
            </Text>
          </Pressable>
          <Pressable style={styles.btn} onPress={onCancel} accessibilityRole="button">
            <Text style={styles.cancelText}>{cancelLabel}</Text>
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
  confirmText: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  cancelText: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
});
