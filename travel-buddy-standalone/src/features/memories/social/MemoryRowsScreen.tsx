/**
 * MemoryRowsScreen — one list shell for the owner's browse projections and the
 * saved shelf (HM-F11, HM-F13).
 *
 * Three honest states, never merged:
 *   loading — a spinner;
 *   error   — the server's own sentence and a retry (a projection the server
 *             could not build is refused with `degraded_unavailable`, and that
 *             is NOT "you have no memories" — DV-83);
 *   empty   — only when the read succeeded with zero rows.
 * A truncated projection says so rather than implying the list is complete.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../../theme/tokens.ts';

export interface MemoryRowView {
  memoryId: string;
  title: string;
  subtitle: string | null;
  meta: string | null;
}

export type MemoryRowsLoad = () => Promise<
  { ok: true; rows: MemoryRowView[]; truncated?: boolean } | { ok: false; message: string }
>;

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; rows: MemoryRowView[]; truncated: boolean };

export function formatMemoryDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function placeLine(city: string | null | undefined, country: string | null | undefined): string | null {
  const s = [city, country].filter(Boolean).join(', ');
  return s || null;
}

export function MemoryRowsScreen({
  title, intro, load, emptyTitle, emptyBody, testID,
}: {
  title: string;
  intro?: string | null;
  load: MemoryRowsLoad;
  emptyTitle: string;
  emptyBody: string;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const run = useCallback(async () => {
    setState({ kind: 'loading' });
    const res = await load();
    setState(res.ok ? { kind: 'ready', rows: res.rows, truncated: res.truncated === true } : { kind: 'error', message: res.message });
  }, [load]);

  useEffect(() => { void run(); }, [run]);

  return (
    <View style={s.screen} testID={testID}>
      <View style={[s.topBar, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Go back">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.title} numberOfLines={1}>{title}</Text>
        <View style={s.spacer} />
      </View>
      {state.kind === 'loading' ? (
        <View style={s.center}><ActivityIndicator color={color.signal} /></View>
      ) : state.kind === 'error' ? (
        <View style={s.center} testID="memory-rows-error">
          <Text style={s.emptyTitle}>Could not load this</Text>
          <Text style={s.body}>{state.message}</Text>
          <Pressable onPress={run} style={s.retry} accessibilityRole="button" testID="memory-rows-retry">
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : state.rows.length === 0 ? (
        <View style={s.center} testID="memory-rows-empty">
          <Text style={s.emptyTitle}>{emptyTitle}</Text>
          <Text style={s.body}>{emptyBody}</Text>
        </View>
      ) : (
        <FlatList
          data={state.rows}
          keyExtractor={(r) => r.memoryId}
          contentContainerStyle={[s.list, { paddingBottom: insets.bottom + space.xl }]}
          ListHeaderComponent={intro ? <Text style={s.intro}>{intro}</Text> : null}
          ListFooterComponent={state.truncated ? <Text style={s.caption}>Showing the most recent part of this list.</Text> : null}
          renderItem={({ item }) => (
            <Pressable
              style={s.card}
              onPress={() => router.push(`/memory/${item.memoryId}` as never)}
              accessibilityRole="button"
              testID={`memory-row-${item.memoryId}`}
            >
              <Text style={s.cardTitle} numberOfLines={1}>{item.title}</Text>
              {item.subtitle ? <Text style={s.body} numberOfLines={1}>{item.subtitle}</Text> : null}
              {item.meta ? <Text style={s.caption}>{item.meta}</Text> : null}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.md },
  title: { ...(t.bodyStrong as object), color: color.ink, flex: 1, textAlign: 'center' },
  spacer: { width: 22 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  emptyTitle: { ...(t.bodyStrong as object), color: color.ink, textAlign: 'center' },
  body: { ...(t.body as object), color: color.mute },
  caption: { ...(t.small as object), color: color.mute, marginTop: space.xs },
  intro: { ...(t.small as object), color: color.mute, marginBottom: space.sm },
  list: { padding: space.lg, gap: space.sm },
  card: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: 2 },
  cardTitle: { ...(t.bodyStrong as object), color: color.ink },
  retry: { marginTop: space.sm, paddingVertical: space.sm, paddingHorizontal: space.lg },
  retryText: { ...(t.bodyStrong as object), color: color.deep },
});
