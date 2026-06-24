import React from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Star, Shield, CheckCircle, Globe, Zap, Clock } from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens';
import { Stamp } from './ui';
import type { BuddyProfile } from '../services/rentABuddy';

function deriveLevel(reviewCount: number, verified: boolean): { label: string; color: string } {
  if (!verified || reviewCount < 5) return { label: 'New Buddy', color: color.mute };
  if (reviewCount < 25) return { label: 'Rising', color: color.deep };
  if (reviewCount < 60) return { label: 'Pro', color: '#9B59B6' };
  return { label: 'Elite', color: color.warn };
}

function deriveTrustScore(buddy: BuddyProfile): number {
  let score = 0;
  if (buddy.verified) score += 35;
  if (buddy.averageRating != null) score += Math.round((buddy.averageRating / 5) * 35);
  score += Math.min(buddy.reviewCount, 30);
  return Math.min(score, 100);
}

interface BuddyCardProps {
  buddy: BuddyProfile;
  compatibilityScore?: number;
  whyMatched?: string;
  compact?: boolean;
  availableNow?: boolean;
  onBook?: () => void;
  onPress?: () => void;
}

export function BuddyCard({
  buddy, compatibilityScore, whyMatched, compact, availableNow, onBook, onPress,
}: BuddyCardProps) {
  const rating = buddy.averageRating ?? 0;
  const stars = rating > 0 ? rating.toFixed(1) : '—';
  const level = deriveLevel(buddy.reviewCount, buddy.verified);
  const trustScore = deriveTrustScore(buddy);

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: layout.pressedOpacity }]}
      onPress={onPress ?? (() => router.push(`/(rent-a-buddy)/buddy/${buddy.id}` as any))}
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
        {/* Verified badge */}
        {buddy.verified && (
          <View style={styles.verifiedBadge}>
            <CheckCircle size={11} color="#fff" />
          </View>
        )}
        {/* Match score pill */}
        {compatibilityScore != null && (
          <View style={styles.scorePill}>
            <Text style={styles.scoreText}>{compatibilityScore}% match</Text>
          </View>
        )}
        {/* Availability chip */}
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
        {/* Name + rating */}
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>{buddy.displayName ?? 'Local Buddy'}</Text>
          <View style={styles.ratingRow}>
            <Star size={11} color={color.warn} fill={color.warn} />
            <Text style={styles.rating}>{stars}</Text>
            {buddy.reviewCount > 0 && <Text style={styles.ratingCount}>({buddy.reviewCount})</Text>}
          </View>
        </View>

        {/* City */}
        <Text style={styles.city} numberOfLines={1}>
          {buddy.city}{buddy.country ? `, ${buddy.country}` : ''}
        </Text>

        {/* Level + Trust Score row */}
        <View style={styles.metaRow}>
          <View style={[styles.levelBadge, { borderColor: level.color }]}>
            <Text style={[styles.levelText, { color: level.color }]}>{level.label}</Text>
          </View>
          <View style={styles.trustPill}>
            <Shield size={9} color={buddy.verified ? color.success : color.mute} />
            <Text style={[styles.trustText, { color: buddy.verified ? color.success : color.mute }]}>
              Trust {trustScore}
            </Text>
          </View>
          {buddy.responseTimeH != null && (
            <View style={styles.responsePill}>
              <Clock size={9} color={color.deep} />
              <Text style={styles.responseText}>~{buddy.responseTimeH}h reply</Text>
            </View>
          )}
        </View>

        {/* Categories */}
        {!compact && buddy.categories.length > 0 && (
          <View style={styles.tags}>
            {buddy.categories.slice(0, 3).map(cat => (
              <Stamp key={cat} label={cat} tone="deep" rotate={0} />
            ))}
          </View>
        )}

        {/* Languages */}
        {!compact && buddy.languages.length > 0 && (
          <View style={styles.langRow}>
            <Globe size={11} color={color.mute} />
            <Text style={styles.lang} numberOfLines={1}>{buddy.languages.slice(0, 3).join(' · ')}</Text>
          </View>
        )}

        {/* Price */}
        <View style={styles.footer}>
          <Text style={styles.price}>
            {buddy.hourlyRateUsd != null ? `From $${buddy.hourlyRateUsd}/hr` : 'Price on request'}
          </Text>
        </View>

        {/* Why matched */}
        {whyMatched && <Text style={styles.whyMatched} numberOfLines={2}>✦ {whyMatched}</Text>}

        {/* Book button */}
        {onBook && (
          <Pressable
            style={({ pressed }) => [styles.bookBtn, pressed && { opacity: layout.pressedOpacity }]}
            onPress={onBook}
          >
            <Text style={styles.bookBtnText}>Book Now</Text>
          </Pressable>
        )}
      </View>
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
  levelBadge: {
    borderRadius: 4, borderWidth: 1,
    paddingHorizontal: 5, paddingVertical: 2,
  },
  levelText: { fontSize: 9, fontWeight: '800', fontFamily: 'Courier', letterSpacing: 0.5 },
  trustPill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#EEF8F3', borderRadius: 999,
    paddingHorizontal: space.sm, paddingVertical: 3,
  },
  trustText: { fontSize: 9, fontWeight: '700', fontFamily: 'Courier', letterSpacing: 0.3 },
  responsePill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#EAF2F5', borderRadius: 999,
    paddingHorizontal: space.sm, paddingVertical: 3,
  },
  responseText: { fontSize: 9, fontWeight: '700', color: color.deep, fontFamily: 'Courier', letterSpacing: 0.3 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  langRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  lang: { ...t.small, color: color.mute, flex: 1 },
  footer: { flexDirection: 'row', alignItems: 'center', marginTop: space.sm },
  price: { ...t.small, fontWeight: '700', color: color.ink },
  whyMatched: { ...t.small, color: color.deep, fontStyle: 'italic', marginTop: space.xs },
  bookBtn: {
    backgroundColor: color.signal, borderRadius: radius.sm,
    paddingVertical: space.sm, alignItems: 'center', marginTop: space.sm,
  },
  bookBtnText: { ...t.bodyStrong, color: color.onInk },
});
