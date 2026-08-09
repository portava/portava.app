/**
 * NeighborhoodMatchSection — entry-point banner on the trip page.
 *
 * Calls fetchNeighborhoodMatch on mount. Renders nothing when the service
 * returns null (flag off / unconfigured). When non-null, shows a "Where
 * should I stay?" banner that opens NeighborhoodMatchSheet.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Home } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../../theme/tokens.ts';
import { fetchNeighborhoodMatch } from '../../services/neighborhoods.ts';
import { NeighborhoodMatchSheet } from './NeighborhoodMatchSheet.tsx';

export interface NeighborhoodMatchSectionProps {
  tripId: string;
}

export function NeighborhoodMatchSection({ tripId }: NeighborhoodMatchSectionProps) {
  const [checking, setChecking] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      const result = await fetchNeighborhoodMatch(tripId);
      if (!cancelled) {
        setEnabled(result !== null);
        setChecking(false);
      }
    }
    check();
    return () => { cancelled = true; };
  }, [tripId]);

  // Render nothing while checking or when flag is off
  if (checking || !enabled) return null;

  return (
    <>
      <Pressable
        style={styles.banner}
        onPress={() => setSheetOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Where should I stay? Find neighborhood matches"
      >
        <View style={styles.iconWrap}>
          <Home size={18} color={color.deep} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.bannerTitle}>Where should I stay?</Text>
          <Text style={styles.bannerSub}>Find the best neighborhoods for your trip →</Text>
        </View>
      </Pressable>

      <NeighborhoodMatchSheet
        visible={sheetOpen}
        tripId={tripId}
        onClose={() => setSheetOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    marginVertical: space.sm,
    padding: space.lg,
    backgroundColor: '#EDF4F7',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#C8DDE5',
  },
  iconWrap: {
    width: avatar.s40, height: avatar.s40,
    borderRadius: avatar.s40 / 2,
    backgroundColor: color.paper,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#C8DDE5',
  },
  bannerTitle: {
    ...t.bodyStrong,
    color: color.deep,
  },
  bannerSub: {
    ...t.small,
    color: color.mute,
    marginTop: 2,
  },
});
