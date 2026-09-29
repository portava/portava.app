/**
 * PlaceRecapsSection — your recaps of this place, on the place screen (HM-F19).
 *
 * `GET /places/:placeId/recaps` answers the CALLER'S OWN recaps here (not
 * removed), each with every version joined. Shown with the latest version's
 * title and the recap's status, published first; each opens /recaps/:id,
 * where review / publish / archive / restore live.
 *
 * Capability off (client flag, or the server's feature_disabled): nothing.
 * A failed read: an error with a retry. No recaps: nothing — there is nothing
 * of yours here, which is not a failure.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { color, radius, space, type as t, typography } from '../../theme/tokens.ts';
import { listPlaceRecaps, type PlaceRecapListItem, type RecapStatus } from '../../services/placeRecaps.ts';

type State = { kind: 'idle' } | { kind: 'error' } | { kind: 'ready'; recaps: PlaceRecapListItem[] };

const STATUS_LABEL: Record<RecapStatus, string> = {
  draft: 'Draft', reviewed: 'Reviewed', published: 'Published', archived: 'Archived', removed: 'Removed', restored: 'Restored',
};
const STATUS_ORDER: Record<RecapStatus, number> = { published: 0, restored: 1, reviewed: 2, draft: 3, archived: 4, removed: 5 };

function latestTitle(r: PlaceRecapListItem): string {
  const versions = [...(r.live_place_recap_versions ?? [])].sort((a, b) => b.version_number - a.version_number);
  return versions[0]?.title || 'Untitled recap';
}

export function PlaceRecapsSection({ placeId, enabled }: { placeId: string; enabled: boolean }) {
  const [state, setState] = useState<State>({ kind: 'idle' });

  const load = useCallback(async () => {
    if (!enabled) return;
    setState({ kind: 'idle' });
    const res = await listPlaceRecaps(placeId);
    if (res.error === null) setState({ kind: 'ready', recaps: res.data });
    else if (res.error === 'disabled' || res.error === 'unavailable') setState({ kind: 'ready', recaps: [] });
    else setState({ kind: 'error' });
  }, [placeId, enabled]);

  useEffect(() => { void load(); }, [load]);

  if (!enabled) return null;
  if (state.kind === 'error') {
    return (
      <View style={s.card} testID="place-recaps-error">
        <Text style={s.title}>Your recaps here</Text>
        <Text style={s.body}>Your recaps could not be loaded.</Text>
        <Pressable onPress={load} accessibilityRole="button" testID="place-recaps-retry"><Text style={s.link}>Try again</Text></Pressable>
      </View>
    );
  }
  if (state.kind !== 'ready' || state.recaps.length === 0) return null;
  const recaps = [...state.recaps].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.created_at.localeCompare(a.created_at));
  return (
    <View style={s.card} testID="place-recaps">
      <Text style={s.title}>Your recaps here</Text>
      {recaps.map((r) => (
        <Pressable key={r.id} style={s.row} onPress={() => router.push(`/recaps/${r.id}` as never)} accessibilityRole="button" testID={`place-recap-${r.id}`}>
          <Text style={[s.body, s.flex]} numberOfLines={1}>{latestTitle(r)}</Text>
          <Text style={[s.chip, r.status === 'published' && s.chipLive]}>{STATUS_LABEL[r.status] ?? r.status}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: space.sm, marginHorizontal: space.lg, marginTop: space.md },
  title: { ...t.bodyStrong, color: color.ink },
  body: { ...typography.body, color: color.ink },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs },
  chip: { ...typography.caption, color: color.mute },
  chipLive: { color: color.success, fontWeight: '700' },
  link: { ...t.bodyStrong, color: color.deep },
});
