/**
 * MemoryRecapsScreen — Personal Recaps and "On this day" (§5, testing-mode
 * WP-12, flow COMP-F17).
 *
 * Reads GET /compass/me/on-this-day and GET /compass/me/recaps?kind=…. Both are
 * owner-only, rebuilt on every open (anything forgotten, hidden or deleted
 * since is not in them) and never publish anything.
 *
 * HONEST STATES, per card: loading; a failed request is an error with Try
 * again; `enabled: false` (the `memory_recaps` flag is off) says the feature is
 * not turned on — not "no memories"; sources the server could not read are
 * named; a recap that answered with nothing says so for its window.
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { History } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  fetchRecap, fetchOnThisDay, SOURCE_LABELS,
  type RecapView, type OnThisDayView, type RecapRequest, type RecapItem, type MemorySurfaceResult,
} from '../../services/compassMemorySurfaces.ts';
import { MemoryHeader, MemoryLoading, MemoryError, UnavailableNotice, errorCopy, ms } from './memorySurfaceParts.tsx';

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T };

function settle<T>(r: MemorySurfaceResult<T>): Load<T> {
  return r.ok ? { state: 'ready', data: r.data } : { state: 'error', message: errorCopy(r.error, r.message) };
}

const unavailableText = (sources: string[]) =>
  `Couldn't load ${sources.map((x) => SOURCE_LABELS[x] ?? x).join(', ')} right now, so this may be incomplete.`;

/** The recap windows offered: this month, this year, last year. */
function windows(now: Date): Array<{ key: string; label: string; req: RecapRequest }> {
  const y = now.getFullYear();
  return [
    { key: 'month', label: 'This month', req: { kind: 'month', year: y, month: now.getMonth() + 1 } },
    { key: 'year', label: 'This year', req: { kind: 'year', year: y } },
    { key: 'last-year', label: String(y - 1), req: { kind: 'year', year: y - 1 } },
  ];
}

function ItemRow({ item }: { item: RecapItem }) {
  return (
    <View style={s.item}>
      <Text style={s.itemTitle}>{item.title}</Text>
      <Text style={ms.sectionText}>{[item.label, item.occurredAt ? new Date(item.occurredAt).getFullYear() : null].filter(Boolean).join(' · ')}</Text>
      {item.isInferred ? <Text style={s.inferred}>Inferred by Portava</Text> : null}
    </View>
  );
}

export function MemoryRecapsScreen({ now = new Date() }: { now?: Date } = {}) {
  const insets = useSafeAreaInsets();
  const options = windows(now);
  const [windowKey, setWindowKey] = useState(options[1]!.key);
  const [otd, setOtd] = useState<Load<OnThisDayView>>({ state: 'loading' });
  const [recap, setRecap] = useState<Load<RecapView>>({ state: 'loading' });
  const otdSeq = useRef(0);
  const recapSeq = useRef(0);

  const loadOnThisDay = useCallback(async () => {
    const mine = ++otdSeq.current;
    setOtd({ state: 'loading' });
    const r = await fetchOnThisDay();
    if (mine === otdSeq.current) setOtd(settle(r));
  }, []);

  const loadRecap = useCallback(async (key: string) => {
    const mine = ++recapSeq.current;
    setRecap({ state: 'loading' });
    const w = windows(now).find((o) => o.key === key) ?? windows(now)[1]!;
    const r = await fetchRecap(w.req);
    if (mine === recapSeq.current) setRecap(settle(r));
    // `now` is fixed for the life of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFocusEffect(useCallback(() => {
    void loadOnThisDay();
    void loadRecap(windowKey);
    return () => { otdSeq.current += 1; recapSeq.current += 1; };
    // Re-run on focus only; a window change loads through `choose`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadOnThisDay, loadRecap]));

  const choose = (key: string) => {
    if (key === windowKey) return;
    setWindowKey(key);
    void loadRecap(key);
  };

  const current = options.find((o) => o.key === windowKey) ?? options[1]!;

  return (
    <View style={[ms.root, { paddingTop: insets.top }]}>
      <MemoryHeader title="Recaps & On this day" Icon={History} />
      <ScrollView contentContainerStyle={[ms.scrollContent, { paddingBottom: insets.bottom + space.xxl }]}>
        <Text style={ms.subtitle}>Private to you. Rebuilt every time you open it, and never posted anywhere.</Text>

        <View style={ms.card} testID="otd-card">
          <Text style={ms.sectionTitle}>On this day</Text>
          {otd.state === 'loading' ? <MemoryLoading label="Loading On this day" />
            : otd.state === 'error' ? <MemoryError testID="otd-error" title="Couldn't load On this day" message={otd.message} onRetry={loadOnThisDay} />
            : !otd.data.enabled ? <Text style={ms.note} testID="otd-disabled">{otd.data.notes[0] ?? 'On this day is not turned on yet.'}</Text>
            : (
              <>
                {otd.data.unavailable.length > 0 ? <UnavailableNotice testID="otd-partial" text={unavailableText(otd.data.unavailable)} onRetry={loadOnThisDay} /> : null}
                {otd.data.items.length === 0
                  ? <Text style={ms.note} testID="otd-empty">Nothing from this day in earlier years{otd.data.unavailable.length > 0 ? ' that could be loaded' : ''}.</Text>
                  : otd.data.items.map((i) => <ItemRow key={i.id} item={i} />)}
              </>
            )}
        </View>

        <View style={ms.card} testID="recap-card">
          <Text style={ms.sectionTitle}>Recap</Text>
          <View style={s.chips}>
            {options.map((o) => (
              <Pressable key={o.key} onPress={() => choose(o.key)} style={[s.chip, o.key === windowKey && s.chipOn]} accessibilityRole="button" accessibilityState={{ selected: o.key === windowKey }} testID={`recap-window-${o.key}`}>
                <Text style={[s.chipText, o.key === windowKey && s.chipTextOn]}>{o.label}</Text>
              </Pressable>
            ))}
          </View>
          {recap.state === 'loading' ? <MemoryLoading label="Loading your recap" />
            : recap.state === 'error' ? <MemoryError testID="recap-error" title="Couldn't build your recap" message={recap.message} onRetry={() => void loadRecap(windowKey)} />
            : !recap.data.enabled ? <Text style={ms.note} testID="recap-disabled">{recap.data.notes[0] ?? 'Personal recaps are not turned on yet.'}</Text>
            : (
              <>
                {recap.data.unavailable.length > 0 ? <UnavailableNotice testID="recap-partial" text={unavailableText(recap.data.unavailable)} onRetry={() => void loadRecap(windowKey)} /> : null}
                {recap.data.sections.length === 0
                  ? <Text style={ms.note} testID="recap-empty">No memories in {recap.data.windowLabel || current.label}{recap.data.unavailable.length > 0 ? ' that could be loaded' : ''}.</Text>
                  : recap.data.sections.map((sec) => (
                    <View key={sec.group} style={s.section}>
                      <Text style={s.sectionLabel}>{sec.label}</Text>
                      {sec.items.map((i) => <ItemRow key={i.id} item={i} />)}
                    </View>
                  ))}
              </>
            )}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  item: { gap: 2, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze },
  itemTitle: { ...t.body, color: color.ink },
  inferred: { ...t.small, color: color.deep, fontStyle: 'italic' },
  section: { gap: space.xs, marginTop: space.sm },
  sectionLabel: { ...t.small, color: color.mute, textTransform: 'uppercase', letterSpacing: 0.6 },
  chips: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  chip: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  chipOn: { backgroundColor: color.ink, borderColor: color.ink },
  chipText: { ...t.small, color: color.ink },
  chipTextOn: { color: color.paper },
});

export default MemoryRecapsScreen;
