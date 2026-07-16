import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import type { PassportStats } from '../services/passportStamps.ts';
import { getPassportStats } from '../services/passportStamps.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';

interface Props {
  tripCount?: number;
  followersCount?: number;
  followingCount?: number;
  onCellPress?: (label: string) => void;
  onFollowersPress?: () => void;
  onFollowingPress?: () => void;
}

function fmt(n: number | undefined | null): string {
  const v = n ?? 0;
  if (!Number.isFinite(v) || isNaN(v)) return '0';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(v);
}

export function CompactStatsRow({
  tripCount,
  followersCount,
  followingCount,
  onCellPress,
  onFollowersPress,
  onFollowingPress,
}: Props) {
  const [liveStats, setLiveStats] = useState<PassportStats | null>(null);

  useEffect(() => {
    getPassportStats()
      .then((res) => { if (res.ok) setLiveStats(res.data); })
      .catch(() => {});
  }, []);

  const trips      = tripCount ?? 0;
  const cities     = liveStats?.cities ?? 0;
  const postcards  = liveStats?.totalStamps != null ? liveStats.totalStamps : 0;
  const followers  = followersCount ?? 0;
  const following  = followingCount ?? 0;

  const items: Array<{ n: number; label: string; onPress?: () => void }> = [
    { n: trips,     label: 'Trips',      onPress: () => onCellPress?.('Trips') },
    { n: cities,    label: 'Cities',     onPress: () => onCellPress?.('Cities') },
    { n: postcards, label: 'Postcards',  onPress: () => onCellPress?.('Postcards') },
    { n: followers, label: 'Followers',  onPress: onFollowersPress ?? (() => onCellPress?.('Followers')) },
    { n: following, label: 'Following',  onPress: onFollowingPress ?? (() => onCellPress?.('Following')) },
  ];

  return (
    <View style={st.row}>
      {items.map((item, i) => (
        <React.Fragment key={item.label}>
          {i > 0 && <View style={st.divider} />}
          <Pressable
            style={({ pressed }) => [st.cell, pressed && st.cellPressed]}
            onPress={item.onPress}
            accessibilityLabel={`${item.n} ${item.label}`}
            accessibilityRole="button"
          >
            <Text style={st.n}>{fmt(item.n)}</Text>
            <Text style={st.l}>{item.label.toUpperCase()}</Text>
          </Pressable>
        </React.Fragment>
      ))}
    </View>
  );
}

const st = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze,
    marginHorizontal: space.lg, marginTop: 0,
    paddingVertical: 10,
  },
  cell: { flex: 1, alignItems: 'center', gap: 1, paddingVertical: 2 },
  cellPressed: { opacity: 0.55 },
  divider: { width: 1, height: 28, backgroundColor: color.haze },
  n: { ...t.heading, color: color.ink, fontSize: 17 },
  l: { fontFamily: 'Courier', fontSize: 7, color: color.mute, letterSpacing: 0.5, fontWeight: '700' },
});
