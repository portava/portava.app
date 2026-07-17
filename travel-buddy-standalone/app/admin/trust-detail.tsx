import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import {
  fetchUserTrustDetail,
  confirmTrustEvent,
  dismissTrustEvent,
  applyTrustRestriction,
  liftTrustRestriction,
  liftTrustCap,
  type TrustUserDetail,
  type TrustEvent,
  type TrustCap,
  type TrustRestriction,
} from '../../src/services/trustAdmin';
import { ReasonPromptModal } from '../../src/components/ReasonPromptModal';

const LEVEL_COLORS: Record<string, string> = {
  new_traveler:      '#9CA3AF',
  building_trust:    '#F59E0B',
  reliable_traveler: '#3B82F6',
  trusted_traveler:  '#8B5CF6',
  highly_trusted:    '#10B981',
  city_trusted:      '#F97316',
};

const RESTRICTION_TYPES = [
  { value: 'hosting',              label: '🏠 Hosting' },
  { value: 'private_plan_access',  label: '🔒 Private Plans' },
  { value: 'messaging',            label: '💬 Messaging' },
  { value: 'location_plan_join',   label: '📍 Location Plans' },
];

const CAT_SHORT: Record<string, string> = {
  plan_attendance:    'Attend',
  host_quality:       'Host',
  communication:      'Comms',
  respect_safety:     'Safety',
  location_honesty:   'GPS',
  content_quality:    'Content',
  community_value:    'Community',
  guide_accuracy:     'Guide',
  passport_authenticity: 'Passport',
};

// ── Score bar ─────────────────────────────────────────────────────────────────

function ScoreBar({ label, score }: { label: string; score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  const color = pct >= 65 ? '#10B981' : pct >= 40 ? '#F59E0B' : '#EF4444';
  return (
    <View style={s.scoreRow}>
      <Text style={s.scoreLabel}>{label}</Text>
      <View style={s.barTrack}>
        <View style={[s.barFill, { width: `${pct}%` as any, backgroundColor: color }]} />
      </View>
      <Text style={[s.scoreNum, { color }]}>{pct.toFixed(0)}</Text>
    </View>
  );
}

// ── Event row ─────────────────────────────────────────────────────────────────

function EventRow({
  item,
  onConfirm,
  onDismiss,
}: {
  item: TrustEvent;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const isPending = item.status === 'pending_review';
  const statusColor = isPending ? '#F59E0B'
    : item.status === 'confirmed' ? '#10B981'
    : item.status === 'dismissed' ? '#9CA3AF'
    : '#6B7280';

  return (
    <View style={s.eventRow}>
      <View style={s.eventTop}>
        <Text style={s.eventType}>{item.event_type}</Text>
        <View style={[s.badge, { borderColor: statusColor, backgroundColor: statusColor + '22' }]}>
          <Text style={[s.badgeText, { color: statusColor }]}>{item.status}</Text>
        </View>
      </View>
      <Text style={s.eventMeta}>
        {CAT_SHORT[item.category] ?? item.category} · {item.delta > 0 ? '+' : ''}{item.delta} · {item.severity}
      </Text>
      <Text style={s.eventDate}>{new Date(item.created_at).toLocaleDateString()}</Text>
      {isPending && (
        <View style={s.eventActions}>
          <TouchableOpacity style={s.confirmBtn} onPress={onConfirm}>
            <Text style={s.confirmBtnText}>Confirm</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.dimissBtn} onPress={onDismiss}>
            <Text style={s.dimissBtnText}>Dismiss</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ── Restrict modal ────────────────────────────────────────────────────────────

function RestrictModal({
  visible,
  userId,
  onClose,
  onApplied,
}: {
  visible: boolean;
  userId: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [type, setType]     = useState('hosting');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const onConfirm = async () => {
    if (!reason.trim()) { Alert.alert('Required', 'Please enter a reason'); return; }
    setSaving(true);
    try {
      await applyTrustRestriction(userId, type, reason.trim());
      onApplied();
      onClose();
      setReason('');
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not apply restriction');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={s.modalContainer}>
        <View style={s.modalHeader}>
          <Text style={s.modalTitle}>Apply Restriction</Text>
          <TouchableOpacity onPress={onClose}><Text style={s.modalClose}>Cancel</Text></TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          <Text style={s.fieldLabel}>Restriction Type</Text>
          {RESTRICTION_TYPES.map((rt) => (
            <TouchableOpacity
              key={rt.value}
              style={[s.typeChip, type === rt.value && s.typeChipActive]}
              onPress={() => setType(rt.value)}
            >
              <Text style={[s.typeChipText, type === rt.value && s.typeChipTextActive]}>{rt.label}</Text>
            </TouchableOpacity>
          ))}

          <Text style={[s.fieldLabel, { marginTop: 8 }]}>Reason (required)</Text>
          <TextInput
            style={s.textArea}
            value={reason}
            onChangeText={setReason}
            multiline
            numberOfLines={4}
            placeholder="Explain why this restriction is being applied…"
            placeholderTextColor="#9CA3AF"
          />

          <TouchableOpacity
            style={[s.applyBtn, (!reason.trim() || saving) && s.applyBtnDisabled]}
            onPress={onConfirm}
            disabled={!reason.trim() || saving}
          >
            <Text style={s.applyBtnText}>{saving ? 'Applying…' : 'Apply Restriction'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function TrustDetailScreen() {
  const insets = useSafeAreaInsets();
  useRequireAdmin();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const [detail, setDetail]           = useState<TrustUserDetail | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [restrictModal, setRestrictModal] = useState(false);
  const [actioning, setActioning]     = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      setError(null);
      const d = await fetchUserTrustDetail(userId);
      setDetail(d);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load trust detail');
    }
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  // Cross-platform reason prompt (Alert.prompt is iOS-only — a silent no-op
  // on Android/web), backed by a modal with a TextInput.
  const [reasonPrompt, setReasonPrompt] = useState<{
    title: string;
    message: string;
    resolve: (value: string | null) => void;
  } | null>(null);

  const promptReason = (title: string, message: string): Promise<string | null> =>
    new Promise((resolve) => {
      setReasonPrompt({ title, message, resolve });
    });

  const onConfirmEvent = async (event: TrustEvent) => {
    const reason = await promptReason('Confirm Event', 'Enter reason for confirming this event:');
    if (!reason) return;
    setActioning(event.id);
    try {
      await confirmTrustEvent(event.id, reason);
      await load();
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not confirm event');
    } finally {
      setActioning(null);
    }
  };

  const onDismissEvent = async (event: TrustEvent) => {
    const reason = await promptReason('Dismiss Event', 'Enter reason for dismissing this event:');
    if (!reason) return;
    setActioning(event.id);
    try {
      await dismissTrustEvent(event.id, reason);
      await load();
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not dismiss event');
    } finally {
      setActioning(null);
    }
  };

  const onLiftCap = async (cap: TrustCap) => {
    const reason = await promptReason('Lift Cap', `Remove the ${cap.category} cap (ceiling: ${cap.ceilingScore})?`);
    if (!reason) return;
    if (!userId) return;
    setActioning(cap.id);
    try {
      await liftTrustCap(userId, cap.id, reason);
      await load();
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not lift cap');
    } finally {
      setActioning(null);
    }
  };

  const onLiftRestriction = async (restriction: TrustRestriction) => {
    const reason = await promptReason('Lift Restriction', `Lift ${restriction.restriction_type} restriction?`);
    if (!reason) return;
    if (!userId) return;
    setActioning(restriction.id);
    try {
      await liftTrustRestriction(restriction.id, userId, reason);
      await load();
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Could not lift restriction');
    } finally {
      setActioning(null);
    }
  };

  if (loading) {
    return <View style={s.centered}><ActivityIndicator size="large" color="#3B82F6" /></View>;
  }

  if (error || !detail) {
    return (
      <View style={s.centered}>
        <Text style={s.errorText}>{error ?? 'Not found'}</Text>
        <TouchableOpacity style={s.retryBtn} onPress={() => { setLoading(true); load().finally(() => setLoading(false)); }}>
          <Text style={s.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const { profile, caps, restrictions, events, openReviews } = detail;
  const levelColor = LEVEL_COLORS[profile?.public_level ?? ''] ?? '#9CA3AF';
  const pendingEvents = events.filter((e) => e.status === 'pending_review');
  const activeRestrictions = restrictions.filter((r) => !r.lifted_at);

  return (
    <>
      <ScrollView style={[s.container, { paddingTop: insets.top }]} contentContainerStyle={{ paddingBottom: 48 }}>

        {/* ── Header ── */}
        <View style={s.header}>
          <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={20} color="#111827" />
          </Pressable>
          <Text style={s.userId} numberOfLines={1}>{userId}</Text>
          <View style={[s.levelBadge, { backgroundColor: levelColor + '22', borderColor: levelColor }]}>
            <Text style={[s.levelText, { color: levelColor }]}>
              {profile?.public_level?.replace('_', ' ') ?? 'Unknown'}
            </Text>
          </View>
          <Text style={s.overallScore}>
            Overall: <Text style={{ fontWeight: '700' }}>{profile?.overall_score?.toFixed(1) ?? '—'}</Text>
          </Text>
        </View>

        {/* ── Quick actions ── */}
        <View style={s.quickActions}>
          <TouchableOpacity style={s.actionBtn} onPress={() => setRestrictModal(true)}>
            <Text style={s.actionBtnText}>+ Restriction</Text>
          </TouchableOpacity>
        </View>

        {/* ── Category scores ── */}
        {profile && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Category Scores</Text>
            {Object.entries(profile.categories ?? {}).map(([cat, score]) => (
              <ScoreBar key={cat} label={CAT_SHORT[cat] ?? cat} score={score as number} />
            ))}
          </View>
        )}

        {/* ── Active caps ── */}
        {caps.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Active Caps ({caps.length})</Text>
            {caps.map((cap) => (
              <View key={cap.id} style={s.capRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.capCat}>{CAT_SHORT[cap.category] ?? cap.category}</Text>
                  <Text style={s.capDetail}>ceiling {cap.ceilingScore} · {cap.reasonCode}</Text>
                  {cap.expiresAt && (
                    <Text style={s.capExpiry}>expires {new Date(cap.expiresAt).toLocaleDateString()}</Text>
                  )}
                </View>
                <TouchableOpacity
                  style={[s.liftBtn, actioning === cap.id && s.liftBtnDisabled]}
                  onPress={() => onLiftCap(cap)}
                  disabled={actioning === cap.id}
                >
                  <Text style={s.liftBtnText}>{actioning === cap.id ? '…' : 'Lift'}</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* ── Active restrictions ── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Restrictions ({activeRestrictions.length})</Text>
          {activeRestrictions.length === 0 ? (
            <Text style={s.emptyText}>None active</Text>
          ) : (
            activeRestrictions.map((r) => (
              <View key={r.id} style={s.restrictRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.restrictType}>{r.restriction_type.replace('_', ' ')}</Text>
                  <Text style={s.restrictReason} numberOfLines={2}>{r.reason}</Text>
                  {r.expires_at && (
                    <Text style={s.restrictExpiry}>expires {new Date(r.expires_at).toLocaleDateString()}</Text>
                  )}
                </View>
                <TouchableOpacity
                  style={[s.liftBtn, actioning === r.id && s.liftBtnDisabled]}
                  onPress={() => onLiftRestriction(r)}
                  disabled={actioning === r.id}
                >
                  <Text style={s.liftBtnText}>{actioning === r.id ? '…' : 'Lift'}</Text>
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        {/* ── Open reviews ── */}
        {openReviews.length > 0 && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Open Reviews ({openReviews.length})</Text>
            {openReviews.map((r) => (
              <View key={r.id} style={s.reviewRow}>
                <Text style={s.reviewType}>{r.review_type}</Text>
                <View style={[s.badge, { borderColor: '#F59E0B', backgroundColor: '#FEF3C722' }]}>
                  <Text style={[s.badgeText, { color: '#F59E0B' }]}>{r.status}</Text>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* ── Pending events ── */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>
            Events{pendingEvents.length > 0 ? ` · ${pendingEvents.length} pending` : ''}
          </Text>
          {events.length === 0 ? (
            <Text style={s.emptyText}>No events recorded</Text>
          ) : (
            events.slice(0, 20).map((ev) => (
              <EventRow
                key={ev.id}
                item={ev}
                onConfirm={() => onConfirmEvent(ev)}
                onDismiss={() => onDismissEvent(ev)}
              />
            ))
          )}
        </View>

      </ScrollView>

      <RestrictModal
        visible={restrictModal}
        userId={userId ?? ''}
        onClose={() => setRestrictModal(false)}
        onApplied={load}
      />

      <ReasonPromptModal
        visible={reasonPrompt != null}
        title={reasonPrompt?.title ?? ''}
        message={reasonPrompt?.message ?? ''}
        onCancel={() => { reasonPrompt?.resolve(null); setReasonPrompt(null); }}
        onSubmit={(value) => { reasonPrompt?.resolve(value); setReasonPrompt(null); }}
      />
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },
  centered:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  errorText: { color: '#EF4444', textAlign: 'center', marginBottom: 12 },
  retryBtn:  { backgroundColor: '#3B82F6', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryText: { color: '#fff', fontWeight: '600' },

  header:      { padding: 16, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  backBtn:     { padding: 4, marginBottom: 8 },
  userId:      { fontSize: 13, color: '#6B7280', marginBottom: 6 },
  levelBadge:  { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12, borderWidth: 1, marginBottom: 6 },
  levelText:   { fontSize: 13, fontWeight: '700', textTransform: 'capitalize' },
  overallScore:{ fontSize: 14, color: '#374151' },

  quickActions: { flexDirection: 'row', padding: 12, gap: 8 },
  actionBtn:    { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: '#3B82F6' },
  actionBtnText:{ color: '#fff', fontWeight: '600', fontSize: 13 },

  section:      { backgroundColor: '#fff', marginTop: 12, marginHorizontal: 16, borderRadius: 12, padding: 14, overflow: 'hidden' },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: '#374151', marginBottom: 10 },
  emptyText:    { fontSize: 13, color: '#9CA3AF', textAlign: 'center', paddingVertical: 8 },

  scoreRow:    { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  scoreLabel:  { width: 68, fontSize: 12, color: '#6B7280' },
  barTrack:    { flex: 1, height: 6, backgroundColor: '#F3F4F6', borderRadius: 3, overflow: 'hidden', marginHorizontal: 8 },
  barFill:     { height: '100%', borderRadius: 3 },
  scoreNum:    { width: 28, fontSize: 12, fontWeight: '600', textAlign: 'right' },

  capRow:      { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#F9FAFB' },
  capCat:      { fontSize: 13, fontWeight: '600', color: '#111827' },
  capDetail:   { fontSize: 12, color: '#6B7280', marginTop: 1 },
  capExpiry:   { fontSize: 11, color: '#F59E0B', marginTop: 1 },

  restrictRow:   { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#F9FAFB' },
  restrictType:  { fontSize: 13, fontWeight: '600', color: '#111827', textTransform: 'capitalize' },
  restrictReason:{ fontSize: 12, color: '#6B7280', marginTop: 1 },
  restrictExpiry:{ fontSize: 11, color: '#F59E0B', marginTop: 1 },

  liftBtn:         { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: '#D1D5DB', backgroundColor: '#F9FAFB', marginLeft: 8 },
  liftBtnDisabled: { opacity: 0.5 },
  liftBtnText:     { fontSize: 12, color: '#374151', fontWeight: '600' },

  reviewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: 1, borderTopColor: '#F9FAFB' },
  reviewType:{ fontSize: 13, color: '#374151' },

  eventRow:    { paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#F9FAFB' },
  eventTop:    { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  eventType:   { flex: 1, fontSize: 13, fontWeight: '600', color: '#111827' },
  eventMeta:   { fontSize: 12, color: '#6B7280' },
  eventDate:   { fontSize: 11, color: '#9CA3AF', marginTop: 1 },
  eventActions:{ flexDirection: 'row', marginTop: 8, gap: 8 },
  confirmBtn:  { flex: 1, paddingVertical: 7, borderRadius: 6, backgroundColor: '#DCFCE7', alignItems: 'center', borderWidth: 1, borderColor: '#10B981' },
  confirmBtnText:{ fontSize: 13, color: '#065F46', fontWeight: '600' },
  dimissBtn:   { flex: 1, paddingVertical: 7, borderRadius: 6, backgroundColor: '#F3F4F6', alignItems: 'center' },
  dimissBtnText: { fontSize: 13, color: '#374151', fontWeight: '600' },

  badge:     { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, borderWidth: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },

  modalContainer: { flex: 1, backgroundColor: '#fff' },
  modalHeader:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' },
  modalTitle:     { fontSize: 18, fontWeight: '700', color: '#111827' },
  modalClose:     { fontSize: 15, color: '#3B82F6' },

  fieldLabel:  { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 6 },
  typeChip:    { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#E5E7EB', marginBottom: 6 },
  typeChipActive:    { borderColor: '#3B82F6', backgroundColor: '#EFF6FF' },
  typeChipText:      { fontSize: 14, color: '#374151' },
  typeChipTextActive:{ color: '#3B82F6', fontWeight: '600' },
  textArea:    { borderWidth: 1, borderColor: '#E5E7EB', borderRadius: 8, padding: 10, height: 100, fontSize: 14, color: '#111827', textAlignVertical: 'top' },
  applyBtn:         { backgroundColor: '#EF4444', paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  applyBtnDisabled: { backgroundColor: '#FCA5A5' },
  applyBtnText:     { color: '#fff', fontSize: 15, fontWeight: '700' },
});
