/**
 * Admin — Feature flags screen.
 * Lists all rows from GET /api/admin/feature-flags and lets admins toggle
 * each flag on/off via PATCH /api/admin/feature-flags/:flag.
 * Tapping a flag row opens a bottom sheet with the full change history
 * from GET /api/admin/feature-flags/:flag/history.
 * Requires admin role (enforced server-side by requireAdmin middleware).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, ChevronRight, Clock, Search, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../src/lib/supabase';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import {
  applyOptimisticToggle,
  applyToggleResult,
  applyLoadResult,
  applyHistoryLoadResult,
  getActiveKillSwitches,
} from '../../src/screens/admin/featureFlags.machine';
import { KILL_SWITCH_LABELS } from '../../src/constants/killSwitches';
import type { FeatureFlag, FlagHistoryEntry } from '../../src/screens/admin/featureFlags.machine';

// ── API helpers ───────────────────────────────────────────────────────────────

function apiBase() { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }

async function freshToken(): Promise<string | null> {
  try {
    const { data: refreshed } = await supabase.auth.refreshSession();
    const s = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
    return s?.access_token ?? null;
  } catch { return null; }
}

async function adminGet<T>(path: string): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() as T };
  } catch (e: any) { return { ok: false, error: e?.message ?? 'Network error' }; }
}

async function adminPatch<T>(path: string, body: unknown): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() as T };
  } catch (e: any) { return { ok: false, error: e?.message ?? 'Network error' }; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ── Flag history bottom sheet ─────────────────────────────────────────────────

function EnabledPill({ value }: { value: boolean }) {
  return (
    <View style={[sh.pill, value ? sh.pillOn : sh.pillOff]}>
      <Text style={[sh.pillText, value ? sh.pillTextOn : sh.pillTextOff]}>
        {value ? 'ON' : 'OFF'}
      </Text>
    </View>
  );
}

function HistoryEntry({ entry }: { entry: FlagHistoryEntry }) {
  return (
    <View style={sh.entry}>
      <View style={sh.entryHeader}>
        <Clock size={13} color={color.faint} />
        <Text style={sh.entryTime}>{formatDateTime(entry.changed_at)}</Text>
        {!!entry.changed_by_name && (
          <Text style={sh.entryActor} numberOfLines={1}>· {entry.changed_by_name}</Text>
        )}
      </View>
      <View style={sh.pillRow}>
        <EnabledPill value={entry.old_enabled} />
        <Text style={sh.arrow}>→</Text>
        <EnabledPill value={entry.new_enabled} />
      </View>
    </View>
  );
}

function FlagHistorySheet({
  flagName,
  visible,
  onClose,
}: {
  flagName: string | null;
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<FlagHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (flag: string) => {
    setLoading(true);
    setError(null);
    const res = await adminGet<{ flag: string; history: FlagHistoryEntry[] }>(
      `/api/admin/feature-flags/${encodeURIComponent(flag)}/history`,
    );
    const { entries: loaded, error: loadError } = applyHistoryLoadResult(res);
    setEntries(loaded);
    setError(loadError);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (visible && flagName) {
      load(flagName);
    } else if (!visible) {
      setEntries([]);
      setError(null);
    }
  }, [visible, flagName, load]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={sh.backdrop} onPress={onClose} />
      <View style={[sh.sheet, { paddingBottom: insets.bottom + space.md }]}>
        {/* Header */}
        <View style={sh.header}>
          <View style={sh.headerLeft}>
            <Text style={sh.title}>Change History</Text>
            {!!flagName && (
              <Text style={sh.subtitle} numberOfLines={1}>{flagName}</Text>
            )}
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={sh.closeBtn}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        {/* Body */}
        {loading ? (
          <View style={sh.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : error ? (
          <View style={sh.center}>
            <Text style={sh.errorText}>{error}</Text>
            {!!flagName && (
              <Pressable style={sh.retryBtn} onPress={() => load(flagName)}>
                <Text style={sh.retryText}>Retry</Text>
              </Pressable>
            )}
          </View>
        ) : entries.length === 0 ? (
          <View style={sh.center}>
            <Text style={sh.empty}>No changes recorded yet.</Text>
            <Text style={sh.emptyHint}>History is written the first time a flag is toggled.</Text>
          </View>
        ) : (
          <FlatList
            data={entries}
            keyExtractor={(e) => e.id}
            renderItem={({ item }) => <HistoryEntry entry={item} />}
            contentContainerStyle={sh.list}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </Modal>
  );
}

// ── Flag row ──────────────────────────────────────────────────────────────────

function FlagRow({
  item,
  onToggle,
  toggling,
  onViewHistory,
}: {
  item: FeatureFlag;
  onToggle: (flag: string, enabled: boolean) => void;
  toggling: boolean;
  onViewHistory: (flag: string) => void;
}) {
  const lc = item.last_change;
  return (
    <Pressable
      style={({ pressed }) => [s.row, pressed && { opacity: 0.85 }]}
      onPress={() => onViewHistory(item.flag)}
      accessibilityLabel={`View history for ${item.flag}`}
      accessibilityRole="button"
    >
      <View style={s.rowText}>
        <Text style={s.flagName} numberOfLines={1}>{item.flag}</Text>
        {!!item.description && (
          <Text style={s.flagDesc} numberOfLines={2}>{item.description}</Text>
        )}
        {lc ? (
          <Text style={s.flagDate}>
            {lc.changed_by_name ? `${lc.changed_by_name} · ` : ''}
            {formatDateTime(lc.changed_at)}
          </Text>
        ) : !!item.updated_at && (
          <Text style={s.flagDate}>
            Updated {new Date(item.updated_at).toLocaleDateString()}
          </Text>
        )}
      </View>
      <View style={s.rowRight}>
        <Switch
          value={item.enabled}
          onValueChange={(v) => onToggle(item.flag, v)}
          disabled={toggling}
          trackColor={{ false: color.haze, true: color.signal }}
          thumbColor="#fff"
        />
        <ChevronRight size={16} color={color.faint} />
      </View>
    </Pressable>
  );
}

// ── Kill-switch banner ────────────────────────────────────────────────────────

function KillSwitchBanner({ activeFlags }: { activeFlags: string[] }) {
  if (activeFlags.length === 0) return null;
  return (
    <View style={s.killBanner}>
      <Text style={s.killBannerTitle}>
        {activeFlags.length === 1 ? '⚠ Kill switch active' : `⚠ ${activeFlags.length} kill switches active`}
      </Text>
      {activeFlags.map((flag) => (
        <Text key={flag} style={s.killBannerItem}>· {KILL_SWITCH_LABELS[flag] ?? flag}</Text>
      ))}
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function FeatureFlagsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();

  useEffect(() => {
    if (!sessionLoading && !isAuthed) { router.replace('/(auth)/sign-in' as any); }
  }, [isAuthed, sessionLoading]);

  const [flags, setFlags]           = useState<FeatureFlag[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [togglingFlag, setTogglingFlag] = useState<string | null>(null);

  // History sheet state
  const [historyFlag, setHistoryFlag] = useState<string | null>(null);

  // Search / filter state
  const [query, setQuery] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const res = await adminGet<{ flags: FeatureFlag[] }>('/api/admin/feature-flags');
    const { flags: loaded, error: loadError } = applyLoadResult(res);
    if (loaded !== null) {
      setFlags(loaded);
    } else {
      setError(loadError);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (!sessionLoading && isAuthed) load();
  }, [load, isAuthed, sessionLoading]);

  const handleToggle = useCallback(async (flag: string, enabled: boolean) => {
    setTogglingFlag(flag);
    setFlags((prev) => applyOptimisticToggle(prev, flag, enabled));

    const res = await adminPatch<{ flag: FeatureFlag }>(
      `/api/admin/feature-flags/${encodeURIComponent(flag)}`,
      { enabled },
    );

    setFlags((prev) => {
      const { flags: next, error: toggleError } = applyToggleResult(prev, flag, enabled, res);
      if (toggleError) {
        Alert.alert('Toggle failed', toggleError);
      }
      return next;
    });

    setTogglingFlag(null);
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load(true);
  }, [load]);

  const handleViewHistory = useCallback((flag: string) => {
    setHistoryFlag(flag);
  }, []);

  const handleCloseHistory = useCallback(() => {
    setHistoryFlag(null);
  }, []);

  // ── Derived ─────────────────────────────────────────────────────────────────

  const activeKillSwitches = getActiveKillSwitches(flags);

  const filteredFlags = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flags;
    return flags.filter(
      (f) =>
        f.flag.toLowerCase().includes(q) ||
        (f.description ?? '').toLowerCase().includes(q),
    );
  }, [flags, query]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={[s.screen, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable
          onPress={() => router.back()}
          style={({ pressed }) => [s.backBtn, pressed && { opacity: 0.6 }]}
          hitSlop={8}
        >
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.title}>Feature Flags</Text>
        <View style={{ width: 36 }} />
      </View>

      {/* Kill-switch banner */}
      <KillSwitchBanner activeFlags={activeKillSwitches} />

      {/* Search bar */}
      <View style={s.searchRow}>
        <Search size={16} color={color.faint} style={s.searchIcon} />
        <TextInput
          style={s.searchInput}
          placeholder="Search flags…"
          placeholderTextColor={color.faint}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
          accessibilityLabel="Search feature flags"
        />
        {query.length > 0 && (
          <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear search">
            <X size={16} color={color.faint} />
          </Pressable>
        )}
      </View>

      {/* Body */}
      {loading ? (
        <View style={s.center}>
          <ActivityIndicator size="large" color={color.signal} />
        </View>
      ) : error ? (
        <View style={s.center}>
          <Text style={s.errorText}>{error}</Text>
          <Pressable style={s.retryBtn} onPress={() => load()}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={filteredFlags}
          keyExtractor={(f) => f.flag}
          contentContainerStyle={{ padding: space.md, paddingBottom: insets.bottom + space.xl }}
          ItemSeparatorComponent={() => <View style={s.separator} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={color.signal}
            />
          }
          ListEmptyComponent={
            <View style={s.center}>
              <Text style={s.emptyText}>
                {query.trim().length > 0
                  ? `No flags match "${query.trim()}".`
                  : 'No feature flags found.'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <FlagRow
              item={item}
              onToggle={handleToggle}
              toggling={togglingFlag === item.flag}
              onViewHistory={handleViewHistory}
            />
          )}
        />
      )}

      {/* Flag history bottom sheet */}
      <FlagHistorySheet
        flagName={historyFlag}
        visible={historyFlag !== null}
        onClose={handleCloseHistory}
      />
    </View>
  );
}

// ── Screen styles ─────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    ...t.heading,
    color: color.ink,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  flagName: {
    ...t.bodyStrong,
    color: color.ink,
  },
  flagDesc: {
    ...t.small,
    color: color.mute,
  },
  flagDate: {
    ...t.small,
    color: color.faint,
    marginTop: 2,
  },
  separator: {
    height: space.sm,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  errorText: {
    ...t.body,
    color: '#C0392B',
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.md,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.onInk,
  },
  emptyText: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: space.md,
    marginTop: space.sm,
    marginBottom: space.xs,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    gap: space.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
  },
  searchIcon: {
    flexShrink: 0,
  },
  searchInput: {
    flex: 1,
    ...t.body,
    color: color.ink,
    paddingVertical: 4,
  },
  killBanner: {
    backgroundColor: '#FFF0EE',
    borderLeftWidth: 4,
    borderLeftColor: '#E03131',
    marginHorizontal: space.md,
    marginTop: space.sm,
    marginBottom: space.xs,
    borderRadius: radius.sm,
    padding: space.md,
    gap: 4,
  },
  killBannerTitle: {
    ...t.bodyStrong,
    color: '#C0392B',
  },
  killBannerItem: {
    ...t.small,
    color: '#C0392B',
    paddingLeft: 4,
  },
});

// ── Sheet styles ──────────────────────────────────────────────────────────────

const sh = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,15,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: space.md,
    maxHeight: '80%',
    ...shadow.card,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    marginBottom: space.xs,
  },
  headerLeft: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: color.ink,
  },
  subtitle: {
    fontSize: 12,
    color: color.faint,
    fontFamily: 'monospace',
  },
  closeBtn: {
    marginLeft: space.md,
    paddingTop: 2,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  empty: {
    fontSize: 14,
    color: color.faint,
    textAlign: 'center',
  },
  emptyHint: {
    fontSize: 12,
    color: color.faint,
    textAlign: 'center',
    opacity: 0.7,
  },
  errorText: {
    fontSize: 14,
    color: '#C0392B',
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.signal,
    borderRadius: radius.md,
  },
  retryText: {
    fontSize: 14,
    fontWeight: '600',
    color: color.onInk,
  },
  list: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.md,
  },
  entry: {
    gap: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexWrap: 'wrap',
  },
  entryTime: {
    fontSize: 12,
    color: color.faint,
    fontWeight: '500',
  },
  entryActor: {
    fontSize: 12,
    color: color.mute,
    fontWeight: '500',
    flex: 1,
  },
  pillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  arrow: {
    fontSize: 14,
    color: color.faint,
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  pillOn: {
    backgroundColor: '#E8F5EE',
  },
  pillOff: {
    backgroundColor: '#F5F5F5',
  },
  pillText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  pillTextOn: {
    color: color.success,
  },
  pillTextOff: {
    color: color.faint,
  },
});
