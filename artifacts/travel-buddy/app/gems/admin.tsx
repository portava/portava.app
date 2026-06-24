/**
 * Admin Gem Moderation screen
 *
 * Shows pending, reported, and guide-application queues for admin users.
 * All actions call the admin API endpoints.
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

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.message ?? 'Request failed');
  return json as T;
}

type AdminTab = 'Pending' | 'Reported' | 'Guides';

const TABS: AdminTab[] = ['Pending', 'Reported', 'Guides'];

// ── Queue row ─────────────────────────────────────────────────────────────────

function QueueRow({
  label,
  sublabel,
  onApprove,
  onReject,
  approveLabel = 'Approve',
  rejectLabel  = 'Reject',
}: {
  label: string;
  sublabel: string;
  onApprove?: () => void;
  onReject?: () => void;
  approveLabel?: string;
  rejectLabel?: string;
}) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowSub}>{sublabel}</Text>
      </View>
      <View style={styles.rowActions}>
        {onApprove && (
          <TouchableOpacity style={styles.approveBtn} onPress={onApprove}>
            <Text style={styles.approveTxt}>{approveLabel}</Text>
          </TouchableOpacity>
        )}
        {onReject && (
          <TouchableOpacity style={styles.rejectBtn} onPress={onReject}>
            <Text style={styles.rejectTxt}>{rejectLabel}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ── Pending tab ───────────────────────────────────────────────────────────────

function PendingTab() {
  const [items, setItems]     = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await adminFetch<{ gems: any[] }>('/api/admin/hidden-gems/pending');
      setItems(data.gems ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const verify = useCallback(async (id: string, action: 'approve' | 'reject') => {
    try {
      await adminFetch(`/api/admin/hidden-gems/${id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      setItems((prev) => prev.filter((g) => g.id !== id));
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  if (loading) return <View style={styles.center}><ActivityIndicator color="#4C8BF5" /></View>;
  if (error)   return <View style={styles.center}><Text style={styles.err}>{error}</Text></View>;
  if (items.length === 0) return <View style={styles.center}><Text style={styles.empty}>No pending gems</Text></View>;

  return (
    <FlatList
      data={items}
      keyExtractor={(g) => g.id}
      renderItem={({ item }) => (
        <QueueRow
          label={item.name}
          sublabel={`${item.city} · ${item.category}`}
          onApprove={() => verify(item.id, 'approve')}
          onReject={() => verify(item.id, 'reject')}
        />
      )}
      contentContainerStyle={styles.list}
    />
  );
}

// ── Reported tab ──────────────────────────────────────────────────────────────

function ReportedTab() {
  const [items, setItems]     = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await adminFetch<{ gems: any[] }>('/api/admin/hidden-gems/reported');
      setItems(data.gems ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const hide = useCallback(async (id: string) => {
    try {
      await adminFetch(`/api/admin/hidden-gems/${id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ action: 'hide' }),
      });
      setItems((prev) => prev.filter((g) => g.id !== id));
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  const markSensitive = useCallback(async (id: string) => {
    try {
      await adminFetch(`/api/admin/hidden-gems/${id}/sensitive`, {
        method: 'POST',
        body: JSON.stringify({ sensitivityLevel: 'protected' }),
      });
      setItems((prev) => prev.filter((g) => g.id !== id));
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  if (loading) return <View style={styles.center}><ActivityIndicator color="#4C8BF5" /></View>;
  if (error)   return <View style={styles.center}><Text style={styles.err}>{error}</Text></View>;
  if (items.length === 0) return <View style={styles.center}><Text style={styles.empty}>No reported gems</Text></View>;

  return (
    <FlatList
      data={items}
      keyExtractor={(g) => g.id}
      renderItem={({ item }) => (
        <QueueRow
          label={item.name}
          sublabel={`${item.city} · reports: ${item.reportCount ?? '?'}`}
          onApprove={() => markSensitive(item.id)}
          onReject={() => hide(item.id)}
          approveLabel="Mark Sensitive"
          rejectLabel="Hide"
        />
      )}
      contentContainerStyle={styles.list}
    />
  );
}

// ── Guide applications tab ────────────────────────────────────────────────────

function GuidesTab() {
  const [items, setItems]     = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await adminFetch<{ applications: any[] }>('/api/admin/hidden-gems/guide-applications');
      setItems(data.applications ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setStatus = useCallback(async (userId: string, status: 'active' | 'rejected') => {
    try {
      await adminFetch(`/api/admin/local-guides/${userId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      });
      setItems((prev) => prev.filter((g) => g.userId !== userId));
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
  }, []);

  if (loading) return <View style={styles.center}><ActivityIndicator color="#4C8BF5" /></View>;
  if (error)   return <View style={styles.center}><Text style={styles.err}>{error}</Text></View>;
  if (items.length === 0) return <View style={styles.center}><Text style={styles.empty}>No pending applications</Text></View>;

  return (
    <FlatList
      data={items}
      keyExtractor={(g) => g.userId ?? g.id}
      renderItem={({ item }) => (
        <QueueRow
          label={item.userId ?? item.id}
          sublabel={`Cities: ${(item.cityExpertise ?? []).join(', ') || '—'}`}
          onApprove={() => setStatus(item.userId ?? item.id, 'active')}
          onReject={() => setStatus(item.userId ?? item.id, 'rejected')}
          approveLabel="Approve"
          rejectLabel="Reject"
        />
      )}
      contentContainerStyle={styles.list}
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

      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabTxt, tab === t && styles.tabTxtActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'Pending'  && <PendingTab />}
      {tab === 'Reported' && <ReportedTab />}
      {tab === 'Guides'   && <GuidesTab />}
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

  tabBar: { flexDirection: 'row', paddingHorizontal: 16, marginBottom: 8 },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 8 },
  tabBtnActive: { backgroundColor: '#1E2D45' },
  tabTxt: { fontSize: 14, color: '#8A9BB5' },
  tabTxtActive: { color: '#4C8BF5', fontWeight: '600' },

  row: { backgroundColor: '#1E2D45', borderRadius: 12, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowLabel: { fontSize: 15, fontWeight: '600', color: '#E8F0FE' },
  rowSub:   { fontSize: 13, color: '#8A9BB5', marginTop: 2 },
  rowActions: { flexDirection: 'column', gap: 6 },
  approveBtn: { backgroundColor: '#1A3A2A', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  approveTxt: { color: '#4CAF7D', fontSize: 12, fontWeight: '600' },
  rejectBtn:  { backgroundColor: '#3A1A1A', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  rejectTxt:  { color: '#FF6B6B', fontSize: 12, fontWeight: '600' },
});
