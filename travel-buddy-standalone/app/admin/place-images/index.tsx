/**
 * Admin — Place Images review & moderation.
 *
 * Two tabs:
 *  • Review Queue — paginated cards of place images pending admin sign-off.
 *  • Reports      — unresolved user wrong-place reports with quick actions.
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
  Text,
  TextInput,
  View,
} from 'react-native';
import { CachedImage } from '../../../src/components/CachedImage';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Flag,
  Image as ImageIcon,
  Info,
  RefreshCw,
  Shield,
  X,
  XCircle,
} from 'lucide-react-native';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { color, radius, space, type as t } from '../../../src/theme/tokens';
import {
  approvePlaceImage,
  downgradePlaceImage,
  getPlaceImageDetail,
  getPlaceImageQueue,
  getPlaceImageReports,
  rejectPlaceImage,
  replacePlaceImage,
  resolvePlaceImageReport,
  type PlaceImageDetail,
  type PlaceImageQueueItem,
  type PlaceImageReport,
} from '../../../src/services/adminPlaceImages';

type Tab = 'queue' | 'reports';

// ── Filter chips ──────────────────────────────────────────────────────────────

type FilterChipId = 'all' | 'needs_review' | 'has_reports' | 'ai_grounded' | 'unverified';

interface FilterChipDef {
  id: FilterChipId;
  label: string;
  /** Query params forwarded to GET /admin/place-images/queue */
  serverFilters: { accuracy_status?: string; image_source_type?: string; has_reports?: boolean };
  /**
   * Optional post-fetch predicate applied client-side when the backend has no
   * direct param for this concept (e.g. the compound needsReview flag).
   */
  clientFilter?: (item: PlaceImageQueueItem) => boolean;
}

const FILTER_CHIPS: FilterChipDef[] = [
  { id: 'all',          label: 'All',         serverFilters: {} },
  {
    id: 'needs_review', label: 'Needs Review', serverFilters: {},
    // Mirrors isHighImportance() on the server: reference_grounded_ai images
    // whose accuracy has not been finalised (verified_real / reference_grounded).
    clientFilter: (item) => item.needsReview,
  },
  { id: 'has_reports',  label: 'Has Reports',  serverFilters: { has_reports: true } },
  { id: 'ai_grounded',  label: 'AI-Grounded',  serverFilters: { image_source_type: 'reference_grounded_ai' } },
  { id: 'unverified',   label: 'Unverified',   serverFilters: { accuracy_status: 'unverified' } },
];

// ── Source badge colours ──────────────────────────────────────────────────────

function sourceBadgeColor(src: string | null): string {
  switch (src) {
    case 'official':              return '#059669';
    case 'trusted_provider':      return '#0284C7';
    case 'tourism_authority':     return '#7C3AED';
    case 'verified_owner':        return '#D97706';
    case 'verified_user_photo':   return '#16A34A';
    case 'reference_grounded_ai': return '#6366F1';
    case 'generic_ai_illustration': return '#9CA3AF';
    default:                      return '#6B7280';
  }
}

function accuracyColor(status: string): string {
  switch (status) {
    case 'verified_real':      return '#10B981';
    case 'reference_grounded': return '#6366F1';
    case 'illustrative_only':  return '#F59E0B';
    case 'rejected':           return '#EF4444';
    default:                   return '#9CA3AF'; // unverified
  }
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── PlaceImageReviewCard ──────────────────────────────────────────────────────

function PlaceImageReviewCard({
  item,
  onPress,
}: {
  item: PlaceImageQueueItem;
  onPress: () => void;
}) {
  const thumb = item.source_image_url ?? item.source_url ?? null;
  return (
    <Pressable style={sc.card} onPress={onPress} android_ripple={{ color: '#0001' }}>
      {/* Thumbnail */}
      <View style={sc.thumbWrap}>
        {thumb
          ? <Image source={{ uri: thumb }} style={sc.thumb} resizeMode="cover" />
          : <View style={[sc.thumb, sc.thumbFallback]}><ImageIcon size={20} color={color.mute} /></View>
        }
      </View>

      {/* Body */}
      <View style={sc.cardBody}>
        <View style={sc.cardTitleRow}>
          <Text style={sc.cardTitle} numberOfLines={1}>{item.entity_id}</Text>
          {item.needsReview && (
            <View style={sc.needsReviewBadge}>
              <Text style={sc.needsReviewText}>Needs Review</Text>
            </View>
          )}
        </View>

        <View style={sc.badgeRow}>
          {/* Source badge */}
          <View style={[sc.chip, { backgroundColor: sourceBadgeColor(item.image_source_type) }]}>
            <Text style={sc.chipText}>{item.image_source_type ?? 'unknown'}</Text>
          </View>
          {/* Accuracy badge */}
          <View style={[sc.chip, { backgroundColor: accuracyColor(item.accuracy_status) }]}>
            <Text style={sc.chipText}>{item.accuracy_status}</Text>
          </View>
        </View>

        <View style={sc.cardFooter}>
          {item.reportCount > 0 && (
            <View style={sc.reportCountBadge}>
              <Flag size={10} color="#DC2626" />
              <Text style={sc.reportCountText}>{item.reportCount} report{item.reportCount !== 1 ? 's' : ''}</Text>
            </View>
          )}
          <Text style={sc.cardDate}>{fmtDate(item.created_at)}</Text>
        </View>
      </View>

      <ChevronRight size={16} color={color.mute} />
    </Pressable>
  );
}

// ── PlaceImageReviewSheet ─────────────────────────────────────────────────────

function PlaceImageReviewSheet({
  visualId,
  visible,
  onClose,
  onActioned,
}: {
  visualId: string | null;
  visible: boolean;
  onClose: () => void;
  onActioned: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [detail, setDetail] = useState<PlaceImageDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [replaceUrl, setReplaceUrl] = useState('');
  const [replaceType, setReplaceType] = useState('official');
  const [showReplace, setShowReplace] = useState(false);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    if (!visible || !visualId) { setDetail(null); setShowReplace(false); return; }
    setLoading(true);
    getPlaceImageDetail(visualId).then((res) => {
      if (res.ok) setDetail(res.data);
      setLoading(false);
    });
  }, [visible, visualId]);

  if (!visualId) return null;

  const visual = detail?.visual;

  async function act(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try { await fn(); } finally { setBusy(null); }
  }

  async function handleApprove() {
    if (!visualId) return;
    await act('approve', async () => {
      const res = await approvePlaceImage(visualId);
      if (!res.ok) { Alert.alert('Error', res.error); return; }
      onActioned(visualId);
      onClose();
    });
  }

  function handleReject() {
    if (!visualId) return;
    setRejectReason('');
    setShowRejectForm(true);
  }

  async function handleConfirmReject() {
    if (!visualId) return;
    if (!rejectReason.trim()) { Alert.alert('Required', 'Please enter a reason for rejection.'); return; }
    await act('reject', async () => {
      const res = await rejectPlaceImage(visualId, rejectReason.trim());
      if (!res.ok) { Alert.alert('Error', res.error); return; }
      onActioned(visualId);
      onClose();
    });
  }

  async function handleDowngrade() {
    if (!visualId) return;
    Alert.alert(
      'Downgrade Image',
      'Move from reference-grounded AI to generic illustration and add disclaimer?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Downgrade',
          style: 'destructive',
          onPress: async () => {
            await act('downgrade', async () => {
              const res = await downgradePlaceImage(visualId);
              if (!res.ok) { Alert.alert('Error', res.error); return; }
              onActioned(visualId);
              onClose();
            });
          },
        },
      ],
    );
  }

  async function handleReplace() {
    if (!visualId || !replaceUrl.trim()) {
      Alert.alert('Error', 'Please enter a valid image URL');
      return;
    }
    await act('replace', async () => {
      const res = await replacePlaceImage(visualId, replaceUrl.trim(), replaceType);
      if (!res.ok) { Alert.alert('Error', res.error); return; }
      onActioned(visualId);
      onClose();
    });
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={sc.backdrop} onPress={onClose} />
      <View style={[sc.sheet, { paddingBottom: insets.bottom + space.md }]}>
        {/* Header */}
        <View style={sc.sheetHeader}>
          <Text style={sc.sheetTitle}>Image Review</Text>
          <Pressable onPress={onClose} hitSlop={10} style={sc.closeBtn}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: space.md }}>
          {loading && <ActivityIndicator color={color.ink} style={{ marginTop: space.lg }} />}

          {!loading && visual && (
            <>
              {/* Candidate image */}
              {!!(visual.source_image_url ?? visual.source_url) && (
                <View>
                  <Text style={sc.sectionLabel}>Candidate Image</Text>
                  <CachedImage
                    source={{ uri: (visual.source_image_url ?? visual.source_url)! }}
                    style={sc.sheetImage}
                    resizeMode="cover"
                    accessibilityLabel="Candidate place image"
                  />
                </View>
              )}

              {/* Reference images side-by-side */}
              {Array.isArray(visual.reference_asset_ids) && visual.reference_asset_ids.length > 0 && (
                <View>
                  <Text style={sc.sectionLabel}>Reference Assets ({visual.reference_asset_ids.length})</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={sc.refRow}>
                      {(visual.reference_asset_ids as string[]).map((assetId, i) => (
                        <View key={assetId} style={sc.refThumb}>
                          <Text style={sc.refThumbLabel} numberOfLines={1}>ref {i + 1}</Text>
                          <Text style={sc.refThumbId} numberOfLines={1}>{assetId}</Text>
                        </View>
                      ))}
                    </View>
                  </ScrollView>
                </View>
              )}

              {/* Place data */}
              {detail?.place && (
                <View style={sc.metaCard}>
                  <Text style={sc.sectionLabel}>Canonical Place</Text>
                  <Text style={sc.metaRow}><Text style={sc.metaKey}>Name: </Text>{detail.place.name}</Text>
                  <Text style={sc.metaRow}><Text style={sc.metaKey}>Category: </Text>{detail.place.primary_category}</Text>
                  {detail.place.city && (
                    <Text style={sc.metaRow}><Text style={sc.metaKey}>City: </Text>{detail.place.city}</Text>
                  )}
                  <Text style={sc.metaRow}><Text style={sc.metaKey}>Place ID: </Text>{detail.place.id}</Text>
                </View>
              )}

              {/* Provenance metadata */}
              <View style={sc.metaCard}>
                <Text style={sc.sectionLabel}>Provenance</Text>
                <Text style={sc.metaRow}><Text style={sc.metaKey}>Source Type: </Text>{visual.image_source_type ?? '—'}</Text>
                <Text style={sc.metaRow}><Text style={sc.metaKey}>Accuracy Status: </Text>{visual.accuracy_status}</Text>
                <Text style={sc.metaRow}><Text style={sc.metaKey}>Generation Method: </Text>{visual.generation_method ?? '—'}</Text>
                <Text style={sc.metaRow}><Text style={sc.metaKey}>Generated with AI: </Text>{visual.generated_with_ai ? 'Yes' : 'No'}</Text>
                <Text style={sc.metaRow}><Text style={sc.metaKey}>Source Provider: </Text>{visual.source_provider ?? '—'}</Text>
                <Text style={sc.metaRow}><Text style={sc.metaKey}>Source URL: </Text>{visual.source_url ?? '—'}</Text>
                <Text style={sc.metaRow}><Text style={sc.metaKey}>Canonical Place ID: </Text>{visual.canonical_place_id ?? '—'}</Text>
                <Text style={sc.metaRow}><Text style={sc.metaKey}>Verified By: </Text>{visual.verified_by ?? '—'}</Text>
                <Text style={sc.metaRow}><Text style={sc.metaKey}>Verified At: </Text>{fmtDate(visual.verified_at)}</Text>
                {visual.disclaimer_required && (
                  <View style={sc.disclaimerBanner}>
                    <Info size={12} color="#92400E" />
                    <Text style={sc.disclaimerText}>Disclaimer required</Text>
                  </View>
                )}
              </View>

              {/* User reports */}
              {detail?.userReports && detail.userReports.length > 0 && (
                <View>
                  <Text style={sc.sectionLabel}>User Reports ({detail.userReports.length})</Text>
                  {detail.userReports.map((r) => (
                    <View key={r.id} style={sc.reportRow}>
                      <Flag size={12} color="#DC2626" />
                      <View style={{ flex: 1 }}>
                        <Text style={sc.reportReason}>{r.report_reason}</Text>
                        <Text style={sc.reportMeta}>
                          {r.reporterHandle ? `@${r.reporterHandle}` : 'anonymous'} · {fmtDate(r.created_at)}
                        </Text>
                      </View>
                      <View style={[sc.chip, { backgroundColor: r.status === 'resolved' ? '#10B981' : '#F59E0B' }]}>
                        <Text style={sc.chipText}>{r.status}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}

              {/* Reject form (cross-platform — no Alert.prompt) */}
              {showRejectForm && (
                <View style={sc.replaceForm}>
                  <Text style={sc.sectionLabel}>Reject Image — Enter Reason</Text>
                  <TextInput
                    style={sc.input}
                    value={rejectReason}
                    onChangeText={setRejectReason}
                    placeholder="Reason for rejection (required)"
                    placeholderTextColor={color.mute}
                    multiline
                    numberOfLines={3}
                    autoFocus
                  />
                  <View style={{ flexDirection: 'row', gap: space.sm }}>
                    <Pressable
                      style={[sc.actionBtn, sc.actionRed, { flex: 1 }, busy === 'reject' && sc.actionBusy]}
                      onPress={handleConfirmReject}
                      disabled={!!busy}
                    >
                      {busy === 'reject'
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Text style={sc.actionBtnText}>Confirm Reject</Text>
                      }
                    </Pressable>
                    <Pressable
                      style={[sc.actionBtn, sc.actionGray]}
                      onPress={() => setShowRejectForm(false)}
                      disabled={!!busy}
                    >
                      <Text style={sc.actionBtnText}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              {/* Replace form */}
              {showReplace && (
                <View style={sc.replaceForm}>
                  <Text style={sc.sectionLabel}>Replace Image</Text>
                  <TextInput
                    style={sc.input}
                    value={replaceUrl}
                    onChangeText={setReplaceUrl}
                    placeholder="New image URL (https://...)"
                    placeholderTextColor={color.mute}
                    autoCapitalize="none"
                    keyboardType="url"
                  />
                  <TextInput
                    style={sc.input}
                    value={replaceType}
                    onChangeText={setReplaceType}
                    placeholder="Source type (e.g. official)"
                    placeholderTextColor={color.mute}
                    autoCapitalize="none"
                  />
                  <Pressable
                    style={[sc.actionBtn, sc.actionBlue, busy === 'replace' && sc.actionBusy]}
                    onPress={handleReplace}
                    disabled={!!busy}
                  >
                    {busy === 'replace'
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Text style={sc.actionBtnText}>Confirm Replace</Text>
                    }
                  </Pressable>
                </View>
              )}

              {/* Action buttons */}
              <View style={sc.actionsGrid}>
                <Pressable
                  style={[sc.actionBtn, sc.actionGreen, busy === 'approve' && sc.actionBusy]}
                  onPress={handleApprove}
                  disabled={!!busy}
                >
                  {busy === 'approve'
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <><CheckCircle size={14} color="#fff" /><Text style={sc.actionBtnText}>Approve</Text></>
                  }
                </Pressable>

                <Pressable
                  style={[sc.actionBtn, sc.actionRed, busy === 'reject' && sc.actionBusy]}
                  onPress={handleReject}
                  disabled={!!busy}
                >
                  {busy === 'reject'
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <><XCircle size={14} color="#fff" /><Text style={sc.actionBtnText}>Reject</Text></>
                  }
                </Pressable>

                {visual.image_source_type === 'reference_grounded_ai' && (
                  <Pressable
                    style={[sc.actionBtn, sc.actionOrange, busy === 'downgrade' && sc.actionBusy]}
                    onPress={handleDowngrade}
                    disabled={!!busy}
                  >
                    {busy === 'downgrade'
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <><ChevronDown size={14} color="#fff" /><Text style={sc.actionBtnText}>Downgrade</Text></>
                    }
                  </Pressable>
                )}

                <Pressable
                  style={[sc.actionBtn, sc.actionGray]}
                  onPress={() => setShowReplace((v) => !v)}
                  disabled={!!busy}
                >
                  <RefreshCw size={14} color="#fff" />
                  <Text style={sc.actionBtnText}>Replace</Text>
                </Pressable>
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── ReportsTab ────────────────────────────────────────────────────────────────

function ReportsTab() {
  const [reports, setReports] = useState<PlaceImageReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    const res = await getPlaceImageReports({ status: 'pending', limit: 50 });
    if (res.ok) setReports(res.data.items);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleQuickAction(
    report: PlaceImageReport,
    action: 'image_rejected' | 'no_action',
  ) {
    const label = action === 'image_rejected' ? 'Reject Image' : 'No Action';
    Alert.alert(
      label,
      action === 'image_rejected'
        ? 'Reject the reported image and mark this report resolved?'
        : 'Mark this report resolved with no action taken?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: label,
          style: action === 'image_rejected' ? 'destructive' : 'default',
          onPress: async () => {
            setBusy(report.id);
            const res = await resolvePlaceImageReport(report.id, action);
            setBusy(null);
            if (!res.ok) { Alert.alert('Error', res.error); return; }
            // Optimistic remove
            setReports((prev) => prev.filter((r) => r.id !== report.id));
          },
        },
      ],
    );
  }

  if (loading) {
    return <ActivityIndicator color={color.ink} style={{ marginTop: 40 }} />;
  }

  if (reports.length === 0) {
    return (
      <View style={sc.emptyState}>
        <Shield size={32} color={color.mute} />
        <Text style={sc.emptyText}>No unresolved reports</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={reports}
      keyExtractor={(r) => r.id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); load(true); }}
        />
      }
      contentContainerStyle={{ padding: space.md, gap: space.sm }}
      renderItem={({ item }) => (
        <View style={sc.reportCard}>
          <View style={sc.reportCardHeader}>
            <Flag size={14} color="#DC2626" />
            <Text style={sc.reportCardTitle} numberOfLines={1}>
              {item.place_id}
            </Text>
            <Text style={sc.reportDate}>{fmtDate(item.created_at)}</Text>
          </View>

          <Text style={sc.reportCardReason}>{item.report_reason}</Text>

          <Text style={sc.reportCardMeta}>
            Reporter: {item.reporterHandle ? `@${item.reporterHandle}` : 'anonymous'}
          </Text>

          {item.priorReviewActions && (
            <View style={sc.priorAction}>
              <Info size={10} color="#6B7280" />
              <Text style={sc.priorActionText}>
                Prior action: {item.priorReviewActions.accuracyStatus}
                {item.priorReviewActions.verifiedAt ? ` · ${fmtDate(item.priorReviewActions.verifiedAt)}` : ''}
              </Text>
            </View>
          )}

          <View style={sc.reportCardActions}>
            <Pressable
              style={[sc.quickBtn, sc.quickBtnRed, busy === item.id && sc.actionBusy]}
              onPress={() => handleQuickAction(item, 'image_rejected')}
              disabled={!!busy}
            >
              {busy === item.id
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={sc.quickBtnText}>Reject Image</Text>
              }
            </Pressable>
            <Pressable
              style={[sc.quickBtn, sc.quickBtnGray, busy === item.id && sc.actionBusy]}
              onPress={() => handleQuickAction(item, 'no_action')}
              disabled={!!busy}
            >
              <Text style={sc.quickBtnText}>No Action</Text>
            </Pressable>
          </View>
        </View>
      )}
    />
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function PlaceImagesAdminScreen() {
  const insets = useSafeAreaInsets();
  useRequireAdmin();

  const [tab, setTab] = useState<Tab>('queue');

  // Queue state
  const [queueItems, setQueueItems] = useState<PlaceImageQueueItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueRefreshing, setQueueRefreshing] = useState(false);
  const [queueTotal, setQueueTotal] = useState(0);

  // Filter chip state
  const [activeChip, setActiveChip] = useState<FilterChipId>('all');

  // Sheet state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const loadQueue = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setQueueLoading(true);
    const chipDef = FILTER_CHIPS.find((c) => c.id === activeChip) ?? FILTER_CHIPS[0];
    const res = await getPlaceImageQueue({ limit: 50, page: 1, ...chipDef.serverFilters });
    if (res.ok) {
      const items = chipDef.clientFilter
        ? res.data.items.filter(chipDef.clientFilter)
        : res.data.items;
      setQueueItems(items);
      setQueueTotal(chipDef.clientFilter ? items.length : res.data.pagination.total);
    }
    setQueueLoading(false);
    setQueueRefreshing(false);
  }, [activeChip]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  function handleChipPress(chipId: FilterChipId) {
    if (chipId === activeChip) return;
    // Setting state causes loadQueue's identity to change (activeChip dep),
    // which triggers the useEffect — no direct loadQueue call needed.
    setActiveChip(chipId);
  }

  function openSheet(id: string) {
    setSelectedId(id);
    setSheetOpen(true);
  }

  function closeSheet() {
    setSheetOpen(false);
    setSelectedId(null);
  }

  function handleActioned(id: string) {
    // Optimistic remove from queue
    setQueueItems((prev) => prev.filter((item) => item.id !== id));
    setQueueTotal((prev) => Math.max(0, prev - 1));
  }

  return (
    <View style={[sc.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={sc.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={sc.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={sc.headerTitle}>Place Images</Text>
      </View>

      {/* Tab bar */}
      <View style={sc.tabBar}>
        <Pressable
          style={[sc.tabItem, tab === 'queue' && sc.tabItemActive]}
          onPress={() => setTab('queue')}
        >
          <Text style={[sc.tabText, tab === 'queue' && sc.tabTextActive]}>
            Review Queue{queueTotal > 0 ? ` (${queueTotal})` : ''}
          </Text>
        </Pressable>
        <Pressable
          style={[sc.tabItem, tab === 'reports' && sc.tabItemActive]}
          onPress={() => setTab('reports')}
        >
          <Text style={[sc.tabText, tab === 'reports' && sc.tabTextActive]}>Reports</Text>
        </Pressable>
      </View>

      {/* Content */}
      {tab === 'queue' ? (
        <>
          {/* Filter chip bar */}
          <View style={sc.filterBar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={sc.filterBarContent}
            >
              {FILTER_CHIPS.map((chip) => (
                <Pressable
                  key={chip.id}
                  style={[sc.filterChip, activeChip === chip.id && sc.filterChipActive]}
                  onPress={() => handleChipPress(chip.id)}
                >
                  <Text style={[sc.filterChipText, activeChip === chip.id && sc.filterChipTextActive]}>
                    {chip.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>

          {queueLoading ? (
            <ActivityIndicator color={color.ink} style={{ marginTop: 40 }} />
          ) : queueItems.length === 0 ? (
            <View style={sc.emptyState}>
              <CheckCircle size={32} color={color.mute} />
              <Text style={sc.emptyText}>No images pending review</Text>
            </View>
          ) : (
            <FlatList
              data={queueItems}
              keyExtractor={(item) => item.id}
              refreshControl={
                <RefreshControl
                  refreshing={queueRefreshing}
                  onRefresh={() => { setQueueRefreshing(true); loadQueue(true); }}
                />
              }
              contentContainerStyle={{ padding: space.md, gap: space.sm }}
              renderItem={({ item }) => (
                <PlaceImageReviewCard
                  item={item}
                  onPress={() => openSheet(item.id)}
                />
              )}
            />
          )}
        </>
      ) : (
        <ReportsTab />
      )}

      {/* Detail sheet */}
      <PlaceImageReviewSheet
        visualId={selectedId}
        visible={sheetOpen}
        onClose={closeSheet}
        onActioned={handleActioned}
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const sc = StyleSheet.create({
  root:   { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze,
  },
  backBtn:     { marginRight: space.sm },
  headerTitle: { ...t.heading, color: color.ink },

  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  tabItem: {
    flex: 1, paddingVertical: space.sm, alignItems: 'center',
    borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  tabItemActive:  { borderBottomColor: color.ink },
  tabText:        { ...t.body, color: color.mute, fontWeight: '600' },
  tabTextActive:  { color: color.ink },

  // Queue card
  card: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    padding: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: color.haze,
  },
  thumbWrap:    { flexShrink: 0 },
  thumb:        { width: 64, height: 48, borderRadius: radius.sm, backgroundColor: color.haze },
  thumbFallback:{ justifyContent: 'center', alignItems: 'center' },
  cardBody:     { flex: 1, gap: 4 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' },
  cardTitle:    { ...t.body, color: color.ink, fontWeight: '600', flexShrink: 1 },
  badgeRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  cardFooter:   { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardDate:     { ...t.small, color: color.mute, fontSize: 11, marginLeft: 'auto' },

  needsReviewBadge: {
    backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FCD34D',
    borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 2,
  },
  needsReviewText:  { fontSize: 10, fontWeight: '700', color: '#92400E' },

  chip:     { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.pill },
  chipText: { fontSize: 10, fontWeight: '700', color: '#fff' },

  reportCountBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  reportCountText:  { fontSize: 11, color: '#DC2626', fontWeight: '600' },

  // Filter chip bar
  filterBar: {
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  filterBarContent: {
    paddingHorizontal: space.md, paddingVertical: space.xs, gap: space.xs,
    flexDirection: 'row',
  },
  filterChip: {
    paddingHorizontal: space.md, paddingVertical: 6,
    borderRadius: radius.pill, backgroundColor: color.paperRaised,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.haze,
  },
  filterChipActive:     { backgroundColor: color.ink, borderColor: color.ink },
  filterChipText:       { ...t.small, color: color.mute, fontWeight: '600', fontSize: 12 },
  filterChipTextActive: { color: '#fff' },

  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: space.sm },
  emptyText:  { ...t.body, color: color.mute },

  // Sheet
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet:    {
    position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '92%',
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, overflow: 'hidden',
  },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze,
  },
  sheetTitle:  { ...t.heading, color: color.ink, fontWeight: '700', flex: 1 },
  closeBtn:    { padding: 4 },
  sheetImage:  { width: '100%', height: 200, borderRadius: radius.md, backgroundColor: color.haze },

  sectionLabel: { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },

  metaCard:  { backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md, gap: 4 },
  metaRow:   { ...t.small, color: color.ink, fontSize: 13 },
  metaKey:   { fontWeight: '700', color: color.mute },

  disclaimerBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#FEF3C7', borderRadius: radius.sm,
    paddingHorizontal: space.sm, paddingVertical: 4, marginTop: 4,
  },
  disclaimerText: { ...t.small, color: '#92400E', fontSize: 12 },

  refRow:    { flexDirection: 'row', gap: space.sm },
  refThumb:  {
    width: 80, height: 60, borderRadius: radius.sm,
    backgroundColor: color.haze, justifyContent: 'center', alignItems: 'center', padding: 4,
  },
  refThumbLabel: { ...t.small, color: color.mute, fontSize: 10, fontWeight: '700' },
  refThumbId:    { ...t.small, color: color.mute, fontSize: 9 },

  reportRow:    { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: space.xs },
  reportReason: { ...t.body, color: color.ink, fontWeight: '600', fontSize: 13 },
  reportMeta:   { ...t.small, color: color.mute, fontSize: 11 },

  replaceForm: { gap: space.sm, backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md },
  input:       {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm,
    padding: space.sm, ...t.body, color: color.ink, fontSize: 13,
    backgroundColor: color.paper,
  },

  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  actionBtn:   {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  actionBtnText: { ...t.small, color: '#fff', fontWeight: '600', fontSize: 13 },
  actionBusy:    { opacity: 0.6 },
  actionGreen:   { backgroundColor: '#10B981' },
  actionRed:     { backgroundColor: '#EF4444' },
  actionBlue:    { backgroundColor: '#3B82F6' },
  actionOrange:  { backgroundColor: '#F59E0B' },
  actionGray:    { backgroundColor: '#6B7280' },

  // Reports tab
  reportCard: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    padding: space.md, gap: space.xs,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.haze,
  },
  reportCardHeader: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  reportCardTitle:  { ...t.body, color: color.ink, fontWeight: '600', flex: 1 },
  reportDate:       { ...t.small, color: color.mute, fontSize: 11 },
  reportCardReason: { ...t.body, color: color.ink, fontSize: 13 },
  reportCardMeta:   { ...t.small, color: color.mute, fontSize: 12 },
  priorAction:      { flexDirection: 'row', alignItems: 'center', gap: 4 },
  priorActionText:  { ...t.small, color: color.mute, fontSize: 11 },
  reportCardActions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  quickBtn: {
    flex: 1, paddingVertical: space.sm, borderRadius: radius.md, alignItems: 'center',
  },
  quickBtnRed:  { backgroundColor: '#EF4444' },
  quickBtnGray: { backgroundColor: '#6B7280' },
  quickBtnText: { ...t.small, color: '#fff', fontWeight: '600', fontSize: 13 },
});
