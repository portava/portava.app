/**
 * Admin — Stamp Studio duplicate catalog pairs.
 * Lists likely duplicate catalog entries (coordinate proximity or name
 * similarity) and lets an admin merge one entry into the other. Consumes the
 * typed StampDuplicatesResponse so server-side field renames surface as
 * compile errors instead of silent runtime breakage.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, Copy, Merge } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import {
  getStampDuplicates,
  mergeCatalogEntry,
  type StampDuplicatePair,
  type StampDuplicateRow,
} from '../../../src/services/adminStamps';

/** Stable key for a pair — catalog ids are unique, order is server-defined. */
function pairKey(pair: StampDuplicatePair): string {
  return `${pair.a.id}:${pair.b.id}`;
}

function reasonLabel(reason: StampDuplicatePair['reason']): string {
  return reason === 'coordinate_proximity' ? 'Nearby coordinates' : 'Similar names';
}

export default function StampDuplicatesScreen() {
  const insets = useSafeAreaInsets();
  useRequireAdmin();

  const [pairs, setPairs]           = useState<StampDuplicatePair[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey]       = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await getStampDuplicates();
    if (res.ok) setPairs(res.data.duplicates ?? []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const onMerge = useCallback((pair: StampDuplicatePair, source: StampDuplicateRow, target: StampDuplicateRow) => {
    Alert.alert(
      'Merge entries?',
      `"${source.display_name}" will be merged into "${target.display_name}". Earned stamps are repointed and the source entry is removed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Merge',
          style: 'destructive',
          onPress: async () => {
            const key = pairKey(pair);
            setBusyKey(key);
            const res = await mergeCatalogEntry(source.id, target.id);
            setBusyKey(null);
            if (res.ok) {
              setPairs((prev) =>
                prev.filter((p) => p.a.id !== source.id && p.b.id !== source.id)
              );
            } else {
              Alert.alert('Error', res.error ?? 'Failed to merge entries');
            }
          },
        },
      ],
    );
  }, []);

  const renderEntry = (row: StampDuplicateRow) => (
    <View style={styles.entryMeta}>
      <Text style={styles.entryName} numberOfLines={1}>{row.display_name}</Text>
      <Text style={styles.entrySub}>
        {row.stamp_type} · {row.country_code} · {row.earn_count} earned · {row.status}
      </Text>
      <Text style={styles.entryKey} numberOfLines={1}>{row.canonical_location_key}</Text>
    </View>
  );

  const renderPair = ({ item }: { item: StampDuplicatePair }) => {
    const busy = busyKey === pairKey(item);
    return (
      <View style={styles.card}>
        <View style={styles.reasonBadge}>
          <Text style={styles.reasonText}>{reasonLabel(item.reason)}</Text>
        </View>
        {renderEntry(item.a)}
        {renderEntry(item.b)}
        <View style={styles.actions}>
          <Pressable
            style={styles.mergeBtn}
            onPress={() => onMerge(item, item.b, item.a)}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color={color.onInk} />
            ) : (
              <>
                <Merge size={14} color={color.onInk} strokeWidth={2} />
                <Text style={styles.mergeText}>Merge B → A</Text>
              </>
            )}
          </Pressable>
          <Pressable
            style={styles.mergeBtn}
            onPress={() => onMerge(item, item.a, item.b)}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color={color.onInk} />
            ) : (
              <>
                <Merge size={14} color={color.onInk} strokeWidth={2} />
                <Text style={styles.mergeText}>Merge A → B</Text>
              </>
            )}
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.title}>Duplicate Entries</Text>
        <Text style={styles.count}>{pairs.length}</Text>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.ink} /></View>
      ) : (
        <FlatList
          testID="duplicate-pairs-list"
          data={pairs}
          keyExtractor={pairKey}
          renderItem={renderPair}
          contentContainerStyle={{ padding: space.md, paddingBottom: insets.bottom + space.xl }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Copy size={28} color={color.mute} strokeWidth={1.5} />
              <Text style={styles.empty}>No duplicate pairs detected</Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root:        { flex: 1, backgroundColor: color.paper },
  header:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn:     { marginRight: space.sm },
  title:       { ...t.heading, color: color.ink, flex: 1 },
  count:       { ...t.small, color: color.mute },
  center:      { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card:        { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: space.sm, backgroundColor: color.paper },
  reasonBadge: { alignSelf: 'flex-start', backgroundColor: '#EFF6FF', borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  reasonText:  { fontSize: 10, fontWeight: '700', color: '#1D4ED8' },
  entryMeta:   { gap: 1 },
  entryName:   { ...t.body, color: color.ink, fontWeight: '600' },
  entrySub:    { ...t.small, color: color.mute },
  entryKey:    { ...t.small, color: color.mute, fontFamily: 'monospace', fontSize: 10 },
  actions:     { flexDirection: 'row', gap: space.sm },
  mergeBtn:    { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.ink, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 8 },
  mergeText:   { fontSize: 12, fontWeight: '700', color: color.onInk },
  emptyWrap:   { alignItems: 'center', gap: space.xs, padding: space.xl },
  empty:       { color: color.mute },
});
