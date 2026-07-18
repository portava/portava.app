/**
 * DestinationsTab — aggregated destination cards on the Passport screen.
 *
 * Groups the user's memories, postcards, and trips by city and renders a
 * scrollable FlatList of destination cards.  Tapping a card opens the
 * DestinationDetail screen.
 */
import React, { useMemo } from 'react';
import {
  View, Text, FlatList, Pressable, Image, StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { MapPin } from 'lucide-react-native';
import type { PassportMemory } from '../../services/passportStamps.ts';
import type { PassportStamp, PassportPostcard } from '../../types/models.ts';
import type { TripRow } from '../../services/trips.ts';
import {
  groupByDestination,
  encodeDestinationKey,
  type DestinationGroup,
} from '../../utils/destinationGrouping.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

interface Props {
  memories: PassportMemory[];
  stamps: PassportStamp[];
  postcards: PassportPostcard[];
  trips: TripRow[];
}

// ── Chip helper ──────────────────────────────────────────────────────────────

interface CountChipProps {
  label: string;
  count: number;
}

function CountChip({ label, count }: CountChipProps) {
  if (count === 0) return null;
  return (
    <View style={s.chip}>
      <Text style={s.chipText}>{count} {label}</Text>
    </View>
  );
}

// ── Destination card ─────────────────────────────────────────────────────────

interface CardProps {
  group: DestinationGroup;
}

function DestinationCard({ group }: CardProps) {
  const handlePress = () => {
    router.push({
      pathname: '/destinations/[city]' as any,
      params: { city: encodeDestinationKey(group.key) },
    });
  };

  return (
    <Pressable style={s.card} onPress={handlePress}>
      {/* Hero image */}
      {group.heroImageUrl ? (
        <Image source={{ uri: group.heroImageUrl }} style={s.hero} resizeMode="cover" />
      ) : (
        <View style={[s.hero, s.heroPlaceholder]}>
          <MapPin size={28} color={color.faint} />
        </View>
      )}

      {/* Card body */}
      <View style={s.body}>
        <View style={s.titleRow}>
          <Text style={s.city} numberOfLines={1}>{group.city}</Text>
          {group.country ? (
            <Text style={s.country} numberOfLines={1}>{group.country}</Text>
          ) : null}
        </View>

        {/* Content-type chips */}
        <View style={s.chips}>
          <CountChip label="memories" count={group.memories.length} />
          <CountChip label="stamps" count={group.stamps.length} />
          <CountChip label="postcards" count={group.postcards.length} />
          <CountChip label="trips" count={group.trips.length} />
        </View>

        {/* Most recent date */}
        <Text style={s.date}>
          {group.mostRecentAt > new Date(0).toISOString()
            ? new Date(group.mostRecentAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
            : null}
        </Text>
      </View>
    </Pressable>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <View style={s.empty}>
      <MapPin size={32} color={color.faint} />
      <Text style={s.emptyTitle}>No destinations yet</Text>
      <Text style={s.emptySub}>
        Add memories, postcards, or trips to see your destinations here.
      </Text>
    </View>
  );
}

// ── DestinationsTab ──────────────────────────────────────────────────────────

export function DestinationsTab({ memories, stamps, postcards, trips }: Props) {
  const groups = useMemo(
    () => groupByDestination(memories, stamps, postcards, trips),
    [memories, stamps, postcards, trips],
  );

  if (groups.length === 0) {
    return <EmptyState />;
  }

  return (
    <FlatList
      data={groups}
      keyExtractor={(item) => item.key}
      renderItem={({ item }) => <DestinationCard group={item} />}
      contentContainerStyle={s.list}
      scrollEnabled={false}
      ItemSeparatorComponent={() => <View style={s.separator} />}
    />
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  list: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  separator: { height: space.md },

  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
  },
  hero: {
    width: '100%',
    height: 140,
    backgroundColor: color.haze,
  },
  heroPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    padding: space.md,
    gap: space.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
  },
  city: {
    ...t.heading,
    color: color.ink,
    flex: 1,
  },
  country: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    marginTop: 2,
  },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
  },
  chipText: {
    ...t.stamp,
    fontFamily: 'Courier',
    color: color.mute,
    fontSize: 11,
  },
  date: {
    ...t.small,
    color: color.faint,
    fontFamily: 'Courier',
    marginTop: 2,
  },

  empty: {
    marginHorizontal: space.lg,
    marginTop: space.xl,
    padding: space.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.haze,
    alignItems: 'center',
    gap: space.sm,
  },
  emptyTitle: { ...t.bodyStrong, color: color.ink },
  emptySub: { ...t.small, color: color.mute, textAlign: 'center' },
});
