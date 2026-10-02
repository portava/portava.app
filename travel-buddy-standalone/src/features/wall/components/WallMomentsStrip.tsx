/**
 * WallMomentsStrip — TM-live (WP-11) WALL-F13: server-built live moments on
 * the Wall, under the Live For You strip.
 *
 * It asks GET /wall/moments about the places the Live strip is showing (the
 * viewer-relevant live set) and renders the moments the Attention Engine placed
 * on the Wall or would notify about, newest change first, each with its truth
 * class — a moment is a reading of a change, never a statement about people.
 *
 * Every non-answer says what it is:
 *   - no live places to ask about  → nothing (there is nothing a moment could be about)
 *   - moments off in this build    → nothing (the flag-off behaviour)
 *   - the request failed           → "Couldn't check what changed" + Try again
 *   - Live intelligence closed     → says changes can't be checked right now
 *   - some places refused          → "N places couldn't be checked"
 *   - looked, nothing changed      → says exactly that, for the places it looked at
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Activity } from 'lucide-react-native';

import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import { failureLine } from '../../live/liveApi.ts';
import { fetchWallMoments, shownMoments, truthWord, type MomentsRead } from '../services/wallMoments.ts';

interface Props {
  /** The Live For You items: their subjects are the places asked about, their names label the moments. */
  liveItems: { subjectId: string; subject?: { name?: string | null } | null }[];
  /** Test seam — the real service by default. */
  load?: typeof fetchWallMoments;
}

function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m)) return '';
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

export function WallMomentsStrip({ liveItems, load = fetchWallMoments }: Props) {
  const subjectIds = useMemo(() => Array.from(new Set(liveItems.map((i) => i.subjectId).filter(Boolean))).sort(), [liveItems]);
  const key = subjectIds.join(',');
  const names = useMemo(() => new Map(liveItems.map((i) => [i.subjectId, i.subject?.name ?? null])), [liveItems]);
  const [read, setRead] = useState<MomentsRead | undefined>(undefined);
  const seen = useRef<Set<string>>(new Set());

  const run = useCallback(async () => {
    if (key.length === 0) return;
    setRead(undefined);
    const r = await load(key.split(','), Array.from(seen.current));
    setRead(r);
  }, [key, load]);

  useEffect(() => { void run(); }, [run]);
  // Moments shown once are sent back as `seen`, so the Attention Engine does not route the same change again.
  useEffect(() => { if (read?.state === 'ok') for (const m of shownMoments(read.moments).shown) seen.current.add(m.id); }, [read]);

  if (key.length === 0 || read?.state === 'off') return null;

  if (read === undefined) {
    return (
      <View style={s.wrap} testID="wall-moments-loading">
        <ActivityIndicator size="small" color={color.signal} />
      </View>
    );
  }
  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="wall-moments-unavailable">
        <Text style={s.error}>{failureLine(read.call, 'what changed at these places')}</Text>
        <Pressable onPress={() => void run()} testID="wall-moments-retry"><Text style={s.action}>Try again</Text></Pressable>
      </View>
    );
  }
  if (!read.liveIntelligenceReadable) {
    return (
      <View style={s.wrap} testID="wall-moments-live-closed">
        <Text style={s.sub}>Live intelligence isn't available right now, so changes at these places can't be checked.</Text>
      </View>
    );
  }

  const { shown, held } = shownMoments(read.moments);
  const refused = read.subjects.filter((x) => x.refusal !== null).length;
  const looked = read.subjects.length - refused;

  return (
    <View style={s.wrap} testID="wall-moments-strip">
      <Text style={s.label}>WHAT CHANGED NEARBY</Text>
      {shown.map((m) => (
        <Pressable key={m.id} style={s.row} onPress={() => router.push(`/place/${m.subject.id}` as never)} testID={`wall-moment-${m.id}`}>
          <Activity size={12} color={color.signal} />
          <View style={{ flex: 1 }}>
            <Text style={s.title} numberOfLines={1}>{names.get(m.subject.id) ?? 'A place near you'}</Text>
            <Text style={s.sub}>{m.reason.text}</Text>
            <Text style={s.meta}>{truthWord(m.truthClass)} · {m.freshness} · {ago(m.occurredAt)}</Text>
          </View>
        </Pressable>
      ))}
      {shown.length === 0 && looked > 0 ? (
        <Text style={s.sub} testID="wall-moments-none">
          No change worth showing at the {looked} live place{looked === 1 ? '' : 's'} near you since they were last read.
        </Text>
      ) : null}
      {held > 0 ? <Text style={s.meta} testID="wall-moments-held">{held} quieter change{held === 1 ? '' : 's'} not shown here.</Text> : null}
      {refused > 0 ? (
        <Text style={s.error} testID="wall-moments-refused">{refused} place{refused === 1 ? '' : 's'} couldn't be checked — not the same as nothing changing.</Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.sm, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised, gap: space.xs },
  label: { ...t.stamp, color: color.mute, letterSpacing: 0.5 },
  row: { flexDirection: 'row', gap: space.sm, paddingVertical: space.xs },
  title: { ...t.bodyStrong, color: color.ink },
  sub: { ...t.small, color: color.mute },
  meta: { ...t.stamp, color: color.mute },
  error: { ...t.small, color: color.warn },
  action: { ...t.stamp, color: color.deep, fontWeight: '600' },
});
