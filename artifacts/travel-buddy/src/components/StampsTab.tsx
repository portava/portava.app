/**
 * StampsTab — refactored to compose StampCategoryFilter, StampGrid,
 * and StampDetailModal. Fetches live stamp data from the API and
 * falls back to legacy PassportStamp[] prop when the fetch hasn't
 * returned yet (first paint).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import type { PassportStamp } from '../types/models.ts';
import type { PassportStampNew } from '../services/passportStamps.ts';
import { getMyPassportStamps, getUserStampsByUsername } from '../services/passportStamps.ts';
import { getMyProgress } from '../services/stamps.ts';
import type { StampProgress } from '../services/stamps.ts';
import { useBlockedIds } from '../context/BlockedIdsContext.tsx';
import { StampCategoryFilter } from './stamps/StampCategoryFilter.tsx';
import type { StampCategory } from './stamps/StampCategoryFilter.tsx';
import { StampGrid } from './stamps/StampGrid.tsx';
import { toLegacy } from './stamps/StampCard.tsx';
import { UniversalStampArtwork } from './stamps/UniversalStampArtwork.tsx';
import { StampDetailModal } from './stamps/StampDetailModal.tsx';
import { color, space, radius, type as t } from '../theme/tokens.ts';

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
      ['location', 'city', 'neighborhood', 'check_in'].includes(sType) ||
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
}

export function StampsTab({ stamps: _legacyStamps = [], viewingUsername, viewingUserId, isOwner = false, loadMoreRef }: StampsTabProps) {
  // All hooks must be declared before any early return (Rules of Hooks).
  const { blockedIds, blockerIds } = useBlockedIds();
  const [allStamps, setAllStamps]     = useState<PassportStampNew[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [category, setCategory]       = useState<StampCategory>('');
  const [selected, setSelected]       = useState<PassportStampNew | null>(null);
  const [progress, setProgress]       = useState<StampProgress | null>(null);
  // Pagination (owner view only — the public profile endpoint is unpaginated).
  const [serverTotal, setServerTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const allStampsRef   = React.useRef<PassportStampNew[]>([]);
  const serverTotalRef = React.useRef(0);
  const loadingMoreRef = React.useRef(false);

  // If either party has blocked the other, hide the section entirely.
  // Computed after hooks so hook order is stable across renders.
  const isBlocked = Boolean(viewingUserId && (blockedIds.has(viewingUserId) || blockerIds.has(viewingUserId)));

  if (isBlocked) return null;

  const load = useCallback(async () => {
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
  }, [viewingUsername]);

  useEffect(() => { load(); }, [load]);

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

  // Expose loadMore to the parent scroll container.
  useEffect(() => {
    if (!loadMoreRef) return;
    loadMoreRef.current = loadMore;
    return () => { loadMoreRef.current = null; };
  }, [loadMoreRef, loadMore]);

  useEffect(() => {
    if (!isOwner || viewingUsername) return;
    getMyProgress().then((res) => { if (res.ok) setProgress(res.data); }).catch(() => {});
  }, [isOwner, viewingUsername]);

  const displayed = allStamps.filter((s) => {
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
  const gridStamps = featured ? displayed.filter((s) => s.id !== featured.id) : displayed;

  const totalCount = viewingUsername
    ? allStamps.filter((s) => !s.isRevoked && s.visibility !== 'private').length
    : Math.max(serverTotal, allStamps.length);

  const handleStampUpdated = useCallback((updated: PassportStampNew) => {
    setAllStamps((prev) => {
      const next = prev.map((s) => s.id === updated.id ? updated : s);
      allStampsRef.current = next;
      return next;
    });
    setSelected((prev) => prev?.id === updated.id ? updated : prev);
  }, []);

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
        {loading && allStamps.length === 0 ? (
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
      </View>

      {/* Category filter strip (shown for both views so public profiles can browse) */}
      <StampCategoryFilter selected={category} onCategoryChange={setCategory} />

      {/* Featured: most recent stamp (1x on top of the grid) */}
      {featured ? (() => {
        const legacy = toLegacy(featured);
        const location = [featured.city, featured.country].filter(Boolean).join(', ');
        return (
          <Pressable
            style={styles.featured}
            onPress={() => setSelected(featured)}
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
              {location ? (
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

      {/* Stamp grid */}
      <StampGrid
        stamps={gridStamps}
        loading={loading}
        error={error}
        isOwner={isOwner}
        onRetry={load}
        onStampPress={setSelected}
        emptyTitle={emptyTitle}
        emptySub={emptySub}
      />

      {/* Next-page loading indicator (infinite scroll) */}
      {loadingMore && (
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
