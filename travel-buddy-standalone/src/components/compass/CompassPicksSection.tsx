/**
 * CompassPicksSection — horizontal card strip of Compass picks.
 *
 * Appears inside ForYouTab above community sections. Fetches from the
 * `compass_picks` section of the Compass feed and renders a horizontal
 * ScrollView of cards. Self-hides when empty, Compass is disabled, or
 * the feed call fails. A loading skeleton is shown while fetching.
 *
 * Each card exposes:
 *   • Type label + title
 *   • Reason / explanation text
 *   • Source label + optional trust label
 *   • Context-appropriate action button (Save / Join / Follow / View)
 *   • "Why this?" button → CompassWhySheet
 *   • Overflow menu → CompassFeedbackMenu (not now / hide / report …)
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { CachedImage } from '../CachedImage.tsx';
import { Sparkles, CheckCircle, Navigation, Settings2, MapPin, Calendar, User, Map, Users } from 'lucide-react-native';
import { router } from 'expo-router';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { useCompassFeed } from '../../hooks/compass/useCompassFeed.ts';
import { CompassWhySheet } from './CompassWhySheet.tsx';
import { CompassFeedbackMenu } from './CompassFeedbackMenu.tsx';
import { postCompassAnalyticsEvent, reportCompassViewed, COMPASS_ENGINE_VERSION } from '../../services/compass.ts';
import type { CompassFeedItem } from '../../services/compass.ts';
import { resolveCompassTitle, formatCompassSubtitle, formatCompassContext, resolveCompassCategory, resolveCompassImageUrl } from '../../utils/compassFormat.ts';
import { getPlaceCategoryFallback } from '../../utils/placeCategoryFallback.ts';

// ── Action label mapping ──────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  event:    'Join',
  traveler: 'Follow',
  place:    'Save',
  trip:     'View',
  buddy:    'Connect',
};

function actionLabel(type: string): string {
  return ACTION_LABELS[type] ?? 'View';
}

// ── Skeleton placeholder card ─────────────────────────────────────────────────

function CardSkeleton() {
  return (
    <View style={[s.card, s.skeletonCard]}>
      <View style={[s.skeletonBar, { width: '100%', height: 90, borderRadius: radius.sm, marginBottom: space.xs }]} />
      <View style={[s.skeletonBar, { width: 54, height: 9, marginBottom: 6 }]} />
      <View style={[s.skeletonBar, { width: 110, height: 12, marginBottom: space.sm }]} />
      <View style={[s.skeletonBar, { width: 90, height: 9, marginBottom: space.sm }]} />
      <View style={[s.skeletonBar, { width: 70, height: 28, borderRadius: radius.md }]} />
    </View>
  );
}

// ── Generic hero fallback (non-place types, no image or broken image) ─────────

const GENERIC_FALLBACK_ICONS: Record<string, React.ComponentType<{ size: number; color: string }>> = {
  event:    Calendar,
  traveler: User,
  user:     User,
  trip:     Map,
  buddy:    Users,
};

interface GenericFallbackProps { type: string; itemId: string }

function GenericHeroFallback({ type, itemId }: GenericFallbackProps) {
  const Icon = GENERIC_FALLBACK_ICONS[type] ?? Sparkles;
  return (
    <View
      style={[s.emojiHeader, s.genericFallback]}
      testID={`compass-pick-generic-fallback-${itemId}`}
    >
      <Icon size={28} color={color.mute} />
    </View>
  );
}

function resolveCompassFallbackCategory(item: CompassFeedItem): string {
  const cat  = (item.category ?? '').trim();
  if (cat) return cat;
  const type = item.type ?? '';
  if (type === 'event')                                        return 'events';
  if (type === 'traveler' || type === 'user' || type === 'buddy') return 'for_you';
  if (type === 'hidden_gem')                                   return 'places';
  if (type === 'trip')                                         return 'outdoors';
  return 'places';
}

// ── Individual compass pick card ──────────────────────────────────────────────

interface CardProps {
  item:        CompassFeedItem;
  sectionName: string;
  onWhyPress:  () => void;
  onDismiss:   () => void;
  onRestore:   () => void;
}

function CompassPickCard({ item, sectionName, onWhyPress, onDismiss, onRestore }: CardProps) {
  const source     = (item.data?.source as string) ?? null;
  const trustLabel = (item.data?.trustLabel as string) ?? null;
  const title      = resolveCompassTitle(item);
  const subtitle   = formatCompassSubtitle(item);
  const city       = (item.data?.city as string) ?? null;

  // Place-specific enrichment
  const isPlace      = (item.type ?? '') === 'place';
  const placeAddress = isPlace
    ? ((item.data?.neighborhood as string | undefined) ?? (item.data?.address as string | undefined) ?? null)
    : null;
  const imageUrl = resolveCompassImageUrl(item);
  // Category fallback applies to ALL item types — every card gets a header.
  const categoryFallback = getPlaceCategoryFallback(resolveCompassFallbackCategory(item));

  // Track hero image load errors so we can fall back to the emoji/color strip
  const [imageError, setImageError] = useState(false);

  function navigateToItem() {
    // Fire-and-forget "viewed" outcome — the user actually opened the card.
    reportCompassViewed(item.recommendationToken, item.id);
    const type = item.type ?? '';
    if (type === 'event') {
      router.push(`/event/${item.id}` as any);
    } else if (type === 'hidden_gem') {
      const rawId = (item.data?.id as string | undefined) ?? item.id.replace(/^gem:/, '');
      router.push(`/gems/${rawId}` as any);
    } else if (type === 'place') {
      router.push('/(tabs)/discovery' as any);
    } else if (type === 'traveler' || type === 'user') {
      const handle = (item.data?.username as string | undefined) ?? (item.data?.handle as string | undefined);
      router.push((handle ? `/u/${encodeURIComponent(handle)}` : '/(tabs)/discovery') as any);
    } else if (type === 'post') {
      router.push(`/post/${item.id}` as any);
    } else {
      router.push('/(tabs)/ai' as any);
    }
  }

  function handleActionTap() {
    postCompassAnalyticsEvent({
      event_name:             'compass_card_tapped',
      compass_engine_version: COMPASS_ENGINE_VERSION,
      item_id:                item.id,
      item_type:              item.type ?? 'place',
      section_name:           sectionName,
      city:                   city ?? undefined,
    });
    navigateToItem();
  }

  return (
    <Pressable style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]} onPress={navigateToItem}>
      {/* Hero image when the server provides one; emoji+colour header for all items */}
      {imageUrl && !imageError ? (
        <CachedImage
          source={{ uri: imageUrl }}
          style={s.heroImage}
          resizeMode="cover"
          accessibilityLabel={title}
          testID={`compass-pick-image-${item.id}`}
          onError={() => setImageError(true)}
        />
      ) : isPlace ? (
        // Place items always fall back to the emoji/colour header.
        <View
          style={[s.emojiHeader, { backgroundColor: categoryFallback.color + '22' }]}
          testID={`compass-pick-emoji-${item.id}`}
        >
          <Text style={s.emojiText}>{categoryFallback.emoji}</Text>
        </View>
      ) : (
        // Non-place items (event, traveler, trip, buddy): show a type-keyed
        // icon on a neutral tinted background — never a blank gap.
        <GenericHeroFallback type={item.type ?? ''} itemId={item.id} />
      )}

      {/* Row 1: type chip + overflow menu */}
      <View style={s.typeRow}>
        <View style={s.typeChip}>
          <Text style={s.typeText}>{resolveCompassCategory(item) || (item.type ?? 'pick')}</Text>
        </View>
        <View style={{ flex: 1 }} />
        <CompassFeedbackMenu
          recommendationId={item.recommendationToken ?? item.id}
          itemId={item.id}
          itemType={item.type ?? 'place'}
          category={item.category ?? undefined}
          city={city ?? undefined}
          sectionName={sectionName}
          onWhyPress={onWhyPress}
          onDismiss={onDismiss}
          onRestore={onRestore}
        />
      </View>

      {/* Title */}
      <Text style={s.cardTitle} numberOfLines={2}>{title}</Text>

      {/* Real metadata line (date/time + status + city + category) */}
      {subtitle ? (
        <View style={s.cityRow}>
          <Navigation size={9} color={color.faint} />
          <Text style={s.cityText} numberOfLines={1}>{subtitle}</Text>
        </View>
      ) : null}

      {/* Address / neighborhood for place picks */}
      {placeAddress ? (
        <View style={s.cityRow}>
          <MapPin size={9} color={color.faint} />
          <Text style={s.cityText} numberOfLines={1} testID="compass-pick-address">{placeAddress}</Text>
        </View>
      ) : null}

      {/* Reason / context */}
      <Pressable style={s.reasonPill} onPress={onWhyPress} hitSlop={4}>
        <Sparkles size={9} color={color.signal} />
        <Text style={s.reasonText} numberOfLines={2}>{formatCompassContext(item)}</Text>
      </Pressable>

      {/* Source + trust */}
      {(source || trustLabel) ? (
        <View style={s.metaRow}>
          {source ? <Text style={s.sourceText} numberOfLines={1}>{source}</Text> : null}
          {trustLabel ? (
            <View style={s.trustPill}>
              <CheckCircle size={9} color={color.success} />
              <Text style={s.trustText}>{trustLabel}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Action button */}
      <Pressable style={s.actionBtn} onPress={handleActionTap}>
        <Text style={s.actionText}>{actionLabel(item.type ?? '')}</Text>
      </Pressable>
    </Pressable>
  );
}

// ── Section header with optional city display ─────────────────────────────────

interface SectionHeaderProps {
  city: string | null;
  onSwitchCity?: () => void;
}

function SectionHeader({ city, onSwitchCity }: SectionHeaderProps) {
  return (
    <View style={s.header}>
      <Sparkles size={12} color={color.signal} />
      <Text style={s.sectionTitle}>Compass Picks</Text>
      {city ? (
        <Pressable style={s.cityPill} onPress={onSwitchCity} hitSlop={6}>
          <Navigation size={9} color={color.signal} />
          <Text style={s.cityPillText}>{city}</Text>
        </Pressable>
      ) : null}
      <Pressable
        style={s.gearBtn}
        onPress={() => router.push('/compass-preferences' as any)}
        hitSlop={8}
        accessibilityLabel="Compass settings"
      >
        <Settings2 size={14} color={color.mute} />
      </Pressable>
    </View>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

interface CompassPicksSectionProps {
  city: string | null;
  compassCity?: string | null;
  enabled?: boolean;
  onSwitchCity?: () => void;
}

export function CompassPicksSection({
  city,
  compassCity,
  enabled = true,
  onSwitchCity,
}: CompassPicksSectionProps) {
  const effectiveCity = compassCity ?? city;

  const compass = useCompassFeed({
    section: 'compass_picks',
    city: effectiveCity ?? undefined,
    enabled,
  });

  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [whyId, setWhyId]         = useState<string | null>(null);
  const [whyOpen, setWhyOpen]     = useState(false);

  // Compute display items before the analytics effect so the effect can read them
  const sectionItems: CompassFeedItem[] = (compass.data?.sections ?? [])
    .flatMap((sec) => sec.items ?? []);
  const safeItems: CompassFeedItem[] = compass.data?.safeItems ?? [];
  const raw = sectionItems.length > 0 ? sectionItems : safeItems;
  const displayItems = raw.filter((item) => !dismissed.has(item.id));

  // Fire compass_card_viewed once per batch when items first appear
  const viewedBatchRef = useRef<string>('');
  useEffect(() => {
    if (displayItems.length === 0) return;
    const batchKey = displayItems.slice(0, 8).map((i) => i.id).join(',');
    if (batchKey === viewedBatchRef.current) return;
    viewedBatchRef.current = batchKey;
    postCompassAnalyticsEvent({
      event_name:             'compass_card_viewed',
      compass_engine_version: COMPASS_ENGINE_VERSION,
      section_name:           'compass_picks',
      city:                   effectiveCity ?? undefined,
      metadata:               { count: Math.min(displayItems.length, 8) },
    });
  }, [displayItems, effectiveCity]);

  // Never render if Compass is disabled
  if (!enabled) return null;
  if (!compass.compassEnabled && !compass.loading) return null;

  // Loading skeleton — show while initial load is in progress
  if (compass.loading && !compass.data) {
    return (
      <View style={s.container}>
        <SectionHeader city={effectiveCity} onSwitchCity={onSwitchCity} />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.row}
        >
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </ScrollView>
      </View>
    );
  }

  // Nothing to show — hide silently (no error state)
  if (displayItems.length === 0) return null;

  return (
    <>
      <View style={s.container}>
        <SectionHeader city={effectiveCity} onSwitchCity={onSwitchCity} />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.row}
        >
          {displayItems.slice(0, 8).map((item) => (
            <CompassPickCard
              key={item.id}
              item={item}
              sectionName="compass_picks"
              onWhyPress={() => {
                setWhyId(item.recommendationToken ?? item.id);
                setWhyOpen(true);
              }}
              onDismiss={() =>
                setDismissed((prev) => {
                  const next = new Set(prev);
                  next.add(item.id);
                  return next;
                })
              }
              onRestore={() =>
                setDismissed((prev) => {
                  const next = new Set(prev);
                  next.delete(item.id);
                  return next;
                })
              }
            />
          ))}
        </ScrollView>
      </View>

      <CompassWhySheet
        visible={whyOpen}
        recommendationId={whyId}
        onClose={() => { setWhyOpen(false); setWhyId(null); }}
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: {
    marginTop: space.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  sectionTitle: {
    ...t.stamp,
    color: color.ink,
    fontSize: 12,
    fontWeight: '700' as const,
    letterSpacing: 0.3,
    textTransform: 'uppercase' as const,
    flex: 1,
  },
  cityPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: color.signal + '12',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  cityPillText: {
    ...t.small,
    color: color.signal,
    fontSize: 10,
    fontWeight: '600' as const,
  },
  gearBtn: {
    padding: 4,
    marginLeft: space.xs,
  },
  row: {
    paddingHorizontal: space.lg,
    gap: space.sm,
    paddingRight: space.xl,
  },
  // Hero image — shown when the server sends an imageUrl
  heroImage: {
    width: '100%' as const,
    height: 90,
    borderRadius: radius.sm,
    marginBottom: 2,
  },
  // Full-width emoji+colour header — shown for place cards when no real image
  emojiHeader: {
    width: '100%' as const,
    height: 90,
    borderRadius: radius.sm,
    marginBottom: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Generic icon fallback — shown for non-place cards (event/traveler/trip/buddy)
  // when imageUrl is absent or fires onError; neutral tint keeps the card tidy.
  genericFallback: {
    backgroundColor: color.haze,
  },
  emojiText: {
    fontSize: 34,
  },
  // Card
  card: {
    width: 168,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
  },
  skeletonCard: {
    opacity: 0.55,
  },
  skeletonBar: {
    backgroundColor: color.haze,
    borderRadius: 4,
  },
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  typeChip: {
    backgroundColor: color.signal + '15',
    borderRadius: radius.pill,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  typeText: {
    ...t.small,
    color: color.signal,
    fontSize: 9,
    fontWeight: '700' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
  },
  cardTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 13,
    lineHeight: 17,
  },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  cityText: {
    ...t.small,
    color: color.faint,
    fontSize: 10,
  },
  reasonPill: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 3,
    backgroundColor: color.signal + '08',
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  reasonText: {
    ...t.small,
    color: color.signal,
    fontSize: 10,
    fontStyle: 'italic',
    lineHeight: 13,
    flex: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  sourceText: {
    ...t.small,
    color: color.mute,
    fontSize: 10,
    flex: 1,
  },
  trustPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: color.success + '15',
    borderRadius: radius.pill,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  trustText: {
    ...t.small,
    color: color.success,
    fontSize: 9,
    fontWeight: '600' as const,
  },
  actionBtn: {
    marginTop: 2,
    backgroundColor: color.ink,
    borderRadius: radius.sm,
    paddingVertical: 7,
    alignItems: 'center',
  },
  actionText: {
    ...t.small,
    color: color.onInk,
    fontWeight: '700' as const,
    fontSize: 11,
  },
});
