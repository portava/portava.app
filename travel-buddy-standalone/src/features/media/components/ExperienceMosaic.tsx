/**
 * ExperienceMosaic — experience projection cards (spec §23).
 *
 * Media organized around real-world experiences (Sunset at My Khe, Beach
 * Festival, Friday Night An Thuong). Each card leads with a spatial hero image
 * strip and shows coverage (perspectives / contributors) + freshness — coverage
 * is a corroboration signal, not a popularity counter (§25/§46.2).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import { CachedImage } from '../../../components/CachedImage.tsx';
import type { MediaExperienceProjection, ExperienceState } from '../types/mediaExperience.ts';
import { FreshnessBadge } from './FreshnessBadge.tsx';

export interface ExperienceMosaicProps {
  experiences: MediaExperienceProjection[];
  onOpen?: (experience: MediaExperienceProjection) => void;
}

const STATE_LABEL: Record<ExperienceState, string> = {
  upcoming: 'Upcoming',
  starting: 'Starting',
  building: 'Building',
  peak: 'Peak',
  winding_down: 'Winding down',
  ended: 'Ended',
  typical: 'Typical',
};

export function ExperienceMosaic({ experiences, onOpen }: ExperienceMosaicProps) {
  return (
    <View style={styles.list}>
      {experiences.map((exp) => {
        const heroes = exp.heroMedia.slice(0, 3);
        return (
          <Pressable
            key={exp.id}
            style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            onPress={onOpen ? () => onOpen(exp) : undefined}
            accessibilityRole="button"
            accessibilityLabel={exp.title}
          >
            <View style={styles.heroStrip}>
              {heroes.length > 0 ? (
                heroes.map((m, i) => (
                  <View key={m.id || i} style={styles.heroCell}>
                    {m.thumbnailUrl ? (
                      <CachedImage source={{ uri: m.thumbnailUrl }} style={styles.heroImg} resizeMode="cover" />
                    ) : (
                      <View style={[styles.heroImg, styles.heroFallback]} />
                    )}
                  </View>
                ))
              ) : (
                <View style={[styles.heroCell, styles.heroImg, styles.heroFallback]} />
              )}
            </View>

            <View style={styles.body}>
              <View style={styles.titleRow}>
                <Text style={styles.title} numberOfLines={1}>
                  {exp.title}
                </Text>
                {exp.currentState ? (
                  <View style={styles.stateChip}>
                    <Text style={styles.stateChipText}>{STATE_LABEL[exp.currentState]}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.coverage}>
                {exp.perspectiveCount} {exp.perspectiveCount === 1 ? 'perspective' : 'perspectives'}
                {exp.contributorCount > 0 ? ` · ${exp.contributorCount} contributors` : ''}
              </Text>
              <View style={styles.footer}>
                <FreshnessBadge freshness={exp.freshness} />
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.md, paddingHorizontal: space.lg },
  card: {
    borderRadius: radius.lg,
    backgroundColor: 'rgba(250,249,246,0.05)',
    overflow: 'hidden',
  },
  pressed: { opacity: 0.85 },
  heroStrip: { flexDirection: 'row', height: 130, gap: 2, backgroundColor: '#1B1B18' },
  heroCell: { flex: 1 },
  heroImg: { width: '100%', height: '100%' },
  heroFallback: { backgroundColor: '#22221E' },
  body: { padding: space.md, gap: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  title: { color: color.onInk, fontSize: 17, fontWeight: '800', letterSpacing: -0.4, flex: 1 },
  stateChip: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    backgroundColor: 'rgba(61,214,196,0.16)',
  },
  stateChipText: { color: '#3DD6C4', fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },
  coverage: { color: color.onInkMute, fontSize: 13, fontWeight: '600' },
  footer: { flexDirection: 'row', marginTop: space.xs },
});
