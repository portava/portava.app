/**
 * StampsTab — refactored to compose StampCategoryFilter, StampGrid,
 * and StampDetailModal. Fetches live stamp data from the API and
 * falls back to legacy PassportStamp[] prop when the fetch hasn't
 * returned yet (first paint).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import type { PassportStamp } from '../types/models.ts';
import type { PassportStampNew } from '../services/passportStamps.ts';
import { getMyPassportStamps, getUserStampsByUsername } from '../services/passportStamps.ts';
import { getMyProgress } from '../services/stamps.ts';
import type { StampProgress } from '../services/stamps.ts';
import { getPassportStats } from '../services/passportStamps.ts';
import type { PassportMilestone } from '../services/passportStamps.ts';
import { useBlockedIds } from '../context/BlockedIdsContext.tsx';
import { StampCategoryFilter } from './stamps/StampCategoryFilter.tsx';
import type { StampCategory } from './stamps/StampCategoryFilter.tsx';
import { StampGrid } from './stamps/StampGrid.tsx';
import { toLegacy } from './stamps/StampCard.tsx';
import { UniversalStampArtwork } from './stamps/UniversalStampArtwork.tsx';
import { StampDetailModal } from './stamps/StampDetailModal.tsx';
import { StampShowcaseRow, StampShowcaseEmptyCard } from './stamps/StampShowcaseRow.tsx';
import { StampShowcaseCurationSheet } from './stamps/StampShowcaseCurationSheet.tsx';
import { getMyShowcase } from '../services/stampShowcase.ts';
import type { ShowcaseStamp } from '../services/stampShowcase.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';

/** Client-side category filter — maps filter pills to actual DB category values.
 *
 * DB stamp_definitions.category values: 'trip', 'location', 'community',
 * 'event', 'safety', 'trust', 'special', 'rent_buddy'.
 *
 * Filter pill values: 'location', 'trips', 'events', 'social', 'safety',
 * 'rent_buddy'. Note the plural/singular mismatch and 'social' vs 'community'.
 */
function matchesCategory(stamp: PassportStampNew, cat: StampCategory): boolean {
  if (!cat) return true;
  const definitionCat = stamp.definition?.category ?? '';
  const sType = stamp.stampType;

  if (cat === 'location') {
    return (
      // stamp_type values: 'location' (v2) or legacy 'city'/'neighborhood'/'check_in'
      // 'place_contributor' stamps are awarded at a specific place and therefore
      // belong in the location category.
      ['location', 'city', 'neighborhood', 'check_in', 'place_contributor'].includes(sType) ||
      definitionCat === 'location'
    );
  }
  if (cat === 'trips') {
    return (
      // stamp_type values: 'trip' (v2) or legacy 'trip_crew'/'plan'
      ['trip', 'trip_crew', 'plan'].includes(sType) ||
      // DB category stores 'trip' (singular); also accept 'trips' for forward compat
      definitionCat === 'trip' || definitionCat === 'trips'
    );
  }
  if (cat === 'events') {
    // stamp_type: 'event'; DB category: 'event' (singular)
    return sType === 'event' || definitionCat === 'event' || definitionCat === 'events';
  }
  if (cat === 'social') {
    // stamp_type: 'social'; DB category: 'community' — also accept legacy 'social'
    return (
      sType === 'social' ||
      definitionCat === 'community' || definitionCat === 'social'
    );
  }
  if (cat === 'safety') {
    // stamp_type: 'safety' (v2) or legacy 'safe_return'
    // 'trust' stamps (verified_traveler) are verification/safety-adjacent
    return (
      sType === 'safety' || sType === 'safe_return' ||
      definitionCat === 'safety' || definitionCat === 'trust'
    );
  }
  if (cat === 'rent_buddy') {
    // stamp_type: 'rent_buddy' (v2) or legacy 'host'
    // 'special' stamps (early_adopter, founding_member) have no dedicated pill;
    // group them under rent_buddy as a catch-all
    return (
      sType === 'rent_buddy' || sType === 'host' ||
      definitionCat === 'rent_buddy' || definitionCat === 'special'
    );
  }
  return true;
}

interface StampsTabProps {
  stamps?: PassportStamp[];
  viewingUsername?: string;
  /** UUID of the profile being viewed — used for block detection. */
  viewingUserId?: string;
  isOwner?: boolean;
  /**
   * Ref filled with the tab's load-more function so the parent scroll view
   * (which owns the scroll events) can trigger the next stamps page when the
   * user nears the bottom. Guards itself: in-flight and total-sentinel checks.
   */
  loadMoreRef?: React.MutableRefObject<(() => void) | null>;
  /**
   * Externally-owned stamp data (owner passport screen): when provided, the
   * tab renders this list instead of fetching its own — the parent hook
   * (usePassport) is the single stamps pipeline. `loadMoreRef` is then bound
   * to `onLoadMore` so the parent scroll view pages the shared pipeline.
   */
  data?: PassportStampNew[];
  /** Server-reported total for `data` (pagination sentinel / header count). */
  dataTotal?: number;
  /** True while the parent pipeline is fetching the next page. */
  dataLoadingMore?: boolean;
  /** Parent pipeline's load-more (guards itself: in-flight + total sentinel). */
  onLoadMore?: () => void;
  /** Propagate a stamp edit (e.g. visibility change) back to the parent store. */
  onStampUpdated?: (updated: PassportStampNew) => void;
  /** Retry handler for the external pipeline (grid error state). */
  onRetry?: () => void;
}

export function StampsTab({
  stamps: _legacyStamps = [], viewingUsername, viewingUserId, isOwner = false, loadMoreRef,
  data, dataTotal, dataLoadingMore, onLoadMore, onStampUpdated, onRetry,
}: StampsTabProps) {
  // External mode: parent owns fetching/pagination; this tab is render-only.
  const external = data !== undefined;
  // All hooks must be declared before any early return (Rules of Hooks).
  const router = useRouter();
  const { blockedIds, blockerIds } = useBlockedIds();
  const { isEnabled: isFlagEnabled } = useFeatureFlags();
  const [allStamps, setAllStamps]     = useState<PassportStampNew[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [category, setCategory]       = useState<StampCategory>('');
  const [selected, setSelected]       = useState<PassportStampNew | null>(null);
  const [progress, setProgress]       = useState<StampProgress | null>(null);
  const [milestones, setMilestones]   = useState<PassportMilestone[]>([]);
  // Showcase: null = feature flag off (no UI change), [] = flag on but empty,
  // items = flag on with curated stamps.
  const [showcase, setShowcase]       = useState<ShowcaseStamp[] | null>(null);
  const [showCuration, setShowCuration] = useState(false);
  // Pagination (owner view only — the public profile endpoint is unpaginated).
  const [serverTotal, setServerTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const allStampsRef   = React.useRef<PassportStampNew[]>([]);
  const serverTotalRef = React.useRef(0);
  const loadingMoreRef = React.useRef(false);

  const load = useCallback(async () => {
    if (external) return; // parent pipeline owns the data
    setLoading(true);
    setError(null);
    const res = viewingUsername
      ? await getUserStampsByUsername(viewingUsername)
      : await getMyPassportStamps();
    setLoading(false);
    if (res.ok) {
      setAllStamps(res.data);
      allStampsRef.current = res.data;
      const total = !viewingUsername && typeof (res as any).total === 'number'
        ? (res as any).total
        : res.data.length;
      serverTotalRef.current = total;
      setServerTotal(total);
    } else {
      setError(res.message);
    }
  }, [viewingUsername, external]);

  // Fetch the next page of stamps (owner view). Sentinel: server-reported
  // total — when allStamps.length === total there is nothing left to fetch.
  const loadMore = useCallback(() => {
    if (viewingUsername) return; // public endpoint is unpaginated
    if (loadingMoreRef.current) return;
    if (allStampsRef.current.length >= serverTotalRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    getMyPassportStamps({ offset: allStampsRef.current.length })
      .then((res) => {
        if (res.ok) {
          if (res.data.length > 0) {
            allStampsRef.current = [...allStampsRef.current, ...res.data];
            setAllStamps(allStampsRef.current);
          }
          if (typeof res.total === 'number') {
            serverTotalRef.current = res.total;
            setServerTotal(res.total);
          }
          if (res.data.length === 0) {
            // Defensive: an empty page means the server has no more rows —
            // clamp the sentinel so we never loop.
            serverTotalRef.current = allStampsRef.current.length;
            setServerTotal(allStampsRef.current.length);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [viewingUsername]);

  const handleStampUpdated = useCallback((updated: PassportStampNew) => {
    if (external) {
      onStampUpdated?.(updated);
    } else {
      setAllStamps((prev) => {
        const next = prev.map((s) => s.id === updated.id ? updated : s);
        allStampsRef.current = next;
        return next;
      });
    }
    setSelected((prev) => prev?.id === updated.id ? updated : prev);
  }, [external, onStampUpdated]);

  // If either party has blocked the other, hide the section entirely.
  // Computed after hooks so hook order is stable across renders.
  const isBlocked = Boolean(viewingUserId && (blockedIds.has(viewingUserId) || blockerIds.has(viewingUserId)));

  useEffect(() => {
    if (isBlocked) return;
    load();
  }, [load]);

  // Expose loadMore to the parent scroll container. In external mode this is
  // the parent pipeline's own load-more, so scrolling triggers exactly one
  // paged request per page (single fetch pipeline).
  useEffect(() => {
    if (isBlocked) return;
    if (!loadMoreRef) return;
    loadMoreRef.current = external ? (onLoadMore ?? null) : loadMore;
    return () => { loadMoreRef.current = null; };
  }, [loadMoreRef, loadMore, external, onLoadMore]);

  useEffect(() => {
    if (isBlocked) return;
    if (!isOwner || viewingUsername) return;
    getMyProgress().then((res) => { if (res.ok) setProgress(res.data); }).catch(() => {});
  }, [isOwner, viewingUsername]);

  useEffect(() => {
    if (isBlocked) return;
    if (!isOwner || viewingUsername) return;
    getPassportStats().then((res) => {
      if (res.ok) {
        setMilestones(res.data.milestones ?? []);
      }
    }).catch(() => {});
  }, [isOwner, viewingUsername]);

  // Fetch showcase on mount for the owner's own passport only.
  // external mode is intentionally NOT excluded — the main passport tab mounts
  // StampsTab with data={stampsNew} (external=true) and still needs showcase.
  useEffect(() => {
    if (isBlocked) return;
    if (!isOwner || viewingUsername) return;
    getMyShowcase().then((result) => { setShowcase(result); }).catch(() => {});
  }, [isOwner, viewingUsername]);

  if (isBlocked) return null;

  // Effective values — external mode reads the parent-owned pipeline.
  const effStamps      = external ? data! : allStamps;
  const effLoading     = external ? false : loading;
  const effError       = external ? null : error;
  const effLoadingMore = external ? !!dataLoadingMore : loadingMore;
  const effTotal       = external ? Math.max(dataTotal ?? 0, data!.length) : serverTotal;

  const displayed = effStamps.filter((s) => {
    if (viewingUsername && (s.isRevoked || s.visibility === 'private')) return false;
    return matchesCategory(s, category);
  });

  // Featured: the most recently earned stamp in the current view, shown as a
  // full-width card above the grid (and excluded from the grid below).
  // Plain computation (not useMemo): this component has an early return above,
  // so adding hooks below it would break the Rules of Hooks.
  const featured = displayed.length > 0
    ? displayed.reduce((best, s) => ((s.earnedAt ?? '') > (best.earnedAt ?? '') ? s : best), displayed[0])
    : null;
  // Only drop the featured stamp from the grid when there's at least one other
  // match to show in its place — otherwise a category with exactly one stamp
  // (which becomes MOST RECENT) would empty the grid entirely and wrongly
  // render "No stamps in this category" despite MOST RECENT proving one exists.
  const gridStamps = (featured && displayed.length > 1) ? displayed.filter((s) => s.id !== featured.id) : displayed;

  const totalCount = viewingUsername
    ? effStamps.filter((s) => !s.isRevoked && s.visibility !== 'private').length
    : Math.max(effTotal, effStamps.length);

  const emptyTitle = category
    ? 'No stamps in this category'
    : viewingUsername
      ? 'No public stamps yet.'
      : 'No stamps yet';

  const emptySub = category
    ? 'Try a different category above.'
    : viewingUsername
      ? `@${viewingUsername} hasn't earned any public stamps yet.`
      : 'Start traveling, joining events, and posting postcards to earn stamps.';

  return (
    <View style={styles.wrap}>
      {/* Header: stamp count + next-stamp progress (owner only) */}
      <View style={styles.header}>
        {effLoading && effStamps.length === 0 ? (
          <ActivityIndicator size="small" color={color.signal} />
        ) : (
          <Text style={styles.count}>
            {totalCount} {totalCount === 1 ? 'stamp' : 'stamps'}
          </Text>
        )}

        {isOwner && progress?.nextStamp && (
          <View style={styles.progressCard}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressLabel}>Next: {progress.nextStamp.name}</Text>
              <Text style={styles.progressPct}>{Math.round(progress.nextStamp.progressPct)}%</Text>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.min(100, progress.nextStamp.progressPct)}%` as any },
                ]}
              />
            </View>
            {progress.nextStamp.description ? (
              <Text style={styles.progressSub} numberOfLines={1}>
                {progress.nextStamp.description}
              </Text>
            ) : null}
          </View>
        )}

        {isOwner && !viewingUsername && !effLoading && (
          <View style={styles.earnedRow}>
            <Text style={styles.earnedLabel}>Stamps Earned</Text>
            <Text style={styles.earnedValue}>{totalCount.toLocaleString()}</Text>
          </View>
        )}

        {isOwner && !viewingUsername && milestones.length > 0 && (
          <View style={styles.milestonesCard}>
            <Text style={styles.milestonesHeading}>MILESTONES</Text>
            {milestones
              .slice()
              .sort((a, b) => a.level - b.level)
              .map((m) => {
                const label = m.level >= 10000 ? '10K stamps' : m.level >= 1000 ? '1K stamps' : `${m.level} stamps`;
                const date = new Date(m.celebratedAt).toLocaleDateString(undefined, {
                  month: 'short', day: 'numeric', year: 'numeric',
                });
                return (
                  <View key={m.level} style={styles.milestoneRow}>
                    <Text style={styles.milestoneLabel}>{label}</Text>
                    <Text style={styles.milestoneDate}>{date}</Text>
                  </View>
                );
              })}
          </View>
        )}
      </View>

      {/* Category filter strip (shown for both views so public profiles can browse) */}
      <StampCategoryFilter selected={category} onCategoryChange={setCategory} />

      {/* Showcase: curated stamps — only shown to the owner when:
          (a) stamp_showcase_enabled client flag is on, AND
          (b) server returned data (showcase !== null). */}
      {isFlagEnabled('stamp_showcase_enabled') && isOwner && !viewingUsername && showcase !== null && (
        showcase.length > 0 ? (
          <StampShowcaseRow
            items={showcase}
            onPress={(item) => {
              // Find the corresponding PassportStampNew to open the detail modal.
              const match = effStamps.find((s) => s.id === item.userStampId);
              if (match) setSelected(match);
            }}
            onEdit={() => setShowCuration(true)}
          />
        ) : (
          <StampShowcaseEmptyCard onEdit={() => setShowCuration(true)} />
        )
      )}

      {/* Featured: most recent stamp (1x on top of the grid) */}
      {featured ? (() => {
        const legacy = toLegacy(featured);
        const location = [featured.city, featured.country].filter(Boolean).join(', ');
        // place_contributor stamps tap through to the Living Destination Page;
        // all other stamps open the detail modal.  The place ID lives on the
        // top-level placeId field of PassportStampNew — not in metadata.
        const isPlaceContributor = featured.stampType === 'place_contributor';
        const placeContributorId = isPlaceContributor ? (featured.placeId ?? undefined) : undefined;
        // Use titleOverride as the place name hint when set, otherwise fall back
        // to the city field which the award worker stamps at earn time.
        const placeContributorName = isPlaceContributor
          ? (featured.titleOverride ?? featured.city ?? undefined)
          : undefined;
        return (
          <Pressable
            style={styles.featured}
            onPress={() => {
              if (isPlaceContributor && placeContributorId) {
                router.push(`/place/${placeContributorId}` as any);
              } else {
                setSelected(featured);
              }
            }}
            accessibilityRole="button"
            accessibilityLabel={`Most recent stamp: ${legacy.label}`}
          >
            <UniversalStampArtwork
              activeArtworkUrl={featured.activeArtworkUrl}
              stamp={legacy}
              size={72}
              showPendingLabel={false}
            />
            <View style={styles.featuredInfo}>
              <Text style={styles.featuredKicker}>MOST RECENT</Text>
              <Text style={styles.featuredName} numberOfLines={1}>{legacy.label}</Text>
              {isPlaceContributor && placeContributorName ? (
                <Text style={styles.featuredMeta} numberOfLines={1}>📍 {placeContributorName}</Text>
              ) : location ? (
                <Text style={styles.featuredMeta} numberOfLines={1}>{location}</Text>
              ) : null}
              <Text style={styles.featuredDate}>
                {new Date(featured.earnedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
            </View>
            <ChevronRight size={18} color={color.faint} />
          </Pressable>
        );
      })() : null}

      {/* Stamp grid — place_contributor stamps navigate directly to the place
          page; all other stamps open the detail modal. */}
      <StampGrid
        stamps={gridStamps}
        loading={effLoading}
        error={effError}
        isOwner={isOwner}
        onRetry={external ? (onRetry ?? (() => {})) : load}
        onStampPress={(s) => {
          const pid = s.stampType === 'place_contributor' ? (s.placeId ?? undefined) : undefined;
          if (pid) {
            router.push(`/place/${pid}` as any);
          } else {
            setSelected(s);
          }
        }}
        emptyTitle={emptyTitle}
        emptySub={emptySub}
      />

      {/* Next-page loading indicator (infinite scroll) */}
      {effLoadingMore && (
        <View style={styles.loadingMore} testID="stamps-loading-more">
          <ActivityIndicator size="small" color={color.signal} />
        </View>
      )}

      {/* Detail modal */}
      <StampDetailModal
        stamp={selected}
        isOwner={isOwner}
        visible={selected !== null}
        onClose={() => setSelected(null)}
        onStampUpdated={handleStampUpdated}
        username={viewingUsername ?? null}
      />

      {/* Showcase curation sheet (owner only, when feature flag is on) */}
      {isFlagEnabled('stamp_showcase_enabled') && isOwner && !viewingUsername && showcase !== null && (
        <StampShowcaseCurationSheet
          visible={showCuration}
          stamps={effStamps}
          currentIds={showcase.map((s) => s.userStampId)}
          onClose={() => setShowCuration(false)}
          onSaved={(orderedIds) => {
            // Optimistic update: rebuild a ShowcaseStamp[] from the local stamps list.
            const updatedShowcase: ShowcaseStamp[] = orderedIds
              .map((id, idx) => {
                const prev = showcase.find((s) => s.userStampId === id);
                if (prev) return { ...prev, rank: idx + 1 };
                const stamp = effStamps.find((s) => s.id === id);
                if (!stamp) return null;
                return {
                  userStampId: id,
                  rank: idx + 1,
                  earnedAt: stamp.earnedAt,
                  city: stamp.city,
                  country: stamp.country,
                  titleOverride: stamp.titleOverride ?? null,
                  definition: stamp.definition
                    ? {
                        slug: stamp.definition.slug,
                        name: stamp.definition.name,
                        rarity: stamp.definition.rarity,
                        stampType: stamp.definition.stampType,
                        category: stamp.definition.category ?? '',
                        artworkUrl: stamp.activeArtworkUrl ?? null,
                      }
                    : null,
                } satisfies ShowcaseStamp;
              })
              .filter((x): x is ShowcaseStamp => x !== null);
            setShowcase(updatedShowcase);
            setShowCuration(false);
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap:   { paddingTop: space.sm },
  header: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xs,
    gap: space.sm,
    minHeight: 24,
    justifyContent: 'center',
  },
  count: { ...t.small, color: color.mute, fontWeight: '600' },
  progressCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: 6,
  },
  progressHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  progressLabel: { ...t.small, color: color.ink, fontWeight: '600', flex: 1 },
  progressPct:   { ...t.small, color: color.signal, fontWeight: '700' },
  progressTrack: {
    height: 4,
    backgroundColor: color.haze,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    backgroundColor: color.signal,
    borderRadius: 2,
  },
  progressSub: { ...t.small, color: color.mute, fontSize: 11 },
  earnedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xs,
  },
  earnedLabel: { ...t.small, color: color.mute, fontWeight: '600' },
  earnedValue: { ...t.small, color: color.ink, fontWeight: '700' },
  milestonesCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: 6,
  },
  milestonesHeading: {
    fontSize: 9, fontWeight: '700', letterSpacing: 1.1,
    color: color.mute, fontFamily: 'Courier',
    marginBottom: 2,
  },
  milestoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  milestoneLabel: { ...t.small, color: color.ink, fontWeight: '600' },
  milestoneDate:  { ...t.small, color: color.mute },
  loadingMore: { paddingVertical: space.md, alignItems: 'center' },

  featured: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    marginBottom: space.xs,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  featuredInfo: { flex: 1, minWidth: 0, gap: 1 },
  featuredKicker: {
    fontSize: 9, fontWeight: '700', letterSpacing: 1.1,
    color: color.mute, fontFamily: 'Courier',
  },
  featuredName: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  featuredMeta: { ...t.small, color: color.mute, fontSize: 12 },
  featuredDate: { ...t.small, color: color.faint, fontSize: 11 },
});
