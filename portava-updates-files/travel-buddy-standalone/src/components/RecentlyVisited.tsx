import React, { useMemo } from 'react';
import { View, Text, Image, StyleSheet, ScrollView } from 'react-native';
import { MapPin } from 'lucide-react-native';
import type { PassportPostcard } from '../types/models';

/**
 * Recently Visited — horizontal destination cards for the Map tab, derived
 * from the already-loaded postcards (city + latest media + last visit date).
 * Display-only: no dedicated destination-history screen exists yet.
 */

interface Visit {
  key: string;
  city: string;
  country: string | null;
  mediaUri: string | null;
  lastVisit: string;
}

function fmtMonth(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

export function RecentlyVisited({ postcards }: { postcards: PassportPostcard[] }) {
  const visits = useMemo<Visit[]>(() => {
    const byCity = new Map<string, Visit>();
    const sorted = postcards.slice().sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    for (const card of sorted) {
      const city = card.locationCity || card.locationName;
      if (!city) continue;
      const key = `${city}|${card.locationCountry ?? ''}`;
      if (byCity.has(key)) continue;
      byCity.set(key, {
        key,
        city,
        country: card.locationCountry,
        mediaUri: card.media?.[0]?.thumbnailUrl ?? card.media?.[0]?.url ?? card.mediaUrl,
        lastVisit: card.createdAt,
      });
      if (byCity.size >= 10) break;
    }
    return [...byCity.values()];
  }, [postcards]);

  if (visits.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.header}>Recently Visited</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {visits.map((v) => (
          <View key={v.key} style={styles.card} accessibilityLabel={`${v.city}${v.country ? `, ${v.country}` : ''}`}>
            {v.mediaUri ? (
              <Image source={{ uri: v.mediaUri }} style={styles.image} resizeMode="cover" />
            ) : (
              <View style={[styles.image, styles.imageFallback]}>
                <MapPin size={18} color="#B08A45" strokeWidth={1.7} />
              </View>
            )}
            <View style={styles.info}>
              <Text style={styles.city} numberOfLines={1}>{v.city}</Text>
              {v.country ? <Text style={styles.meta} numberOfLines={1}>{v.country}</Text> : null}
              {fmtMonth(v.lastVisit) ? <Text style={styles.meta}>{fmtMonth(v.lastVisit)}</Text> : null}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingTop: 18 },
  header: {
    fontSize: 18, fontWeight: '700', color: '#101828',
    paddingHorizontal: 16, marginBottom: 10,
  },
  rail: { paddingHorizontal: 16, gap: 12 },
  card: {
    width: 128, borderRadius: 12, overflow: 'hidden',
    borderWidth: 1, borderColor: '#EAECF0', backgroundColor: '#FFFFFF',
  },
  image: { width: '100%', height: 84 },
  imageFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#FCF6E8' },
  info: { padding: 8 },
  city: { fontSize: 13.5, fontWeight: '700', color: '#101828' },
  meta: { marginTop: 1, fontSize: 11.5, color: '#667085' },
});
