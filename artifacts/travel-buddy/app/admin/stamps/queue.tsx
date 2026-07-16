/**
 * Admin — Stamp Studio catalog queue.
 * Filterable/paginated list of all catalog entries.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, Search } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import { getAdminStampCatalog, type CatalogListEntry } from '../../../src/services/adminStamps';

const STATUS_FILTERS = ['', 'pending_artwork', 'review_required', 'approved', 'rejected'] as const;

export default function StampQueueScreen() {
  const insets = useSafeAreaInsets();
  useRequireAdmin();

  const params = useLocalSearchParams<{ status?: string }>();
  const [entries, setEntries]       = useState<CatalogListEntry[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch]         = useState('');
  const [status, setStatus]         = useState<string>(params.status ?? '');
  const [total, setTotal]           = useState(0);

  const load = useCallback(async (reset = true) => {
    const res = await getAdminStampCatalog({
      page: 1,
      limit: 100,
      status: status || undefined,
      search: search || undefined,
    });
    if (res.ok) {
      setEntries(res.data.entries ?? []);
      setTotal(res.data.total ?? 0);
    }
    setLoading(false);
    setRefreshing(false);
  }, [status, search]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const renderEntry = ({ item }: { item: CatalogListEntry }) => (
    <Pressable
      style={styles.row}
      onPress={() => router.push(`/admin/stamps/${item.id}` as any)}
    >
      <View style={styles.rowMeta}>
        <Text style={styles.rowName} numberOfLines={1}>{item.display_name}</Text>
        <Text style={styles.rowSub}>{item.stamp_type} · {item.country_code} · {item.earn_count ?? 0} earners</Text>
      </View>
      <View style={styles.badgeCol}>
        {item.status === 'review_required' && typeof item.last_error === 'string' && item.last_error.startsWith('candidate_shortfall') && (
          <View style={[styles.badge, styles.degradedBadge]}>
            <Text style={[styles.badgeText, styles.degradedBadgeText]}>degraded</Text>
          </View>
        )}
        <View style={[styles.badge, { backgroundColor: statusBg(item.status) }]}>
          <Text style={styles.badgeText}>{item.status?.replace(/_/g, ' ')}</Text>
        </View>
      </View>
    </Pressable>
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.title}>Catalog Queue</Text>
        <Text style={styles.count}>{total}</Text>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <Search size={16} color={color.mute} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name…"
          placeholderTextColor={color.faint}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
      </View>

      {/* Status filter chips */}
      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((s) => (
          <Pressable
            key={s || 'all'}
            style={[styles.chip, status === s && styles.chipActive]}
            onPress={() => setStatus(s)}
          >
            <Text style={[styles.chipText, status === s && styles.chipTextActive]}>
              {s ? s.replace(/_/g, ' ') : 'All'}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.ink} /></View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.id}
          renderItem={renderEntry}
          contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={<Text style={styles.empty}>No entries found</Text>}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}
    </View>
  );
}

function statusBg(s: string) {
  switch (s) {
    case 'approved':        return '#D1FAE5';
    case 'pending_artwork': return '#FEF3C7';
    case 'rejected':        return '#FEE2E2';
    case 'review_required': return '#DBEAFE';
    default:                return '#F3F4F6';
  }
}

const styles = StyleSheet.create({
  root:          { flex: 1, backgroundColor: color.paper },
  header:        { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn:       { marginRight: space.sm },
  title:         { ...t.heading, color: color.ink, flex: 1 },
  count:         { ...t.small, color: color.mute },
  searchRow:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.xs, borderBottomWidth: 1, borderBottomColor: color.haze, gap: space.xs },
  searchInput:   { flex: 1, ...t.body, color: color.ink, paddingVertical: 6 },
  filterRow:     { flexDirection: 'row', paddingHorizontal: space.md, paddingVertical: space.xs, gap: space.xs, flexWrap: 'wrap', borderBottomWidth: 1, borderBottomColor: color.haze },
  chip:          { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: '#F3F4F6', borderWidth: 1, borderColor: color.haze },
  chipActive:    { backgroundColor: color.ink, borderColor: color.ink },
  chipText:      { fontSize: 11, color: color.mute, fontWeight: '600' },
  chipTextActive:{ color: color.onInk },
  center:        { flex: 1, justifyContent: 'center', alignItems: 'center' },
  row:           { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.md, backgroundColor: color.paper },
  rowMeta:       { flex: 1 },
  rowName:       { ...t.body, color: color.ink, fontWeight: '600' },
  rowSub:        { ...t.small, color: color.mute },
  badgeCol:      { alignItems: 'flex-end', gap: 4 },
  badge:         { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  degradedBadge: { backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#FCA5A5' },
  degradedBadgeText: { color: '#B91C1C' },
  badgeText:     { fontSize: 10, fontWeight: '700', color: '#374151' },
  sep:           { height: 1, backgroundColor: color.haze, marginLeft: space.md },
  empty:         { textAlign: 'center', color: color.mute, padding: space.xl },
});
