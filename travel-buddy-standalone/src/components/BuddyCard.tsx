import React, { useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Star, CheckCircle, Globe, Zap, Clock, Bookmark, BookmarkCheck, MapPin } from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens.ts';
import { Stamp } from './ui.tsx';
import type { BuddyProfile } from '../services/rentABuddy.ts';
import { saveBuddy, unsaveBuddy } from '../services/rentABuddy.ts';
import { CompassFeedbackMenu } from './compass/CompassFeedbackMenu.tsx';
import { CompassWhySheet } from './compass/CompassWhySheet.tsx';

/** "650 m away" / "2.3 km away" / "12 km away" */
export function formatDistanceAway(km: number): string {
  if (km < 1) return `${Math.max(50, Math.round(km * 1000 / 50) * 50)} m away`;
  if (km < 10) return `${km.toFixed(1)} km away`;
  return `${Math.round(km)} km away`;
}

function deriveLevel(reviewCount: number, verified: boolean): { label: string; color: string } {
  if (!verified || reviewCount < 5) return { label: 'New Buddy', color: color.mute };
  if (reviewCount < 25) return { label: 'Rising', color: color.deep };
  if (reviewCount < 60) return { label: 'Pro', color: '#9B59B6' };
  return { label: 'Elite', color: color.warn };
}

interface BuddyCardProps {
  buddy: BuddyProfile;
  compatibilityScore?: number;
  whyMatched?: string;
  compact?: boolean;
  availableNow?: boolean;
  /** If passed, used as the primary booking CTA handler; if omitted, navigates directly to checkout with buddyId. */
  onBook?: () => void;
  onPress?: () => void;
  onDismiss?: () => void;
  /** Initial saved state — passed from parent when known (e.g. saved list). */
  savedInitial?: boolean;
  /** Signed Compass recommendation token — enables "Why am I seeing this?" when set. */
  recommendationId?: string;
}

export function BuddyCard({
  buddy, compatibilityScore, whyMatched, compact, availableNow, onBook, onPress, onDismiss,
  savedInitial = false, recommendationId,
}: BuddyCardProps) {
  const [dismissed, setDismissed] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [saved, setSaved] = useState(savedInitial);
  const [savingInProgress, setSavingInProgress] = useState(false);

  if (dismissed) return null;

  const rating = buddy.averageRating ?? 0;
  const stars = rating > 0 ? rating.toFixed(1) : '—';
  const level = buddy.buddyLevel
    ? { label: buddy.buddyLevel, color: buddy.buddyLevel === 'Elite' ? color.warn : buddy.buddyLevel === 'Pro' ? '#9B59B6' : buddy.buddyLevel === 'Rising' ? color.deep : color.mute }
    : deriveLevel(buddy.reviewCount, buddy.verified);

  const handleSave = async () => {
    if (savingInProgress) return;
    setSavingInProgress(true);
    const next = !saved;
    setSaved(next);
    const res = next ? await saveBuddy(buddy.id) : await unsaveBuddy(buddy.id);
    if (!res.ok) setSaved(!next);
    setSavingInProgress(false);
  };

  const handleViewProfile = () => {
    router.push(`/(rent-a-buddy)/buddy/${buddy.id}` as any);
  };

  const handleBook = () => {
    if (onBook) {
      onBook();
    } else {
      router.push({ pathname: '/(rent-a-buddy)/checkout' as any, params: { buddyId: buddy.id } });
    }
  };

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress ?? handleViewProfile}
    >
      {/* Image */}
      <View style={styles.imageWrap}>
        {buddy.coverPhotoUrl ? (
          <Image source={{ uri: buddy.coverPhotoUrl }} style={styles.image} resizeMode="cover" />
        ) : (
          <View style={[styles.image, styles.imageFallback]}>
            <Text style={styles.imageFallbackText}>{buddy.displayName?.[0]?.toUpperCase() ?? '?'}</Text>
          </View>
        )}
        {buddy.verified && (
          <View style={styles.verifiedBadge}>
            <CheckCircle size={11} color="#fff" />
          </View>
        )}
        {compatibilityScore != null && (
          <View style={styles.scorePill}>
            <Text style={styles.scoreText}>{compatibilityScore}% match</Text>
          </View>
        )}
        <View style={[styles.availChip, availableNow ? styles.availChipLive : styles.availChipSoon]}>
          {availableNow
            ? <Zap size={9} color="#fff" fill="#fff" />
            : <Clock size={9} color={color.mute} />
          }
          <Text style={[styles.availText, !availableNow && { color: color.mute }]}>
            {availableNow ? 'Available Now' : 'Bookable'}
          </Text>
        </View>
      </View>

      {/* Body */}
      <View style={styles.body}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>{buddy.displayName ?? 'Local Buddy'}</Text>
          <View style={styles.ratingRow}>
            <Star size={11} color={color.warn} fill={color.warn} />
            <Text style={styles.rating}>{stars}</Text>
            {buddy.reviewCount > 0 && <Text style={styles.ratingCount}>({buddy.reviewCount})</Text>}
          </View>
        </View>

        <Text style={styles.city} numberOfLines={1}>
          {buddy.city}{buddy.country ? `, ${buddy.country}` : ''}
        </Text>

        <View style={styles.metaRow}>
          <View style={[styles.levelBadge, { borderColor: level.color }]}>
            <Text style={[styles.levelText, { color: level.color }]}>{level.label}</Text>
          </View>
          {buddy.distanceKm != null && (
            <View style={styles.distancePill}>
              <MapPin size={9} color={color.deep} />
              <Text style={styles.distanceText}>{formatDistanceAway(buddy.distanceKm)}</Text>
            </View>
          )}
          {buddy.responseTimeH != null && (
            <View style={styles.responsePill}>
              <Clock size={9} color={color.deep} />
              <Text style={styles.responseText}>~{buddy.responseTimeH}h reply</Text>
            </View>
          )}
        </View>

        {!compact && buddy.categories.length > 0 && (
          <View style={styles.tags}>
            {buddy.categories.slice(0, 3).map(cat => (
              <Stamp key={cat} label={cat} tone="deep" rotate={0} />
            ))}
          </View>
        )}

        {!compact && buddy.languages.length > 0 && (
          <View style={styles.langRow}>
            <Globe size={11} color={color.mute} />
            <Text style={styles.lang} numberOfLines={1}>{buddy.languages.slice(0, 3).join(' · ')}</Text>
          </View>
        )}

        <View style={styles.footer}>
          <Text style={styles.price}>
            {buddy.hourlyRateUsd != null ? `From $${buddy.hourlyRateUsd}/hr` : 'Price on request'}
          </Text>
        </View>

        {whyMatched && <Text style={styles.whyMatched} numberOfLines={2}>✦ {whyMatched}</Text>}

        {/* ── Consistent CTA row: Save · View Profile · Request Booking ── */}
        <View style={styles.ctaRow}>
          {/* Save / Favorite */}
          <Pressable
            style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.7 }]}
            onPress={handleSave}
            hitSlop={8}
            accessibilityLabel={saved ? 'Unsave buddy' : 'Save buddy'}
          >
            {saved
              ? <BookmarkCheck size={16} color={color.signal} fill={`${color.signal}30`} />
              : <Bookmark size={16} color={color.mute} />
            }
          </Pressable>

          {/* View Profile */}
          <Pressable
            style={({ pressed }) => [styles.profileBtn, pressed && { opacity: 0.7 }]}
            onPress={handleViewProfile}
          >
            <Text style={styles.profileBtnText}>View Profile</Text>
          </Pressable>

          {/* Request Booking */}
          <Pressable
            style={({ pressed }) => [styles.bookBtn, pressed && { opacity: 0.7 }]}
            onPress={handleBook}
          >
            <Text style={styles.bookBtnText}>Book</Text>
          </Pressable>
        </View>

        {/* Compass feedback menu */}
        <View style={styles.feedbackRow}>
          <CompassFeedbackMenu
            recommendationId={buddy.id}
            itemType="buddy"
            category="rent_a_buddy"
            onWhyPress={recommendationId ? () => setWhyOpen(true) : undefined}
            onDismiss={() => { setDismissed(true); onDismiss?.(); }}
          />
        </View>
      </View>

      <CompassWhySheet
        visible={whyOpen}
        recommendationId={recommendationId ?? null}
        onClose={() => setWhyOpen(false)}
      />
    </Pressable>
  );
}

export function BuddyCardSkeleton() {
  return (
    <View style={[styles.card, { overflow: 'hidden' }]}>
      <View style={[styles.image, { backgroundColor: color.haze }]} />
      <View style={[styles.body, { gap: space.sm }]}>
        <View style={{ height: 14, width: '60%', backgroundColor: color.haze, borderRadius: 4 }} />
        <View style={{ height: 12, width: '40%', backgroundColor: color.haze, borderRadius: 4 }} />
        <View style={{ height: 12, width: '80%', backgroundColor: color.haze, borderRadius: 4 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    ...shadow.card,
    overflow: 'hidden',
    marginBottom: space.md,
  },
  imageWrap: { position: 'relative', height: 140 },
  image: { width: '100%', height: '100%' },
  imageFallback: { backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  imageFallbackText: { fontSize: 40, fontWeight: '700', color: color.onInk, opacity: 0.7 },
  verifiedBadge: {
    position: 'absolute', top: space.sm, right: space.sm,
    backgroundColor: color.success,
    borderRadius: 999, width: 20, height: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  scorePill: {
    position: 'absolute', top: space.sm, left: space.sm,
    backgroundColor: color.signal, borderRadius: 999,
    paddingHorizontal: space.sm, paddingVertical: 3,
  },
  scoreText: { fontSize: 10, fontWeight: '800', color: '#fff', fontFamily: 'Courier', letterSpacing: 0.3 },
  availChip: {
    position: 'absolute', bottom: space.sm, left: space.sm,
    flexDirection: 'row', alignItems: 'center', gap: 3,
    borderRadius: 999, paddingHorizontal: space.sm, paddingVertical: 3,
  },
  availChipLive: { backgroundColor: color.success },
  availChipSoon: { backgroundColor: 'rgba(250,249,246,0.9)', borderWidth: 1, borderColor: color.haze },
  availText: { fontSize: 9, fontWeight: '800', color: '#fff', fontFamily: 'Courier', letterSpacing: 0.5 },
  body: { padding: space.md, gap: space.xs },
  nameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { ...t.bodyStrong, color: color.ink, flex: 1, marginRight: space.sm },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  rating: { ...t.small, fontWeight: '700', color: color.ink },
  ratingCount: { ...t.small, color: color.mute },
  city: { ...t.small, color: color.mute },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', marginTop: 2 },
  levelBadge: { borderRadius: 4, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 2 },
  levelText: { fontSize: 9, fontWeight: '800', fontFamily: 'Courier', letterSpacing: 0.5 },
  responsePill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#EAF2F5', borderRadius: 999,
    paddingHorizontal: space.sm, paddingVertical: 3,
  },
  responseText: { fontSize: 9, fontWeight: '700', color: color.deep, fontFamily: 'Courier', letterSpacing: 0.3 },
  distancePill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#EAF2F5', borderRadius: 999,
    paddingHorizontal: space.sm, paddingVertical: 3,
  },
  distanceText: { fontSize: 9, fontWeight: '700', color: color.deep, fontFamily: 'Courier', letterSpacing: 0.3 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  langRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  lang: { ...t.small, color: color.mute, flex: 1 },
  footer: { flexDirection: 'row', alignItems: 'center', marginTop: space.sm },
  price: { ...t.small, fontWeight: '700', color: color.ink },
  whyMatched: { ...t.small, color: color.deep, fontStyle: 'italic', marginTop: space.xs },

  ctaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  saveBtn: {
    width: 36, height: 36, borderRadius: radius.sm,
    borderWidth: 1.5, borderColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
  },
  profileBtn: {
    flex: 1, borderRadius: radius.sm, borderWidth: 1.5, borderColor: color.haze,
    paddingVertical: 8, alignItems: 'center',
  },
  profileBtnText: { ...t.small, color: color.ink, fontWeight: '600' },
  bookBtn: {
    flex: 1, borderRadius: radius.sm, backgroundColor: color.signal,
    paddingVertical: 8, alignItems: 'center',
  },
  bookBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },

  feedbackRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: space.xs },
});
