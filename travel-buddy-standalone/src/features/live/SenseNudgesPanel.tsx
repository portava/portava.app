/**
 * SenseNudgesPanel — TM-live (WP-11) COMP-F11 on screen, inside Compass
 * preferences' "Compass Sense" section.
 *
 *   - "Check now" asks the server to evaluate the traveller's signals and
 *     deliver what passes its gates, then says what it DELIVERED, what it held
 *     back and why, and which checks could NOT run (census-compass §32) —
 *     never "nothing to nudge you about". A 503 is an error with Try again.
 *   - "Recent nudges" lists what Sense sent in the last 7 days; a tap opens
 *     the surface the nudge points at.
 *   - A failed read or check says it failed, with Try again. Compass off
 *     renders nothing (the section around it is hidden too).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Bell, RefreshCw } from 'lucide-react-native';

import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { failureLine } from './liveApi.ts';
import { fetchSenseNudges, runSenseCheck, checkSummary, partialLine, sourceNames, SUPPRESSION_WORDS, type SenseCheck, type SenseNudge, type SenseRead } from './senseNudges.ts';

interface Props {
  /** Test seams — the real service by default. */
  load?: typeof fetchSenseNudges;
  check?: typeof runSenseCheck;
}

function when(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function SenseNudgesPanel({ load = fetchSenseNudges, check = runSenseCheck }: Props) {
  const [list, setList] = useState<SenseRead<SenseNudge[]> | undefined>(undefined);
  const [last, setLast] = useState<SenseRead<SenseCheck> | null>(null);
  const [checking, setChecking] = useState(false);

  const reload = useCallback(async () => {
    setList(undefined);
    setList(await load());
  }, [load]);

  useEffect(() => { void reload(); }, [reload]);

  const checkNow = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    const r = await check();
    setLast(r);
    setChecking(false);
    if (r.state === 'ok') void reload();
  }, [check, checking, reload]);

  if (list?.state === 'off' || last?.state === 'off') return null;

  return (
    <View style={s.wrap} testID="sense-nudges-panel">
      <View style={s.headRow}>
        <Text style={s.label}>Recent nudges</Text>
        <Pressable style={s.checkBtn} onPress={() => void checkNow()} disabled={checking} testID="sense-check-now" accessibilityRole="button">
          {checking ? <ActivityIndicator size="small" color={color.signal} /> : <RefreshCw size={12} color={color.signal} />}
          <Text style={s.checkText}>Check now</Text>
        </Pressable>
      </View>

      {last?.state === 'ok' ? (
        <View testID="sense-check-result">
          <Text style={s.detail}>{checkSummary(last.value)}</Text>
          {last.value.suppressed.map((x, i) => (
            <Text key={`${x.type}-${i}`} style={s.sub}>• {x.type.replace(/_/g, ' ')} held back — {SUPPRESSION_WORDS[x.reason] ?? x.reason}</Text>
          ))}
          {last.value.failedSources.length > 0 ? (
            <Text style={s.error} testID="sense-check-partial">{partialLine(last.value)}</Text>
          ) : null}
        </View>
      ) : last?.state === 'unavailable' ? (
        <View testID="sense-check-failed">
          <Text style={s.error}>{failureLine(last.call, 'the Sense check')}</Text>
          {last.failedSources && last.failedSources.length > 0 ? (
            <Text style={s.sub}>{`Couldn't run: ${sourceNames(last.failedSources)}.`}</Text>
          ) : null}
          <Pressable onPress={() => void checkNow()} disabled={checking} testID="sense-check-retry" accessibilityRole="button">
            <Text style={s.checkText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {list === undefined ? (
        <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.sm }} testID="sense-nudges-loading" />
      ) : list.state === 'unavailable' ? (
        <View testID="sense-nudges-unavailable">
          <Text style={s.error}>{failureLine(list.call, 'your nudges')}</Text>
          <Pressable onPress={() => void reload()} testID="sense-nudges-retry"><Text style={s.checkText}>Try again</Text></Pressable>
        </View>
      ) : list.state === 'ok' && list.value.length === 0 ? (
        <Text style={s.sub} testID="sense-nudges-empty">Sense hasn't sent you a nudge in the last 7 days.</Text>
      ) : list.state === 'ok' ? (
        list.value.map((n) => (
          <Pressable
            key={n.id}
            style={s.nudge}
            testID={`sense-nudge-${n.id}`}
            disabled={!n.actionUrl || !n.actionUrl.startsWith('/')}
            onPress={() => { if (n.actionUrl && n.actionUrl.startsWith('/')) router.push(n.actionUrl as never); }}
          >
            <Bell size={12} color={color.deep} />
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{n.title}</Text>
              <Text style={s.sub}>{n.body}</Text>
              <Text style={s.meta}>{n.category.replace(/_/g, ' ')} · {when(n.createdAt)}</Text>
            </View>
          </Pressable>
        ))
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: space.md, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze, gap: space.xs },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { ...t.bodyStrong, color: color.ink },
  checkBtn: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  checkText: { ...t.stamp, color: color.signal, fontWeight: '600' },
  detail: { ...t.small, color: color.ink },
  sub: { ...t.small, color: color.mute },
  meta: { ...t.stamp, color: color.faint },
  error: { ...t.small, color: color.warn },
  title: { ...t.bodyStrong, color: color.ink },
  nudge: { flexDirection: 'row', gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze },
});
