/**
 * LayoverPresenceIntents — §14's L1 rung, "5 open to food".
 * census-layover L27 / L129 / L187.
 *
 * Two halves, and the asymmetry is the point:
 *   - what the traveller says about THEMSELVES: which of five things they are
 *     open to, until their flight;
 *   - what they see about OTHERS: how many are open to each — never who. The
 *     server sends counts only; this component has nothing else to show.
 *
 * Rendered by LayoverPeopleSection only when the overview says the surface
 * exists (`share.intentsEnabled`) and the traveller is sharing their city. The
 * server's own `available: false` renders nothing. A failed read is a failure
 * with a retry, never "nobody is open to anything"; a failed save keeps the
 * traveller's selection on screen and says it did not save.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import {
  PRESENCE_INTENT_KEYS,
  clearPresenceIntents,
  getPresenceIntents,
  setPresenceIntents,
  type PresenceIntentKey,
  type PresenceIntentsRead,
} from '../../services/layover.ts';

const LABEL: Record<PresenceIntentKey, string> = {
  food: 'Food', nightlife: 'Nightlife', shopping: 'Shopping', culture: 'Culture', meetups: 'Meetups',
};

/** "2 open to food · 1 open to nightlife", or null when nobody has said anything. */
export function describeIntentCounts(counts: Record<PresenceIntentKey, number> | null): string | null {
  if (!counts) return null;
  const parts = PRESENCE_INTENT_KEYS.filter((k) => counts[k] > 0).map((k) => `${counts[k]} open to ${LABEL[k].toLowerCase()}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

interface Props {
  sessionId: string;
  canEdit: boolean;
}

export function LayoverPresenceIntents({ sessionId, canEdit }: Props) {
  const [read, setRead] = useState<PresenceIntentsRead | null>(null);
  const [picked, setPicked] = useState<PresenceIntentKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const ticket = useRef(0);

  const load = useCallback(async () => {
    const mine = ++ticket.current;
    const r = await getPresenceIntents(sessionId);
    if (mine !== ticket.current) return;
    setRead(r);
    if (r.ok && r.available) setPicked(r.own?.intents ?? []);
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const w = picked.length === 0 ? await clearPresenceIntents(sessionId) : await setPresenceIntents(sessionId, { intents: picked });
      if (w.ok) await load();
      else setNotice(w.message);
    } finally {
      setBusy(false);
    }
  }, [picked, sessionId, load]);

  if (!read) return <ActivityIndicator size="small" color={color.mute} testID="layover-intents-loading" />;
  if (read.ok && !read.available) return null;
  if (!read.ok) {
    return (
      <View style={styles.box} testID="layover-intents-unavailable">
        <Text style={styles.body}>{read.message}</Text>
        <Pressable onPress={() => void load()} accessibilityRole="button" testID="layover-intents-retry">
          <Text style={styles.link}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const others = describeIntentCounts(read.counts);
  const saved = (read.own?.intents ?? []).join(',');
  const dirty = saved !== picked.join(',');

  return (
    <View style={styles.box} testID="layover-intents">
      <Text style={styles.head}>What are you open to?</Text>
      <Text style={styles.hint}>Others here see only how many people are open to each — never who.</Text>
      {canEdit ? (
        <View style={styles.chipRow}>
          {PRESENCE_INTENT_KEYS.map((k) => {
            const on = picked.includes(k);
            return (
              <Pressable
                key={k}
                style={[styles.chip, on && styles.chipOn]}
                onPress={() => setPicked((cur) => (on ? cur.filter((x) => x !== k) : PRESENCE_INTENT_KEYS.filter((x) => x === k || cur.includes(x))))}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                testID={`layover-intent-${k}`}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{LABEL[k]}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {canEdit && dirty ? (
        <Pressable style={[styles.btn, busy && styles.btnBusy]} onPress={() => void save()} disabled={busy} accessibilityRole="button" testID="layover-intents-save">
          <Text style={styles.btnText}>{busy ? 'Saving…' : picked.length === 0 ? 'Stop sharing what I’m open to' : 'Share what I’m open to'}</Text>
        </Pressable>
      ) : null}
      {notice ? <Text style={styles.notice} testID="layover-intents-notice">{notice}</Text> : null}
      <Text style={styles.body} testID="layover-intents-others">
        {read.counts === null
          ? 'Share your city to see what others here are open to.'
          : others ?? 'Nobody here has said what they’re open to yet.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box:        { marginTop: space.sm, gap: space.xs, backgroundColor: color.paper, borderRadius: radius.md, padding: space.md },
  head:       { ...t.bodyStrong, color: color.ink },
  body:       { ...t.small, color: color.ink },
  hint:       { ...t.stamp, color: color.faint },
  link:       { ...t.small, color: color.signal },
  notice:     { ...t.small, color: color.warn },
  chipRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip:       { paddingHorizontal: space.sm, paddingVertical: 6, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze },
  chipOn:     { backgroundColor: color.deep, borderColor: color.deep },
  chipText:   { ...t.small, color: color.ink },
  chipTextOn: { color: color.paper },
  btn:        { alignItems: 'center', justifyContent: 'center', paddingVertical: space.sm, borderRadius: radius.md, backgroundColor: color.deep },
  btnBusy:    { opacity: 0.5 },
  btnText:    { ...t.bodyStrong, color: color.paper },
});
