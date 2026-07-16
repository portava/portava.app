/**
 * Admin — Geocode Cache management screen.
 *
 * Lists city_country_geocode_cache rows. Admins can delete a row to force
 * re-resolution on the next lookup. When a deletion returns xx_entries_pending > 0
 * an inline warning banner appears with a one-click "Repair now" action that
 * re-issues the DELETE with repair_catalog=true so affected catalog entries are
 * re-keyed immediately.
 *
 * Requires admin role.
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
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { AlertTriangle, ArrowLeft, Search, Trash2, Wrench } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import {
  getGeocodeCacheRows,
  deleteGeocodeCacheRow,
  type GeocodeCacheRow,
} from '../../src/services/adminGeocode';
import {
  warningsAfterDelete,
  warningsAfterRepairStart,
  warningsAfterRepairSuccess,
  warningsAfterRepairFailure,
  type PendingWarning,
} from '../../src/lib/geocodeCacheWarnings';

// ── Component ──────────────────────────────────────────────────────────────────

export default function AdminGeocodeCacheScreen() {
  const insets = useSafeAreaInsets();
  useRequireAdmin();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<GeocodeCacheRow[]>([]);
  const [search, setSearch] = useState('');
  const [deletingKeys, setDeletingKeys] = useState<Set<string>>(new Set());

  // Inline warnings for city keys whose deletion left xx_entries_pending > 0.
  const [warnings, setWarnings] = useState<PendingWarning[]>([]);

  // ── Data loading ─────────────────────────────────────────────────────────────

  const load = useCallback(async (q?: string) => {
    setError(null);
    const res = await getGeocodeCacheRows(q);
    setLoading(false);
    setRefreshing(false);
    if (!res.ok) {
      setError(res.error ?? 'Failed to load geocode cache');
      return;
    }
    setRows(res.data.rows ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load(search.trim() || undefined);
  }, [load, search]);

  // Debounced search: re-fetch from server when the query changes.
  useEffect(() => {
    const timer = setTimeout(() => {
      load(search.trim() || undefined);
    }, 350);
    return () => clearTimeout(timer);
  }, [search, load]);

  // ── Delete ───────────────────────────────────────────────────────────────────

  function confirmDelete(row: GeocodeCacheRow) {
    Alert.alert(
      'Delete cache row',
      `Remove "${row.city_key}" from the geocode cache? The next lookup will re-resolve via Nominatim.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => performDelete(row.city_key) },
      ],
    );
  }

  async function performDelete(cityKey: string, repairCatalog = false) {
    setDeletingKeys((prev) => new Set(prev).add(cityKey));
    const res = await deleteGeocodeCacheRow(cityKey, repairCatalog);
    setDeletingKeys((prev) => {
      const next = new Set(prev);
      next.delete(cityKey);
      return next;
    });

    if (!res.ok) {
      Alert.alert('Delete failed', res.error ?? 'Please try again.');
      return;
    }

    // Remove the row from the list on success.
    setRows((prev) => prev.filter((r) => r.city_key !== cityKey));

    const pending = res.data.xx_entries_pending ?? 0;
    setWarnings((prev) => warningsAfterDelete(prev, cityKey, pending));
  }

  async function handleRepairNow(cityKey: string) {
    // Mark as repairing in place so the button shows a spinner.
    setWarnings((prev) => warningsAfterRepairStart(prev, cityKey));

    const res = await deleteGeocodeCacheRow(cityKey, true);

    if (!res.ok) {
      setWarnings((prev) => warningsAfterRepairFailure(prev, cityKey));
      Alert.alert('Repair failed', res.error ?? 'Please try again.');
      return;
    }

    // Repair succeeded — dismiss the warning regardless of residual count.
    // The row was already removed when we deleted it without repair. Nothing to
    // remove from the list again — the row may not even exist any more.
    setWarnings((prev) => warningsAfterRepairSuccess(prev, cityKey));
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────

  function renderRow({ item }: { item: GeocodeCacheRow }) {
    const deleting = deletingKeys.has(item.city_key);
    return (
      <View style={s.row} testID={`geocode-row-${item.city_key}`}>
        <View style={s.rowLeft}>
          <Text style={s.rowKey} numberOfLines={1}>{item.city_key}</Text>
          <Text style={s.rowMeta}>
            {item.country_code} · {item.country}
            {item.updated_at ? `  ·  ${formatDate(item.updated_at)}` : ''}
          </Text>
        </View>
        <Pressable
          style={[s.deleteBtn, deleting && s.deleteBtnBusy]}
          onPress={() => confirmDelete(item)}
          disabled={deleting}
          hitSlop={8}
          testID={`delete-btn-${item.city_key}`}
        >
          {deleting
            ? <ActivityIndicator size="small" color="#EF4444" />
            : <Trash2 size={18} color="#EF4444" strokeWidth={2} />}
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Geocode Cache</Text>
      </View>

      {/* Search */}
      <View style={s.searchRow}>
        <Search size={16} color={color.mute} />
        <TextInput
          style={s.searchInput}
          placeholder="Search city key…"
          placeholderTextColor={color.mute}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          autoCapitalize="none"
          testID="geocode-search"
        />
      </View>

      {/* XX-entries-pending warning banners */}
      {warnings.length > 0 && (
        <View style={s.warningsContainer} testID="xx-warnings">
          {warnings.map((w) => (
            <View key={w.cityKey} style={s.warnBanner} testID={`xx-warning-${w.cityKey}`}>
              <AlertTriangle size={18} color="#B45309" strokeWidth={2} style={s.warnIcon} />
              <View style={s.warnBody}>
                <Text style={s.warnTitle} testID={`xx-warning-text-${w.cityKey}`}>
                  {w.count} catalog {w.count === 1 ? 'entry is' : 'entries are'} still showing XX for "{w.cityKey}". Re-delete with 'Repair catalog' to fix {w.count === 1 ? 'it' : 'them'} now.
                </Text>
                <Pressable
                  style={[s.repairBtn, w.repairing && s.repairBtnBusy]}
                  onPress={() => handleRepairNow(w.cityKey)}
                  disabled={w.repairing}
                  testID={`repair-btn-${w.cityKey}`}
                >
                  {w.repairing ? (
                    <ActivityIndicator size="small" color="#92400E" />
                  ) : (
                    <>
                      <Wrench size={14} color="#92400E" strokeWidth={2} />
                      <Text style={s.repairBtnText}>Repair now</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* Body */}
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator color={color.ink} />
        </View>
      ) : error ? (
        <View style={s.center}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable onPress={() => load()} style={s.retryBtn}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.city_key}
          renderItem={renderRow}
          contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
          ItemSeparatorComponent={() => <View style={s.separator} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View style={s.center}>
              <Text style={s.emptyText}>
                {search.trim() ? 'No rows match that search.' : 'Geocode cache is empty.'}
              </Text>
            </View>
          }
          testID="geocode-cache-list"
        />
      )}
    </View>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:   { flex: 1, backgroundColor: color.paper },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.sm,
  },
  backBtn: { padding: 4 },
  title:   { ...t.bodyStrong, color: color.ink, fontWeight: '700', flex: 1 },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  searchInput: { flex: 1, ...t.body, color: color.ink, paddingVertical: 4 },

  warningsContainer: { gap: 0 },
  warnBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    backgroundColor: '#FEF3C7',
    borderBottomWidth: 1,
    borderBottomColor: '#FCD34D',
    padding: space.md,
  },
  warnIcon: { marginTop: 2 },
  warnBody: { flex: 1, gap: space.xs },
  warnTitle: { ...t.small, color: '#92400E', lineHeight: 18 },
  repairBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: '#FDE68A',
    borderWidth: 1,
    borderColor: '#F59E0B',
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    minWidth: 48,
    minHeight: 28,
    justifyContent: 'center',
  },
  repairBtnBusy: { opacity: 0.6 },
  repairBtnText: { ...t.small, color: '#92400E', fontWeight: '700' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.paper,
  },
  rowLeft:  { flex: 1, gap: 2 },
  rowKey:   { ...t.bodyStrong, color: color.ink },
  rowMeta:  { fontSize: 11, color: color.mute },
  deleteBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteBtnBusy: { opacity: 0.5 },

  separator: { height: 1, backgroundColor: color.haze },

  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  errorText: { ...t.body, color: '#EF4444', textAlign: 'center', marginBottom: space.md },
  retryBtn:  { paddingHorizontal: space.lg, paddingVertical: space.sm },
  retryText: { ...t.bodyStrong, color: color.signal },
});
