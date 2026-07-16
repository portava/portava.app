/**
 * Admin Gem Moderation screen
 *
 * Shows Pending / Reported / Guides / Sensitive / Duplicates queues.
 * All API calls use the same apiFetch helper (bearer token from Supabase session).
 * Route: /gems/admin
 */
import { useState, useCallback, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, Alert,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../src/lib/supabase';
import { NavBarFiller, useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await freshToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const json = await res.json();
  if (!res.ok) throw new Error((json as any).message ?? `HTTP ${res.status}`);
  return json as T;
}

type AdminTab = 'Pending' | 'Reported' | 'Guides' | 'Sensitive' | 'Duplicates';
const TABS: AdminTab[] = ['Pending', 'Reported', 'Guides', 'Sensitive', 'Duplicates'];

// ── Queue row ─────────────────────────────────────────────────────────────────

function QueueRow({
  label,
  sublabel,
  actions,
}: {
  label: string;
  sublabel: string;
  actions: { label: string; color: string; bg: string; onPress: () => void }[];
}) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowSub}>{sublabel}</Text>
      </View>
      <View style={styles.rowActions}>
        {actions.map((a) => (
          <TouchableOpacity
            key={a.label}
            style={[styles.actionBtn, { backgroundColor: a.bg }]}
            onPress={a.onPress}
          >
            <Text style={[styles.actionTxt, { color: a.color }]}>{a.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ── Generic admin queue tab ───────────────────────────────────────────────────

function AdminQueue<T extends { id: string }>({
  endpoint,
  responseKey,
  renderRow,
}: {
  endpoint: string;
  responseKey: string;
  renderRow: (item: T, refresh: () => void) => React.ReactElement;
}) {
  const navBarScrollHandler = useNavBarScrollHandler();
  const [items, setItems]     = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await adminFetch<Record<string, T[]>>(endpoint);
      setItems(data[responseKey] ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [endpoint, responseKey]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <View style={styles.center}><ActivityIndicator color="#4C8BF5" /></View>;
  if (error)   return <View style={styles.center}><Text style={styles.err}>{error}</Text></View>;
  if (items.length === 0) return <View style={styles.center}><Text style={styles.empty}>Queue is empty</Text></View>;

  return (
    <FlatList
      data={items}
      keyExtractor={(i) => i.id ?? (i as any).user_id}
      renderItem={({ item }) => renderRow(item, load)}
      contentContainerStyle={styles.list}
      onScroll={navBarScrollHandler}
      scrollEventThrottle={16}
      ListFooterComponent={<NavBarFiller />}
    />
  );
}

// ── Pending tab ───────────────────────────────────────────────────────────────

function PendingTab() {
  const verify = useCallback(async (id: string, result: 'approved' | 'rejected', refresh: () => void) => {
    try {
      // API schema: { result: 'approved' | 'rejected' | 'hidden' }
      await adminFetch(`/api/admin/hidden-gems/${id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ result }),
      });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  return (
    <AdminQueue<any>
      endpoint="/api/admin/hidden-gems/pending"
      responseKey="queue"
      renderRow={(item, refresh) => (
        <QueueRow
          label={item.name}
          sublabel={`${item.city} · ${item.category}`}
          actions={[
            { label: 'Approve', color: '#4CAF7D', bg: '#1A3A2A', onPress: () => verify(item.id, 'approved', refresh) },
            { label: 'Reject',  color: '#FF6B6B', bg: '#3A1A1A', onPress: () => verify(item.id, 'rejected', refresh) },
          ]}
        />
      )}
    />
  );
}

// ── Reported tab ──────────────────────────────────────────────────────────────

function ReportedTab() {
  const hide = useCallback(async (id: string, refresh: () => void) => {
    try {
      // API schema: { result: 'hidden' }
      await adminFetch(`/api/admin/hidden-gems/${id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ result: 'hidden' }),
      });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  const markSensitive = useCallback(async (id: string, refresh: () => void) => {
    try {
      await adminFetch(`/api/admin/hidden-gems/${id}/sensitive`, {
        method: 'POST',
        body: JSON.stringify({ sensitivityLevel: 'protected' }),
      });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  return (
    <AdminQueue<any>
      endpoint="/api/admin/hidden-gems/reported"
      responseKey="gems"
      renderRow={(item, refresh) => (
        <QueueRow
          label={item.name}
          sublabel={`${item.city} · reports: ${item.report_count ?? '?'}`}
          actions={[
            { label: 'Sensitive', color: '#F5A623', bg: '#3A2E1A', onPress: () => markSensitive(item.id, refresh) },
            { label: 'Hide',      color: '#FF6B6B', bg: '#3A1A1A', onPress: () => hide(item.id, refresh) },
          ]}
        />
      )}
    />
  );
}

// ── Guide applications tab ────────────────────────────────────────────────────

function GuidesTab() {
  const setStatus = useCallback(async (userId: string, status: 'active' | 'demoted', refresh: () => void) => {
    try {
      // API: { status: 'active' | 'suspended' | 'demoted' }
      await adminFetch(`/api/admin/local-guides/${userId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  return (
    <AdminQueue<any>
      endpoint="/api/admin/hidden-gems/guide-applications"
      responseKey="applications"
      renderRow={(item, refresh) => (
        <QueueRow
          label={item.user_id ?? item.id}
          sublabel={`Cities: ${(item.city_expertise ?? []).join(', ') || '—'}`}
          actions={[
            { label: 'Approve', color: '#4CAF7D', bg: '#1A3A2A', onPress: () => setStatus(item.user_id ?? item.id, 'active',  refresh) },
            { label: 'Demote',  color: '#FF6B6B', bg: '#3A1A1A', onPress: () => setStatus(item.user_id ?? item.id, 'demoted', refresh) },
          ]}
        />
      )}
    />
  );
}

// ── Sensitive gems tab ────────────────────────────────────────────────────────

function SensitiveTab() {
  const downgrade = useCallback(async (id: string, refresh: () => void) => {
    try {
      await adminFetch(`/api/admin/hidden-gems/${id}/sensitive`, {
        method: 'POST',
        body: JSON.stringify({ sensitivityLevel: 'approximate' }),
      });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  const hide = useCallback(async (id: string, refresh: () => void) => {
    try {
      await adminFetch(`/api/admin/hidden-gems/${id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ result: 'hidden' }),
      });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  return (
    <AdminQueue<any>
      endpoint="/api/admin/hidden-gems/sensitive-gems"
      responseKey="gems"
      renderRow={(item, refresh) => (
        <QueueRow
          label={item.name}
          sublabel={`${item.city} · ${item.sensitivity_level}`}
          actions={[
            { label: 'Downgrade', color: '#4C8BF5', bg: '#1A2A3A', onPress: () => downgrade(item.id, refresh) },
            { label: 'Hide',      color: '#FF6B6B', bg: '#3A1A1A', onPress: () => hide(item.id, refresh) },
          ]}
        />
      )}
    />
  );
}

// ── Duplicate candidates tab ──────────────────────────────────────────────────

function DuplicatesTab() {
  const [canonicalId, setCanonicalId] = useState<string>('');

  const merge = useCallback(async (id: string, refresh: () => void) => {
    Alert.prompt(
      'Merge Duplicate',
      'Enter the canonical gem ID to merge into:',
      async (targetId) => {
        if (!targetId) return;
        try {
          await adminFetch(`/api/admin/hidden-gems/${id}/merge`, {
            method: 'POST',
            body: JSON.stringify({ canonicalGemId: targetId }),
          });
          refresh();
        } catch (e: any) {
          Alert.alert('Error', e.message);
        }
      },
      'plain-text',
    );
  }, []);

  const approve = useCallback(async (id: string, refresh: () => void) => {
    try {
      await adminFetch(`/api/admin/hidden-gems/${id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ result: 'approved' }),
      });
      refresh();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  return (
    <AdminQueue<any>
      endpoint="/api/admin/hidden-gems/duplicate-candidates"
      responseKey="gems"
      renderRow={(item, refresh) => (
        <QueueRow
          label={item.name}
          sublabel={`${item.city} · ${item.category}`}
          actions={[
            { label: 'Approve',   color: '#4CAF7D', bg: '#1A3A2A', onPress: () => approve(item.id, refresh) },
            { label: 'Merge…',    color: '#A78BFA', bg: '#2A1A3A', onPress: () => merge(item.id, refresh) },
          ]}
        />
      )}
    />
  );
}

// ── Root screen ───────────────────────────────────────────────────────────────

export default function AdminModerationScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<AdminTab>('Pending');

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Ionicons name="arrow-back" size={22} color="#E8F0FE" />
        </TouchableOpacity>
        <Text style={styles.title}>Gem Moderation</Text>
        <View style={{ width: 30 }} />
      </View>

      {/* Tab bar scrollable — 5 tabs */}
      <FlatList
        data={TABS}
        horizontal
        keyExtractor={(t) => t}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.tabBar}
        renderItem={({ item: t }) => (
          <TouchableOpacity
            style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabTxt, tab === t && styles.tabTxtActive]}>{t}</Text>
          </TouchableOpacity>
        )}
      />

      {tab === 'Pending'    && <PendingTab />}
      {tab === 'Reported'   && <ReportedTab />}
      {tab === 'Guides'     && <GuidesTab />}
      {tab === 'Sensitive'  && <SensitiveTab />}
      {tab === 'Duplicates' && <DuplicatesTab />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root:  { flex: 1, backgroundColor: '#0A1628' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  err:   { color: '#FF6B6B', fontSize: 14, textAlign: 'center' },
  empty: { color: '#8A9BB5', fontSize: 14 },
  list:  { padding: 16 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  back:   { padding: 4 },
  title:  { fontSize: 18, fontWeight: '700', color: '#E8F0FE' },

  tabBar: { paddingHorizontal: 12, paddingBottom: 4, gap: 6 },
  tabBtn: { alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  tabBtnActive: { backgroundColor: '#1E2D45' },
  tabTxt: { fontSize: 13, color: '#8A9BB5' },
  tabTxtActive: { color: '#4C8BF5', fontWeight: '600' },

  row: { backgroundColor: '#1E2D45', borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowLabel: { fontSize: 15, fontWeight: '600', color: '#E8F0FE' },
  rowSub:   { fontSize: 13, color: '#8A9BB5', marginTop: 2 },
  rowActions: { flexDirection: 'column', gap: 6 },
  actionBtn:  { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  actionTxt:  { fontSize: 12, fontWeight: '600' },
});
