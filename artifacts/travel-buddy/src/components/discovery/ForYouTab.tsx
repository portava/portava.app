/**
 * For You tab — AI-backed recommendations from Telegraph.
 * Falls back to OSM attractions when Telegraph is unavailable or user is not signed in.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, RefreshControl, Linking,
} from 'react-native';
import { Sparkles, MapPin, Clock, Tag, Navigation, Plus, Info } from 'lucide-react-native';
import type { TelegraphRecommendation } from '../../services/telegraphRecommend';
import { getForYouRecommendations } from '../../services/telegraphRecommend';
import type { DiscoveryPlace } from '../../services/discovery';
import { getDiscoveryPlaces } from '../../services/discovery';
import { PlaceSkeletonList } from './PlaceSkeleton';
import { color, space, radius, type as t, shadow } from '../../theme/tokens';
import { useSession } from '../../context/SessionContext';

// ── Telegraph recommendation card ─────────────────────────────────────────────

interface ForYouCardProps {
  rec: TelegraphRecommendation;
  onAddToPlan: () => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  food:      '#D4722A',
  nightlife: '#7C3AED',
  beach:     '#0891B2',
  activity:  '#2E7D5B',
  hotel:     '#475569',
  transport: '#475569',
  tip:       '#B45309',
};

function ForYouCard({ rec, onAddToPlan }: ForYouCardProps) {
  const accent = CATEGORY_COLORS[rec.category] ?? color.signal;

  return (
    <View style={[fc.card, { borderLeftColor: accent }]}>
      {/* Why this? badge */}
      <View style={[fc.reasonBadge, { backgroundColor: accent + '18' }]}>
        <Info size={11} color={accent} />
        <Text style={[fc.reasonText, { color: accent }]} numberOfLines={2}>
          {rec.reason || 'Matches your travel style'}
        </Text>
      </View>

      {/* Title + category */}
      <Text style={fc.title} numberOfLines={2}>{rec.title}</Text>
      <View style={fc.meta}>
        {rec.category ? (
          <View style={[fc.catPill, { backgroundColor: accent + '22' }]}>
            <Tag size={10} color={accent} />
            <Text style={[fc.catText, { color: accent }]}>{rec.category}</Text>
          </View>
        ) : null}
        {rec.estimatedTime ? (
          <View style={fc.timeRow}>
            <Clock size={11} color={color.faint} />
            <Text style={fc.timeText}>{rec.estimatedTime}</Text>
          </View>
        ) : null}
        {rec.priceLevel && rec.priceLevel !== 'free' ? (
          <Text style={fc.price}>{rec.priceLevel}</Text>
        ) : null}
      </View>

      {/* Location context */}
      {rec.locationContext ? (
        <View style={fc.locRow}>
          <MapPin size={11} color={color.mute} />
          <Text style={fc.locText} numberOfLines={1}>{rec.locationContext}</Text>
        </View>
      ) : null}

      {/* Action */}
      <Pressable style={fc.addBtn} onPress={onAddToPlan}>
        <Plus size={15} color={color.signal} />
        <Text style={fc.addText}>Add to Plan</Text>
      </Pressable>
    </View>
  );
}

// ── OSM fallback card (when Telegraph unavailable) ────────────────────────────

interface FallbackCardProps {
  place: DiscoveryPlace;
  onAddToPlan: () => void;
}

function FallbackCard({ place, onAddToPlan }: FallbackCardProps) {
  const openMap = () => {
    if (place.lat != null && place.lng != null) {
      Linking.openURL(`https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lng}&zoom=17`).catch(() => {});
    }
  };

  return (
    <View style={fb.card}>
      <Text style={fb.name} numberOfLines={1}>{place.name}</Text>
      {place.type ? <Text style={fb.type}>{place.type}</Text> : null}
      {place.distanceKm != null && (
        <View style={fb.locRow}>
          <MapPin size={11} color={color.mute} />
          <Text style={fb.dist}>
            {place.distanceKm < 1 ? `${Math.round(place.distanceKm * 1000)}m` : `${place.distanceKm}km`}
          </Text>
        </View>
      )}
      <View style={fb.actions}>
        <Pressable style={fb.planBtn} onPress={onAddToPlan}>
          <Plus size={14} color={color.signal} />
          <Text style={fb.planText}>Add to Plan</Text>
        </Pressable>
        {place.lat != null && (
          <Pressable style={fb.dirBtn} onPress={openMap}>
            <Navigation size={14} color={color.deep} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface ForYouTabProps {
  destination: string;
  onAddToPlan: (item: { id: string; name: string; category: string }) => void;
}

export function ForYouTab({ destination, onAddToPlan }: ForYouTabProps) {
  const { isAuthed } = useSession();
  const [recs, setRecs]             = useState<TelegraphRecommendation[]>([]);
  const [fallback, setFallback]     = useState<DiscoveryPlace[]>([]);
  const [loading, setLoading]       = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [source, setSource]         = useState<'telegraph' | 'osm' | 'none'>('none');

  const load = useCallback(async (isRefresh = false) => {
    if (!destination) return;
    if (!isRefresh) setLoading(true);

    // 1. Try Telegraph (requires auth)
    if (isAuthed) {
      const res = await getForYouRecommendations({ destination, count: 8 });
      if (res.ok && res.recommendations.length > 0) {
        setRecs(res.recommendations);
        setSource('telegraph');
        setLoading(false);
        setRefreshing(false);
        return;
      }
    }

    // 2. Fall back to OSM for_you mix
    const osm = await getDiscoveryPlaces(destination, 'for_you', { radiusKm: 25, openNow: false, minRating: null });
    setLoading(false);
    setRefreshing(false);
    if (osm.ok && osm.data.places.length > 0) {
      setFallback(osm.data.places.slice(0, 15));
      setSource('osm');
    } else {
      setSource('none');
    }
  }, [destination, isAuthed]);

  useEffect(() => {
    setRecs([]);
    setFallback([]);
    setSource('none');
    load(false);
  }, [destination, isAuthed, load]);

  const handleRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  if (!destination) return null;

  if (loading && recs.length === 0 && fallback.length === 0) {
    return <PlaceSkeletonList count={5} />;
  }

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={color.signal} />
      }
    >
      {/* Source label */}
      <View style={styles.sourceRow}>
        <Sparkles size={14} color={color.signal} />
        <Text style={styles.sourceLabel}>
          {source === 'telegraph'
            ? 'Personalised recommendations · powered by Telegraph AI'
            : source === 'osm'
            ? 'Popular spots from OpenStreetMap · sign in for personalised picks'
            : 'Curated picks'}
        </Text>
      </View>

      {source === 'telegraph' && recs.map((rec) => (
        <ForYouCard
          key={rec.id}
          rec={rec}
          onAddToPlan={() => onAddToPlan({ id: rec.id, name: rec.title, category: rec.category })}
        />
      ))}

      {source === 'osm' && fallback.map((place) => (
        <FallbackCard
          key={place.id}
          place={place}
          onAddToPlan={() => onAddToPlan({ id: place.id, name: place.name, category: place.category })}
        />
      ))}

      {source === 'none' && (
        <View style={styles.empty}>
          <Sparkles size={28} color={color.faint} />
          <Text style={styles.emptyTitle}>No recommendations yet</Text>
          <Text style={styles.emptyDesc}>
            {isAuthed
              ? `We couldn't find recommendations for ${destination} right now. Try refreshing.`
              : `Sign in to get personalised recommendations for ${destination}.`}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const fc = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    borderLeftWidth: 4,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: space.md,
    gap: space.sm,
    ...shadow.card,
  },
  reasonBadge: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
    padding: space.sm,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  reasonText: {
    ...t.small,
    fontSize: 11,
    fontStyle: 'italic',
    flex: 1,
    lineHeight: 15,
  },
  title: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 15,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  catPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  catText: {
    ...t.stamp,
    fontSize: 10,
    textTransform: 'capitalize',
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  timeText: {
    ...t.stamp,
    color: color.faint,
    fontSize: 10,
  },
  price: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
    fontWeight: '700',
  },
  locRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  locText: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    flex: 1,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.signal + '50',
  },
  addText: {
    ...t.small,
    color: color.signal,
    fontWeight: '600',
    fontSize: 12,
  },
});

const fb = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: space.md,
    gap: space.xs,
  },
  name: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  type: { ...t.small, color: color.mute, fontSize: 12, textTransform: 'capitalize' },
  locRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dist: { ...t.stamp, color: color.faint, fontSize: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs },
  planBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    paddingHorizontal: space.md, paddingVertical: space.xs + 2,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal + '50',
  },
  planText: { ...t.small, color: color.signal, fontWeight: '600', fontSize: 12 },
  dirBtn: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
  },
});

const styles = StyleSheet.create({
  list: {
    paddingTop: space.md,
    paddingBottom: space.xxxl,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  sourceLabel: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    flex: 1,
    lineHeight: 16,
  },
  empty: {
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xxl,
    paddingTop: space.xxl,
  },
  emptyTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptyDesc: { ...t.small, color: color.mute, textAlign: 'center', lineHeight: 19 },
});

export default ForYouTab;
