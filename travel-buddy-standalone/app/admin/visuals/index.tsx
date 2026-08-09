/**
 * Admin — AI Visuals Dashboard.
 *
 * Three tabs: Overview (stats + kill-switches), Pending Review, History.
 * Gated by admin role + ai_visual_admin_review_enabled feature flag.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CachedImage } from '../../../src/components/CachedImage';
import { router, useFocusEffect } from 'expo-router';
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Zap,
  BarChart2,
  RefreshCw,
  Trash2,
  Eye,
  Ban,
  ChevronDown,
  ChevronUp,
  Search,
  X,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { color, space, radius, type as t, dot} from '../../../src/theme/tokens';
import {
  getVisualStats,
  getPendingReview,
  getVisualHistory,
  verifyVisual,
  disableVisual,
  regenerateVisual,
  blockVisualEntity,
  deleteVisual,
  toggleVisualFlag,
  type VisualStats,
  type AdminVisual,
} from '../../../src/services/adminVisuals';

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString();
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s  = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

type TabKey = 'overview' | 'pending' | 'history';

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={sc.statCard}>
      <Text style={sc.statValue}>{value}</Text>
      <Text style={sc.statLabel}>{label}</Text>
      {!!sub && <Text style={sc.statSub}>{sub}</Text>}
    </View>
  );
}

// ── Kill-switch toggle ────────────────────────────────────────────────────────

function KillSwitchRow({
  label,
  flagKey,
  value,
  onToggle,
  busy,
}: {
  label: string;
  flagKey: string;
  value: boolean;
  onToggle: (flag: string, next: boolean) => void;
  busy: boolean;
}) {
  const handleChange = (next: boolean) => {
    if (!next) {
      Alert.alert(
        'Disable feature?',
        `Turning off "${label}" will prevent new AI visuals from being generated. Continue?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Disable', style: 'destructive', onPress: () => onToggle(flagKey, false) },
        ],
      );
    } else {
      onToggle(flagKey, true);
    }
  };

  return (
    <View style={sc.ksRow}>
      <View style={{ flex: 1 }}>
        <Text style={sc.ksLabel}>{label}</Text>
        <Text style={sc.ksSub}>{flagKey}</Text>
      </View>
      {busy ? (
        <ActivityIndicator size="small" color={color.signal ?? color.ink} />
      ) : (
        <Switch
          value={value}
          onValueChange={handleChange}
          trackColor={{ true: '#10B981', false: color.haze }}
          thumbColor="#fff"
        />
      )}
    </View>
  );
}

// ── Visual detail sheet ───────────────────────────────────────────────────────

function VisualDetailSheet({
  visual,
  visible,
  onClose,
  onVerify,
  onDisable,
  onRegenerate,
  onBlockEntity,
  onDelete,
}: {
  visual: AdminVisual | null;
  visible: boolean;
  onClose: () => void;
  onVerify:      (id: string) => Promise<void>;
  onDisable:     (id: string) => Promise<void>;
  onRegenerate:  (id: string) => Promise<void>;
  onBlockEntity: (id: string) => Promise<void>;
  onDelete:      (id: string) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  if (!visual) return null;

  const imageUrl = visual.source_image_url ?? visual.sourceImageUrl ?? null;
  const prompt   = visual.final_prompt ?? visual.finalPrompt ?? null;
  const snapshot = visual.input_snapshot ?? visual.inputSnapshot ?? null;

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } finally { setBusy(null); }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={sc.backdrop} onPress={onClose} />
      <View style={[sc.sheet, { paddingBottom: insets.bottom + space.md }]}>
        {/* Header */}
        <View style={sc.sheetHeader}>
          <Text style={sc.sheetTitle} numberOfLines={1}>
            Visual Detail
          </Text>
          <Pressable onPress={onClose} hitSlop={10} style={sc.closeBtn}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: space.md }}>
          {/* Image */}
          {!!imageUrl && (
            <CachedImage
              source={{ uri: imageUrl }}
              style={sc.sheetImage}
              resizeMode="cover"
              accessibilityLabel="Generated visual"
            />
          )}

          {/* Meta */}
          <View style={sc.sheetMeta}>
            <Text style={sc.sheetMetaRow}>
              <Text style={sc.sheetMetaKey}>Entity: </Text>
              <Text style={sc.sheetMetaVal}>{visual.entity_type} / {visual.entity_id}</Text>
            </Text>
            <Text style={sc.sheetMetaRow}>
              <Text style={sc.sheetMetaKey}>Purpose: </Text>
              <Text style={sc.sheetMetaVal}>{visual.purpose}</Text>
            </Text>
            <Text style={sc.sheetMetaRow}>
              <Text style={sc.sheetMetaKey}>Status: </Text>
              <Text style={sc.sheetMetaVal}>{visual.status}</Text>
            </Text>
            <Text style={sc.sheetMetaRow}>
              <Text style={sc.sheetMetaKey}>Provider: </Text>
              <Text style={sc.sheetMetaVal}>{visual.provider}{visual.model ? ` / ${visual.model}` : ''}</Text>
            </Text>
            <Text style={sc.sheetMetaRow}>
              <Text style={sc.sheetMetaKey}>Style: </Text>
              <Text style={sc.sheetMetaVal}>{visual.style}</Text>
            </Text>
            <Text style={sc.sheetMetaRow}>
              <Text style={sc.sheetMetaKey}>Attempts: </Text>
              <Text style={sc.sheetMetaVal}>{visual.attempt_count ?? visual.attemptCount ?? 0}</Text>
            </Text>
            <Text style={sc.sheetMetaRow}>
              <Text style={sc.sheetMetaKey}>Generated: </Text>
              <Text style={sc.sheetMetaVal}>{fmtDate(visual.generated_at ?? visual.generatedAt)}</Text>
            </Text>
            <Text style={sc.sheetMetaRow}>
              <Text style={sc.sheetMetaKey}>Verified: </Text>
              <Text style={sc.sheetMetaVal}>{visual.verifiedAt ? fmtDate(visual.verifiedAt) : '—'}</Text>
            </Text>
            {!!(visual.failure_code ?? visual.failureCode) && (
              <Text style={sc.sheetMetaRow}>
                <Text style={sc.sheetMetaKey}>Failure: </Text>
                <Text style={[sc.sheetMetaVal, { color: '#EF4444' }]}>
                  {visual.failure_code ?? visual.failureCode} — {visual.failure_message ?? visual.failureMessage}
                </Text>
              </Text>
            )}
          </View>

          {/* Derivative URLs */}
          {!!visual.derivativeUrls && (
            <View style={sc.section}>
              <Text style={sc.sectionTitle}>Derivative URLs</Text>
              {Object.entries(visual.derivativeUrls).map(([key, url]) =>
                url ? (
                  <Text key={key} style={sc.urlRow} numberOfLines={1}>
                    <Text style={sc.urlKey}>{key}: </Text>
                    <Text style={sc.urlVal}>{url}</Text>
                  </Text>
                ) : null,
              )}
            </View>
          )}

          {/* Prompt (admin-only) */}
          {!!prompt && (
            <View style={sc.section}>
              <Pressable
                style={sc.expandRow}
                onPress={() => setExpanded((v) => !v)}
                accessibilityRole="button"
              >
                <Text style={sc.sectionTitle}>Prompt snapshot</Text>
                {expanded ? (
                  <ChevronUp size={16} color={color.mute ?? color.ink} />
                ) : (
                  <ChevronDown size={16} color={color.mute ?? color.ink} />
                )}
              </Pressable>
              {expanded && (
                <Text style={sc.promptText} selectable>
                  {prompt}
                </Text>
              )}
            </View>
          )}

          {/* Input snapshot (admin-only) */}
          {!!snapshot && expanded && (
            <View style={sc.section}>
              <Text style={sc.sectionTitle}>Input snapshot</Text>
              <Text style={sc.promptText} selectable>
                {JSON.stringify(snapshot, null, 2)}
              </Text>
            </View>
          )}

          {/* Actions */}
          <View style={sc.actionsGrid}>
            {visual.status === 'ready' && !visual.verifiedAt && (
              <Pressable
                style={[sc.actionBtn, sc.actionGreen]}
                onPress={() => act('verify', () => onVerify(visual.id).then(onClose))}
                disabled={!!busy}
                accessibilityLabel="Mark verified"
              >
                {busy === 'verify' ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <CheckCircle size={16} color="#fff" />
                )}
                <Text style={sc.actionBtnText}>Mark verified</Text>
              </Pressable>
            )}
            <Pressable
              style={[sc.actionBtn, sc.actionRed]}
              onPress={() => act('disable', () => onDisable(visual.id).then(onClose))}
              disabled={!!busy}
              accessibilityLabel="Disable visual"
            >
              {busy === 'disable' ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ban size={16} color="#fff" />
              )}
              <Text style={sc.actionBtnText}>Disable</Text>
            </Pressable>
            <Pressable
              style={[sc.actionBtn, sc.actionBlue]}
              onPress={() => act('regen', () => onRegenerate(visual.id).then(onClose))}
              disabled={!!busy}
              accessibilityLabel="Regenerate"
            >
              {busy === 'regen' ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <RefreshCw size={16} color="#fff" />
              )}
              <Text style={sc.actionBtnText}>Regenerate</Text>
            </Pressable>
            <Pressable
              style={[sc.actionBtn, sc.actionOrange]}
              onPress={() =>
                Alert.alert('Block entity?', 'This will block all visuals for this entity and prevent future generation.', [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Block entity',
                    style: 'destructive',
                    onPress: () => act('block', () => onBlockEntity(visual.id).then(onClose)),
                  },
                ])
              }
              disabled={!!busy}
              accessibilityLabel="Block entity"
            >
              {busy === 'block' ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <XCircle size={16} color="#fff" />
              )}
              <Text style={sc.actionBtnText}>Block entity</Text>
            </Pressable>
            <Pressable
              style={[sc.actionBtn, sc.actionGray]}
              onPress={() =>
                Alert.alert('Delete visual?', 'This permanently removes the record.', [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => act('delete', () => onDelete(visual.id).then(onClose)),
                  },
                ])
              }
              disabled={!!busy}
              accessibilityLabel="Delete"
            >
              {busy === 'delete' ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Trash2 size={16} color="#fff" />
              )}
              <Text style={sc.actionBtnText}>Delete</Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Pending row ────────────────────────────────────────────────────────────────

function PendingRow({
  visual,
  onPress,
}: {
  visual: AdminVisual;
  onPress: () => void;
}) {
  const thumb = visual.source_image_url ?? visual.sourceImageUrl ?? null;
  return (
    <Pressable style={({ pressed }) => [sc.listRow, pressed && { opacity: 0.7 }]} onPress={onPress}>
      {!!thumb && (
        <Image source={{ uri: thumb }} style={sc.thumb} resizeMode="cover" />
      )}
      {!thumb && <View style={[sc.thumb, { backgroundColor: color.haze }]} />}
      <View style={{ flex: 1 }}>
        <Text style={sc.rowTitle} numberOfLines={1}>
          {visual.placeName ?? visual.entity_id}
        </Text>
        {!!visual.placeCategory && (
          <Text style={sc.rowSub}>{visual.placeCategory}</Text>
        )}
        <Text style={sc.rowSub}>{timeAgo(visual.created_at ?? visual.createdAt)}</Text>
      </View>
      <Eye size={18} color={color.mute ?? color.ink} />
    </Pressable>
  );
}

// ── History row ────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  ready:      '#10B981',
  failed:     '#EF4444',
  blocked:    '#F59E0B',
  replaced:   '#6B7280',
  queued:     '#3B82F6',
  generating: '#8B5CF6',
};

function HistoryRow({
  visual,
  onPress,
}: {
  visual: AdminVisual;
  onPress: () => void;
}) {
  const dotColor = STATUS_COLORS[visual.status] ?? '#9CA3AF';
  return (
    <Pressable style={({ pressed }) => [sc.listRow, pressed && { opacity: 0.7 }]} onPress={onPress}>
      <View style={[sc.statusDot, { backgroundColor: dotColor }]} />
      <View style={{ flex: 1 }}>
        <Text style={sc.rowTitle} numberOfLines={1}>
          {visual.entity_type} · {visual.entity_id.slice(0, 8)}…
        </Text>
        <Text style={sc.rowSub}>{visual.purpose} · {visual.provider}</Text>
        <Text style={sc.rowSub}>{fmtDate(visual.created_at ?? visual.createdAt)}</Text>
      </View>
      <Text style={[sc.statusBadge, { color: dotColor }]}>{visual.status}</Text>
    </Pressable>
  );
}

// ── Overview tab ───────────────────────────────────────────────────────────────

function OverviewTab({
  stats,
  loading,
  refreshing,
  onRefresh,
  flagBusy,
  onToggleFlag,
}: {
  stats: VisualStats | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  flagBusy: Record<string, boolean>;
  onToggleFlag: (flag: string, next: boolean) => void;
}) {
  if (loading) {
    return (
      <View style={sc.center}>
        <ActivityIndicator color={color.ink} />
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={sc.overviewContent}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {/* Provider status banner */}
      {stats && (
        <View
          style={[
            sc.providerBanner,
            {
              backgroundColor:
                stats.providerStatus === 'healthy' ? '#D1FAE5'
                  : stats.providerStatus === 'degraded' ? '#FEF3C7'
                  : '#FEE2E2',
            },
          ]}
        >
          <View style={[sc.statusDot, {
            backgroundColor:
              stats.providerStatus === 'healthy' ? '#10B981'
                : stats.providerStatus === 'degraded' ? '#F59E0B'
                : '#EF4444',
          }]} />
          <Text style={sc.providerBannerText}>
            Provider: {stats.providerStatus.toUpperCase()}
            {'  ·  '}Queue: {fmt(stats.queueDepth)} job{stats.queueDepth !== 1 ? 's' : ''}
          </Text>
        </View>
      )}

      {/* Stats grid */}
      <View style={sc.statsGrid}>
        <StatCard
          label="Today"
          value={fmt(stats?.generationsToday ?? 0)}
          sub="generations"
        />
        <StatCard
          label="This week"
          value={fmt(stats?.generationsWeek ?? 0)}
          sub="generations"
        />
        <StatCard
          label="Success"
          value={fmt(stats?.byStatus.success ?? 0)}
        />
        <StatCard
          label="Failed"
          value={fmt(stats?.byStatus.failed ?? 0)}
        />
        <StatCard
          label="Blocked"
          value={fmt(stats?.byStatus.blocked ?? 0)}
        />
        <StatCard
          label="Reused"
          value={fmt(stats?.byStatus.reused ?? 0)}
        />
        <StatCard
          label="Avg attempts"
          value={String(stats?.avgAttemptsPerSuccess ?? '—')}
          sub="per success"
        />
        <StatCard
          label="Est. cost"
          value={`$${(stats?.estimatedCostThisMonth ?? 0).toFixed(2)}`}
          sub={`this month · $${(stats?.costPerImage ?? 0.04).toFixed(2)}/img`}
        />
        <StatCard
          label="Avg duration"
          value={fmtDuration(stats?.avgGenerationDurationMs ?? null)}
        />
        <StatCard
          label="Regen rate"
          value={`${((stats?.regenerationRate ?? 0) * 100).toFixed(1)}%`}
        />
      </View>

      {/* By entity type */}
      {stats?.byType && Object.keys(stats.byType).length > 0 && (
        <View style={sc.section}>
          <Text style={sc.sectionTitle}>By entity type</Text>
          {Object.entries(stats.byType).map(([type, count]) => (
            <View key={type} style={sc.typeRow}>
              <Text style={sc.typeLabel}>{type}</Text>
              <Text style={sc.typeCount}>{fmt(count)}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Top styles */}
      {stats?.topStyles && stats.topStyles.length > 0 && (
        <View style={sc.section}>
          <Text style={sc.sectionTitle}>Top styles</Text>
          {stats.topStyles.map(({ style, count }) => (
            <View key={style} style={sc.typeRow}>
              <Text style={sc.typeLabel}>{style}</Text>
              <Text style={sc.typeCount}>{fmt(count)}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Kill switches */}
      <View style={sc.section}>
        <Text style={sc.sectionTitle}>Kill switches</Text>
        <Text style={sc.sectionSub}>Toggle these flags to enable or disable AI visual generation globally. Changes take effect on the next generation request.</Text>
        <KillSwitchRow
          label="AI provider"
          flagKey="ai_visual_provider_enabled"
          value={stats?.providerEnabled ?? false}
          onToggle={onToggleFlag}
          busy={!!flagBusy['ai_visual_provider_enabled']}
        />
        <View style={sc.divider} />
        <KillSwitchRow
          label="Event headers"
          flagKey="ai_event_headers_enabled"
          value={stats?.eventHeadersEnabled ?? false}
          onToggle={onToggleFlag}
          busy={!!flagBusy['ai_event_headers_enabled']}
        />
        <View style={sc.divider} />
        <KillSwitchRow
          label="Place headers"
          flagKey="ai_place_headers_enabled"
          value={stats?.placeHeadersEnabled ?? false}
          onToggle={onToggleFlag}
          busy={!!flagBusy['ai_place_headers_enabled']}
        />
      </View>
    </ScrollView>
  );
}

// ── Pending Review tab ─────────────────────────────────────────────────────────

function PendingReviewTab({
  onSelect,
}: {
  onSelect: (v: AdminVisual) => void;
}) {
  const [visuals, setVisuals] = useState<AdminVisual[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (p = 1, append = false) => {
    if (!append) setLoading(true);
    const res = await getPendingReview({ page: p, limit: 30 });
    if (res.ok) {
      setVisuals((prev) => append ? [...prev, ...res.data.visuals] : res.data.visuals);
      setTotal(res.data.total);
      setPage(p);
    }
    setLoading(false);
    setRefreshing(false);
    setLoadingMore(false);
  }, []);

  useEffect(() => { load(1); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(1); };

  const loadMore = () => {
    if (loadingMore || visuals.length >= total) return;
    setLoadingMore(true);
    load(page + 1, true);
  };

  if (loading) {
    return (
      <View style={sc.center}>
        <ActivityIndicator color={color.ink} />
      </View>
    );
  }

  return (
    <FlatList
      data={visuals}
      keyExtractor={(v) => v.id}
      renderItem={({ item }) => <PendingRow visual={item} onPress={() => onSelect(item)} />}
      ItemSeparatorComponent={() => <View style={sc.sep} />}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      onEndReached={loadMore}
      onEndReachedThreshold={0.3}
      contentContainerStyle={{ paddingBottom: space.xl }}
      ListEmptyComponent={
        <View style={sc.empty}>
          <CheckCircle size={40} color="#10B981" />
          <Text style={sc.emptyText}>No visuals awaiting review</Text>
        </View>
      }
      ListFooterComponent={
        loadingMore ? <ActivityIndicator color={color.ink} style={{ margin: space.md }} /> : null
      }
    />
  );
}

// ── History tab ────────────────────────────────────────────────────────────────

const ENTITY_TYPES = ['event', 'place', 'trip', 'city_guide', 'group', 'content'];
const STATUSES     = ['queued', 'generating', 'ready', 'failed', 'blocked', 'replaced'];

function HistoryTab({ onSelect }: { onSelect: (v: AdminVisual) => void }) {
  const [visuals, setVisuals]     = useState<AdminVisual[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  const [entityType, setEntityType] = useState<string>('');
  const [entityId, setEntityId]     = useState('');
  const [status, setStatus]         = useState<string>('');
  const [search, setSearch]         = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (p = 1, append = false, params?: {
    entityType?: string;
    entityId?: string;
    status?: string;
  }) => {
    if (!append) setLoading(true);
    const res = await getVisualHistory({
      page: p,
      limit: 30,
      entityType: params?.entityType || entityType || undefined,
      entityId:   params?.entityId   || entityId   || undefined,
      status:     params?.status     || status     || undefined,
    });
    if (res.ok) {
      setVisuals((prev) => append ? [...prev, ...res.data.visuals] : res.data.visuals);
      setTotal(res.data.total);
      setPage(p);
    }
    setLoading(false);
    setRefreshing(false);
    setLoadingMore(false);
  }, [entityType, entityId, status]);

  useEffect(() => { load(1); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(1); };

  const loadMore = () => {
    if (loadingMore || visuals.length >= total) return;
    setLoadingMore(true);
    load(page + 1, true);
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Filters */}
      <View style={sc.filterBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={sc.chipScroll}>
          {/* Entity type chips */}
          {ENTITY_TYPES.map((type) => (
            <Pressable
              key={type}
              style={[sc.chip, entityType === type && sc.chipActive]}
              onPress={() => setEntityType((prev) => prev === type ? '' : type)}
            >
              <Text style={[sc.chipText, entityType === type && sc.chipTextActive]}>{type}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={sc.chipScroll}>
          {/* Status chips */}
          {STATUSES.map((s) => (
            <Pressable
              key={s}
              style={[sc.chip, status === s && sc.chipActive]}
              onPress={() => setStatus((prev) => prev === s ? '' : s)}
            >
              <Text style={[sc.chipText, status === s && sc.chipTextActive]}>{s}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {/* Entity ID search */}
        <View style={sc.searchRow}>
          <Search size={14} color={color.mute ?? '#6B7280'} />
          <TextInput
            style={sc.searchInput}
            value={search}
            onChangeText={(v) => {
              setSearch(v);
              if (searchTimer.current) clearTimeout(searchTimer.current);
              searchTimer.current = setTimeout(() => {
                setEntityId(v.trim());
              }, 400);
            }}
            placeholder="Filter by entity ID"
            placeholderTextColor={color.mute ?? '#6B7280'}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {!!search && (
            <Pressable onPress={() => { setSearch(''); setEntityId(''); }} hitSlop={8}>
              <X size={14} color={color.mute ?? '#6B7280'} />
            </Pressable>
          )}
        </View>
      </View>

      {loading ? (
        <View style={sc.center}>
          <ActivityIndicator color={color.ink} />
        </View>
      ) : (
        <FlatList
          data={visuals}
          keyExtractor={(v) => v.id}
          renderItem={({ item }) => <HistoryRow visual={item} onPress={() => onSelect(item)} />}
          ItemSeparatorComponent={() => <View style={sc.sep} />}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          contentContainerStyle={{ paddingBottom: space.xl }}
          ListHeaderComponent={
            <Text style={sc.totalText}>{fmt(total)} total</Text>
          }
          ListEmptyComponent={
            <View style={sc.empty}>
              <BarChart2 size={40} color={color.mute ?? '#6B7280'} />
              <Text style={sc.emptyText}>No results</Text>
            </View>
          }
          ListFooterComponent={
            loadingMore ? <ActivityIndicator color={color.ink} style={{ margin: space.md }} /> : null
          }
        />
      )}
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────

export default function AdminVisualsScreen() {
  const insets = useSafeAreaInsets();
  useRequireAdmin();

  const [tab, setTab] = useState<TabKey>('overview');
  const [stats, setStats]       = useState<VisualStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsRefreshing, setStatsRefreshing] = useState(false);
  const [flagBusy, setFlagBusy] = useState<Record<string, boolean>>({});

  const [selectedVisual, setSelectedVisual] = useState<AdminVisual | null>(null);
  const [sheetVisible, setSheetVisible]     = useState(false);

  const loadStats = useCallback(async () => {
    const res = await getVisualStats();
    if (res.ok) setStats(res.data);
    setStatsLoading(false);
    setStatsRefreshing(false);
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  useFocusEffect(
    useCallback(() => {
      const id = setInterval(() => loadStats(), 60_000);
      return () => clearInterval(id);
    }, [loadStats]),
  );

  const onRefreshStats = () => { setStatsRefreshing(true); loadStats(); };

  const handleToggleFlag = useCallback(async (flag: string, next: boolean) => {
    setFlagBusy((prev) => ({ ...prev, [flag]: true }));
    const res = await toggleVisualFlag(flag, next);
    if (res.ok) {
      setStats((prev) =>
        prev
          ? {
              ...prev,
              providerEnabled:     flag === 'ai_visual_provider_enabled' ? next : prev.providerEnabled,
              eventHeadersEnabled: flag === 'ai_event_headers_enabled'   ? next : prev.eventHeadersEnabled,
              placeHeadersEnabled: flag === 'ai_place_headers_enabled'   ? next : prev.placeHeadersEnabled,
            }
          : prev,
      );
    } else {
      Alert.alert('Error', res.error ?? 'Failed to toggle flag');
    }
    setFlagBusy((prev) => ({ ...prev, [flag]: false }));
  }, []);

  const openVisual = (v: AdminVisual) => {
    setSelectedVisual(v);
    setSheetVisible(true);
  };

  const closeSheet = () => setSheetVisible(false);

  // Action handlers
  const handleVerify = useCallback(async (id: string) => {
    const res = await verifyVisual(id);
    if (!res.ok) Alert.alert('Error', res.error ?? 'Failed to verify');
  }, []);

  const handleDisable = useCallback(async (id: string) => {
    const res = await disableVisual(id);
    if (!res.ok) Alert.alert('Error', res.error ?? 'Failed to disable');
  }, []);

  const handleRegenerate = useCallback(async (id: string) => {
    const res = await regenerateVisual(id);
    if (!res.ok) Alert.alert('Error', res.error ?? 'Failed to regenerate');
    else Alert.alert('Queued', 'Regeneration job has been queued.');
  }, []);

  const handleBlockEntity = useCallback(async (id: string) => {
    const res = await blockVisualEntity(id);
    if (!res.ok) Alert.alert('Error', res.error ?? 'Failed to block entity');
    else Alert.alert('Blocked', 'Entity has been blocked from future generation.');
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const res = await deleteVisual(id);
    if (!res.ok) Alert.alert('Error', res.error ?? 'Failed to delete');
  }, []);

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'pending',  label: 'Pending review' },
    { key: 'history',  label: 'History' },
  ];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.title}>AI Visuals</Text>
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        {TABS.map(({ key, label }) => (
          <Pressable
            key={key}
            style={[styles.tabItem, tab === key && styles.tabItemActive]}
            onPress={() => setTab(key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === key }}
          >
            <Text style={[styles.tabLabel, tab === key && styles.tabLabelActive]}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Content */}
      <View style={{ flex: 1 }}>
        {tab === 'overview' && (
          <OverviewTab
            stats={stats}
            loading={statsLoading}
            refreshing={statsRefreshing}
            onRefresh={onRefreshStats}
            flagBusy={flagBusy}
            onToggleFlag={handleToggleFlag}
          />
        )}
        {tab === 'pending' && (
          <PendingReviewTab onSelect={openVisual} />
        )}
        {tab === 'history' && (
          <HistoryTab onSelect={openVisual} />
        )}
      </View>

      {/* Detail sheet */}
      <VisualDetailSheet
        visual={selectedVisual}
        visible={sheetVisible}
        onClose={closeSheet}
        onVerify={handleVerify}
        onDisable={handleDisable}
        onRegenerate={handleRegenerate}
        onBlockEntity={handleBlockEntity}
        onDelete={handleDelete}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: color.paper ?? '#fff' },
  header:  { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, gap: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze },
  backBtn: { padding: space.xs ?? 4 },
  title:   { ...t.heading, color: color.ink, fontWeight: '700', fontSize: 18 },
  tabBar:  { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze, backgroundColor: color.paper ?? '#fff' },
  tabItem: { flex: 1, paddingVertical: space.sm, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabItemActive: { borderBottomColor: color.signal ?? color.ink },
  tabLabel:      { ...t.small, color: color.mute ?? '#6B7280', fontWeight: '500', fontSize: 13 },
  tabLabelActive:{ color: color.ink, fontWeight: '700' },
});

// Sub-component styles
const sc = StyleSheet.create({
  center:   { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty:    { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl * 2 },
  emptyText:{ ...t.body, color: color.mute ?? '#6B7280', textAlign: 'center' },

  overviewContent: { padding: space.md, gap: space.md, paddingBottom: space.xl * 2 },

  providerBanner: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    borderRadius: radius.md ?? 8, padding: space.md,
  },
  providerBannerText: { ...t.small, color: color.ink, fontWeight: '600' },

  statsGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  statCard:   {
    flex: 1, minWidth: '45%',
    backgroundColor: color.paperRaised,
    borderRadius: radius.md ?? 8,
    padding: space.md,
    gap: 2,
  },
  statValue:  { ...t.heading, color: color.ink, fontWeight: '700', fontSize: 22 },
  statLabel:  { ...t.small, color: color.mute ?? '#6B7280', fontSize: 12 },
  statSub:    { ...t.small, color: color.mute ?? '#9CA3AF', fontSize: 11 },

  section:     { gap: space.sm },
  sectionTitle:{ ...t.small, color: color.ink, fontWeight: '700', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionSub:  { ...t.small, color: color.mute ?? '#6B7280', fontSize: 12, marginBottom: space.xs ?? 4 },

  typeRow:   { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.xs ?? 4 },
  typeLabel: { ...t.body, color: color.ink },
  typeCount: { ...t.body, color: color.mute ?? '#6B7280', fontWeight: '600' },

  ksRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  ksLabel: { ...t.body, color: color.ink, fontWeight: '600' },
  ksSub:   { ...t.small, color: color.mute ?? '#6B7280', fontSize: 11 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.haze },

  listRow:    { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md },
  thumb:      { width: 56, height: 40, borderRadius: radius.sm ?? 4, overflow: 'hidden' },
  rowTitle:   { ...t.body, color: color.ink, fontWeight: '600' },
  rowSub:     { ...t.small, color: color.mute ?? '#6B7280', fontSize: 12 },
  statusDot:  { width: dot.s10, height: dot.s10, borderRadius: dot.s10 / 2 },
  statusBadge:{ ...t.small, fontWeight: '600', fontSize: 12 },
  sep:        { height: StyleSheet.hairlineWidth, backgroundColor: color.haze, marginLeft: space.md },

  // History filter bar
  filterBar:  { backgroundColor: color.paper ?? '#fff', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze, paddingVertical: space.xs ?? 4 },
  chipScroll: { paddingHorizontal: space.md, paddingVertical: space.xs ?? 4 },
  chip:       { paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill ?? 999, backgroundColor: color.paperRaised, marginRight: space.xs ?? 4 },
  chipActive: { backgroundColor: color.ink },
  chipText:   { ...t.small, color: color.mute ?? '#6B7280', fontSize: 12 },
  chipTextActive: { color: '#fff' },
  searchRow:  { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.xs ?? 4 },
  searchInput:{ flex: 1, ...t.body, color: color.ink, fontSize: 13, padding: 0 },
  totalText:  { ...t.small, color: color.mute ?? '#6B7280', padding: space.md, paddingBottom: 0 },

  // Sheet
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet:    { position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '90%', backgroundColor: color.paper ?? '#fff', borderTopLeftRadius: radius.lg ?? 16, borderTopRightRadius: radius.lg ?? 16, overflow: 'hidden' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze },
  sheetTitle:  { ...t.heading, color: color.ink, fontWeight: '700', flex: 1 },
  closeBtn:    { padding: space.xs ?? 4 },
  sheetImage:  { width: '100%', height: 200, borderRadius: radius.md ?? 8, backgroundColor: color.paperRaised },
  sheetMeta:   { gap: 4 },
  sheetMetaRow:{ ...t.small, color: color.ink, fontSize: 13 },
  sheetMetaKey:{ fontWeight: '700', color: color.mute ?? '#6B7280' },
  sheetMetaVal:{ color: color.ink },

  expandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  promptText:{ ...t.small, color: color.ink, fontSize: 12, fontFamily: 'monospace', backgroundColor: color.paperRaised, borderRadius: radius.sm ?? 4, padding: space.sm },

  urlRow: { ...t.small, color: color.ink, fontSize: 12 },
  urlKey: { fontWeight: '700', color: color.mute ?? '#6B7280' },
  urlVal: { color: color.mute ?? '#6B7280' },

  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  actionBtn:   { flexDirection: 'row', alignItems: 'center', gap: space.xs ?? 4, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md ?? 8 },
  actionBtnText: { ...t.small, color: '#fff', fontWeight: '600', fontSize: 13 },
  actionGreen:  { backgroundColor: '#10B981' },
  actionRed:    { backgroundColor: '#EF4444' },
  actionBlue:   { backgroundColor: '#3B82F6' },
  actionOrange: { backgroundColor: '#F59E0B' },
  actionGray:   { backgroundColor: '#6B7280' },
});
