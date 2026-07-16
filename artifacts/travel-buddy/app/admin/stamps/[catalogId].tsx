/**
 * Admin — Stamp Studio detail page.
 * Shows metadata, candidate artwork side-by-side, approve/reject controls,
 * regenerate, earn history, and audit log.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, CheckCircle, XCircle, RefreshCw } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRequireAdmin } from '../../../src/hooks/useRequireAdmin';
import { color, space, radius, type as t } from '../../../src/theme/tokens';
import {
  getAdminCatalogEntry,
  activateStampVersion,
  rejectCatalogEntry,
  regenerateCatalogEntry,
  type CatalogDetail,
  type ArtworkVersion,
} from '../../../src/services/adminStamps';

export default function StampCatalogDetail() {
  const insets = useSafeAreaInsets();
  useRequireAdmin();

  const { catalogId } = useLocalSearchParams<{ catalogId: string }>();
  const [detail, setDetail]         = useState<CatalogDetail | null>(null);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing]         = useState(false);

  const load = useCallback(async () => {
    if (!catalogId) return;
    const res = await getAdminCatalogEntry(catalogId);
    if (res.ok) setDetail(res.data);
    setLoading(false);
    setRefreshing(false);
  }, [catalogId]);

  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const handleActivate = useCallback(async (versionId: string) => {
    setActing(true);
    const res = await activateStampVersion(catalogId!, versionId, 'Approved via admin studio');
    setActing(false);
    if (res.ok) {
      Alert.alert('Approved', 'This artwork version is now active for all users.');
      load();
    } else {
      Alert.alert('Error', (res as any).error ?? 'Failed to activate version');
    }
  }, [catalogId, load]);

  const handleReject = useCallback(() => {
    Alert.prompt('Reject Entry', 'Enter reason for rejection:', async (reason) => {
      if (!reason) return;
      setActing(true);
      const res = await rejectCatalogEntry(catalogId!, reason);
      setActing(false);
      if (res.ok) { Alert.alert('Rejected', 'Catalog entry marked as rejected.'); load(); }
      else Alert.alert('Error', (res as any).error ?? 'Failed to reject');
    });
  }, [catalogId, load]);

  const handleRegenerate = useCallback(() => {
    Alert.alert('Regenerate Artwork', 'This will archive existing candidates and queue new AI generation. Continue?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Regenerate', style: 'destructive', onPress: async () => {
          setActing(true);
          const res = await regenerateCatalogEntry(catalogId!);
          setActing(false);
          if (res.ok) { Alert.alert('Queued', 'New artwork generation has been queued.'); load(); }
          else Alert.alert('Error', (res as any).error ?? 'Failed to regenerate');
        },
      },
    ]);
  }, [catalogId, load]);

  if (loading) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={color.ink} />
      </View>
    );
  }

  if (!detail) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={{ color: color.mute }}>Entry not found</Text>
      </View>
    );
  }

  const { entry, versions, queue, audit, earnSample } = detail;
  const candidates = versions.filter((v) => v.status === 'candidate');
  const approved   = versions.find((v) => v.status === 'approved');

  // Degraded generation: worker records a shortfall on the queue row when
  // fewer candidates than expected were produced; candidate metadata carries
  // the same counts as a fallback.
  const meta = (candidates[0] as any)?.generation_metadata ?? {};
  const shortfallFromMeta =
    typeof meta.candidates_expected === 'number' &&
    typeof meta.candidates_produced === 'number' &&
    meta.candidates_produced < meta.candidates_expected
      ? `Only ${meta.candidates_produced} of ${meta.candidates_expected} candidates were generated.`
      : null;
  const shortfallFromQueue =
    typeof queue?.last_error === 'string' && queue.last_error.startsWith('candidate_shortfall')
      ? queue.last_error.replace(/^candidate_shortfall:\s*/, '')
      : null;
  const shortfall = shortfallFromMeta ?? shortfallFromQueue;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{entry.display_name}</Text>
        <View style={[styles.badge, { backgroundColor: statusBg(entry.status) }]}>
          <Text style={styles.badgeText}>{entry.status}</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xl }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Metadata */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Catalog Metadata</Text>
          <InfoRow label="Stamp Type"    value={entry.stamp_type} />
          <InfoRow label="Country"       value={`${entry.country} (${entry.country_code})`} />
          <InfoRow label="City"          value={entry.city ?? '—'} />
          <InfoRow label="Canonical Key" value={entry.canonical_location_key} mono />
          <InfoRow label="Earn Count"    value={String(entry.earn_count)} />
          <InfoRow label="Queue Status"  value={queue?.status ?? 'no job'} />
        </View>

        {/* Actions */}
        <View style={styles.actionRow}>
          <Pressable style={[styles.actionBtn, styles.actionRegenerate]} onPress={handleRegenerate} disabled={acting}>
            <RefreshCw size={15} color={color.onInk} strokeWidth={2.5} />
            <Text style={styles.actionBtnText}>Regenerate</Text>
          </Pressable>
          <Pressable style={[styles.actionBtn, styles.actionReject]} onPress={handleReject} disabled={acting}>
            <XCircle size={15} color={color.onInk} strokeWidth={2.5} />
            <Text style={styles.actionBtnText}>Reject Entry</Text>
          </Pressable>
        </View>

        {/* Active artwork */}
        {approved && approved.public_url ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Active Artwork</Text>
            <Image source={{ uri: approved.public_url }} style={styles.artworkLarge} resizeMode="contain" />
            <Text style={styles.artworkMeta}>Provider: {approved.provider ?? 'admin_upload'}</Text>
          </View>
        ) : null}

        {/* Candidates */}
        {candidates.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Candidate Artworks ({candidates.length})</Text>
            {shortfall ? (
              <View style={styles.shortfallBanner}>
                <Text style={styles.shortfallText}>⚠️ Degraded generation: {shortfall} Consider regenerating for a full set.</Text>
              </View>
            ) : null}
            <Text style={styles.hint}>Tap "Set as Active" to approve and publish to all users.</Text>
            <View style={styles.candidatesRow}>
              {candidates.map((v) => (
                <CandidateCard key={v.id} version={v} onActivate={() => handleActivate(v.id)} disabled={acting} />
              ))}
            </View>
          </View>
        ) : !approved ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Artwork</Text>
            <Text style={styles.hint}>
              {queue?.status === 'queued' || queue?.status === 'generating'
                ? '⏳ AI artwork generation is in progress…'
                : 'No candidates yet. Tap Regenerate to queue AI artwork generation.'}
            </Text>
          </View>
        ) : null}

        {/* Earn history */}
        {earnSample.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Recent Earners</Text>
            {earnSample.map((r: any) => (
              <Text key={r.id} style={styles.earnRow}>
                {r.user_id?.slice(0, 8)}… — {r.source_type} — {new Date(r.earned_at).toLocaleDateString()}
              </Text>
            ))}
          </View>
        ) : null}

        {/* Audit log */}
        {audit.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Audit Log</Text>
            {audit.map((a: any) => (
              <View key={a.id} style={styles.auditRow}>
                <Text style={styles.auditAction}>{a.action}</Text>
                <Text style={styles.auditNotes} numberOfLines={2}>{a.notes ?? ''}</Text>
                <Text style={styles.auditDate}>{new Date(a.created_at).toLocaleString()}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function CandidateCard({ version, onActivate, disabled }: {
  version: ArtworkVersion;
  onActivate: () => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.candidateCard}>
      {version.public_url ? (
        <Image source={{ uri: version.public_url }} style={styles.candidateImg} resizeMode="contain" />
      ) : (
        <View style={[styles.candidateImg, { backgroundColor: color.haze, justifyContent: 'center', alignItems: 'center' }]}>
          <Text style={{ color: color.mute, fontSize: 10 }}>No image</Text>
        </View>
      )}
      <Text style={styles.candidateMeta}>{version.provider ?? 'ai'}</Text>
      <Pressable
        style={[styles.activateBtn, disabled && styles.activateBtnDisabled]}
        onPress={onActivate}
        disabled={disabled}
      >
        <CheckCircle size={13} color={color.onInk} strokeWidth={2.5} />
        <Text style={styles.activateBtnText}>Set as Active</Text>
      </Pressable>
    </View>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono && styles.infoMono]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

function statusBg(s: string) {
  switch (s) {
    case 'approved':        return '#D1FAE5';
    case 'pending_artwork': return '#FEF3C7';
    case 'rejected':        return '#FEE2E2';
    default:                return '#F3F4F6';
  }
}

const styles = StyleSheet.create({
  root:              { flex: 1, backgroundColor: color.paper },
  center:            { justifyContent: 'center', alignItems: 'center' },
  header:            { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze, gap: space.sm },
  backBtn:           { marginRight: space.xs },
  title:             { ...t.heading, color: color.ink, flex: 1 },
  badge:             { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  badgeText:         { fontSize: 10, fontWeight: '700', color: '#374151' },
  content:           { padding: space.md, gap: space.md },
  card:              { backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: color.haze },
  sectionTitle:      { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: space.sm },
  infoRow:           { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, gap: space.sm },
  infoLabel:         { ...t.small, color: color.mute, flexShrink: 0 },
  infoValue:         { ...t.small, color: color.ink, fontWeight: '600', flex: 1, textAlign: 'right' },
  infoMono:          { fontFamily: 'Courier', fontSize: 10 },
  actionRow:         { flexDirection: 'row', gap: space.sm },
  actionBtn:         { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: radius.md },
  actionRegenerate:  { backgroundColor: '#6B7280' },
  actionReject:      { backgroundColor: '#EF4444' },
  actionBtnText:     { color: color.onInk, fontSize: 13, fontWeight: '700' },
  artworkLarge:      { width: '100%', height: 200, borderRadius: radius.sm, marginBottom: space.xs },
  artworkMeta:       { ...t.small, color: color.mute },
  hint:              { ...t.small, color: color.mute, marginBottom: space.sm },
  shortfallBanner:   { backgroundColor: '#FEF3C7', borderRadius: radius.sm, padding: space.sm, marginBottom: space.sm, borderWidth: 1, borderColor: '#FDE68A' },
  shortfallText:     { ...t.small, color: '#92400E', fontWeight: '600' },
  candidatesRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  candidateCard:     { width: '30%', alignItems: 'center', gap: 4 },
  candidateImg:      { width: '100%', aspectRatio: 1, borderRadius: radius.sm, backgroundColor: '#F9FAFB' },
  candidateMeta:     { fontSize: 9, color: color.faint },
  activateBtn:       { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.success, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.pill },
  activateBtnDisabled: { opacity: 0.5 },
  activateBtnText:   { color: color.onInk, fontSize: 10, fontWeight: '700' },
  earnRow:           { ...t.small, color: color.mute, paddingVertical: 2 },
  auditRow:          { paddingVertical: space.xs, borderBottomWidth: 1, borderBottomColor: color.haze },
  auditAction:       { ...t.small, color: color.ink, fontWeight: '700', textTransform: 'uppercase' },
  auditNotes:        { ...t.small, color: color.mute },
  auditDate:         { fontSize: 10, color: color.faint },
});
