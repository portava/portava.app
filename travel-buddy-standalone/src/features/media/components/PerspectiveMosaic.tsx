/**
 * PerspectiveMosaic — spatial mosaic of perspectives for a place/experience
 * (spec §13 CURRENT VIEW / §46 "spatial mosaics instead of repeated stacked
 * cards").
 *
 * Renders the perspective-group chips (Street · Entrance · Rooftops …) plus a
 * two-column mosaic of perspective tiles. A selected group filters the mosaic.
 * Deliberately NOT a single-column vertical feed (§46.2).
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { MediaProjection } from '../types/media.ts';
import type { PerspectiveGroup } from '../types/perspective.ts';
import { PerspectiveTile } from './PerspectiveTile.tsx';

export interface PerspectiveMosaicProps {
  media: MediaProjection[];
  groups?: PerspectiveGroup[];
  onOpen?: (media: MediaProjection) => void;
}

const ALL_KEY = '__all__';

export function PerspectiveMosaic({ media, groups, onOpen }: PerspectiveMosaicProps) {
  const [activeGroup, setActiveGroup] = useState<string>(ALL_KEY);

  const labelByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups ?? []) map.set(g.key, g.label);
    return map;
  }, [groups]);

  const filtered = useMemo(() => {
    if (activeGroup === ALL_KEY) return media;
    return media.filter((m) => (m.perspectiveKey ?? '') === activeGroup);
  }, [media, activeGroup]);

  // Two balanced columns for a masonry-ish feel without a heavy layout engine.
  const columns = useMemo(() => {
    const left: MediaProjection[] = [];
    const right: MediaProjection[] = [];
    filtered.forEach((m, i) => (i % 2 === 0 ? left : right).push(m));
    return { left, right };
  }, [filtered]);

  return (
    <View style={styles.wrap}>
      {groups && groups.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          <GroupChip
            label="All"
            count={media.length}
            active={activeGroup === ALL_KEY}
            onPress={() => setActiveGroup(ALL_KEY)}
          />
          {groups.map((g) => (
            <GroupChip
              key={g.key}
              label={g.label}
              count={g.count}
              active={activeGroup === g.key}
              onPress={() => setActiveGroup(g.key)}
            />
          ))}
        </ScrollView>
      ) : null}

      {filtered.length === 0 ? (
        <Text style={styles.empty}>No perspectives in this view yet.</Text>
      ) : (
        <View style={styles.mosaic}>
          <View style={styles.col}>
            {columns.left.map((m, i) => (
              <PerspectiveTile
                key={m.id || `l${i}`}
                media={m}
                perspectiveLabel={m.perspectiveKey ? labelByKey.get(m.perspectiveKey) ?? null : null}
                height={i % 2 === 0 ? 190 : 150}
                onOpen={onOpen}
              />
            ))}
          </View>
          <View style={styles.col}>
            {columns.right.map((m, i) => (
              <PerspectiveTile
                key={m.id || `r${i}`}
                media={m}
                perspectiveLabel={m.perspectiveKey ? labelByKey.get(m.perspectiveKey) ?? null : null}
                height={i % 2 === 0 ? 150 : 190}
                onOpen={onOpen}
              />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

function GroupChip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
      <Text style={[styles.chipCount, active && styles.chipTextActive]}>{count}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  chips: { gap: space.sm, paddingHorizontal: space.lg },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.08)',
  },
  chipActive: { backgroundColor: color.onInk },
  chipText: { color: color.onInkMute, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: color.ink },
  chipCount: { color: color.faint, fontSize: 12, fontWeight: '700' },
  mosaic: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg },
  col: { flex: 1, gap: space.sm },
  empty: { color: color.onInkMute, fontSize: 14, paddingHorizontal: space.lg, paddingVertical: space.lg },
});
