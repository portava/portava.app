/**
 * Admin — Media Review Dashboard.
 *
 * Five tabs:
 *  • Processing Failures — stuck / errored media items
 *  • Reported            — posts flagged by users
 *  • Wrong Place         — wrong-place reports for Gems
 *  • Gems Pending        — Gems submissions awaiting review
 *  • AI Provenance       — AI-generated / illustrative items
 *
 * Follows the same pattern as app/admin/place-images/index.tsx.
 * Requires admin role (enforced server-side).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  ChevronRight,
  Flag,
  Image as ImageIcon,
  MapPin,
  Video,
  X,
  XCircle,
  Zap,
} from 'lucide-react-native';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { color, radius, space, type as t } from '../../../src/theme/tokens';
import {
  getMediaProcessingFailures,
  getMediaReported,
  getMediaWrongPlace,
  getMediaGemsPending,
  getMediaAiProvenance,
  moderateMediaItem,
  type MediaProcessingFailure,
  type MediaReport,
  type WrongPlaceReport,
  type GemPendingItem,
  type AiProvenanceItem,
} from '../../../src/services/adminMedia';

// ── Types ─────────────────────────────────────────────────────────────────────

type TabKey = 'failures' | 'reported' | 'wrong_place' | 'gems_pending' | 'ai_provenance';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'failures',     label: 'Processing' },
  { key: 'reported',     label: 'Reported' },
  { key: 'wrong_place',  label: 'Wrong Place' },
  { key: 'gems_pending', label: 'Gems' },
  { key: 'ai_provenance',label: 'AI Labels' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function statusColor(s: string): string {
  switch (s) {
    case 'failed': case 'error': return '#EF4444';
    case 'processing': case 'pending': case 'queued': return '#F59E0B';
    case 'approved': case 'ready': return '#10B981';
    case 'rejected': return '#6B7280';
    case 'flagged': return '#8B5CF6';
    default: return '#9CA3AF';
  }
}

// ── Moderate sheet ────────────────────────────────────────────────────────────

function ModerateSheet({
  visible,
  title,
  itemId,
  target,
  onClose,
  onDone,
}: {
  visible: boolean;
  title: string;
  itemId: string | null;
  target: 'post' | 'post_media' | 'hidden_gem' | 'report';
  onClose: () => void;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) { setReason(''); setBusy(null); }
  }, [visible]);

  if (!itemId) return null;

  async function act(action: 'approve' | 'reject' | 'flag') {
    if (!itemId) return;
    if ((action === 'reject' || action === 'flag') && !reason.trim()) {
      Alert.alert('Reason required', 'Please enter a reason before rejecting or flagging.');
      return;
    }
    setBusy(action);
    try {
      const res = await moderateMediaItem(itemId, action, {
        target,
        reason: reason.trim() || undefined,
      });
      if (!res.ok) {
        Alert.alert('Error', res.error);
        return;
      }
      onDone();
      onClose();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={sc.backdrop} onPress={onClose} />
      <View style={[sc.sheet, { paddingBottom: insets.bottom + space.md }]}>
        <View style={sc.sheetHeader}>
          <Text style={sc.sheetTitle} numberOfLines={1}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={10} style={sc.closeBtn}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: space.md }}>
          <Text style={sc.sectionLabel}>Reason (required for reject / flag)</Text>
          <TextInput
            style={sc.input}
            value={reason}
            onChangeText={setReason}
            placeholder="Enter moderation reason…"
            placeholderTextColor={color.mute}
            multiline
            numberOfLines={3}
          />

          <View style={sc.actionsRow}>
            <Pressable
              style={[sc.actionBtn, sc.actionGreen, busy === 'approve' && sc.actionBusy]}
              onPress={() => act('approve')}
              disabled={!!busy}
            >
              {busy === 'approve'
                ? <ActivityIndicator size="small" color="#fff" />
                : <><CheckCircle size={14} color="#fff" /><Text style={sc.actionBtnText}>Approve</Text></>
              }
            </Pressable>

            <Pressable
              style={[sc.actionBtn, sc.actionRed, busy === 'reject' && sc.actionBusy]}
              onPress={() => act('reject')}
              disabled={!!busy}
            >
              {busy === 'reject'
                ? <ActivityIndicator size="small" color="#fff" />
                : <><XCircle size={14} color="#fff" /><Text style={sc.actionBtnText}>Reject</Text></>
              }
            </Pressable>

            <Pressable
              style={[sc.actionBtn, sc.actionOrange, busy === 'flag' && sc.actionBusy]}
              onPress={() => act('flag')}
              disabled={!!busy}
            >
              {busy === 'flag'
                ? <ActivityIndicator size="small" color="#fff" />
                : <><Flag size={14} color="#fff" /><Text style={sc.actionBtnText}>Escalate</Text></>
              }
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Processing Failures tab ───────────────────────────────────────────────────

function FailuresTab() {
  const [items, setItems] = useState<MediaProcessingFailure[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<MediaProcessingFailure | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    const res = await getMediaProcessingFailures({ limit: 50 });
    if (res.ok) setItems(res.data.items);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <View style={sc.center}><ActivityIndicator color={color.ink} /></View>;
  }

  return (
    <>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(true); }} />}
        ListEmptyComponent={<Text style={sc.empty}>No processing failures</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={sc.card}
            onPress={() => { setSelected(item); setSheetVisible(true); }}
          >
            <View style={sc.thumbWrap}>
              {item.thumbnail_url
                ? <Image source={{ uri: item.thumbnail_url }} style={sc.thumb} resizeMode="cover" />
                : <View style={[sc.thumb, sc.thumbFallback]}>
                    {item.media_type === 'video'
                      ? <Video size={20} color={color.mute} />
                      : <ImageIcon size={20} color={color.mute} />
                    }
                  </View>
              }
            </View>
            <View style={sc.cardBody}>
              <Text style={sc.cardTitle} numberOfLines={1}>{item.post_id}</Text>
              <View style={sc.badgeRow}>
                <View style={[sc.chip, { backgroundColor: statusColor(item.processing_status) }]}>
                  <Text style={sc.chipText}>{item.processing_status}</Text>
                </View>
                <View style={sc.chip}>
                  <Text style={sc.chipText}>{item.media_type}</Text>
                </View>
              </View>
              <Text style={sc.cardDate}>{fmtDate(item.created_at)}</Text>
            </View>
            <ChevronRight size={16} color={color.mute} />
          </Pressable>
        )}
      />
      <ModerateSheet
        visible={sheetVisible}
        title={`Processing failure: ${selected?.post_id?.slice(0, 8) ?? ''}…`}
        itemId={selected?.post_id ?? null}
        target="post"
        onClose={() => setSheetVisible(false)}
        onDone={() => { void load(); }}
      />
    </>
  );
}

// ── Reported tab ──────────────────────────────────────────────────────────────

function ReportedTab() {
  const [items, setItems] = useState<MediaReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<MediaReport | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    const res = await getMediaReported({ limit: 50, status: 'open' });
    if (res.ok) setItems(res.data.items);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <View style={sc.center}><ActivityIndicator color={color.ink} /></View>;
  }

  return (
    <>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(true); }} />}
        ListEmptyComponent={<Text style={sc.empty}>No reported items</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={sc.card}
            onPress={() => { setSelected(item); setSheetVisible(true); }}
          >
            <View style={sc.thumbWrap}>
              {item.primaryMedia?.thumbnail_url
                ? <Image source={{ uri: item.primaryMedia.thumbnail_url }} style={sc.thumb} resizeMode="cover" />
                : <View style={[sc.thumb, sc.thumbFallback]}><Flag size={20} color={color.mute} /></View>
              }
            </View>
            <View style={sc.cardBody}>
              <Text style={sc.cardTitle} numberOfLines={1}>{item.reason_code}</Text>
              {!!item.reason_detail && (
                <Text style={sc.cardMeta} numberOfLines={2}>{item.reason_detail}</Text>
              )}
              <View style={sc.badgeRow}>
                <View style={[sc.chip, { backgroundColor: statusColor(item.status) }]}>
                  <Text style={sc.chipText}>{item.status}</Text>
                </View>
              </View>
              <Text style={sc.cardDate}>{fmtDate(item.created_at)}</Text>
            </View>
            <ChevronRight size={16} color={color.mute} />
          </Pressable>
        )}
      />
      <ModerateSheet
        visible={sheetVisible}
        title={`Report: ${selected?.reason_code?.slice(0, 30) ?? ''}…`}
        itemId={selected?.id ?? null}
        target="report"
        onClose={() => setSheetVisible(false)}
        onDone={() => { void load(); }}
      />
    </>
  );
}

// ── Wrong Place tab ───────────────────────────────────────────────────────────

function WrongPlaceTab() {
  const [items, setItems] = useState<WrongPlaceReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<WrongPlaceReport | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    const res = await getMediaWrongPlace({ limit: 50, status: 'open' });
    if (res.ok) setItems(res.data.items);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <View style={sc.center}><ActivityIndicator color={color.ink} /></View>;
  }

  return (
    <>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(true); }} />}
        ListEmptyComponent={<Text style={sc.empty}>No wrong-place reports</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={sc.card}
            onPress={() => { setSelected(item); setSheetVisible(true); }}
          >
            <View style={sc.thumbWrap}>
              <View style={[sc.thumb, sc.thumbFallback]}><MapPin size={20} color={color.mute} /></View>
            </View>
            <View style={sc.cardBody}>
              <Text style={sc.cardTitle} numberOfLines={1}>{item.target_id}</Text>
              <Text style={sc.cardMeta} numberOfLines={2}>{item.reason_code}{item.reason_detail ? ` — ${item.reason_detail}` : ''}</Text>
              <View style={sc.badgeRow}>
                <View style={[sc.chip, { backgroundColor: statusColor(item.status) }]}>
                  <Text style={sc.chipText}>{item.status}</Text>
                </View>
              </View>
              <Text style={sc.cardDate}>{fmtDate(item.created_at)}</Text>
            </View>
            <ChevronRight size={16} color={color.mute} />
          </Pressable>
        )}
      />
      <ModerateSheet
        visible={sheetVisible}
        title="Wrong-place report"
        itemId={selected?.id ?? null}
        target="report"
        onClose={() => setSheetVisible(false)}
        onDone={() => { void load(); }}
      />
    </>
  );
}

// ── Gems Pending tab ──────────────────────────────────────────────────────────

function GemsPendingTab() {
  const [items, setItems] = useState<GemPendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<GemPendingItem | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    const res = await getMediaGemsPending({ limit: 50 });
    if (res.ok) setItems(res.data.items);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <View style={sc.center}><ActivityIndicator color={color.ink} /></View>;
  }

  return (
    <>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(true); }} />}
        ListEmptyComponent={<Text style={sc.empty}>No pending Gems submissions</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={sc.card}
            onPress={() => { setSelected(item); setSheetVisible(true); }}
          >
            <View style={sc.thumbWrap}>
              {item.image_url
                ? <Image source={{ uri: item.image_url }} style={sc.thumb} resizeMode="cover" />
                : <View style={[sc.thumb, sc.thumbFallback]}><Zap size={20} color={color.mute} /></View>
              }
            </View>
            <View style={sc.cardBody}>
              <Text style={sc.cardTitle} numberOfLines={1}>{item.name}</Text>
              <Text style={sc.cardMeta}>{item.city} · {item.category}</Text>
              {item.description && (
                <Text style={sc.cardMeta} numberOfLines={2}>{item.description}</Text>
              )}
              <Text style={sc.cardDate}>{fmtDate(item.created_at)}</Text>
            </View>
            <ChevronRight size={16} color={color.mute} />
          </Pressable>
        )}
      />
      <ModerateSheet
        visible={sheetVisible}
        title={`Gem: ${selected?.name ?? selected?.id?.slice(0, 12) ?? ''}…`}
        itemId={selected?.id ?? null}
        target="hidden_gem"
        onClose={() => setSheetVisible(false)}
        onDone={() => { void load(); }}
      />
    </>
  );
}

// ── AI Provenance tab ─────────────────────────────────────────────────────────

function AiProvenanceTab() {
  const [items, setItems] = useState<AiProvenanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<AiProvenanceItem | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    const res = await getMediaAiProvenance({ limit: 50 });
    if (res.ok) setItems(res.data.items);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <View style={sc.center}><ActivityIndicator color={color.ink} /></View>;
  }

  return (
    <>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(true); }} />}
        ListEmptyComponent={<Text style={sc.empty}>No AI-provenance flagged items</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={sc.card}
            onPress={() => { setSelected(item); setSheetVisible(true); }}
          >
            <View style={sc.thumbWrap}>
              {(item.thumbnail_url ?? item.source_url)
                ? <Image source={{ uri: (item.thumbnail_url ?? item.source_url)! }} style={sc.thumb} resizeMode="cover" />
                : <View style={[sc.thumb, sc.thumbFallback]}><AlertTriangle size={20} color={color.mute} /></View>
              }
            </View>
            <View style={sc.cardBody}>
              <Text style={sc.cardTitle} numberOfLines={1}>
                {item.entity_type ?? item.media_type ?? 'media'} · {(item.entity_id ?? item.post_id ?? item.id).slice(0, 8)}…
              </Text>
              <View style={sc.badgeRow}>
                {item.image_source_type && (
                  <View style={[sc.chip, { backgroundColor: '#8B5CF6' }]}>
                    <Text style={sc.chipText}>{item.image_source_type}</Text>
                  </View>
                )}
                {item.accuracy_status && (
                  <View style={[sc.chip, { backgroundColor: '#6366F1' }]}>
                    <Text style={sc.chipText}>{item.accuracy_status}</Text>
                  </View>
                )}
                {item.disclaimer_required && (
                  <View style={[sc.chip, { backgroundColor: '#F59E0B' }]}>
                    <Text style={sc.chipText}>disclaimer</Text>
                  </View>
                )}
              </View>
              <Text style={sc.cardDate}>{fmtDate(item.created_at)}</Text>
            </View>
            <ChevronRight size={16} color={color.mute} />
          </Pressable>
        )}
      />
      <ModerateSheet
        visible={sheetVisible}
        title="AI Provenance item"
        itemId={selected?.post_id ?? selected?.entity_id ?? selected?.id ?? null}
        target={selected?.entity_type ? 'post' : 'post_media'}
        onClose={() => setSheetVisible(false)}
        onDone={() => { void load(); }}
      />
    </>
  );
}

// ── Root screen ───────────────────────────────────────────────────────────────

export default function AdminMediaScreen() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<TabKey>('failures');

  useRequireAdmin();

  return (
    <View style={[sc.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={sc.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={sc.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={sc.headerTitle}>Media Review</Text>
        <View style={{ width: 36 }} />
      </View>

      {/* Tab bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={sc.tabBar}
        contentContainerStyle={sc.tabBarContent}
      >
        {TABS.map((tab) => (
          <Pressable
            key={tab.key}
            style={[sc.tabItem, activeTab === tab.key && sc.tabItemActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={[sc.tabLabel, activeTab === tab.key && sc.tabLabelActive]}>
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Content */}
      <View style={{ flex: 1 }}>
        {activeTab === 'failures'     && <FailuresTab />}
        {activeTab === 'reported'     && <ReportedTab />}
        {activeTab === 'wrong_place'  && <WrongPlaceTab />}
        {activeTab === 'gems_pending' && <GemsPendingTab />}
        {activeTab === 'ai_provenance'&& <AiProvenanceTab />}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const sc = StyleSheet.create({
  root:        { flex: 1, backgroundColor: color.paper },
  header:      { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn:     { width: 36, height: 36, justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', ...t.heading, color: color.ink },

  tabBar:        { flexShrink: 0, borderBottomWidth: 1, borderBottomColor: color.haze },
  tabBarContent: { paddingHorizontal: space.md, gap: space.sm, flexDirection: 'row', paddingVertical: space.xs },
  tabItem:       { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: color.haze },
  tabItemActive: { backgroundColor: color.ink },
  tabLabel:      { ...t.small, color: color.mute },
  tabLabelActive:{ ...t.small, color: color.paper },

  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty:  { textAlign: 'center', ...t.body, color: color.mute, marginTop: space.xl },

  card:      { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  thumbWrap: { width: 60, height: 60, borderRadius: radius.sm, overflow: 'hidden' },
  thumb:     { width: 60, height: 60 },
  thumbFallback: { backgroundColor: color.haze, justifyContent: 'center', alignItems: 'center' },
  cardBody:  { flex: 1, gap: 2 },
  cardTitle: { ...t.bodyStrong, color: color.ink },
  cardMeta:  { ...t.small, color: color.mute },
  cardDate:  { ...t.small, color: color.faint },

  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  chip:     { backgroundColor: '#6B7280', borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 2 },
  chipText: { ...t.stamp, color: '#fff', fontSize: 10 },

  // Moderate sheet
  backdrop:    { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet:       { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, maxHeight: '80%' as any },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', padding: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  sheetTitle:  { flex: 1, ...t.heading, color: color.ink },
  closeBtn:    { width: 32, height: 32, justifyContent: 'center', alignItems: 'center' },
  sectionLabel:{ ...t.small, color: color.mute, textTransform: 'uppercase' as const, letterSpacing: 0.5, marginBottom: 4 },
  input:       { borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, padding: space.sm, ...t.body, color: color.ink, backgroundColor: color.paper, minHeight: 80, textAlignVertical: 'top' as const },
  actionsRow:  { flexDirection: 'row', gap: space.sm },
  actionBtn:   { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: space.sm, borderRadius: radius.sm },
  actionBusy:  { opacity: 0.6 },
  actionGreen: { backgroundColor: '#10B981' },
  actionRed:   { backgroundColor: '#EF4444' },
  actionOrange:{ backgroundColor: '#F59E0B' },
  actionBtnText: { ...t.bodyStrong, color: '#fff' },
});
