/**
 * MediaPerspectiveViewerScreen — the §14 CONTEXTUAL media viewer.
 *
 * This is NOT a TikTok-style vertical stranger-video feed (§46.2). It opens on
 * the perspective the user tapped and lets them move between the OTHER
 * perspectives of the SAME entity — the collection is scoped to the entry
 * context (a Place's other perspectives when opened from a Place, etc.), never a
 * global engagement-ranked feed. Each frame shows, per §14:
 *   ← An Thuong                                   •••
 *   [            MEDIA (poster — no autoplay)            ]
 *   Perspective: Street · 4 min ago
 *   Maya ✓  · Trusted nightlife contributor
 *   "It's filling up fast."
 *   Stamp   View Place   Ask Compass
 *   RELATED PERSPECTIVES   [Entrance] [Rooftop] [Street] [Club]
 *
 * It reuses IntelligenceStrip (evidence class + freshness + perspective label)
 * and StampButton; it never plays full-screen stranger video on open (§46.2) —
 * video renders its poster with a play affordance. It degrades cleanly (§33/§39):
 * an empty / missing collection shows a clean empty state and never throws.
 *
 * Additive: the existing generic media viewer (app/media-viewer/[id]) and the
 * media tab are untouched; this is a separate, shell-only surface.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  Dimensions,
  FlatList,
  type ViewToken,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, MoreHorizontal, Play, MapPin, Compass, Check } from 'lucide-react-native';

import { color, space, radius, avatar, icon, dot } from '../../../theme/tokens.ts';
import { CachedImage } from '../../../components/CachedImage.tsx';
import { Avatar } from '../../../components/ui/Avatar.tsx';
import { StampButton } from '../../../components/stamps/StampButton.tsx';

import { IntelligenceStrip } from '../components/IntelligenceStrip.tsx';
import type { MediaProjection } from '../types/media.ts';
import type {
  BuildPerspectiveCollectionInput,
  PerspectiveCollection,
} from '../state/perspectiveViewer.ts';
import {
  buildPerspectiveCollection,
  isEmptyCollection,
  clampIndex,
  initialIndexForMedia,
  activeGroupKeyAt,
  groupLabelFor,
  firstIndexOfGroup,
  relatedPerspectives,
} from '../state/perspectiveViewer.ts';
import { relativeAgeLabel } from '../state/freshness.ts';

const { width: SCREEN_W } = Dimensions.get('window');

export interface MediaPerspectiveViewerScreenProps {
  /** Raw entry-context inputs (kind, entity, groups, media). Null → empty state. */
  input: BuildPerspectiveCollectionInput | null;
  /** The tapped media id; the viewer opens on it (falls back to the first). */
  initialMediaId: string | null;
  onClose: () => void;
  /** §14 "View Place" — open the entity's place screen (when a place id is known). */
  onViewPlace?: (placeId: string) => void;
  /** §14 "Ask Compass" — hand the entity to Compass. */
  onAskCompass?: (entityId: string | null) => void;
}

export function MediaPerspectiveViewerScreen({
  input,
  initialMediaId,
  onClose,
  onViewPlace,
  onAskCompass,
}: MediaPerspectiveViewerScreenProps) {
  const insets = useSafeAreaInsets();

  // Build the entry-context collection once (pure; never throws on partial data).
  const collection = useMemo<PerspectiveCollection | null>(
    () => (input ? buildPerspectiveCollection(input) : null),
    [input],
  );

  const empty = isEmptyCollection(collection);

  const [activeIndex, setActiveIndex] = useState(() =>
    collection ? initialIndexForMedia(collection, initialMediaId) : 0,
  );

  const listRef = useRef<FlatList<MediaProjection>>(null);
  // Pinned identity — FlatList requires onViewableItemsChanged to be stable.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    if (viewableItems.length > 0) setActiveIndex(viewableItems[0].index ?? 0);
  }).current;

  const jumpToIndex = useCallback((index: number) => {
    setActiveIndex(index);
    // Best-effort — the viewable-items callback keeps activeIndex authoritative.
    try {
      listRef.current?.scrollToIndex({ index, animated: true });
    } catch {
      /* index momentarily out of range during layout — ignore */
    }
  }, []);

  // ── Empty / degraded state ────────────────────────────────────────────────
  if (empty || !collection) {
    return (
      <View style={styles.screen}>
        <TopBar entityLabel={input?.entityLabel ?? null} onClose={onClose} insetsTop={insets.top} />
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyTitle}>No perspective to show</Text>
          <Text style={styles.emptyBody}>
            This view isn't available right now. Your other lenses still work.
          </Text>
        </View>
      </View>
    );
  }

  const safeIndex = clampIndex(collection, activeIndex);
  const activeMedia = collection.items[safeIndex] ?? null;
  const activeKey = activeGroupKeyAt(collection, safeIndex);
  const activeLabel = groupLabelFor(collection, activeKey);
  const related = relatedPerspectives(collection, safeIndex);
  const entityLabel = collection.entityLabel ?? input?.entityLabel ?? null;

  return (
    <View style={styles.screen}>
      {/* Horizontal pager over the entry-context collection (NOT a global feed). */}
      <FlatList<MediaProjection>
        ref={listRef}
        data={collection.items}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={SCREEN_W}
        snapToAlignment="center"
        initialScrollIndex={safeIndex}
        getItemLayout={(_, index) => ({ length: SCREEN_W, offset: SCREEN_W * index, index })}
        keyExtractor={(m, i) => m.id || `p${i}`}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        windowSize={3}
        maxToRenderPerBatch={2}
        initialNumToRender={2}
        renderItem={({ item }) => <PerspectiveFrame media={item} />}
      />

      {/* Top bar — back to the entity + overflow. */}
      <TopBar entityLabel={entityLabel} onClose={onClose} insetsTop={insets.top} />

      {/* Bottom contextual overlay. */}
      <View
        style={[styles.overlay, { paddingBottom: Math.max(insets.bottom + space.md, space.xl) }]}
        pointerEvents="box-none"
      >
        {activeMedia ? (
          <PerspectiveContext
            media={activeMedia}
            perspectiveLabel={activeLabel}
            entityId={collection.entityId}
            onViewPlace={onViewPlace}
            onAskCompass={onAskCompass}
          />
        ) : null}

        {/* RELATED PERSPECTIVES — jump between the entity's other groups (§14). */}
        {collection.grouped && related.length > 0 ? (
          <View style={styles.relatedBlock}>
            <Text style={styles.relatedHeading}>Related perspectives</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.relatedChips}
            >
              {related.map((r) => (
                <Pressable
                  key={r.key}
                  style={[styles.chip, r.active && styles.chipActive]}
                  onPress={() => jumpToIndex(firstIndexOfGroup(collection, r.key))}
                  accessibilityRole="button"
                  accessibilityState={{ selected: r.active }}
                  accessibilityLabel={`${r.label} perspectives`}
                >
                  <Text style={[styles.chipText, r.active && styles.chipTextActive]}>{r.label}</Text>
                  {r.count > 0 ? (
                    <Text style={[styles.chipCount, r.active && styles.chipTextActive]}>{r.count}</Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ── Top bar ───────────────────────────────────────────────────────────────────

function TopBar({
  entityLabel,
  onClose,
  insetsTop,
}: {
  entityLabel: string | null;
  onClose: () => void;
  insetsTop: number;
}) {
  return (
    <View style={[styles.topBar, { paddingTop: insetsTop + space.sm }]} pointerEvents="box-none">
      <Pressable
        style={styles.iconBtn}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={8}
      >
        <ChevronLeft size={22} color={color.onInk} strokeWidth={2.5} />
      </Pressable>
      {entityLabel ? (
        <Text style={styles.topTitle} numberOfLines={1}>
          {entityLabel}
        </Text>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      <View style={styles.iconBtn} pointerEvents="none">
        <MoreHorizontal size={20} color={color.onInk} strokeWidth={2.2} />
      </View>
    </View>
  );
}

// ── One media frame (poster; no autoplay — §46.2) ─────────────────────────────

function PerspectiveFrame({ media }: { media: MediaProjection }) {
  const uri = media.url ?? media.thumbnailUrl ?? null;
  return (
    <View style={styles.frame}>
      {uri ? (
        <CachedImage source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" fallbackLabel="" />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.frameFallback]} />
      )}
      {media.mediaType === 'video' ? (
        <View style={styles.playBadge} pointerEvents="none">
          <Play size={16} color={color.onInk} strokeWidth={2.2} fill={color.onInk} />
        </View>
      ) : null}
    </View>
  );
}

// ── Contextual overlay body: perspective + contributor + note + actions ───────

function PerspectiveContext({
  media,
  perspectiveLabel,
  entityId,
  onViewPlace,
  onAskCompass,
}: {
  media: MediaProjection;
  perspectiveLabel: string | null;
  entityId: string | null;
  onViewPlace?: (placeId: string) => void;
  onAskCompass?: (entityId: string | null) => void;
}) {
  const contributor = media.contributor ?? null;
  const age = media.freshnessLabel ?? relativeAgeLabel(media.ageMinutes);
  // "Perspective: Street · 4m ago" — the §14 contextual headline.
  const headline = perspectiveLabel
    ? age
      ? `Perspective: ${perspectiveLabel} · ${age}`
      : `Perspective: ${perspectiveLabel}`
    : age
      ? `Perspective · ${age}`
      : 'Perspective';

  // A View Place target only when this entry context is a real canonical place.
  const placeId = media.place?.id ?? entityId ?? null;

  return (
    <View style={styles.contextBlock}>
      <Text style={styles.headline}>{headline}</Text>

      {/* Evidence class + freshness + perspective group — reused, honest strip. */}
      <IntelligenceStrip
        observationClass={media.observationClass}
        freshness={media.freshness}
        ageMinutes={media.ageMinutes}
        perspectiveLabel={perspectiveLabel}
      />

      {/* Contributor + trust context — visible but secondary (§14/§46). */}
      {contributor ? (
        <View style={styles.contributorRow}>
          <Avatar
            uri={contributor.avatarUrl}
            name={contributor.displayName}
            size={avatar.s40}
            style={styles.avatarRing}
          />
          <View style={styles.contributorText}>
            <View style={styles.contributorNameRow}>
              <Text style={styles.contributorName} numberOfLines={1}>
                {contributor.displayName}
              </Text>
              {contributor.verified ? (
                <View style={styles.verifiedDot}>
                  <Check size={10} color={color.ink} strokeWidth={3} />
                </View>
              ) : null}
            </View>
            {contributor.trustLabel ? (
              <Text style={styles.trustLabel} numberOfLines={1}>
                {contributor.trustLabel}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {/* On-the-ground note — "It's filling up fast." (§14). */}
      {media.note ? (
        <Text style={styles.note} numberOfLines={3}>
          “{media.note}”
        </Text>
      ) : null}

      {/* Actions — the media connects to a social contribution + context (§2/§14/§15). */}
      <View style={styles.actionRow}>
        {media.id ? (
          <StampButton
            key={media.id}
            entityType="media"
            entityId={media.id}
            initialCount={0}
            initialIsStamped={false}
            iconSize={22}
            style={styles.stampBtn}
          />
        ) : null}

        {onViewPlace && placeId ? (
          <Pressable
            style={styles.pillBtn}
            onPress={() => onViewPlace(placeId)}
            accessibilityRole="button"
            accessibilityLabel="View place"
          >
            <MapPin size={14} color={color.onInk} strokeWidth={2} />
            <Text style={styles.pillText}>View Place</Text>
          </Pressable>
        ) : null}

        {onAskCompass ? (
          <Pressable
            style={styles.pillBtn}
            onPress={() => onAskCompass(entityId)}
            accessibilityRole="button"
            accessibilityLabel="Ask Compass"
          >
            <Compass size={14} color={color.onInk} strokeWidth={2} />
            <Text style={styles.pillText}>Ask Compass</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.ink },

  // Top bar
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    zIndex: 10,
  },
  iconBtn: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    backgroundColor: 'rgba(17,17,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: {
    flex: 1,
    color: color.onInk,
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: -0.3,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // Media frame
  frame: {
    width: SCREEN_W,
    flex: 1,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  frameFallback: { backgroundColor: '#1B1B18' },
  playBadge: {
    width: icon.s26,
    height: icon.s26,
    borderRadius: icon.s26 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(17,17,15,0.5)',
  },

  // Bottom overlay
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: space.md,
    paddingTop: space.lg,
    backgroundColor: 'rgba(17,17,15,0.62)',
  },
  contextBlock: { paddingHorizontal: space.lg, gap: space.sm },
  headline: {
    color: color.onInk,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.2,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // Contributor
  contributorRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  avatarRing: { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.6)' },
  contributorText: { flex: 1 },
  contributorNameRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  contributorName: { color: color.onInk, fontSize: 14, fontWeight: '800', letterSpacing: -0.2, flexShrink: 1 },
  verifiedDot: {
    width: dot.s12,
    height: dot.s12,
    borderRadius: dot.s12 / 2,
    backgroundColor: color.onInk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trustLabel: { color: color.onInkMute, fontSize: 12, fontWeight: '600', marginTop: 1 },

  note: { color: color.onInk, fontSize: 15, fontStyle: 'italic', lineHeight: 20 },

  // Actions
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', marginTop: space.xs },
  stampBtn: { alignItems: 'center', justifyContent: 'center' },
  pillBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.14)',
  },
  pillText: { color: color.onInk, fontSize: 13, fontWeight: '700' },

  // Related perspectives
  relatedBlock: { gap: space.xs },
  relatedHeading: {
    color: color.onInkMute,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    paddingHorizontal: space.lg,
  },
  relatedChips: { gap: space.sm, paddingHorizontal: space.lg },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.10)',
  },
  chipActive: { backgroundColor: color.onInk },
  chipText: { color: color.onInkMute, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: color.ink },
  chipCount: { color: color.faint, fontSize: 12, fontWeight: '700' },

  // Empty state
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl, gap: space.sm },
  emptyTitle: { color: color.onInk, fontSize: 17, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center' },
  emptyBody: { color: color.onInkMute, fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
