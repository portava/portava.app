/**
 * CompassBuddyRow — horizontal strip of Compass-matched Rent a Buddy cards.
 *
 * Shows up to 4 Compass-recommended buddies above the category grid on the
 * Rent a Buddy search screen. Self-hides when:
 *   - show_buddy_recommendations is false in compass_settings
 *   - the API returns 0 results
 *   - loading fails
 *
 * Tapping a card routes to /(rent-a-buddy)/buddy/[id].
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Image,
} from 'react-native';
import { router } from 'expo-router';
import { Sparkles, Star, CheckCircle, MapPin, Globe } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import {
  fetchCompassSettings,
  fetchCompassBuddyMatches,
  type CompassBuddyResult,
} from '../../services/compass';

interface Props {
  city?: string | null;
}

function BuddySkeleton() {
  return (
    <View style={[s.card, s.skeleton]}>
      <View style={[s.skBar, { width: 56, height: 56, borderRadius: 28, marginBottom: space.sm }]} />
      <View style={[s.skBar, { width: 80, height: 10, marginBottom: 6 }]} />
      <View style={[s.skBar, { width: 60, height: 8, marginBottom: space.sm }]} />
      <View style={[s.skBar, { width: 70, height: 24, borderRadius: radius.md }]} />
    </View>
  );
}

function BuddyCard({ item }: { item: CompassBuddyResult }) {
  const d = item.data;
  const topCat = item.category ?? 'city';
  const rating = d.averageRating != null ? d.averageRating.toFixed(1) : null;

  return (
    <Pressable
      style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}
      onPress={() => router.push(`/(rent-a-buddy)/buddy/${item.id}` as any)}
    >
      {/* Avatar / cover photo */}
      <View style={s.avatarWrap}>
        {d.coverPhotoUrl ? (
          <Image source={{ uri: d.coverPhotoUrl }} style={s.avatar} />
        ) : (
          <View style={[s.avatar, s.avatarPlaceholder]}>
            <Text style={s.avatarInitial}>
              {(item.title ?? 'B').charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        {d.verified && (
          <View style={s.verifiedBadge}>
            <CheckCircle size={11} color={color.success} fill={color.paper} />
          </View>
        )}
      </View>

      {/* Name */}
      <Text style={s.name} numberOfLines={1}>{item.title ?? 'Buddy'}</Text>

      {/* Category chip */}
      <View style={s.catChip}>
        <Text style={s.catText} numberOfLines={1}>{topCat}</Text>
      </View>

      {/* Availability badge */}
      {d.availabilityStatus !== 'not_available' ? (
        <View style={[
          s.availBadge,
          d.availabilityStatus === 'available_today' ? s.availToday : s.availWeek,
        ]}>
          <Text style={s.availText}>
            {d.availabilityStatus === 'available_today' ? 'Today' : 'This week'}
          </Text>
        </View>
      ) : null}

      {/* Rating */}
      {rating ? (
        <View style={s.ratingRow}>
          <Star size={9} color={color.warn} fill={color.warn} />
          <Text style={s.ratingText}>{rating}</Text>
          {d.reviewCount > 0 && (
            <Text style={s.reviewCount}>({d.reviewCount})</Text>
          )}
        </View>
      ) : null}

      {/* Language chip */}
      {d.languages && d.languages.length > 0 ? (
        <View style={s.langRow}>
          <Globe size={8} color={color.mute} />
          <Text style={s.langText} numberOfLines={1}>
            {d.languages.slice(0, 2).join(', ')}
          </Text>
        </View>
      ) : null}

      {/* City */}
      {item.city ? (
        <View style={s.cityRow}>
          <MapPin size={8} color={color.faint} />
          <Text style={s.cityText} numberOfLines={1}>{item.city}</Text>
        </View>
      ) : null}

      {/* Reason pill */}
      <View style={s.reasonPill}>
        <Sparkles size={8} color={color.signal} />
        <Text style={s.reasonText} numberOfLines={2}>{item.reason}</Text>
      </View>
    </Pressable>
  );
}

export function CompassBuddyRow({ city }: Props) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<CompassBuddyResult[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Settings gate — skip buddy API call if setting is off
      const settingsRes = await fetchCompassSettings();
      if (!cancelled && settingsRes.ok && settingsRes.data?.show_buddy_recommendations === false) {
        setLoading(false);
        return;
      }

      const res = await fetchCompassBuddyMatches({ city, limit: 4 });
      if (!cancelled) {
        setItems((res.ok && !res.disabled) ? (res.data ?? []) : []);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [city]);

  if (loading) {
    return (
      <View style={s.wrap}>
        <View style={s.header}>
          <Sparkles size={13} color={color.signal} />
          <Text style={s.headerText}>Compass Picks</Text>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.strip}>
          <BuddySkeleton />
          <BuddySkeleton />
          <BuddySkeleton />
        </ScrollView>
      </View>
    );
  }

  if (items.length === 0) return null;

  return (
    <View style={s.wrap}>
      <View style={s.header}>
        <Sparkles size={13} color={color.signal} />
        <Text style={s.headerText}>Compass Picks</Text>
        <Text style={s.headerSub}>· matched for you</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.strip}>
        {items.map((item) => (
          <BuddyCard key={item.id} item={item} />
        ))}
      </ScrollView>
    </View>
  );
}

const CARD_W = 130;

const s = StyleSheet.create({
  wrap: {
    marginBottom: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    marginBottom: space.sm,
  },
  headerText: {
    ...t.bodyStrong,
    fontSize: 13,
    color: color.ink,
  },
  headerSub: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
  },
  strip: {
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  card: {
    width: CARD_W,
    backgroundColor: color.paper,
    borderRadius: radius.lg,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
    gap: space.xs,
  },
  skeleton: {
    opacity: 0.5,
    alignItems: 'center',
  },
  skBar: {
    backgroundColor: color.haze,
    borderRadius: 4,
  },
  avatarWrap: {
    alignSelf: 'center',
    marginBottom: space.xs,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  avatarPlaceholder: {
    backgroundColor: color.signal + '20',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    ...t.bodyStrong,
    color: color.signal,
    fontSize: 20,
  },
  verifiedBadge: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    backgroundColor: color.paper,
    borderRadius: 8,
    padding: 1,
  },
  name: {
    ...t.bodyStrong,
    fontSize: 12,
    color: color.ink,
    textAlign: 'center',
  },
  catChip: {
    backgroundColor: color.signal + '14',
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: 'center',
  },
  catText: {
    ...t.small,
    fontSize: 9,
    color: color.signal,
    textTransform: 'capitalize',
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    justifyContent: 'center',
  },
  ratingText: {
    ...t.small,
    fontSize: 10,
    color: color.ink,
  },
  reviewCount: {
    ...t.small,
    fontSize: 9,
    color: color.mute,
  },
  langRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    justifyContent: 'center',
  },
  langText: {
    ...t.small,
    fontSize: 9,
    color: color.mute,
  },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    justifyContent: 'center',
  },
  cityText: {
    ...t.small,
    fontSize: 9,
    color: color.faint,
  },
  availBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
    alignSelf: 'center',
  },
  availToday: {
    backgroundColor: color.success + '22',
  },
  availWeek: {
    backgroundColor: color.signal + '18',
  },
  availText: {
    ...t.small,
    fontSize: 8,
    color: color.success,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  reasonPill: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 3,
    backgroundColor: color.signal + '0e',
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 3,
    marginTop: space.xs,
  },
  reasonText: {
    ...t.small,
    fontSize: 9,
    color: color.signal,
    flex: 1,
    lineHeight: 13,
    fontStyle: 'italic',
  },
});
