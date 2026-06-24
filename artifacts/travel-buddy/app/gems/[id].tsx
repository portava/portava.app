/**
 * Gem detail screen
 * Route: /gems/[id]
 *
 * Shows full gem info, GPS check-in, save/unsave, share to Telegraph,
 * add to trip plan, and report.
 */
import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, Modal, TextInput, FlatList,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { useGemDetail, useGemCheckin, useGemReport } from '../../src/hooks/useHiddenGems';
import { verificationBadge, sensitivityLabel, addGemToPlan, shareGemToTelegraph } from '../../src/services/hiddenGems';

// ── Privacy section ────────────────────────────────────────────────────────────

function PrivacySection({ gem }: { gem: any }) {
  const isHidden  = gem.coordsPrecision === 'hidden';
  const isApprox  = gem.coordsPrecision === 'approximate';

  if (gem.sensitivityLevel === 'public' && gem.coordsPrecision === 'exact') return null;

  const icon   = isHidden ? 'eye-off-outline' : 'navigate-circle-outline';
  const color  = isHidden ? '#FF6B6B' : '#FF8F00';
  const label  = sensitivityLabel(gem.sensitivityLevel);
  const detail = isHidden
    ? 'Exact location is protected. Save or join the trip to reveal it.'
    : isApprox
    ? 'Showing approximate neighbourhood location only.'
    : null;

  return (
    <View style={[styles.privacyBox, { borderColor: color + '44' }]}>
      <Ionicons name={icon as any} size={18} color={color} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.privacyLabel, { color }]}>{label}</Text>
        {detail && <Text style={styles.privacyDetail}>{detail}</Text>}
      </View>
    </View>
  );
}

// ── GPS Check-in modal ─────────────────────────────────────────────────────────

function CheckinModal({
  visible,
  gemId,
  tripId,
  onClose,
  onSuccess,
}: {
  visible: boolean;
  gemId: string;
  tripId?: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { checkin, loading, result } = useGemCheckin();

  const handleCheckin = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Location required', 'Please allow location access to verify your visit.');
      return;
    }
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    await checkin(gemId, loc.coords.latitude, loc.coords.longitude, tripId);
  }, [gemId, tripId, checkin]);

  const done = result != null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.modal}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Verify Your Visit</Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color="#E8F0FE" />
          </TouchableOpacity>
        </View>

        {!done ? (
          <>
            <Ionicons name="location-outline" size={56} color="#4C8BF5" style={styles.modalIcon} />
            <Text style={styles.modalDesc}>
              Stand within 200 m of this gem and tap to verify your visit. GPS verification
              earns community trust points and can upgrade the gem's verification level.
            </Text>
            <TouchableOpacity
              style={[styles.primaryBtn, loading && styles.btnDisabled]}
              onPress={handleCheckin}
              disabled={loading}
            >
              {loading
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.primaryBtnText}>Check In</Text>}
            </TouchableOpacity>
          </>
        ) : (
          <>
            {result!.withinRange && !result!.isSuspicious ? (
              <>
                <Ionicons name="checkmark-circle" size={56} color="#4CAF7D" style={styles.modalIcon} />
                <Text style={styles.modalSuccessTitle}>Visit Verified!</Text>
                <Text style={styles.modalDesc}>
                  You were {result!.distanceM != null ? `${result!.distanceM} m` : 'nearby'}.
                  {result!.verificationUpgraded ? ' This gem has been upgraded to Community Verified! 🎉' : ''}
                </Text>
              </>
            ) : (
              <>
                <Ionicons name="warning-outline" size={56} color="#FF8F00" style={styles.modalIcon} />
                <Text style={[styles.modalSuccessTitle, { color: '#FF8F00' }]}>
                  {result!.error === 'too_far' ? 'Too Far Away' : 'Check-in Flagged'}
                </Text>
                <Text style={styles.modalDesc}>
                  {result!.error === 'too_far'
                    ? `You need to be within 200 m. You were ${result!.distanceM != null ? `${result!.distanceM} m` : 'too far'}.`
                    : 'Your location data was flagged for review. Manual verification may be needed.'}
                </Text>
              </>
            )}
            <TouchableOpacity style={styles.primaryBtn} onPress={() => { onSuccess(); onClose(); }}>
              <Text style={styles.primaryBtnText}>Done</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </Modal>
  );
}

// ── Report modal ───────────────────────────────────────────────────────────────

const REPORT_REASONS = [
  { key: 'inaccurate', label: 'Inaccurate information' },
  { key: 'unsafe',     label: 'Safety concern' },
  { key: 'outdated',   label: 'Place no longer exists' },
  { key: 'duplicate',  label: 'Duplicate listing' },
  { key: 'spam',       label: 'Spam or fake' },
  { key: 'offensive',  label: 'Offensive content' },
  { key: 'other',      label: 'Other' },
];

function ReportModal({ visible, gemId, onClose }: { visible: boolean; gemId: string; onClose: () => void }) {
  const { report, loading, done } = useGemReport();
  const [reason, setReason]       = useState('');
  const [notes, setNotes]         = useState('');

  if (done) {
    return (
      <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modal}>
          <Ionicons name="checkmark-circle" size={56} color="#4CAF7D" style={styles.modalIcon} />
          <Text style={styles.modalSuccessTitle}>Report Submitted</Text>
          <Text style={styles.modalDesc}>Thank you. Our team will review this gem.</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={onClose}>
            <Text style={styles.primaryBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.modal}>
        <View style={styles.modalHeader}>
          <Text style={styles.modalTitle}>Report this Gem</Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color="#E8F0FE" />
          </TouchableOpacity>
        </View>

        {REPORT_REASONS.map((r) => (
          <TouchableOpacity
            key={r.key}
            style={[styles.reasonRow, reason === r.key && styles.reasonRowActive]}
            onPress={() => setReason(r.key)}
          >
            <View style={[styles.radio, reason === r.key && styles.radioActive]} />
            <Text style={styles.reasonText}>{r.label}</Text>
          </TouchableOpacity>
        ))}

        <TextInput
          style={styles.notesInput}
          value={notes}
          onChangeText={setNotes}
          placeholder="Additional notes (optional)"
          placeholderTextColor="#8A9BB5"
          multiline
          maxLength={500}
        />

        <TouchableOpacity
          style={[styles.primaryBtn, (!reason || loading) && styles.btnDisabled]}
          onPress={() => reason && report(gemId, reason, notes || undefined)}
          disabled={!reason || loading}
        >
          {loading
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.primaryBtnText}>Submit Report</Text>}
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function GemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router  = useRouter();

  const { gem, savedByMe, guideProfile, loading, error, refresh, toggleSave } = useGemDetail(id!);

  const [showCheckin, setShowCheckin] = useState(false);
  const [showReport,  setShowReport]  = useState(false);
  const [addingPlan,  setAddingPlan]  = useState(false);
  const [sharing,     setSharing]     = useState(false);

  const handleAddToPlan = useCallback(async () => {
    Alert.prompt(
      'Add to Trip Plan',
      'Enter your Trip ID:',
      async (tripId) => {
        if (!tripId || !gem) return;
        setAddingPlan(true);
        try {
          await addGemToPlan(gem.id, tripId);
          Alert.alert('Added!', 'Gem added to your trip plan.');
        } catch (e: any) {
          Alert.alert('Error', e.message ?? 'Failed to add to plan');
        } finally {
          setAddingPlan(false);
        }
      },
      'plain-text',
    );
  }, [gem]);

  const handleShare = useCallback(async () => {
    if (!gem) return;
    Alert.prompt(
      'Share to Telegraph',
      'Enter the Thread ID to share this gem into:',
      async (threadId) => {
        if (!threadId) return;
        setSharing(true);
        try {
          await shareGemToTelegraph(gem.id, threadId);
          Alert.alert('Shared!', `${gem.name} shared to your Telegraph thread.`);
        } catch (e: any) {
          Alert.alert('Error', e.message ?? 'Failed to share');
        } finally {
          setSharing(false);
        }
      },
      'plain-text',
    );
  }, [gem]);

  if (loading) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#4C8BF5" />
        </View>
      </SafeAreaView>
    );
  }

  if (error || !gem) {
    return (
      <SafeAreaView style={styles.root} edges={['top']}>
        <View style={styles.loadingContainer}>
          <Ionicons name="alert-circle-outline" size={48} color="#FF6B6B" />
          <Text style={styles.errorText}>{error ?? 'Gem not found'}</Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtnFull}>
            <Text style={styles.backBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView>
        {/* Header */}
        <View style={styles.detailHeader}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color="#E8F0FE" />
          </TouchableOpacity>
          <TouchableOpacity onPress={toggleSave} style={styles.saveBtn}>
            <Ionicons
              name={savedByMe ? 'bookmark' : 'bookmark-outline'}
              size={22}
              color={savedByMe ? '#4C8BF5' : '#8A9BB5'}
            />
          </TouchableOpacity>
        </View>

        {/* Name + meta */}
        <View style={styles.section}>
          <View style={styles.categoryPill}>
            <Text style={styles.categoryPillText}>{gem.category}</Text>
          </View>
          <Text style={styles.detailName}>{gem.name}</Text>

          <View style={styles.locationRow}>
            <Ionicons name="location-outline" size={16} color="#8A9BB5" />
            <Text style={styles.locationText}>
              {[gem.neighborhood, gem.city, gem.country].filter(Boolean).join(', ')}
            </Text>
          </View>

          {/* Privacy notice */}
          <PrivacySection gem={gem} />

          {/* Verification badge */}
          <View style={styles.verificationRow}>
            <Ionicons name="shield-checkmark-outline" size={16} color="#4CAF7D" />
            <Text style={styles.verificationText}>{verificationBadge(gem.verificationLevel)}</Text>
          </View>
        </View>

        {/* Description */}
        {gem.description && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>About</Text>
            <Text style={styles.bodyText}>{gem.description}</Text>
          </View>
        )}

        {/* Quick facts */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Facts</Text>
          <View style={styles.factsGrid}>
            {gem.priceRange && (
              <View style={styles.fact}>
                <Ionicons name="cash-outline" size={18} color="#4C8BF5" />
                <Text style={styles.factLabel}>Price</Text>
                <Text style={styles.factValue}>{gem.priceRange}</Text>
              </View>
            )}
            {gem.bestTimeToGo && (
              <View style={styles.fact}>
                <Ionicons name="time-outline" size={18} color="#4C8BF5" />
                <Text style={styles.factLabel}>Best Time</Text>
                <Text style={styles.factValue}>{gem.bestTimeToGo}</Text>
              </View>
            )}
            {gem.layoverSafe && gem.minimumLayoverMinutes && (
              <View style={styles.fact}>
                <Ionicons name="airplane-outline" size={18} color="#4CAF7D" />
                <Text style={styles.factLabel}>Layover</Text>
                <Text style={styles.factValue}>{gem.minimumLayoverMinutes} min+</Text>
              </View>
            )}
            <View style={styles.fact}>
              <Ionicons name="bookmark-outline" size={18} color="#4C8BF5" />
              <Text style={styles.factLabel}>Saved</Text>
              <Text style={styles.factValue}>{gem.saveCount}</Text>
            </View>
          </View>
        </View>

        {/* Safety notes */}
        {gem.safetyNotes && (
          <View style={[styles.section, styles.safetyBox]}>
            <View style={styles.safetyHeader}>
              <Ionicons name="warning-outline" size={18} color="#FF8F00" />
              <Text style={styles.safetyTitle}>Safety Notes</Text>
            </View>
            <Text style={styles.bodyText}>{gem.safetyNotes}</Text>
          </View>
        )}

        {/* Local etiquette */}
        {gem.localEtiquette && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Local Etiquette</Text>
            <Text style={styles.bodyText}>{gem.localEtiquette}</Text>
          </View>
        )}

        {/* Vibe tags */}
        {gem.vibeTags.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Vibes</Text>
            <View style={styles.tagsWrap}>
              {gem.vibeTags.map((t) => (
                <View key={t} style={styles.vibeTag}>
                  <Text style={styles.vibeTagText}>#{t}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Guide profile */}
        {guideProfile && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Verified by Local Guide</Text>
            <View style={styles.guideCard}>
              <View style={styles.guideLevelBadge}>
                <Text style={styles.guideLevelText}>Lv {guideProfile.guideLevel}</Text>
              </View>
              <View style={{ flex: 1 }}>
                {guideProfile.bio && <Text style={styles.guideBio}>{guideProfile.bio}</Text>}
                <Text style={styles.guideStats}>
                  {guideProfile.contributionCount} contributions · {guideProfile.cityExpertise.join(', ')}
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* Action bar */}
        <View style={styles.actionBar}>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setShowCheckin(true)}>
            <Ionicons name="location" size={20} color="#4C8BF5" />
            <Text style={styles.actionBtnText}>Check In</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={handleAddToPlan} disabled={addingPlan}>
            <Ionicons name="calendar-outline" size={20} color="#4CAF7D" />
            <Text style={[styles.actionBtnText, { color: '#4CAF7D' }]}>Add to Plan</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={handleShare} disabled={sharing}>
            <Ionicons name="paper-plane-outline" size={20} color="#A78BFA" />
            <Text style={[styles.actionBtnText, { color: '#A78BFA' }]}>Share</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setShowReport(true)}>
            <Ionicons name="flag-outline" size={20} color="#FF6B6B" />
            <Text style={[styles.actionBtnText, { color: '#FF6B6B' }]}>Report</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Modals */}
      <CheckinModal
        visible={showCheckin}
        gemId={gem.id}
        onClose={() => setShowCheckin(false)}
        onSuccess={refresh}
      />
      <ReportModal
        visible={showReport}
        gemId={gem.id}
        onClose={() => setShowReport(false)}
      />
    </SafeAreaView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0A1628' },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  errorText: { color: '#FF6B6B', fontSize: 16, textAlign: 'center' },
  backBtnFull: { backgroundColor: '#1E2D45', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 8 },
  backBtnText: { color: '#4C8BF5', fontWeight: '600' },

  detailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: { padding: 4 },
  saveBtn: { padding: 4 },

  section: { paddingHorizontal: 20, paddingBottom: 20 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#E8F0FE', marginBottom: 10 },

  categoryPill: {
    alignSelf: 'flex-start',
    backgroundColor: '#1E2D45',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 8,
  },
  categoryPillText: { color: '#8A9BB5', fontSize: 12, textTransform: 'uppercase', fontWeight: '700' },

  detailName: { fontSize: 26, fontWeight: '800', color: '#E8F0FE', marginBottom: 8 },

  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  locationText: { color: '#8A9BB5', fontSize: 14 },

  privacyBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  privacyLabel: { fontWeight: '700', fontSize: 13, marginBottom: 2 },
  privacyDetail: { color: '#8A9BB5', fontSize: 12, lineHeight: 18 },

  verificationRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  verificationText: { color: '#4CAF7D', fontWeight: '600', fontSize: 13 },

  bodyText: { color: '#B0C4DE', fontSize: 15, lineHeight: 22 },

  factsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  fact: {
    backgroundColor: '#13213A',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
    minWidth: 80,
    gap: 4,
    borderWidth: 1,
    borderColor: '#1E2D45',
  },
  factLabel: { color: '#8A9BB5', fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  factValue: { color: '#E8F0FE', fontSize: 13, fontWeight: '700', textAlign: 'center' },

  safetyBox: {
    borderLeftWidth: 3,
    borderLeftColor: '#FF8F00',
    paddingLeft: 16,
    marginHorizontal: 20,
  },
  safetyHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  safetyTitle: { color: '#FF8F00', fontWeight: '700', fontSize: 15 },

  tagsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  vibeTag: { backgroundColor: '#1E2D45', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 5 },
  vibeTagText: { color: '#8A9BB5', fontSize: 13 },

  guideCard: {
    backgroundColor: '#13213A',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1,
    borderColor: '#1E2D45',
  },
  guideLevelBadge: {
    backgroundColor: '#4C8BF5',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  guideLevelText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  guideBio: { color: '#B0C4DE', fontSize: 14, marginBottom: 4 },
  guideStats: { color: '#8A9BB5', fontSize: 12 },

  actionBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#1E2D45',
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginTop: 8,
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#13213A',
    borderRadius: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#1E2D45',
    gap: 4,
  },
  actionBtnText: { color: '#4C8BF5', fontWeight: '600', fontSize: 12 },

  modal: {
    flex: 1,
    backgroundColor: '#0A1628',
    padding: 24,
    paddingTop: 48,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#E8F0FE' },
  modalIcon: { alignSelf: 'center', marginBottom: 16 },
  modalDesc: { color: '#B0C4DE', fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 24 },
  modalSuccessTitle: { fontSize: 22, fontWeight: '800', color: '#4CAF7D', textAlign: 'center', marginBottom: 8 },

  primaryBtn: {
    backgroundColor: '#4C8BF5',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  btnDisabled: { opacity: 0.5 },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },

  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1E2D45',
    gap: 12,
  },
  reasonRowActive: { borderBottomColor: '#4C8BF5' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#8A9BB5' },
  radioActive: { borderColor: '#4C8BF5', backgroundColor: '#4C8BF5' },
  reasonText: { color: '#E8F0FE', fontSize: 15 },

  notesInput: {
    backgroundColor: '#13213A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1E2D45',
    padding: 12,
    color: '#E8F0FE',
    fontSize: 15,
    minHeight: 80,
    marginTop: 12,
    marginBottom: 16,
  },
});
