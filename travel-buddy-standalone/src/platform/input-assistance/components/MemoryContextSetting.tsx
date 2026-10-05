/**
 * OD-INPUT-3's opt-in, inspect view and revoke, as one settings row (census G25).
 *
 *   - OPT-IN: turning the switch on opens the explanation; only "Allow" grants,
 *     sending the version of the words shown (the server checks it).
 *   - INSPECT: while it is on, the row lists exactly what Compass may use — the
 *     same read, through the same gates, that builds the suggestions. A failed
 *     read says so; it is never shown as "you have no memories".
 *   - REVOKE: one tap on the switch. The server stops reading at once.
 *
 * An unreadable setting renders as unreadable with a retry, never as "off".
 * Mounted by app/settings/index.tsx behind `input_memory_context_enabled`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Switch, Pressable, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import {
  MEMORY_CONTEXT_BODY,
  MEMORY_CONTEXT_TITLE,
  memoryFactLabel,
  type MemoryContextView,
} from '../services/memoryContext.ts';
import {
  readMemoryContext as defaultRead,
  writeMemoryContextConsent as defaultWrite,
  type MemoryContextRead,
  type MemoryContextWrite,
} from '../services/memoryContextTransport.ts';

export interface MemoryContextSettingProps {
  read?: () => Promise<MemoryContextRead>;
  write?: (enabled: boolean) => Promise<MemoryContextWrite>;
}

type State = { kind: 'loading' } | { kind: 'unreadable' } | { kind: 'ready'; view: MemoryContextView };

export function MemoryContextSetting({ read = defaultRead, write = defaultWrite }: MemoryContextSettingProps) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await read();
    setState(r.status === 'ok' ? { kind: 'ready', view: r.view } : { kind: 'unreadable' });
  }, [read]);

  useEffect(() => {
    void load();
  }, [load]);

  const commit = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      setNote(null);
      const w = await write(enabled);
      setBusy(false);
      setReviewing(false);
      if (w.status === 'ok') {
        if (!enabled) setNote('Turned off. Compass no longer uses your memories for suggestions.');
        await load(); // re-read: the inspect list must be the server's, not a guess
        return;
      }
      if (w.status === 'stale_disclosure') {
        setNote('This explanation has changed. Please read it again.');
        return;
      }
      setNote(w.status === 'unavailable' ? 'This setting isn’t available yet.' : 'Your change couldn’t be saved. Please try again.');
    },
    [write, load],
  );

  if (state.kind === 'loading') return null;
  if (state.kind === 'unreadable') {
    return (
      <View style={styles.card} testID="memory-context-unreadable">
        <Text style={styles.title}>{MEMORY_CONTEXT_TITLE}</Text>
        <Text style={styles.body}>This setting couldn’t be loaded.</Text>
        <Pressable accessibilityRole="button" onPress={() => void load()} testID="memory-context-retry">
          <Text style={styles.link}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  const { view } = state;
  if (!view.available && !view.enabled) return null;

  return (
    <View style={styles.card} testID="memory-context-setting">
      <View style={styles.row}>
        <Text style={styles.title}>{MEMORY_CONTEXT_TITLE}</Text>
        <Switch
          value={view.enabled || reviewing}
          disabled={busy}
          onValueChange={(next) => {
            if (next) {
              setNote(null);
              setReviewing(true);
            } else if (reviewing) {
              setReviewing(false);
            } else {
              void commit(false);
            }
          }}
          accessibilityLabel={MEMORY_CONTEXT_TITLE}
          testID="memory-context-switch"
        />
      </View>
      {reviewing ? (
        <View style={styles.section} testID="memory-context-disclosure">
          <Text style={styles.body}>{MEMORY_CONTEXT_BODY}</Text>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => setReviewing(false)} testID="memory-context-decline">
              <Text style={styles.link}>Not now</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void commit(true)} testID="memory-context-allow">
              <Text style={styles.primary}>Allow</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {view.enabled ? (
        <View style={styles.section} testID="memory-context-inspect">
          <Text style={styles.small}>What Compass may use</Text>
          {view.factsUnavailable ? (
            <Text style={styles.body} testID="memory-context-facts-unavailable">Your memories couldn’t be checked right now.</Text>
          ) : view.facts && view.facts.length > 0 ? (
            view.facts.map((f) => (
              <Text key={memoryFactLabel(f)} style={styles.body} testID="memory-context-fact">
                {memoryFactLabel(f)}
              </Text>
            ))
          ) : (
            <Text style={styles.body} testID="memory-context-facts-empty">Nothing yet — no places in your memories.</Text>
          )}
        </View>
      ) : null}
      {note ? (
        <Text style={styles.small} accessibilityLiveRegion="polite" testID="memory-context-note">
          {note}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    gap: space.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  title: { ...t.bodyStrong, color: color.ink, flexShrink: 1 },
  body: { ...t.body, color: color.ink },
  small: { ...t.small, color: color.mute },
  section: { gap: space.xs, paddingTop: space.sm },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.xl },
  link: { ...t.bodyStrong, color: color.deep },
  primary: { ...t.bodyStrong, color: color.signalStrong },
});
