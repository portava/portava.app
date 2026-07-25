/**
 * Stamp deep-link screen — /stamp/:stampId
 *
 * Opened when tapping a stamp-earned push notification or tapping "View" on
 * the StampEarnedToast. Fetches the stamp by ID and renders full details
 * with owner controls. The back button returns to the previous screen
 * (typically /(tabs)/passport).
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, Pressable, StyleSheet, ScrollView, Switch, ActivityIndicator,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Share2, Link } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { StampArtwork } from '../../src/components/StampArtwork';
import { StampShareCard } from '../../src/components/StampShareCard';
import { useStampShare } from '../../src/hooks/useStampShare';
import {
  getStampById,
  updateStampVisibility,
  toggleDisplayOnPassport,
} from '../../src/services/stamps';
import type { PassportStampNew, NewStampVisibility } from '../../src/services/stamps';
import { stampToLegacy, makeStampShareLinks } from '../../src/services/stampShareUtils';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';
import { StampAdmireBlock } from '../../src/components/stamps/StampAdmireBlock';
import { useFeatureFlags } from '../../src/context/FeatureFlagsContext';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { NavBarFiller } from '../../src/hooks/useNavBarCollapse';

const RARITY_COLORS: Record<string, string> = {
  common:    '#6B7280',
  uncommon:  '#16A34A',
  rare:      '#2563EB',
  epic:      '#7C3AED',
  legendary: '#D97706',
};

const SOURCE_LABELS: Record<string, string> = {
  trip:        'Completed a trip',
  plan:        'Joined a travel plan',
  host:        'Hosted an experience',
  safe_return: 'Completed a verified safe meetup',
  hidden_gem:  'Discovered a hidden gem',
  check_in:    'GPS-verified check-in',
  system:      'Awarded by Travel Buddy',
  manual:      'Manually awarded',
  event:       'Attended an event',
  rent_buddy:  'Rent a Buddy activity',
};

const VISIBILITY_OPTIONS: { value: NewStampVisibility; label: string }[] = [
  { value: 'public',       label: 'Public' },
  { value: 'friends_only', label: 'Friends only' },
  { value: 'private',      label: 'Private' },
];

function StampDetailContent({
  stamp,
  isOwner,
  onStampUpdated,
}: {
  stamp: PassportStampNew;
  isOwner: boolean;
  onStampUpdated: (updated: PassportStampNew) => void;
}) {
  const [visUpdating, setVisUpdating] = useState(false);
  const [displayUpdating, setDisplayUpdating] = useState(false);
  const [copied, setCopied] = useState(false);
  const navBarScrollHandler = useNavBarScrollHandler();
  const { cardRef, share, sharing } = useStampShare(stamp, null);
  const { isEnabled: isFlagEnabled } = useFeatureFlags();

  const legacy = stampToLegacy(stamp);
  const rarity = stamp.definition?.rarity;
  const rarityColor = rarity ? (RARITY_COLORS[rarity] ?? RARITY_COLORS.common) : null;

  const copyLink = useCallback(async () => {
    const { webUrl } = makeStampShareLinks(stamp, null);
    await Clipboard.setStringAsync(webUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [stamp]);

  async function handleVisChange(vis: NewStampVisibility) {
    setVisUpdating(true);
    const res = await updateStampVisibility(stamp.id, vis);
    setVisUpdating(false);
    if (res.ok) onStampUpdated({ ...stamp, visibility: vis });
  }

  async function handleDisplayToggle(val: boolean) {
    setDisplayUpdating(true);
    const res = await toggleDisplayOnPassport(stamp.id, val);
    setDisplayUpdating(false);
    if (res.ok) onStampUpdated({ ...stamp, displayOnPassport: val });
  }

  return (
    <>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.body}
        bounces={false}
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
      >
        <View style={styles.artworkWrap}>
          <StampArtwork stamp={legacy} size={120} />
        </View>

        <Text style={styles.name} numberOfLines={3}>
          {stamp.titleOverride ?? stamp.definition?.name ?? legacy.label}
        </Text>

        {rarity && rarityColor && (
          <View style={[styles.rarityBadge, { backgroundColor: rarityColor + '25' }]}>
            <Text style={[styles.rarityText, { color: rarityColor }]}>
              {rarity.toUpperCase()}
            </Text>
          </View>
        )}

        {stamp.definition?.description ? (
          <Text style={styles.desc}>{stamp.definition.description}</Text>
        ) : null}

        <View style={styles.divider} />

        {(stamp.city || stamp.country) && (
          <View style={styles.row}>
            <Text style={styles.rowKey}>Location</Text>
            <Text style={styles.rowVal}>
              {[stamp.city, stamp.country].filter(Boolean).join(', ')}
            </Text>
          </View>
        )}

        <View style={styles.row}>
          <Text style={styles.rowKey}>How earned</Text>
          <Text style={styles.rowVal}>
            {SOURCE_LABELS[stamp.sourceType] ?? stamp.sourceType.replace(/_/g, ' ')}
          </Text>
        </View>

        <View style={styles.row}>
          <Text style={styles.rowKey}>Earned</Text>
          <Text style={styles.rowVal}>
            {new Date(stamp.earnedAt).toLocaleDateString(undefined, {
              year: 'numeric', month: 'long', day: 'numeric',
            })}
          </Text>
        </View>

        {/* Admire block — hidden when stamp_admire_enabled flag is off */}
        {isFlagEnabled('stamp_admire_enabled') && (
          <StampAdmireBlock userStampId={stamp.id} isOwner={isOwner} />
        )}

        {stamp.isRevoked && (
          <View style={styles.revokedBanner}>
            <Text style={styles.revokedText}>This stamp has been revoked.</Text>
          </View>
        )}

        {isOwner && !stamp.isRevoked && (
          <>
            <View style={styles.divider} />

            <Text style={styles.sectionLabel}>Visibility</Text>
            <View style={styles.visRow}>
              {VISIBILITY_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.value}
                  style={[
                    styles.visBtn,
                    stamp.visibility === opt.value && styles.visBtnActive,
                    visUpdating && styles.visBtnDisabled,
                  ]}
                  onPress={() => handleVisChange(opt.value)}
                  disabled={visUpdating}
                >
                  {visUpdating && stamp.visibility === opt.value ? (
                    <ActivityIndicator size="small" color={color.signal} />
                  ) : (
                    <Text style={[styles.visBtnText, stamp.visibility === opt.value && styles.visBtnTextActive]}>
                      {opt.label}
                    </Text>
                  )}
                </Pressable>
              ))}
            </View>

            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleLabel}>Show on Passport</Text>
                <Text style={styles.toggleSub}>Display this stamp on your public profile</Text>
              </View>
              {displayUpdating ? (
                <ActivityIndicator size="small" color={color.signal} />
              ) : (
                <Switch
                  value={stamp.displayOnPassport}
                  onValueChange={handleDisplayToggle}
                  trackColor={{ false: color.haze, true: color.signal }}
                  thumbColor="#fff"
                />
              )}
            </View>
          </>
        )}

        {stamp.visibility === 'public' && !stamp.isRevoked && (
          <View style={styles.shareRow}>
            <Pressable
              style={[styles.shareBtn, sharing && styles.shareBtnDisabled, { flex: 1 }]}
              onPress={share}
              disabled={sharing}
            >
              {sharing ? (
                <ActivityIndicator size="small" color={color.ink} />
              ) : (
                <Share2 size={16} color={color.ink} />
              )}
              <Text style={styles.shareBtnText}>
                {sharing ? 'Sharing…' : 'Share'}
              </Text>
            </Pressable>

            <Pressable
              style={[styles.shareBtn, copied && styles.shareBtnCopied, { flex: 1 }]}
              onPress={copyLink}
            >
              <Link size={16} color={copied ? '#16A34A' : color.ink} />
              <Text style={[styles.shareBtnText, copied && styles.shareBtnTextCopied]}>
                {copied ? 'Copied!' : 'Copy link'}
              </Text>
            </Pressable>
          </View>
        )}
        <NavBarFiller />
      </ScrollView>

      <View ref={cardRef} style={styles.offscreen} collapsable={false}>
        <StampShareCard stamp={legacy} visibility="public" />
      </View>
    </>
  );
}

export default function StampDeepLinkScreen() {
  const { stampId } = useLocalSearchParams<{ stampId: string }>();
  const insets = useSafeAreaInsets();

  const [stamp, setStamp] = useState<PassportStampNew | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!stampId) { setError('No stamp ID provided'); setLoading(false); return; }
    setLoading(true);
    setError(null);
    const res = await getStampById(stampId);
    setLoading(false);
    if (!res.ok) { setError(res.message); return; }
    setStamp(res.data.stamp);
    setIsOwner(res.data.isOwner);
  }, [stampId]);

  useEffect(() => { load(); }, [load]);

  function goBack() {
    router.replace('/(tabs)/passport' as any);
  }

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={goBack} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Stamp</Text>
        <View style={styles.backBtn} />
      </View>

      {loading && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={color.signal} />
        </View>
      )}

      {!loading && error && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={load}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </Pressable>
          <Pressable style={[styles.retryBtn, { marginTop: space.sm, backgroundColor: color.haze }]} onPress={goBack}>
            <Text style={[styles.retryBtnText, { color: color.mute }]}>Go back</Text>
          </Pressable>
        </View>
      )}

      {!loading && stamp && (
        <StampDetailContent
          stamp={stamp}
          isOwner={isOwner}
          onStampUpdated={setStamp}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontWeight: '700',
    fontSize: 17,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
  },
  errorText: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.signal,
  },
  retryBtnText: {
    ...t.bodyStrong,
    color: '#fff',
  },
  body: {
    padding: space.xl,
    paddingTop: space.lg,
    gap: space.sm,
    alignItems: 'center',
  },
  artworkWrap: { marginBottom: space.xs },
  name: {
    ...t.title,
    color: color.ink,
    fontWeight: '800',
    textAlign: 'center',
  },
  rarityBadge: {
    alignSelf: 'center',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  rarityText: { ...t.small, fontWeight: '700', letterSpacing: 0.5 },
  desc: { ...t.body, color: color.mute, textAlign: 'center', fontStyle: 'italic', marginTop: 4 },
  divider: { width: '100%', height: 1, backgroundColor: color.haze, marginVertical: space.sm },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.sm,
    width: '100%',
  },
  rowKey: { ...t.small, color: color.mute, fontWeight: '600', flex: 1 },
  rowVal: { ...t.small, color: color.ink, fontWeight: '500', flex: 2, textAlign: 'right' },
  revokedBanner: {
    width: '100%',
    backgroundColor: '#FEE2E2',
    borderRadius: radius.md,
    padding: space.sm,
    alignItems: 'center',
  },
  revokedText: { ...t.small, color: '#DC2626', fontWeight: '600' },
  sectionLabel: {
    ...t.small,
    color: color.mute,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    alignSelf: 'flex-start',
    marginTop: space.xs,
  },
  visRow: { flexDirection: 'row', gap: space.sm, width: '100%' },
  visBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
    minHeight: 40,
  },
  visBtnActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  visBtnDisabled: { opacity: 0.5 },
  visBtnText: { ...t.small, color: color.mute, fontWeight: '600', fontSize: 12 },
  visBtnTextActive: { color: color.signal },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    width: '100%',
    paddingVertical: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    marginTop: space.xs,
  },
  toggleLabel: { ...t.bodyStrong, color: color.ink },
  toggleSub: { ...t.small, color: color.mute, marginTop: 2 },
  shareRow: { flexDirection: 'row', gap: space.sm, width: '100%', marginTop: space.sm },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
    marginTop: space.sm,
  },
  shareBtnDisabled:   { opacity: 0.6 },
  shareBtnCopied:     { borderColor: '#16A34A', backgroundColor: '#F0FDF4' },
  shareBtnText:       { ...t.bodyStrong, color: color.ink },
  shareBtnTextCopied: { color: '#16A34A' },
  offscreen:          { position: 'absolute', left: -2000, top: 0 },
});
