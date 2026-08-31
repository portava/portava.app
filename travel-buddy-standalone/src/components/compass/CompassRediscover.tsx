/**
 * CompassRediscover — Rediscovery surface (Memory + Experience Intelligence §8).
 *
 * On returning to a city, resurfaces the user's prior memory that matters now,
 * grouped by WHY it is being shown:
 *   • been_here_before — "You've been here before"
 *   • you_saved        — "You saved these"
 *   • you_know         — "People you know here"
 *   • relevant         — "Still relevant"  (fallback bucket)
 *
 * Self-fetching card (same shape as CompassHome's data cards): give it a city
 * and it loads its own rediscovery via the compass service. Everything is empty
 * until the server's `memory_projection` flag is on, so the empty state reads as
 * "nothing to resurface yet" — never an error.
 *
 * Mount modes:
 *   • default (standalone / dedicated surface) — shows loading, a graceful empty
 *     state, and a soft retry-able error state.
 *   • collapseWhenEmpty — renders NOTHING until there is real memory to show, so
 *     it can sit inside CompassHome's honest card stack without ever painting a
 *     placeholder while the flag is off.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { History, MapPin, Bookmark, Users, Sparkles } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { fetchRediscover, type RediscoverMemory, type RediscoverReason } from '../../services/compass.ts';

// Display order + label + icon for each reason bucket. `relevant` is the
// catch-all the server falls back to and sorts last.
const REASON_ORDER: RediscoverReason[] = ['been_here_before', 'you_saved', 'you_know', 'relevant'];

const REASON_META: Record<RediscoverReason, { label: string; Icon: React.ComponentType<{ size: number; color: string }> }> = {
  been_here_before: { label: "You've been here before", Icon: MapPin },
  you_saved:        { label: 'You saved these',          Icon: Bookmark },
  you_know:         { label: 'People you know here',     Icon: Users },
  relevant:         { label: 'Still relevant',           Icon: Sparkles },
};

export interface CompassRediscoverProps {
  city: string;
  /**
   * When true, render nothing unless there is real memory to show (no spinner,
   * no empty state, no error) — for embedding inside CompassHome's card stack.
   */
  collapseWhenEmpty?: boolean;
}

export function CompassRediscover({ city, collapseWhenEmpty = false }: CompassRediscoverProps) {
  const [memories, setMemories] = useState<RediscoverMemory[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(false);
  // Guards against a slow fetch for a previous city overwriting the current one.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(false);
    const r = await fetchRediscover(city);
    if (seq !== loadSeq.current) return;
    if (r.ok) {
      setMemories(r.data ?? []);
    } else {
      // `not_configured` / `no_city` are expected pre-launch states, not
      // failures the user should see a retry for — treat as simply empty.
      setError(r.error !== 'not_configured' && r.error !== 'no_city');
      setMemories([]);
    }
    setLoading(false);
  }, [city]);

  useEffect(() => { void load(); }, [load]);

  const hasData = memories.length > 0;

  // Collapsed mode (CompassHome): only ever paints when there is real memory.
  if (collapseWhenEmpty && !hasData) return null;

  // Group memories by reason, preserving the server's confidence ordering.
  const groups: Array<{ reason: RediscoverReason; items: RediscoverMemory[] }> = [];
  for (const reason of REASON_ORDER) {
    const items = memories.filter((m) => m.reason === reason);
    if (items.length) groups.push({ reason, items });
  }
  // Any unexpected reason value the server might add lands in its own bucket
  // under the fallback label rather than vanishing.
  const known = new Set(REASON_ORDER);
  const extras = memories.filter((m) => !known.has(m.reason));
  if (extras.length) groups.push({ reason: 'relevant', items: extras });

  return (
    <View style={s.card} testID="compass-rediscover">
      <View style={s.head}>
        <History size={14} color={color.signal} />
        <Text style={s.headText}>Rediscover {city}</Text>
      </View>

      {loading && !hasData ? (
        <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.md }} testID="rediscover-loading" />
      ) : error ? (
        <View style={s.stateBlock} testID="rediscover-error">
          <Text style={s.stateText}>Couldn't load your memories just now.</Text>
          <Pressable onPress={() => void load()} testID="rediscover-retry" hitSlop={8}>
            <Text style={s.retry}>Try again</Text>
          </Pressable>
        </View>
      ) : !hasData ? (
        <Text style={s.stateText} testID="rediscover-empty">
          Nothing to resurface yet — as you explore {city}, the moments and places
          worth remembering will show up here.
        </Text>
      ) : (
        <View style={{ gap: space.md }}>
          {groups.map((g) => {
            const meta = REASON_META[g.reason];
            const Icon = meta.Icon;
            return (
              <View key={g.reason} style={{ gap: 6 }} testID={`rediscover-group-${g.reason}`}>
                <View style={s.groupHead}>
                  <Icon size={12} color={color.deep} />
                  <Text style={s.groupLabel}>{meta.label}</Text>
                </View>
                {g.items.map((m) => (
                  <View key={m.id} style={s.memRow} testID={`rediscover-item-${m.id}`}>
                    <Text style={s.memContent}>{m.content}</Text>
                  </View>
                ))}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card:       { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  head:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headText:   { ...t.stamp, fontFamily: 'Courier', color: color.signal },
  groupHead:  { flexDirection: 'row', alignItems: 'center', gap: 5 },
  groupLabel: { ...t.small, fontWeight: '700', color: color.deep },
  memRow:     { paddingVertical: 4, paddingLeft: space.md, borderLeftWidth: 2, borderLeftColor: color.haze },
  memContent: { ...t.body, color: color.ink },
  stateBlock: { gap: 4 },
  stateText:  { ...t.small, color: color.mute, lineHeight: 19 },
  retry:      { ...t.small, fontWeight: '700', color: color.signal },
});
