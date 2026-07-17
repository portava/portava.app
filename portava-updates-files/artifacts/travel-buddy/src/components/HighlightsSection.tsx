import React, { useEffect, useState } from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Plus } from 'lucide-react-native';
import { fetchUserHighlights, type Highlight } from '../services/highlights';

/**
 * Highlights rail — social-style highlight circles below the stats row.
 * Uses the existing highlights service; tapping opens the existing
 * HighlightViewer, the owner "New" circle opens the existing composer.
 */

export function HighlightsSection({
  userId,
  isOwner,
  refreshKey = 0,
  onOpenViewer,
  onNewHighlight,
}: {
  userId: string | null;
  isOwner: boolean;
  /** bump to re-fetch after a new highlight is created */
  refreshKey?: number;
  onOpenViewer?: () => void;
  onNewHighlight?: () => void;
}) {
  const [highlights, setHighlights] = useState<Highlight[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!userId) { setHighlights([]); return; }
    let alive = true;
    setFailed(false);
    fetchUserHighlights(userId)
      .then((res) => {
        if (!alive) return;
        if (res.ok && res.data) setHighlights(res.data);
        else { setHighlights([]); setFailed(!res.ok); }
      })
      .catch(() => { if (alive) { setHighlights([]); setFailed(true); } });
    return () => { alive = false; };
  }, [userId, refreshKey]);

  const items = highlights ?? [];
  const loading = highlights === null && !!userId;

  // Public profiles with nothing to show render nothing (no empty shell).
  if (!isOwner && !loading && items.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.header}>Highlights</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {loading
          ? [0, 1, 2].map((i) => (
            <View key={i} style={styles.item}>
              <View style={[styles.ring, styles.skeleton]} />
              <View style={styles.skeletonLabel} />
            </View>
          ))
          : items.map((h) => {
            const label = h.locationCity || h.locationCountry || h.caption || 'Highlight';
            const uri = h.mediaThumbnailUrl || h.mediaUrl;
            return (
              <Pressable
                key={h.id}
                style={styles.item}
                onPress={onOpenViewer}
                disabled={!onOpenViewer}
                accessibilityRole="button"
                accessibilityLabel={`Highlight: ${label}`}
              >
                <View style={styles.ring}>
                  {uri ? (
                    <Image source={{ uri }} style={styles.image} />
                  ) : (
                    <View style={[styles.image, styles.imageFallback]} />
                  )}
                </View>
                <Text style={styles.label} numberOfLines={1}>{label}</Text>
              </Pressable>
            );
          })}

        {isOwner && onNewHighlight ? (
          <Pressable
            style={styles.item}
            onPress={onNewHighlight}
            accessibilityRole="button"
            accessibilityLabel="Create a new highlight"
          >
            <View style={[styles.ring, styles.newRing]}>
              <Plus size={24} color="#667085" strokeWidth={2} />
            </View>
            <Text style={styles.label} numberOfLines={1}>New</Text>
          </Pressable>
        ) : null}
      </ScrollView>
      {isOwner && !loading && items.length === 0 ? (
        <Text style={styles.emptyHint}>
          {failed ? 'Highlights are unavailable right now.' : 'Create your first highlight'}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginHorizontal: 16, marginTop: 14, borderRadius: 16,
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#EAECF0',
    paddingVertical: 14,
  },
  header: {
    fontSize: 18, lineHeight: 23, fontWeight: '700', color: '#101828',
    paddingHorizontal: 16, marginBottom: 10,
  },
  rail: { paddingHorizontal: 16, gap: 14 },
  item: { width: 68, alignItems: 'center' },
  ring: {
    width: 62, height: 62, borderRadius: 31,
    borderWidth: 1, borderColor: '#D9C69A', padding: 3,
  },
  image: { flex: 1, borderRadius: 999, width: '100%' },
  imageFallback: { backgroundColor: '#FCF6E8' },
  newRing: {
    alignItems: 'center', justifyContent: 'center',
    borderStyle: 'dashed', borderColor: '#98A2B3',
  },
  label: {
    marginTop: 6, width: 68, textAlign: 'center',
    fontSize: 11, color: '#344054',
  },
  skeleton: { backgroundColor: '#F2F4F7', borderColor: '#EAECF0' },
  skeletonLabel: {
    marginTop: 6, width: 44, height: 8, borderRadius: 4, backgroundColor: '#F2F4F7',
  },
  emptyHint: {
    marginTop: 10, paddingHorizontal: 16,
    fontSize: 12, color: '#98A2B3',
  },
});
