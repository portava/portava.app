import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, FlatList, StyleSheet, ActivityIndicator, Pressable } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { Chip } from '../src/components/ui';
import { color, space } from '../src/theme/tokens';
import { listSaved, type BookmarkedPlace } from '../src/services/discoveryBookmarks';
import { MapPin, Bookmark } from 'lucide-react-native';

const TABS = ['Places', 'Hotels', 'Nightlife', 'Itineraries'];

function PlaceCard({ place }: { place: BookmarkedPlace }) {
  return (
    <View style={s.card}>
      <View style={s.cardIcon}>
        <MapPin size={16} color={color.signal} />
      </View>
      <View style={s.cardBody}>
        <Text style={s.cardName} numberOfLines={1}>{place.name}</Text>
        {place.category ? (
          <Text style={s.cardMeta} numberOfLines={1}>{place.category}</Text>
        ) : null}
        {place.address ? (
          <Text style={s.cardAddress} numberOfLines={1}>{place.address}</Text>
        ) : null}
      </View>
    </View>
  );
}

export default function Saved() {
  const [tab, setTab] = useState('Places');
  const [places, setPlaces] = useState<BookmarkedPlace[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listSaved();
      setPlaces(data);
    } catch {
      setPlaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const showPlaces = tab === 'Places';

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <ScreenHeader title="Saved" back />
      <FlatList
        data={TABS}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(x) => x}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ gap: space.sm, padding: space.lg }}
        renderItem={({ item }) => (
          <Chip label={item} active={item === tab} onPress={() => setTab(item)} />
        )}
      />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: 0, gap: space.lg }}>
        {showPlaces ? (
          loading ? (
            <View style={s.center}>
              <ActivityIndicator color={color.signal} />
            </View>
          ) : places.length === 0 ? (
            <View style={s.empty}>
              <Bookmark size={28} color={color.haze} />
              <Text style={s.emptyTitle}>No saved places yet</Text>
              <Text style={s.emptySub}>
                Tap the bookmark icon on any place in Discovery to save it here.
              </Text>
            </View>
          ) : (
            places.map((p) => <PlaceCard key={p.id} place={p} />)
          )
        ) : (
          <View style={s.empty}>
            <Bookmark size={28} color={color.haze} />
            <Text style={s.emptyTitle}>Nothing saved here yet</Text>
            <Text style={s.emptySub}>Items you save will appear here.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: `${color.signal}15`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    flex: 1,
    gap: 2,
  },
  cardName: {
    fontSize: 14,
    fontWeight: '600',
    color: color.ink,
  },
  cardMeta: {
    fontSize: 12,
    color: color.mute,
    textTransform: 'capitalize',
  },
  cardAddress: {
    fontSize: 12,
    color: color.faint,
  },
  center: {
    paddingVertical: space.xxxl,
    alignItems: 'center',
  },
  empty: {
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xxxl,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: color.ink,
  },
  emptySub: {
    fontSize: 13,
    color: color.mute,
    textAlign: 'center',
    paddingHorizontal: space.xl,
  },
});
