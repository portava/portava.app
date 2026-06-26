/**
 * Admin — Hashtag moderation screen.
 * Lists all hashtags; supports search, block/unblock, hide/unhide from trending,
 * rename, and merge.
 * Requires admin role (checked server-side by each endpoint).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList, Modal,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ArrowLeft, Search, ShieldOff, Shield, TrendingDown, TrendingUp, Edit2, GitMerge } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { supabase } from '../../src/lib/supabase';
import { useSession } from '../../src/context/SessionContext';

// ── Types ──────────────────────────────────────────────────────────────────────

interface AdminHashtag {
  id: string;
  slug: string;
  usageCount: number;
  isBlocked: boolean;
  hideTrending: boolean;
  reportCount?: number;
}

// ── API helpers ────────────────────────────────────────────────────────────────

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
    const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      return { ok: false, error: (b as any)?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: await res.json() as T };
  } catch (e: any) { return { ok: false, error: e?.message ?? 'Network error' }; }
}

async function adminPost<T>(path: string, body: unknown = {}): Promise<{ ok: boolean; data?: T; error?: string }> {
  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not authenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
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

// ── Component ──────────────────────────────────────────────────────────────────

export default function AdminHashtagsScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();

  useEffect(() => {
    if (!sessionLoading && !isAuthed) { router.replace('/(auth)/sign-in' as any); }
  }, [isAuthed, sessionLoading]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hashtags, setHashtags] = useState<AdminHashtag[]>([]);
  const [search, setSearch] = useState('');
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  // Rename modal state
  const [renameTarget, setRenameTarget] = useState<AdminHashtag | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  // Merge modal state
  const [mergeSource, setMergeSource] = useState<AdminHashtag | null>(null);
  const [mergeTarget, setMergeTarget] = useState('');
  const [mergeBusy, setMergeBusy] = useState(false);

  const fetchHashtags = useCallback(async (q?: string) => {
    setLoading(true);
    setError(null);
    const qs = q ? `?q=${encodeURIComponent(q)}` : '';
    const res = await adminGet<{ hashtags: any[] }>(`/api/admin/hashtags${qs}`);
    setLoading(false);
    if (!res.ok || !res.data) {
      setError(res.error ?? 'Failed to load hashtags');
      return;
    }
    setHashtags((res.data.hashtags ?? []).map((h: any) => ({
      id: h.id,
      slug: h.slug,
      usageCount: h.usageCount ?? h.usage_count ?? 0,
      isBlocked: h.isBlocked ?? h.is_blocked ?? false,
      hideTrending: h.hideTrending ?? h.hide_trending ?? false,
      reportCount: h.reportCount ?? h.report_count,
    })));
  }, []);

  useEffect(() => {
    if (!isAuthed || sessionLoading) return;
    fetchHashtags();
  }, [fetchHashtags, isAuthed, sessionLoading]);

  function setBusy(id: string, busy: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      busy ? next.add(id) : next.delete(id);
      return next;
    });
  }

  async function toggleBlock(ht: AdminHashtag) {
    setBusy(ht.id, true);
    const action = ht.isBlocked ? 'unblock' : 'block';
    const res = await adminPost(`/api/admin/hashtags/${encodeURIComponent(ht.slug)}/${action}`);
    setBusy(ht.id, false);
    if (!res.ok) {
      Alert.alert('Action failed', res.error ?? 'Please try again.');
      return;
    }
    setHashtags((prev) =>
      prev.map((h) => h.id === ht.id ? { ...h, isBlocked: !h.isBlocked } : h),
    );
  }

  async function toggleTrending(ht: AdminHashtag) {
    setBusy(ht.id, true);
    const res = await adminPost(
      `/api/admin/hashtags/${encodeURIComponent(ht.slug)}/hide-trending`,
      { hide: !ht.hideTrending },
    );
    setBusy(ht.id, false);
    if (!res.ok) {
      Alert.alert('Action failed', res.error ?? 'Please try again.');
      return;
    }
    setHashtags((prev) =>
      prev.map((h) => h.id === ht.id ? { ...h, hideTrending: !h.hideTrending } : h),
    );
  }

  async function submitRename() {
    if (!renameTarget || !renameName.trim()) return;
    setRenameBusy(true);
    const res = await adminPatch(`/api/admin/hashtags/${encodeURIComponent(renameTarget.slug)}`, {
      name: renameName.trim(),
    });
    setRenameBusy(false);
    if (!res.ok) {
      Alert.alert('Rename failed', res.error ?? 'Please try again.');
      return;
    }
    setHashtags((prev) =>
      prev.map((h) => h.id === renameTarget.id ? { ...h } : h),
    );
    setRenameTarget(null);
    setRenameName('');
    await fetchHashtags(search.trim() || undefined);
  }

  async function submitMerge() {
    if (!mergeSource || !mergeTarget.trim()) return;
    const targetSlug = mergeTarget.trim().replace(/^#/, '').toLowerCase();
    if (targetSlug === mergeSource.slug) {
      Alert.alert('Invalid', 'Source and target must be different.');
      return;
    }
    setMergeBusy(true);
    const res = await adminPost('/api/admin/hashtags/merge', {
      sourceSlug: mergeSource.slug,
      targetSlug,
    });
    setMergeBusy(false);
    if (!res.ok) {
      Alert.alert('Merge failed', res.error ?? 'Please try again.');
      return;
    }
    setMergeSource(null);
    setMergeTarget('');
    await fetchHashtags(search.trim() || undefined);
  }

  const filtered = search.trim()
    ? hashtags.filter((h) => h.slug.toLowerCase().includes(search.trim().toLowerCase()))
    : hashtags;

  function renderItem({ item: ht }: { item: AdminHashtag }) {
    const busy = busyIds.has(ht.id);
    return (
      <View style={[s.row, ht.isBlocked && s.rowBlocked]}>
        <View style={s.rowLeft}>
          <Text style={[s.slug, ht.isBlocked && s.slugBlocked]}>#{ht.slug}</Text>
          <Text style={s.rowMeta}>
            {ht.usageCount.toLocaleString()} posts
            {typeof ht.reportCount === 'number' && ht.reportCount > 0
              ? `  ·  ${ht.reportCount} report${ht.reportCount !== 1 ? 's' : ''}`
              : ''}
            {ht.hideTrending ? '  ·  hidden from trending' : ''}
          </Text>
        </View>
        <View style={s.rowActions}>
          {busy ? (
            <ActivityIndicator size="small" color={color.signal} />
          ) : (
            <>
              <Pressable
                style={s.actionBtn}
                onPress={() => { setRenameTarget(ht); setRenameName(''); }}
                hitSlop={8}
              >
                <Edit2 size={16} color={color.mute} />
              </Pressable>
              <Pressable
                style={s.actionBtn}
                onPress={() => { setMergeSource(ht); setMergeTarget(''); }}
                hitSlop={8}
              >
                <GitMerge size={16} color={color.mute} />
              </Pressable>
              <Pressable
                style={[s.actionBtn, ht.hideTrending ? s.actionBtnActive : null]}
                onPress={() => toggleTrending(ht)}
                hitSlop={8}
              >
                {ht.hideTrending
                  ? <TrendingUp size={16} color={color.signal} />
                  : <TrendingDown size={16} color={color.mute} />}
              </Pressable>
              <Pressable
                style={[s.actionBtn, ht.isBlocked ? s.actionBtnDanger : null]}
                onPress={() => toggleBlock(ht)}
                hitSlop={8}
              >
                {ht.isBlocked
                  ? <Shield size={16} color={color.signal} />
                  : <ShieldOff size={16} color={color.mute} />}
              </Pressable>
            </>
          )}
        </View>
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
        <Text style={s.title}>Hashtag Moderation</Text>
      </View>

      {/* Search bar */}
      <View style={s.searchRow}>
        <Search size={16} color={color.mute} />
        <TextInput
          style={s.searchInput}
          placeholder="Search hashtags…"
          placeholderTextColor={color.mute}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>

      {/* Legend */}
      <View style={s.legend}>
        <Text style={s.legendText}>
          <Text style={{ color: color.mute }}>↓</Text> = hide from trending  {'  '}
          <Text style={{ color: color.mute }}>⊘</Text> = block hashtag
        </Text>
      </View>

      {/* List */}
      {loading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={color.signal} size="large" />
      ) : error ? (
        <View style={s.emptyWrap}>
          <Text style={s.emptyText}>{error}</Text>
          <Pressable onPress={() => fetchHashtags()} style={s.retryBtn}>
            <Text style={s.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(h) => h.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: insets.bottom + space.xl }}
          ItemSeparatorComponent={() => <View style={s.separator} />}
          ListEmptyComponent={
            <View style={s.emptyWrap}>
              <Text style={s.emptyText}>{search ? 'No hashtags match.' : 'No hashtags yet.'}</Text>
            </View>
          }
        />
      )}

      {/* ── Rename modal ── */}
      <Modal visible={!!renameTarget} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Rename #{renameTarget?.slug}</Text>
            <TextInput
              style={s.modalInput}
              placeholder="New display name…"
              placeholderTextColor={color.mute}
              value={renameName}
              onChangeText={setRenameName}
              autoFocus
              autoCorrect={false}
            />
            <View style={s.modalActions}>
              <Pressable style={s.modalCancelBtn} onPress={() => setRenameTarget(null)}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[s.modalConfirmBtn, (!renameName.trim() || renameBusy) && s.modalBtnDisabled]}
                onPress={submitRename}
                disabled={!renameName.trim() || renameBusy}
              >
                {renameBusy
                  ? <ActivityIndicator size="small" color={color.paper} />
                  : <Text style={s.modalConfirmText}>Rename</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Merge modal ── */}
      <Modal visible={!!mergeSource} transparent animationType="fade" onRequestClose={() => setMergeSource(null)}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Merge #{mergeSource?.slug}</Text>
            <Text style={s.modalHint}>
              All posts tagged #{mergeSource?.slug} will be re-tagged with the target. This cannot be undone.
            </Text>
            <TextInput
              style={s.modalInput}
              placeholder="Target hashtag slug (e.g. travel)"
              placeholderTextColor={color.mute}
              value={mergeTarget}
              onChangeText={setMergeTarget}
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
            />
            <View style={s.modalActions}>
              <Pressable style={s.modalCancelBtn} onPress={() => setMergeSource(null)}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[s.modalConfirmBtn, s.modalBtnDanger, (!mergeTarget.trim() || mergeBusy) && s.modalBtnDisabled]}
                onPress={submitMerge}
                disabled={!mergeTarget.trim() || mergeBusy}
              >
                {mergeBusy
                  ? <ActivityIndicator size="small" color={color.paper} />
                  : <Text style={s.modalConfirmText}>Merge</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },

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
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', flex: 1 },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  searchInput: {
    flex: 1,
    ...t.body,
    color: color.ink,
    paddingVertical: 4,
  },

  legend: {
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
    backgroundColor: color.haze + '50',
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  legendText: { fontSize: 11, color: color.mute },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: color.paper,
  },
  rowBlocked: { backgroundColor: '#FFF0F0' },
  rowLeft: { flex: 1, gap: 2 },
  slug: { ...t.bodyStrong, color: color.ink },
  slugBlocked: { color: color.mute, textDecorationLine: 'line-through' },
  rowMeta: { fontSize: 11, color: color.mute },

  rowActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  actionBtn: {
    width: 32, height: 32,
    borderRadius: radius.sm,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnActive: { backgroundColor: '#FFF3E0' },
  actionBtnDanger: { backgroundColor: '#FFEBEE' },

  separator: { height: 1, backgroundColor: color.haze },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn: { marginTop: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  retryText: { ...t.bodyStrong, color: color.signal },

  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  modalCard: {
    width: '100%',
    backgroundColor: color.paper,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  modalTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 16 },
  modalHint: { ...t.body, color: color.mute, fontSize: 13 },
  modalInput: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    ...t.body,
    color: color.ink,
  },
  modalActions: { flexDirection: 'row', gap: space.sm, justifyContent: 'flex-end' },
  modalCancelBtn: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.haze,
  },
  modalCancelText: { ...t.bodyStrong, color: color.ink },
  modalConfirmBtn: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.signal,
    minWidth: 72,
    alignItems: 'center',
  },
  modalBtnDanger: { backgroundColor: '#D32F2F' },
  modalBtnDisabled: { opacity: 0.4 },
  modalConfirmText: { ...t.bodyStrong, color: color.paper },
});
