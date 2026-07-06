/**
 * Admin — Feature flags screen.
 * Lists all rows from GET /api/admin/feature-flags and lets admins toggle
 * each flag on/off via PATCH /api/admin/feature-flags/:flag.
 * Requires admin role (enforced server-side by requireAdmin middleware).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../src/lib/supabase';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { color, space, radius, type as t } from '../../src/theme/tokens';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FlagLastChange {
  changed_at: string;
  old_enabled: boolean;
  new_enabled: boolean;
  changed_by_name: string | null;
}

interface FeatureFlag {
  flag: string;
  enabled: boolean;
  description: string | null;
  updated_at: string | null;
  last_change?: FlagLastChange;
}

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

// ── Flag row ──────────────────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function FlagRow({
  item,
  onToggle,
  toggling,
}: {
  item: FeatureFlag;
  onToggle: (flag: string, enabled: boolean) => void;
  toggling: boolean;
}) {
  const lc = item.last_change;
  return (
    <View style={s.row}>
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
      <Switch
        value={item.enabled}
        onValueChange={(v) => onToggle(item.flag, v)}
        disabled={toggling}
        trackColor={{ false: color.haze, true: color.signal }}
        thumbColor="#fff"
      />
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

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    const res = await adminGet<{ flags: FeatureFlag[] }>('/api/admin/feature-flags');
    if (res.ok && res.data) {
      setFlags(res.data.flags);
    } else {
      setError(res.error ?? 'Failed to load flags');
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (!sessionLoading && isAuthed) load();
  }, [load, isAuthed, sessionLoading]);

  const handleToggle = useCallback(async (flag: string, enabled: boolean) => {
    setTogglingFlag(flag);
    // Optimistic update
    setFlags((prev) => prev.map((f) => f.flag === flag ? { ...f, enabled } : f));

    const res = await adminPatch<{ flag: FeatureFlag }>(
      `/api/admin/feature-flags/${encodeURIComponent(flag)}`,
      { enabled },
    );

    if (!res.ok) {
      // Revert on failure
      setFlags((prev) => prev.map((f) => f.flag === flag ? { ...f, enabled: !enabled } : f));
      Alert.alert('Toggle failed', res.error ?? 'Unknown error');
    } else if (res.data?.flag) {
      // Sync confirmed server state
      setFlags((prev) => prev.map((f) => f.flag === flag ? res.data!.flag : f));
    }

    setTogglingFlag(null);
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load(true);
  }, [load]);

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
          data={flags}
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
              <Text style={s.emptyText}>No feature flags found.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <FlagRow
              item={item}
              onToggle={handleToggle}
              toggling={togglingFlag === item.flag}
            />
          )}
        />
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

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
});
