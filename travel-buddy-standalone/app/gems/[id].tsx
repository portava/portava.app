/**
 * Gem detail screen
 * Route: /gems/[id]
 *
 * Shows full gem info, GPS check-in, save/unsave, share to Telegraph,
 * add to trip plan, and report.
 */
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { RouteBuilderSheet } from '../../src/components/RouteBuilderSheet';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Pressable,
  ActivityIndicator, Alert, Modal, TextInput, FlatList, Image,
} from 'react-native';
import { CachedImage } from '../../src/components/CachedImage';
import { resolveHeaderImage } from '../../src/lib/visuals/resolveHeaderImage';
import { fallbackUriFor } from '../../src/lib/visuals/fallbackAssets';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getCurrentGps } from '../../src/services/location';
import { useGemDetail, useGemCheckin, useGemReport } from '../../src/hooks/useHiddenGems';
import { verificationBadge, sensitivityLabel, shareGemToTelegraph, type GemState, type GemConfidence } from '../../src/services/hiddenGems';
import { GemStateBadge } from '../../src/components/gems/GemStateBadge';
import { GemContributeSection } from '../../src/components/gems/GemContributeSection';
import { TripWishlistPicker, type AddToTripPayload } from '../../src/components/discovery/TripWishlistPicker';
import { ReviewsSection } from '../../src/components/ReviewsSection';
import { WorthItVoteRow } from '../../src/components/WorthItVoteRow';
import { PlaceInfoSection } from '../../src/components/place/PlaceInfoSection';
import { getCanonicalPlace } from '../../src/services/places';
import type { CanonicalPlace } from '../../src/types/canonicalPlace';
import { GemMapPreview } from '../../src/components/discovery/GemMapPreview';
import { useSession } from '../../src/context/SessionContext';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { PlainBottomFiller } from '../../src/hooks/useBottomInset';
import { ReasonPromptModal } from '../../src/components/ReasonPromptModal';
import { StampButton } from '../../src/components/stamps/StampButton';
import * as Sentry from '@sentry/react-native';
import { icon } from '../../src/theme/tokens';

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
    const gps = await getCurrentGps();
    if (!gps.granted || gps.lat == null || gps.lng == null) {
      Alert.alert('Location required', 'Please allow location access to verify your visit.');
      return;
    }
    await checkin(gemId, gps.lat, gps.lng, tripId);
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
  const { isAuthed } = useSession();
  const navBarScrollHandler = useNavBarScrollHandler();

  const { gem, savedByMe, guideProfile, loading, error, refresh, toggleSave } = useGemDetail(id!);

  const [showCheckin,     setShowCheckin]     = useState(false);
  const [showReport,      setShowReport]      = useState(false);
  const [sharing,         setSharing]         = useState(false);
  const [builderVisible,  setBuilderVisible]  = useState(false);
  const [pickerVisible,   setPickerVisible]   = useState(false);
  const [canonicalPlace,  setCanonicalPlace]  = useState<CanonicalPlace | null>(null);

  // §16.3 — after a structured contribution the backend re-derives the gem's
  // (still community-derived, not flipped) state + confidence. Hold an optional
  // override so the visible status updates in place; falls back to the gem's own
  // projection. Degrades cleanly when the payload never carried a gemState.
  const [stateOverride, setStateOverride] = useState<{
    gemState: GemState | null;
    gemConfidence: GemConfidence | null;
  } | null>(null);
  const handleContributed = useCallback(
    (gemState: GemState | null, gemConfidence: GemConfidence | null) => {
      setStateOverride({ gemState, gemConfidence });
    },
    [],
  );

  // Fetch the canonical place (FSQ-enriched phone, hours, address) whenever the
  // gem carries a canonicalPlaceId.  Failures are silent — falls back to
  // user-entered description/category only.
  useEffect(() => {
    if (!gem?.canonicalPlaceId) {
      setCanonicalPlace(null);
      return;
    }
    let cancelled = false;
    getCanonicalPlace(gem.canonicalPlaceId).then((place) => {
      if (!cancelled) setCanonicalPlace(place);
    });
    return () => { cancelled = true; };
  }, [gem?.canonicalPlaceId]);

  const gemPickerPayload: AddToTripPayload | null = gem ? {
    id:       gem.id,
    name:     gem.name,
    category: gem.category ?? 'place',
    type:     'hidden_gem',
    address:  [gem.neighborhood, gem.city, gem.country].filter(Boolean).join(', ') || null,
    lat:      (gem as any).coordsPrecision === 'exact' ? (gem as any).lat : null,
    lng:      (gem as any).coordsPrecision === 'exact' ? (gem as any).lng : null,
  } : null;

  const handleAddToPlan = useCallback(() => {
    if (!gem) return;
    setPickerVisible(true);
  }, [gem]);

  // Cross-platform Thread-ID prompt (Alert.prompt is iOS-only — a silent
  // no-op on Android/web).
  const [showShare, setShowShare] = useState(false);

  const handleShare = useCallback(() => {
    if (!gem || sharing) return; // in-flight guard: don't reopen the prompt mid-request
    setShowShare(true);
  }, [gem, sharing]);

  const submitShare = useCallback(async (threadId: string) => {
    setShowShare(false);
    if (!gem || !threadId || sharing) return;
    setSharing(true);
    try {
      await shareGemToTelegraph(gem.id, threadId);
      Alert.alert('Shared!', `${gem.name} shared to your Telegraph thread.`);
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Failed to share');
    } finally {
      setSharing(false);
    }
  }, [gem]);

  // Log the raw technical error to Sentry once per occurrence, but never
  // render it — a raw DB/network message (e.g. a Postgres column error) is
  // not something a user should ever see. The UI always shows a friendly,
  // generic fail-soft message with a retry action instead.
  useEffect(() => {
    if (error) {
      Sentry.captureException(new Error(`GemDetailScreen load failed: ${error}`), {
        tags: { screen: 'gems/[id]' },
        extra: { gemId: id, rawError: error },
      });
    }
  }, [error, id]);

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
          <Text style={styles.errorText}>
            {error ? 'We could not load this place right now.' : 'Gem not found.'}
          </Text>
          {error ? (
            <TouchableOpacity onPress={refresh} style={styles.retryBtnFull}>
              <Text style={styles.retryBtnText}>Try Again</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtnFull}>
            <Text style={styles.backBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView onScroll={navBarScrollHandler} scrollEventThrottle={16}>
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

        {/* Cover photo — always shown; falls through to category fallback asset */}
        {(() => {
          const resolved = resolveHeaderImage(
            gem.imageUrl ? [{ url: gem.imageUrl, source: 'provider' }] : [],
            { entityType: 'hidden_gem', category: gem.category ?? undefined, fallbackUrlFor: fallbackUriFor },
          );
          if (!resolved?.url) return null;
          return gem.imageUrl ? (
            <Image source={{ uri: resolved.url }} style={styles.coverImage} resizeMode="cover" />
          ) : (
            <CachedImage source={{ uri: resolved.url }} style={styles.coverImage} resizeMode="cover" />
          );
        })()}

        {/* Name + meta */}
        <View style={styles.section}>
          <View style={styles.categoryPill}>
            <Text style={styles.categoryPillText}>{gem.category}</Text>
          </View>
          <Text style={styles.detailName}>{gem.name}</Text>

          {/* §16 / §46.1 — calm gem-state status + confidence + protective note.
              Prefers a fresh contribution-derived projection when present;
              renders nothing when the payload has no gemState (degrade). */}
          <GemStateBadge
            state={stateOverride ? stateOverride.gemState : gem.gemState}
            confidence={stateOverride ? stateOverride.gemConfidence : gem.gemConfidence}
            showConfidence
            showNote
            size="full"
            style={styles.gemStateBadge}
          />

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

        {/* Map preview — privacy-safe; shows placeholder for hidden/missing coords */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Location</Text>
          <GemMapPreview
            lat={gem.lat}
            lng={gem.lng}
            coordsPrecision={gem.coordsPrecision}
            locationLabel={[gem.neighborhood, gem.city, gem.country].filter(Boolean).join(', ') || null}
          />
        </View>

        {/* "See destination" — tappable link to the canonical Living Destination
            Page when this gem has been linked to a canonical place. */}
        {canonicalPlace ? (
          <Pressable
            style={styles.seeDestinationRow}
            onPress={() => router.push(`/place/${gem.canonicalPlaceId}` as any)}
            accessibilityRole="button"
            accessibilityLabel={`See ${canonicalPlace.name} destination page`}
          >
            <Ionicons name="location-sharp" size={15} color="#4C8BF5" />
            <Text style={styles.seeDestinationText}>
              {canonicalPlace.name} — See destination →
            </Text>
          </Pressable>
        ) : null}

        {/* About — canonical place (FSQ phone/hours/address) when available,
            falling back to user-entered description and category only. */}
        {(canonicalPlace || gem.description || gem.category) ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>About</Text>
            <PlaceInfoSection
              place={canonicalPlace}
              description={gem.description}
              category={gem.category}
            />
          </View>
        ) : null}

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

        {/* §16.3 — structured contributions (observations). Additive to the
            existing verify-visit + report UI below. */}
        <GemContributeSection
          gemId={gem.id}
          isAuthed={isAuthed}
          onContributed={handleContributed}
        />

        {/* Worth-It / Skip-It voting */}
        <View style={[styles.section, { backgroundColor: '#13213A', borderRadius: 16, marginHorizontal: 16, marginBottom: 12, padding: 16 }]}>
          <WorthItVoteRow entityId={gem.id} entityType="gem" />
        </View>

        {/* Reviews */}
        <View style={[styles.section, { backgroundColor: '#fff', borderRadius: 16, marginHorizontal: 16, marginBottom: 20, padding: 16 }]}>
          <ReviewsSection
            entityType="place"
            entityId={gem.id}
            entityName={gem.name}
            canReview={isAuthed}
          />
        </View>

        {/* Action bar */}
        <View style={styles.actionBar}>
          {gem?.id ? (
            <View style={styles.actionBtn}>
              <StampButton
                entityType="gem"
                entityId={gem.id}
                initialCount={0}
                initialIsStamped={false}
                iconSize={20}
              />
            </View>
          ) : null}
          <TouchableOpacity style={styles.actionBtn} onPress={() => setShowCheckin(true)}>
            <Ionicons name="location" size={20} color="#4C8BF5" />
            <Text style={styles.actionBtnText}>Check In</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={handleAddToPlan}>
            <Ionicons name="calendar-outline" size={20} color="#4CAF7D" />
            <Text style={[styles.actionBtnText, { color: '#4CAF7D' }]}>Add to Plan</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setBuilderVisible(true)}>
            <Ionicons name="navigate-outline" size={20} color="#60A5FA" />
            <Text style={[styles.actionBtnText, { color: '#60A5FA' }]}>Add to Route</Text>
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
        <PlainBottomFiller />
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
      <ReasonPromptModal
        visible={showShare}
        title="Share to Telegraph"
        message="Enter the Thread ID to share this gem into:"
        placeholder="Thread ID"
        confirmLabel="Share"
        onCancel={() => setShowShare(false)}
        onSubmit={submitShare}
      />

      {/* Route builder — pre-seeds this gem as the first stop */}
      <RouteBuilderSheet
        visible={builderVisible}
        onClose={() => setBuilderVisible(false)}
        onRouteCreated={() => setBuilderVisible(false)}
        initialStops={gem ? [{
          id:         gem.id,
          title:      gem.name,
          lat:        (gem as any).lat ?? null,
          lng:        (gem as any).lng ?? null,
          sourceType: 'hidden_gem',
          sourceId:   gem.id,
          category:   (gem as any).category ?? undefined,
        }] : undefined}
      />
      <TripWishlistPicker
        place={gemPickerPayload}
        visible={pickerVisible && !!gem}
        onClose={() => setPickerVisible(false)}
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
  retryBtnFull: { backgroundColor: '#4C8BF5', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 8 },
  retryBtnText: { color: '#fff', fontWeight: '700' },

  detailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: { padding: 4 },
  saveBtn: { padding: 4 },
  coverImage: { width: '100%', height: 220 },

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
  gemStateBadge: { marginBottom: 12 },

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

  seeDestinationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: '#13213A',
    borderRadius: 12,
    marginHorizontal: 20,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1E2D45',
  },
  seeDestinationText: { color: '#4C8BF5', fontSize: 14, fontWeight: '600' },

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
  radio: { width: icon.s18, height: icon.s18, borderRadius: icon.s18 / 2, borderWidth: 2, borderColor: '#8A9BB5' },
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
