/**
 * Telegraph §30A.6 — the per-thread notification choice.
 *
 * Offers ONLY what the server says this deployment can store: on a database
 * without migration 3760 that is All and Muted; with it and its flag on, also
 * Mentions only, Important only and a temporary mute. Every state is honest:
 *   - loading: a spinner, no choices;
 *   - a failed read: the reason and Try again, and NO choices — offering
 *     options over an unknown current state invites a change from a value that
 *     is not the person's;
 *   - a choice saves immediately and the sheet then shows what the server READ
 *     BACK; a refused save says so and changes nothing on screen.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, space, type as t } from '../../../theme/tokens.ts'; import { useTelegraphTheme, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import {
  LEVEL_COPY,
  SAFETY_COPY,
  fetchThreadNotificationPolicy,
  muteDurationLabel,
  setThreadNotificationPolicy,
  type ThreadNotificationLevel,
  type ThreadNotificationPolicy,
} from './threadNotificationApi.ts';

export interface ThreadNotificationSheetProps {
  visible: boolean;
  threadId: string | null;
  onClose: () => void;
  /** Told what the server holds after a successful save (e.g. to update a mute icon). */
  onChanged?: (policy: ThreadNotificationPolicy) => void;
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; policy: ThreadNotificationPolicy };

export function ThreadNotificationSheet({ visible, threadId, onClose, onChanged }: ThreadNotificationSheetProps) {
  const { palette, styles } = useTelegraphTheme(makeStyles);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const read = useCallback(async () => {
    if (!threadId) return;
    setLoad({ status: 'loading' });
    const r = await fetchThreadNotificationPolicy(threadId);
    setLoad(r.ok ? { status: 'ready', policy: r.data } : { status: 'error', message: r.message ?? 'We could not read this setting.' });
  }, [threadId]);

  useEffect(() => {
    if (visible) void read();
  }, [visible, read]);

  const choose = async (level: ThreadNotificationLevel, muteForMinutes: number | null = null) => {
    if (!threadId || saving) return;
    setSaving(true);
    setSaveError(null);
    const r = await setThreadNotificationPolicy(threadId, level, muteForMinutes);
    setSaving(false);
    if (r.ok) {
      setLoad({ status: 'ready', policy: r.data });
      onChanged?.(r.data);
    } else {
      setSaveError(r.message ?? 'Your choice was not saved. Nothing was changed.');
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close notification settings" />
      <View style={styles.sheet} testID="thread-notification-sheet">
        <Text style={styles.title} accessibilityRole="header">Notifications for this conversation</Text>
        {load.status === 'loading' ? (
          <ActivityIndicator testID="thread-notification-loading" color={palette.operational} />
        ) : load.status === 'error' ? (
          <View testID="thread-notification-error">
            <Text style={styles.error}>{load.message}</Text>
            <Pressable onPress={() => { void read(); }} accessibilityRole="button" style={styles.retry}>
              <Text style={styles.retryLabel}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <View>
            {load.policy.levelsAvailable.map((level) => {
              const selected = load.policy.level === level;
              return (
                <Pressable
                  key={level}
                  testID={`thread-notification-level-${level}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, disabled: saving }}
                  disabled={saving}
                  onPress={() => { void choose(level); }}
                  style={[styles.row, selected && styles.rowSelected]}
                >
                  <Text style={styles.rowLabel}>{LEVEL_COPY[level].label}{selected ? ' ✓' : ''}</Text>
                  <Text style={styles.rowSub}>{LEVEL_COPY[level].sub}</Text>
                </Pressable>
              );
            })}
            {load.policy.temporaryMuteAvailable ? (
              <View style={styles.tempRow}>
                {load.policy.temporaryMuteMinutes.map((m) => (
                  <Pressable
                    key={m}
                    testID={`thread-notification-mute-${m}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Mute for ${muteDurationLabel(m)}`}
                    disabled={saving}
                    onPress={() => { void choose(load.policy.level === 'MUTED' ? 'ALL' : load.policy.level, m); }}
                    style={styles.chip}
                  >
                    <Text style={styles.chipLabel}>Mute {muteDurationLabel(m)}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {load.policy.temporaryMuteActive && load.policy.mutedUntil ? (
              <Text style={styles.rowSub} testID="thread-notification-temp-active">
                Muted until {new Date(load.policy.mutedUntil).toLocaleString()}
              </Text>
            ) : null}
          </View>
        )}
        {saveError ? <Text style={styles.error} testID="thread-notification-save-error">{saveError}</Text> : null}
        <Text style={styles.safety}>{SAFETY_COPY}</Text>
      </View>
    </Modal>
  );
}

const makeStyles = (p: TelegraphPalette) => StyleSheet.create({ // census T123/T124: the scheme's palette; Try again is ordinary emphasis (teal)
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { backgroundColor: p.surface, padding: space.lg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, gap: space.sm },
  title: { ...t.bodyStrong, color: p.recvText },
  row: { paddingVertical: space.sm, minHeight: 44 },
  rowSelected: { opacity: 1 },
  rowLabel: { ...t.body, color: p.recvText },
  rowSub: { ...t.small, color: p.mute },
  tempRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  chip: { paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: p.haze, minHeight: 44, justifyContent: 'center' },
  chipLabel: { ...t.small, color: p.recvText },
  error: { ...t.small, color: p.recvText, fontWeight: '600' },
  retry: { paddingVertical: space.xs, minHeight: 44, justifyContent: 'center' },
  retryLabel: { ...t.small, color: p.operational, fontWeight: '700' },
  safety: { ...t.small, color: p.mute, marginTop: space.sm },
});

export default ThreadNotificationSheet;
