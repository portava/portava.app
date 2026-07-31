import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, Image, Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft, Star, Shield, CheckCircle, Globe, Clock,
  Bookmark, Flag, ChevronDown, ChevronUp, MapPin,
} from 'lucide-react-native';
import { StampButton } from '../../../src/components/stamps/StampButton';
import { color, space, radius, type as t, shadow, layout } from '../../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState, TravelCard } from '../../../src/components/primitives';
import { Stamp } from '../../../src/components/ui';
import {
  getBuddyProfile, saveBuddy, unsaveBuddy, getBuddyReviews, getBuddyBlockedDates,
  type BuddyProfile as BuddyProfileType,
  type BuddyPackage, type BuddyAddon, type BuddyReview, type BuddyAvailability,
  type BuddyBlockedRange,
} from '../../../src/services/rentABuddy';
import { ReportSheet } from '../../../src/components/ReportSheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStickyBarInset } from '../../../src/hooks/useBottomInset';
import { UserOverflowMenu } from '../../../src/components/interaction/UserOverflowMenu';
import { MeetupAreaPreview } from '../../../src/components/location/MeetupAreaPreview';
import { formatAwayRange, upcomingAwayRanges } from '../../../src/lib/awayDates';

function ReviewSection({ buddyId, initialReviews, total, avgRating }: {
  buddyId: string;
  initialReviews: BuddyReview[];
  total: number;
  avgRating: number;
}) {
  const [reviews, setReviews] = useState(initialReviews);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(initialReviews.length < total);

  const loadMore = async () => {
    setLoading(true);
    const next = page + 1;
    const res = await getBuddyReviews(buddyId, next);
    setLoading(false);
    if (!res.ok) return;
    setReviews(prev => [...prev, ...res.data.reviews]);
    setPage(next);
    setHasMore(reviews.length + res.data.reviews.length < res.data.total);
  };

  return (
    <View style={{ paddingHorizontal: space.lg, marginTop: space.xl }}>
      <View style={styles.reviewsHeader}>
        <Text style={styles.heading}>Reviews</Text>
        <Text style={styles.reviewsAvg}>
          {avgRating > 0 ? avgRating.toFixed(1) : '—'} · {total} reviews
        </Text>
      </View>
      {reviews.map(r => (
        <View key={r.id} style={styles.reviewCard}>
          <View style={styles.reviewTop}>
            <View style={{ flexDirection: 'row', gap: 2 }}>
              {[1, 2, 3, 4, 5].map(i => (
                <Star key={i} size={12} color={color.warn} fill={i <= r.rating ? color.warn : 'none'} />
              ))}
            </View>
            <Text style={styles.reviewDate}>{new Date(r.createdAt).toLocaleDateString()}</Text>
          </View>
          {r.body && <Text style={styles.reviewBody}>{r.body}</Text>}
        </View>
      ))}
      {hasMore && (
        <Pressable
          style={[styles.loadMoreBtn, loading && { opacity: 0.5 }]}
          onPress={loadMore}
          disabled={loading}
        >
          <Text style={styles.loadMoreText}>{loading ? 'Loading…' : `Load more reviews (${total - reviews.length} remaining)`}</Text>
        </Pressable>
      )}
    </View>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  city: 'City', nightlife: 'Nightlife', language: 'Language', shopping: 'Shopping',
  arrival: 'Arrival', content: 'Content', adventure: 'Group Adventures', culture: 'Culture',
  food: 'Food', nature: 'Nature', wellness: 'Wellness', other: 'Custom',
};

function StarRow({ rating, size = 14 }: { rating: number; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} size={size} color={color.warn} fill={i <= Math.round(rating) ? color.warn : 'none'} />
      ))}
    </View>
  );
}

function PackageCard({ pkg, onBook }: { pkg: BuddyPackage; onBook: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <TravelCard style={{ marginBottom: space.md }}>
      <Pressable onPress={() => setExpanded(e => !e)}>
        <View style={styles.pkgHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.pkgTitle}>{pkg.title}</Text>
            <Text style={styles.pkgMeta}>{pkg.durationH}h · Up to {pkg.maxGroup} people</Text>
          </View>
          <View style={styles.pkgPrice}>
            <Text style={styles.pkgPriceText}>${pkg.priceUsd}</Text>
          </View>
          {expanded ? <ChevronUp size={16} color={color.mute} /> : <ChevronDown size={16} color={color.mute} />}
        </View>
        {expanded && pkg.description ? (
          <Text style={[styles.pkgDesc, { marginTop: space.sm }]}>{pkg.description}</Text>
        ) : null}
      </Pressable>
      <Pressable style={styles.bookPkgBtn} onPress={onBook}>
        <Text style={styles.bookPkgBtnText}>Book This Package</Text>
      </Pressable>
    </TravelCard>
  );
}

export default function BuddyProfileScreen() {
  const insets = useSafeAreaInsets();
  const { inset: barInset, onBarLayout } = useStickyBarInset();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<{
    buddy: BuddyProfileType | null;
    packages: BuddyPackage[];
    addons: BuddyAddon[];
    availability: BuddyAvailability[];
    reviews: BuddyReview[];
    savedByMe: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [savingToggle, setSavingToggle] = useState(false);
  const [blockedRanges, setBlockedRanges] = useState<BuddyBlockedRange[]>([]);
  const [reportSheetVisible, setReportSheetVisible] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const [res, blockedRes] = await Promise.all([
      getBuddyProfile(id),
      getBuddyBlockedDates(id),
    ]);
    setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setData(res.data);
    setSaved(res.data.savedByMe);
    // Blocked dates are supplementary — a failure here shouldn't block the profile.
    setBlockedRanges(blockedRes.ok ? blockedRes.data.blocked : []);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const toggleSave = async () => {
    if (savingToggle) return;
    setSavingToggle(true);
    const fn = saved ? unsaveBuddy : saveBuddy;
    const res = await fn(id);
    setSavingToggle(false);
    if (res.ok) setSaved(s => !s);
  };

  if (loading) return <TravelLoadingState label="Loading Buddy profile…" />;
  if (error || !data?.buddy) return (
    <TravelErrorState
      title="Couldn't load profile"
      sub={error ?? 'Profile not found'}
      onRetry={load}
    />
  );

  const buddy = data.buddy;
  const avgRating = buddy.averageRating ?? 0;
  const upcomingAway = upcomingAwayRanges(blockedRanges);

  return (
    <View style={styles.page}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: barInset }}>
        {/* Hero */}
        <View style={styles.heroBox}>
          {buddy.coverPhotoUrl ? (
            <Image source={{ uri: buddy.coverPhotoUrl }} style={styles.heroImage} resizeMode="cover" />
          ) : (
            <View style={[styles.heroImage, styles.heroFallback]}>
              <Text style={styles.heroInitial}>{buddy.displayName?.[0]?.toUpperCase() ?? '?'}</Text>
            </View>
          )}
          {/* Nav overlay */}
          <View style={[styles.heroNav, { top: insets.top + space.sm }]}>
            <Pressable
              style={({ pressed }) => [styles.navBtn, pressed && { opacity: layout.pressedOpacity }]}
              onPress={() => router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/' as any)}
            >
              <ArrowLeft size={18} color={color.onInk} />
            </Pressable>
            <StampButton
              entityType="buddy_profile"
              entityId={buddy.userId}
              initialCount={0}
              initialIsStamped={false}
              iconSize={18}
            />
            <Pressable
              style={({ pressed }) => [styles.navBtn, pressed && { opacity: layout.pressedOpacity }]}
              onPress={toggleSave}
            >
              <Bookmark size={18} color={saved ? color.signal : color.onInk} fill={saved ? color.signal : 'none'} />
            </Pressable>
            <UserOverflowMenu
              userId={buddy.userId}
              displayName={buddy.displayName ?? 'Local Buddy'}
              onBlockSuccess={() => router.replace('/(rent-a-buddy)/' as any)}
            />
          </View>

          {/* Hero info */}
          <View style={styles.heroInfo}>
            <Text style={styles.heroName}>{buddy.displayName ?? 'Local Buddy'}</Text>
            <Text style={styles.heroCity}>{buddy.city}{buddy.country ? `, ${buddy.country}` : ''}</Text>
            <View style={styles.heroTags}>
              {buddy.categories.map(cat => (
                <Stamp key={cat} label={CATEGORY_LABELS[cat] ?? cat} tone="onInk" rotate={0} />
              ))}
            </View>
          </View>
        </View>

        {/* Trust row */}
        <View style={styles.trustRow}>
          <View style={styles.trustItem}>
            <Shield size={18} color={buddy.verified ? color.success : color.mute} />
            <Text style={styles.trustLabel}>{buddy.verified ? 'Verified' : 'Unverified'}</Text>
          </View>
          <View style={styles.trustDivider} />
          <View style={styles.trustItem}>
            <Star size={18} color={color.warn} fill={color.warn} />
            <Text style={styles.trustLabel}>
              {avgRating > 0 ? avgRating.toFixed(1) : '—'} ({buddy.reviewCount})
            </Text>
          </View>
          <View style={styles.trustDivider} />
          <View style={styles.trustItem}>
            <Clock size={18} color={color.deep} />
            <Text style={styles.trustLabel}>
              {buddy.responseTimeH != null ? `~${buddy.responseTimeH}h reply` : 'Response varies'}
            </Text>
          </View>
        </View>

        {/* Tagline / Bio */}
        {(buddy.tagline || buddy.bio) && (
          <View style={{ paddingHorizontal: space.lg, marginTop: space.lg }}>
            {buddy.tagline && <Text style={styles.tagline}>"{buddy.tagline}"</Text>}
            {buddy.bio && <Text style={styles.bio}>{buddy.bio}</Text>}
          </View>
        )}

        {/* Trust Score */}
        <View style={styles.section}>
          <View style={styles.sectionRow}>
            <Shield size={16} color={color.success} />
            <Text style={styles.sectionTitle}>Trust Score</Text>
            {buddy.trustLabel ? (
              <View style={styles.trustLabelBadge}>
                <Text style={styles.trustLabelBadgeText}>{buddy.trustLabel}</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.trustRingRow}>
            <View style={styles.trustRing}>
              <Text style={styles.trustRingNum}>
                {buddy.trustScore ?? Math.min(100, Math.round((buddy.verified ? 35 : 0) + (avgRating / 5) * 35 + Math.min(buddy.reviewCount, 30)))}
              </Text>
              <Text style={styles.trustRingLabel}>/ 100</Text>
            </View>
            <View style={styles.trustFactors}>
              {buddy.trustScoreBreakdown?.factors.map(f => {
                const positive = f.maxPoints > 0;
                const earned = positive ? f.points > 0 : f.points < 0;
                return (
                  <View key={f.key} style={styles.trustFactor}>
                    <CheckCircle
                      size={12}
                      color={positive ? (earned ? color.success : color.haze) : color.warn}
                      fill={positive ? (earned ? color.success : color.haze) : color.warn}
                    />
                    <Text style={[styles.trustFactorText, !earned && positive && { color: color.haze }]}>
                      {f.label}
                      {f.points !== 0 ? (
                        <Text style={styles.trustFactorPts}>
                          {f.points > 0 ? ` +${f.points}` : ` ${f.points}`}
                        </Text>
                      ) : null}
                    </Text>
                  </View>
                );
              }) ?? (
                // Fallback when breakdown is absent (API didn't return it yet)
                [
                  { label: 'ID verified', ok: buddy.verified },
                  { label: `${buddy.reviewCount} verified reviews`, ok: buddy.reviewCount > 0 },
                  { label: `${avgRating > 0 ? avgRating.toFixed(1) : '—'} average rating`, ok: avgRating >= 4.0 },
                ].map(f => (
                  <View key={f.label} style={styles.trustFactor}>
                    <CheckCircle size={12} color={f.ok ? color.success : color.haze} fill={f.ok ? color.success : color.haze} />
                    <Text style={[styles.trustFactorText, !f.ok && { color: color.haze }]}>{f.label}</Text>
                  </View>
                ))
              )}
            </View>
          </View>
        </View>

        {/* Languages */}
        {buddy.languages.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionRow}>
              <Globe size={16} color={color.deep} />
              <Text style={styles.sectionTitle}>Languages</Text>
            </View>
            <View style={styles.tagWrap}>
              {buddy.languages.map(lang => (
                <View key={lang} style={styles.langTag}>
                  <Text style={styles.langTagText}>{lang}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Availability calendar */}
        {(data.availability.length > 0 || upcomingAway.length > 0) && (
          <View style={styles.section}>
            <View style={styles.sectionRow}>
              <Clock size={16} color={color.deep} />
              <Text style={styles.sectionTitle}>Availability</Text>
            </View>
            {upcomingAway.length > 0 && (
              <View style={styles.awayWrap}>
                {upcomingAway.map(r => (
                  <View key={r.id} style={styles.awayChip}>
                    <Text style={styles.awayChipText}>Away {formatAwayRange(r)}</Text>
                  </View>
                ))}
              </View>
            )}
            <View style={styles.availGrid}>
              {data.availability.slice(0, 14).map(av => {
                const d = new Date(av.date);
                const dayName = d.toLocaleDateString('en', { weekday: 'short' });
                const dayNum = d.getDate();
                return (
                  <View key={av.id} style={[styles.availCell, av.isAvailable && styles.availCellActive]}>
                    <Text style={[styles.availDay, av.isAvailable && styles.availDayActive]}>{dayName}</Text>
                    <Text style={[styles.availDate, av.isAvailable && styles.availDateActive]}>{dayNum}</Text>
                    {av.isAvailable && av.timeSlots.length > 0 && (
                      <Text style={styles.availSlots}>{av.timeSlots[0]}</Text>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* Meetup guidance */}
        <View style={styles.section}>
          <View style={styles.sectionRow}>
            <MapPin size={16} color={color.signal} />
            <Text style={styles.sectionTitle}>Public meetup locations</Text>
          </View>
          {buddy.meetupBaseLat != null && buddy.meetupBaseLng != null && (
            <View style={{ marginBottom: space.sm }}>
              <MeetupAreaPreview lat={buddy.meetupBaseLat} lng={buddy.meetupBaseLng} />
            </View>
          )}
          <Text style={styles.safetySub}>
            All first meetups must take place in a busy, well-lit public space of your choosing — a hotel lobby, busy café, or transit hub. Never agree to a private location for your first meeting.
          </Text>
        </View>

        {/* Safety notice */}
        <View style={[styles.safetyBanner, { marginHorizontal: space.lg, marginTop: space.lg }]}>
          <CheckCircle size={16} color={color.success} />
          <View style={{ flex: 1 }}>
            <Text style={styles.safetyTitle}>Safety-first meetups</Text>
            <Text style={styles.safetySub}>
              All meetups begin at public, pre-approved locations. You set the boundaries.
            </Text>
          </View>
        </View>

        {/* Packages */}
        {data.packages.length > 0 && (
          <View style={{ paddingHorizontal: space.lg, marginTop: space.xl }}>
            <Text style={styles.heading}>Packages</Text>
            {data.packages.map(pkg => (
              <PackageCard
                key={pkg.id}
                pkg={pkg}
                onBook={() => router.push({ pathname: '/(rent-a-buddy)/checkout' as any, params: { buddyId: buddy.id, packageId: pkg.id } })}
              />
            ))}
          </View>
        )}

        {/* Add-ons */}
        {data.addons.length > 0 && (
          <View style={{ paddingHorizontal: space.lg, marginTop: space.lg }}>
            <Text style={styles.heading}>Add-ons</Text>
            {data.addons.map(addon => (
              <View key={addon.id} style={styles.addonRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.addonTitle}>{addon.title}</Text>
                  {addon.description && <Text style={styles.addonDesc}>{addon.description}</Text>}
                </View>
                <Text style={styles.addonPrice}>+${addon.priceUsd}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Reviews */}
        {data.reviews.length > 0 && (
          <ReviewSection
            buddyId={buddy.id}
            initialReviews={data.reviews}
            total={buddy.reviewCount}
            avgRating={avgRating}
          />
        )}

        {/* Report listing */}
        <Pressable
          style={styles.reportRow}
          onPress={() => setReportSheetVisible(true)}
        >
          <Flag size={12} color={color.mute} />
          <Text style={styles.reportText}>Report this listing</Text>
        </Pressable>
      </ScrollView>

      {/* Report listing sheet */}
      <ReportSheet
        visible={reportSheetVisible}
        onClose={() => setReportSheetVisible(false)}
        subjectType="buddy_listing"
        subjectId={buddy.id}
        subjectUserId={buddy.userId}
        subjectName={buddy.displayName ?? 'Local Buddy'}
      />

      {/* Sticky Book */}
      <View style={[styles.stickyBottom, { paddingBottom: insets.bottom + space.md }]} onLayout={onBarLayout}>
        <View style={{ flex: 1 }}>
          <Text style={styles.priceLabel}>Starting from</Text>
          <Text style={styles.priceValue}>
            {buddy.hourlyRateUsd != null ? `$${buddy.hourlyRateUsd}/hr` : 'Price on request'}
          </Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.bookBtn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={() => router.push({ pathname: '/(rent-a-buddy)/checkout' as any, params: { buddyId: buddy.id } })}
        >
          <Text style={styles.bookBtnText}>Book Now</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper },
  heroBox: { position: 'relative', height: 300 },
  heroImage: { width: '100%', height: '100%' },
  heroFallback: { backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  heroInitial: { fontSize: 80, fontWeight: '700', color: color.onInk, opacity: 0.7 },
  heroNav: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space.lg },
  navBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(17,17,15,0.5)', alignItems: 'center', justifyContent: 'center' },
  heroInfo: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: space.lg, backgroundColor: 'rgba(17,17,15,0.55)' },
  heroName: { ...t.title, color: color.onInk, fontSize: 24 },
  heroCity: { ...t.body, color: color.onInkMute, marginTop: 2, marginBottom: space.sm },
  heroTags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  trustRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised, borderBottomWidth: 1, borderBottomColor: color.haze,
    paddingVertical: space.lg,
  },
  trustItem: { flex: 1, alignItems: 'center', gap: 4 },
  trustLabel: { ...t.small, fontWeight: '600', color: color.ink, textAlign: 'center' },
  trustDivider: { width: 1, height: 30, backgroundColor: color.haze },
  tagline: { ...t.bodyStrong, color: color.deep, fontStyle: 'italic', fontSize: 17, marginBottom: space.sm },
  bio: { ...t.body, color: color.ink, lineHeight: 22 },
  section: { paddingHorizontal: space.lg, marginTop: space.lg },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
  sectionTitle: { ...t.bodyStrong, color: color.ink },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  langTag: { backgroundColor: '#EAF2F5', borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 4 },
  langTagText: { ...t.small, fontWeight: '600', color: color.deep },
  awayWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.sm },
  awayChip: {
    backgroundColor: '#F4EFE9', borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: 4,
    borderWidth: 1, borderColor: color.haze,
  },
  awayChipText: { ...t.small, fontWeight: '600', color: color.mute },
  safetyBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    backgroundColor: '#EEF8F3', borderRadius: radius.md, padding: space.md,
    borderWidth: 1, borderColor: color.success,
  },
  safetyTitle: { ...t.small, fontWeight: '700', color: color.success },
  safetySub: { ...t.small, color: color.mute, marginTop: 2, lineHeight: 16 },
  heading: { ...t.heading, color: color.ink, marginBottom: space.md },
  pkgHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pkgTitle: { ...t.bodyStrong, color: color.ink },
  pkgMeta: { ...t.small, color: color.mute, marginTop: 2 },
  pkgPrice: { backgroundColor: '#EAF2F5', borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 3 },
  pkgPriceText: { ...t.small, fontWeight: '800', color: color.deep },
  pkgDesc: { ...t.body, color: color.mute },
  bookPkgBtn: {
    backgroundColor: color.signal, borderRadius: radius.sm,
    paddingVertical: space.sm, alignItems: 'center', marginTop: space.md,
  },
  bookPkgBtnText: { ...t.bodyStrong, color: color.onInk },
  addonRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  addonTitle: { ...t.bodyStrong, color: color.ink },
  addonDesc: { ...t.small, color: color.mute, marginTop: 2 },
  addonPrice: { ...t.bodyStrong, color: color.signal },
  reviewsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md },
  reviewsAvg: { ...t.small, color: color.mute, fontWeight: '600' },
  reviewCard: { paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  reviewTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.xs },
  reviewDate: { ...t.small, color: color.haze },
  reviewBody: { ...t.body, color: color.ink, lineHeight: 20 },
  reportRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, justifyContent: 'center', padding: space.xl },
  reportText: { ...t.small, color: color.mute },
  trustRingRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  trustRing: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 4, borderColor: color.success,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#EEF8F3',
  },
  trustRingNum: { fontSize: 22, fontWeight: '800', color: color.success, fontFamily: 'Courier' },
  trustRingLabel: { fontSize: 10, color: color.mute, fontFamily: 'Courier' },
  trustLabelBadge: { backgroundColor: '#EEF8F3', borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 },
  trustLabelBadgeText: { ...t.small, fontWeight: '700', color: color.success },
  trustFactors: { flex: 1, gap: 6 },
  trustFactor: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  trustFactorText: { ...t.small, color: color.ink },
  trustFactorPts: { ...t.small, color: color.mute, fontWeight: '600' },
  availGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  availCell: {
    width: 44, alignItems: 'center', paddingVertical: 6,
    borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  availCellActive: { backgroundColor: '#EEF8F3', borderColor: color.success },
  availDay: { fontSize: 9, fontWeight: '700', color: color.mute, fontFamily: 'Courier' },
  availDayActive: { color: color.success },
  availDate: { fontSize: 16, fontWeight: '700', color: color.haze },
  availDateActive: { color: color.ink },
  availSlots: { fontSize: 8, color: color.success, fontFamily: 'Courier', marginTop: 2 },
  zoneRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: color.haze },
  zoneText: { ...t.small, color: color.ink, flex: 1 },
  loadMoreBtn: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, alignItems: 'center', marginTop: space.md },
  loadMoreText: { ...t.small, fontWeight: '600', color: color.deep },
  stickyBottom: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised, borderTopWidth: 1, borderTopColor: color.haze,
    paddingHorizontal: space.lg, paddingTop: space.md,
    ...shadow.float,
  },
  priceLabel: { ...t.small, color: color.mute },
  priceValue: { ...t.bodyStrong, color: color.ink, fontSize: 18 },
  bookBtn: {
    backgroundColor: color.signal, borderRadius: radius.md,
    paddingHorizontal: space.xl, paddingVertical: space.md,
  },
  bookBtnText: { ...t.bodyStrong, color: color.onInk },
});
