/**
 * Telegraph §30A.12 — "Large groups may support slow mode, host-only posting, media/link restrictions,
 * member moderation" (census T417), the host's and the member's view.
 *
 * A HOST sets the four controls; each change saves at once and the sheet then shows what the server
 * READ BACK. A MEMBER sees which controls are on and their own mute, and can change nothing — the
 * sheet offers no control a member could press only to be refused. Muting and removing a member are
 * offered from that member's message (the long-press sheet), never as a roster here.
 *
 * Honest in each state: loading; a failed read says so with Try again and shows no controls (an
 * unreadable setting is not "no settings"); a refused save says so and nothing changes on screen.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, space, type as t } from '../../../theme/tokens.ts';
import { useTelegraphTheme, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import {
  SLOW_MODE_CHOICES,
  fetchGroupControls,
  setGroupControls,
  slowModeLabel,
  type AudiencePolicy,
  type GroupControls,
  type GroupControlsState,
} from './groupControlsApi.ts';

export interface GroupControlsSheetProps {
  visible: boolean;
  threadId: string | null;
  onClose: () => void;
  /** Told what the server holds whenever it is read (e.g. to know whether the viewer is a host). */
  onLoaded?: (state: GroupControlsState) => void;
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; state: GroupControlsState };

const POLICY_ROWS: Array<{ key: 'postingPolicy' | 'mediaPolicy' | 'linkPolicy'; label: string; hosts: string }> = [
  { key: 'postingPolicy', label: 'Who can post', hosts: 'Only hosts post' },
  { key: 'mediaPolicy', label: 'Who can send photos and videos', hosts: 'Only hosts send media' },
  { key: 'linkPolicy', label: 'Who can send links', hosts: 'Only hosts send links' },
];

/** The member-facing summary of what is on. Pure. */
export function activeControlLines(c: GroupControls): string[] {
  const out: string[] = [];
  if (c.slowModeSeconds > 0) out.push(`Slow mode: one message every ${slowModeLabel(c.slowModeSeconds)}`);
  for (const row of POLICY_ROWS) if (c[row.key] === 'hosts_only') out.push(row.hosts);
  return out;
}

export function GroupControlsSheet({ visible, threadId, onClose, onLoaded }: GroupControlsSheetProps) {
  const { palette, styles } = useTelegraphTheme(makeStyles);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const read = useCallback(async () => {
    if (!threadId) return;
    setLoad({ status: 'loading' });
    const r = await fetchGroupControls(threadId);
    if (r.ok) { setLoad({ status: 'ready', state: r.data }); onLoaded?.(r.data); }
    else setLoad({ status: 'error', message: r.message });
  }, [threadId, onLoaded]);

  useEffect(() => {
    if (visible) { setSaveError(null); void read(); }
  }, [visible, read]);

  const save = async (patch: Partial<GroupControls>) => {
    if (!threadId || saving || load.status !== 'ready' || !load.state.isHost) return;
    setSaving(true);
    setSaveError(null);
    const r = await setGroupControls(threadId, patch);
    setSaving(false);
    if (r.ok) setLoad({ status: 'ready', state: { ...load.state, controls: r.data } });
    else setSaveError(r.message);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close conversation settings" />
      <View style={styles.sheet} testID="group-controls-sheet">
        <Text style={styles.title} accessibilityRole="header">Conversation settings</Text>
        {load.status === 'loading' ? (
          <ActivityIndicator testID="group-controls-loading" color={palette.operational} />
        ) : load.status === 'error' ? (
          <View testID="group-controls-error">
            <Text style={styles.error}>{load.message}</Text>
            <Pressable onPress={() => { void read(); }} accessibilityRole="button" style={styles.retry}>
              <Text style={styles.retryLabel}>Try again</Text>
            </Pressable>
          </View>
        ) : load.state.isHost ? (
          <View testID="group-controls-host">
            <Text style={styles.section}>Slow mode</Text>
            <View style={styles.chips}>
              {SLOW_MODE_CHOICES.map((s) => {
                const on = load.state.controls.slowModeSeconds === s;
                return (
                  <Pressable key={s} testID={`group-controls-slow-${s}`} accessibilityRole="radio" accessibilityState={{ selected: on, disabled: saving }} disabled={saving} onPress={() => { void save({ slowModeSeconds: s }); }} style={[styles.chip, on && styles.chipOn]}>
                    <Text style={styles.chipLabel}>{slowModeLabel(s)}{on ? ' ✓' : ''}</Text>
                  </Pressable>
                );
              })}
            </View>
            {POLICY_ROWS.map((row) => {
              const value: AudiencePolicy = load.state.controls[row.key];
              return (
                <View key={row.key}>
                  <Text style={styles.section}>{row.label}</Text>
                  <View style={styles.chips}>
                    {(['everyone', 'hosts_only'] as AudiencePolicy[]).map((p) => (
                      <Pressable key={p} testID={`group-controls-${row.key}-${p}`} accessibilityRole="radio" accessibilityState={{ selected: value === p, disabled: saving }} disabled={saving} onPress={() => { void save({ [row.key]: p } as Partial<GroupControls>); }} style={[styles.chip, value === p && styles.chipOn]}>
                        <Text style={styles.chipLabel}>{p === 'everyone' ? 'Everyone' : 'Hosts only'}{value === p ? ' ✓' : ''}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              );
            })}
            <Text style={styles.note}>Safety messages always go through, whatever is set here.</Text>
          </View>
        ) : (
          <View testID="group-controls-member">
            {activeControlLines(load.state.controls).length === 0 ? (
              <Text style={styles.note} testID="group-controls-none">No posting limits are on in this conversation.</Text>
            ) : (
              activeControlLines(load.state.controls).map((l) => <Text key={l} style={styles.rowLabel}>{l}</Text>)
            )}
            {load.state.mutedUntil ? (
              <Text style={styles.note} testID="group-controls-own-mute">
                {load.state.mutedUntil === 'indefinite' ? 'A host has muted you here until they lift it. You can still reply to plans and polls.' : `A host has muted you here until ${new Date(load.state.mutedUntil).toLocaleString()}. You can still reply to plans and polls.`}
              </Text>
            ) : null}
            <Text style={styles.note}>Only a host can change these.</Text>
          </View>
        )}
        {saveError ? <Text style={styles.error} testID="group-controls-save-error">{saveError}</Text> : null}
      </View>
    </Modal>
  );
}

const makeStyles = (p: TelegraphPalette) => StyleSheet.create({ // census T123/T124: the scheme's palette; ordinary emphasis is teal
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { backgroundColor: p.surface, padding: space.lg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, gap: space.sm },
  title: { ...t.bodyStrong, color: p.recvText },
  section: { ...t.small, color: p.mute, marginTop: space.sm, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: { paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.md, borderWidth: 1, borderColor: p.haze, minHeight: 44, justifyContent: 'center' },
  chipOn: { borderColor: p.operational },
  chipLabel: { ...t.small, color: p.recvText },
  rowLabel: { ...t.body, color: p.recvText },
  note: { ...t.small, color: p.mute },
  error: { ...t.small, color: p.recvText, fontWeight: '600' },
  retry: { paddingVertical: space.xs, minHeight: 44, justifyContent: 'center' },
  retryLabel: { ...t.small, color: p.operational, fontWeight: '700' },
});

export default GroupControlsSheet;
