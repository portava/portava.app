/**
 * Destination detail screen — shows all passport content (Memories, Stamps,
 * Postcards, Trips) for a single city, grouped into labelled sections.
 *
 * Route param `city` is the URL-encoded destination key produced by
 * `encodeDestinationKey(group.key)` in the DestinationsTab.
 */
import React, { useMemo, useState, useEffect } from 'react';
import {
  View, Text, ScrollView, Pressable,
  ActivityIndicator, StyleSheet,
} from 'react-native';
import { CachedImage } from '../../src/components/CachedImage';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, MapPin } from 'lucide-react-native';
import { usePassport } from '../../src/hooks/usePassport.ts';
import { usePlainBottomInset } from '../../src/hooks/useBottomInset.ts';
import { listMyTrips, type TripRow } from '../../src/services/trips.ts';
import {
  groupByDestination,
  decodeDestinationKey,
  type DestinationGroup,
} from '../../src/utils/destinationGrouping.ts';
import { StampBadge } from '../../src/components/PassportStamps.tsx';
import { color, space, radius, type as t, dot} from '../../src/theme/tokens.ts';

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

// ── Memory row ────────────────────────────────────────────────────────────────

function MemoryRow({ memory }: { memory: import('../../src/services/passportStamps.ts').PassportMemory }) {
  return (
    <View style={s.memoryRow}>
      {memory.photoUrl ? (
        <CachedImage source={{ uri: memory.photoUrl }} style={s.memoryThumb} resizeMode="cover" fallbackLabel="" />
      ) : (
        <View style={[s.memoryThumb, s.memoryThumbEmpty]} />
      )}
      <View style={s.memoryBody}>
        <Text style={s.memoryTitle} numberOfLines={2}>
          {memory.title ?? 'Untitled memory'}
        </Text>
        {memory.description ? (
          <Text style={s.memoryDesc} numberOfLines={2}>{memory.description}</Text>
        ) : null}
        <Text style={s.memoryDate}>
          {new Date(memory.earnedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
        </Text>
      </View>
    </View>
  );
}

// ── Postcard row ──────────────────────────────────────────────────────────────

function PostcardRow({ postcard }: { postcard: import('../../src/types/models.ts').PassportPostcard }) {
  return (
    <Pressable style={s.postcardRow} onPress={() => router.push(`/post/${postcard.postId}` as any)}>
      {postcard.mediaUrl ? (
        <CachedImage source={{ uri: postcard.mediaUrl }} style={s.postcardThumb} resizeMode="cover" fallbackLabel="" />
      ) : (
        <View style={[s.postcardThumb, s.postcardThumbEmpty]} />
      )}
      <View style={s.postcardBody}>
        {postcard.caption ? (
          <Text style={s.postcardCaption} numberOfLines={2}>{postcard.caption}</Text>
        ) : null}
        {postcard.locationName ? (
          <View style={s.locationRow}>
            <MapPin size={11} color={color.mute} />
            <Text style={s.locationText} numberOfLines={1}>{postcard.locationName}</Text>
          </View>
        ) : null}
        <Text style={s.postcardDate}>
          {new Date(postcard.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
        </Text>
      </View>
    </Pressable>
  );
}

// ── Trip row ──────────────────────────────────────────────────────────────────

function TripRow({ trip }: { trip: import('../../src/services/trips.ts').TripRow }) {
  return (
    <Pressable
      style={s.tripRow}
      onPress={() => router.push(`/trip/${trip.id}` as any)}
    >
      <View style={s.tripDot} />
      <View style={{ flex: 1 }}>
        <Text style={s.tripTitle} numberOfLines={1}>{trip.title}</Text>
        <Text style={s.tripMeta}>
          {[trip.startDate
            ? new Date(trip.startDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
            : null,
            trip.status,
          ].filter(Boolean).join(' · ')}
        </Text>
      </View>
      {trip.coverUrl ? (
        <CachedImage source={{ uri: trip.coverUrl }} style={s.tripCover} resizeMode="cover" fallbackLabel="" />
      ) : null}
    </Pressable>
  );
}

// ── Empty section placeholder ─────────────────────────────────────────────────

function EmptySection({ label }: { label: string }) {
  return (
    <View style={s.emptySection}>
      <Text style={s.emptySectionText}>No {label.toLowerCase()} for this destination.</Text>
    </View>
  );
}

// ── DestinationDetailScreen ───────────────────────────────────────────────────

export default function DestinationDetailScreen() {
  const { city: cityParam } = useLocalSearchParams<{ city: string }>();
  const insets = useSafeAreaInsets();
  const bottomInset = usePlainBottomInset();
  const { memories, stamps, postcards, loading } = usePassport();
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [tripsLoaded, setTripsLoaded] = useState(false);

  useEffect(() => {
    listMyTrips()
      .then((rows) => { setTrips(rows); })
      .catch(() => {})
      .finally(() => { setTripsLoaded(true); });
  }, []);

  // Decode the key passed from DestinationsTab
  const targetKey = useMemo(
    () => (cityParam ? decodeDestinationKey(cityParam) : ''),
    [cityParam],
  );

  // Re-group and find the matching destination
  const group: DestinationGroup | null = useMemo(() => {
    const groups = groupByDestination(memories, stamps, postcards, trips);
    return groups.find((g) => g.key === targetKey) ?? null;
  }, [memories, stamps, postcards, trips, targetKey]);

  if (loading || !tripsLoaded) {
    return (
      <View style={[s.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={color.ink} />
      </View>
    );
  }

  if (!group) {
    return (
      <View style={[s.center, { paddingTop: insets.top }]}>
        <Text style={s.notFoundText}>Destination not found.</Text>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={() => router.back()} style={s.backButton} hitSlop={8}>
          <ChevronLeft size={22} color={color.ink} />
        </Pressable>
        <View style={s.headerTitles}>
          <Text style={s.headerCity} numberOfLines={1}>{group.city}</Text>
          {group.country ? (
            <Text style={s.headerCountry}>{group.country}</Text>
          ) : null}
        </View>
      </View>

      {/* Hero image */}
      {group.heroImageUrl ? (
        <CachedImage
          source={{ uri: group.heroImageUrl }}
          style={s.heroImage}
          resizeMode="cover"
        />
      ) : (
        <View style={s.heroPlaceholder}>
          <MapPin size={36} color={color.faint} />
          <Text style={s.heroPlaceholderText}>{group.city}</Text>
        </View>
      )}

      {/* Content sections */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: bottomInset + space.xl }}
        showsVerticalScrollIndicator={false}
      >
        {/* Memories */}
        <Section title={`Memories (${group.memories.length})`}>
          {group.memories.length === 0 ? (
            <EmptySection label="Memories" />
          ) : (
            <View style={s.sectionItems}>
              {group.memories.map((m) => (
                <MemoryRow key={m.id} memory={m} />
              ))}
            </View>
          )}
        </Section>

        {/* Stamps */}
        <Section title={`Stamps (${group.stamps.length})`}>
          {group.stamps.length === 0 ? (
            <EmptySection label="Stamps" />
          ) : (
            <View style={s.stampsRow}>
              {group.stamps.map((stamp, i) => (
                <StampBadge
                  key={stamp.id}
                  stamp={stamp}
                  size={76}
                  rotate={((i % 3) - 1) * 3}
                />
              ))}
            </View>
          )}
        </Section>

        {/* Postcards */}
        <Section title={`Postcards (${group.postcards.length})`}>
          {group.postcards.length === 0 ? (
            <EmptySection label="Postcards" />
          ) : (
            <View style={s.sectionItems}>
              {group.postcards.map((p) => (
                <PostcardRow key={p.id} postcard={p} />
              ))}
            </View>
          )}
        </Section>

        {/* Trips */}
        <Section title={`Trips (${group.trips.length})`}>
          {group.trips.length === 0 ? (
            <EmptySection label="Trips" />
          ) : (
            <View style={s.sectionItems}>
              {group.trips.map((trip) => (
                <TripRow key={trip.id} trip={trip} />
              ))}
            </View>
          )}
        </Section>
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md },
  notFoundText: { ...t.body, color: color.mute },
  backBtn: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
  },
  backBtnText: { ...t.bodyStrong, color: color.ink },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    gap: space.sm,
    backgroundColor: color.paper,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  backButton: {
    padding: 4,
  },
  headerTitles: { flex: 1 },
  headerCity: { ...t.heading, color: color.ink },
  headerCountry: { ...t.small, color: color.mute, fontFamily: 'Courier' },

  heroImage: { width: '100%', height: 200, backgroundColor: color.haze },
  heroPlaceholder: {
    width: '100%',
    height: 120,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  heroPlaceholderText: { ...t.heading, color: color.faint },

  section: {
    marginHorizontal: space.lg,
    marginTop: space.lg,
  },
  sectionTitle: {
    ...t.heading,
    color: color.ink,
    marginBottom: space.sm,
    fontFamily: 'Courier',
    fontSize: 13,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  sectionItems: { gap: space.sm },

  stampsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    paddingVertical: space.sm,
  },

  emptySection: {
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.haze,
    alignItems: 'center',
  },
  emptySectionText: { ...t.small, color: color.faint },

  // Memory
  memoryRow: {
    flexDirection: 'row',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
  },
  memoryThumb: { width: 80, height: 80, backgroundColor: color.haze },
  memoryThumbEmpty: {},
  memoryBody: { flex: 1, padding: space.sm, gap: 3 },
  memoryTitle: { ...t.bodyStrong, color: color.ink },
  memoryDesc: { ...t.small, color: color.mute },
  memoryDate: { ...t.small, color: color.faint, fontFamily: 'Courier' },

  // Postcard
  postcardRow: {
    flexDirection: 'row',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    overflow: 'hidden',
  },
  postcardThumb: { width: 80, height: 80, backgroundColor: color.haze },
  postcardThumbEmpty: {},
  postcardBody: { flex: 1, padding: space.sm, gap: 3 },
  postcardCaption: { ...t.body, color: color.ink },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  locationText: { ...t.small, color: color.mute },
  postcardDate: { ...t.small, color: color.faint, fontFamily: 'Courier' },

  // Trip
  tripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  tripDot: { width: dot.md, height: dot.md, borderRadius: dot.md / 2, backgroundColor: color.signal },
  tripTitle: { ...t.bodyStrong, color: color.ink },
  tripMeta: { ...t.small, color: color.mute, marginTop: 2 },
  tripCover: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: color.haze },
});
