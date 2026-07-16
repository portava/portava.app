/**
 * StampsTab — refactored to compose StampCategoryFilter, StampGrid,
 * and StampDetailModal. Fetches live stamp data from the API and
 * falls back to legacy PassportStamp[] prop when the fetch hasn't
 * returned yet (first paint).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import type { PassportStamp } from '../types/models.ts';
import type { PassportStampNew } from '../services/passportStamps.ts';
import { getMyPassportStamps, getUserStampsByUsername } from '../services/passportStamps.ts';
import { getMyProgress } from '../services/stamps.ts';
import type { StampProgress } from '../services/stamps.ts';
import { useBlockedIds } from '../context/BlockedIdsContext.tsx';
import { StampCategoryFilter } from './stamps/StampCategoryFilter.tsx';
import type { StampCategory } from './stamps/StampCategoryFilter.tsx';
import { StampGrid } from './stamps/StampGrid.tsx';
import { StampDetailModal } from './stamps/StampDetailModal.tsx';
import { color, space, radius, type as t } from '../theme/tokens.ts';

/** Client-side category filter — maps new category slugs to stamp fields. */
function matchesCategory(stamp: PassportStampNew, cat: StampCategory): boolean {
  if (!cat) return true;
  const definitionCat = stamp.definition?.category ?? '';
  const sType = stamp.stampType;

  if (cat === 'location') {
    return (
      ['city', 'neighborhood', 'check_in'].includes(sType) ||
      definitionCat === 'location'
    );
  }
  if (cat === 'trips') {
    return (
      ['trip_crew', 'plan', 'trip'].includes(sType) ||
      definitionCat === 'trips'
    );
  }
  if (cat === 'events') {
    return sType === 'event' || definitionCat === 'events';
  }
  if (cat === 'social') {
    return sType === 'social' || definitionCat === 'social';
  }
  if (cat === 'safety') {
    return sType === 'safe_return' || definitionCat === 'safety';
  }
  if (cat === 'rent_buddy') {
    return sType === 'host' || definitionCat === 'rent_buddy';
  }
  return true;
}

interface StampsTabProps {
  stamps?: PassportStamp[];
  viewingUsername?: string;
  /** UUID of the profile being viewed — used for block detection. */
  viewingUserId?: string;
  isOwner?: boolean;
}

export function StampsTab({ stamps: _legacyStamps = [], viewingUsername, viewingUserId, isOwner = false }: StampsTabProps) {
  // All hooks must be declared before any early return (Rules of Hooks).
  const { blockedIds, blockerIds } = useBlockedIds();
  const [allStamps, setAllStamps]     = useState<PassportStampNew[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [category, setCategory]       = useState<StampCategory>('');
  const [selected, setSelected]       = useState<PassportStampNew | null>(null);
  const [progress, setProgress]       = useState<StampProgress | null>(null);

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
    } else {
      setError(res.message);
    }
  }, [viewingUsername]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!isOwner || viewingUsername) return;
    getMyProgress().then((res) => { if (res.ok) setProgress(res.data); }).catch(() => {});
  }, [isOwner, viewingUsername]);

  const displayed = allStamps.filter((s) => {
    if (viewingUsername && (s.isRevoked || s.visibility === 'private')) return false;
    return matchesCategory(s, category);
  });

  const totalCount = viewingUsername
    ? allStamps.filter((s) => !s.isRevoked && s.visibility !== 'private').length
    : allStamps.length;

  const handleStampUpdated = useCallback((updated: PassportStampNew) => {
    setAllStamps((prev) => prev.map((s) => s.id === updated.id ? updated : s));
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

      {/* Stamp grid */}
      <StampGrid
        stamps={displayed}
        loading={loading}
        error={error}
        isOwner={isOwner}
        onRetry={load}
        onStampPress={setSelected}
        emptyTitle={emptyTitle}
        emptySub={emptySub}
      />

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
});
