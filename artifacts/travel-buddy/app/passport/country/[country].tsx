/**
 * app/passport/country/[country].tsx
 *
 * Shows the current user's stamps for a single country, entered from the
 * passport country pin on the full-screen map.  The back button returns
 * the user to wherever they came from (the map).
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Stamp } from 'lucide-react-native';
import { getMyPassportStamps } from '../../../src/services/passportStamps.ts';
import type { PassportStampNew } from '../../../src/services/passportStamps.ts';
import { StampGrid } from '../../../src/components/stamps/StampGrid.tsx';
import { StampDetailModal } from '../../../src/components/stamps/StampDetailModal.tsx';
import { color, space, radius, type as t } from '../../../src/theme/tokens.ts';

export default function CountryStampsScreen() {
  const { country: rawCountry } = useLocalSearchParams<{ country: string }>();
  const country = Array.isArray(rawCountry) ? rawCountry[0] : (rawCountry ?? '');
  const insets = useSafeAreaInsets();

  const [stamps, setStamps] = useState<PassportStampNew[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PassportStampNew | null>(null);

  const load = useCallback(async () => {
    if (!country) return;
    setLoading(true);
    setError(null);
    const res = await getMyPassportStamps({ country });
    setLoading(false);
    if (res.ok) {
      setStamps(res.data);
    } else {
      setError(res.message ?? 'Could not load stamps');
    }
  }, [country]);

  useEffect(() => { load(); }, [load]);

  const handleStampUpdated = useCallback((updated: PassportStampNew) => {
    setStamps((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setSelected((prev) => (prev?.id === updated.id ? updated : prev));
  }, []);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <View style={s.titleRow}>
          <Stamp size={16} color={color.signal} />
          <Text style={s.title} numberOfLines={1}>{country}</Text>
        </View>
        {/* Spacer to balance the back button */}
        <View style={s.backBtn} />
      </View>

      {/* Subtitle */}
      {!loading && !error && (
        <Text style={s.subtitle}>
          {stamps.length} {stamps.length === 1 ? 'stamp' : 'stamps'} earned
        </Text>
      )}

      {/* Content */}
      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + space.xl }]}
        showsVerticalScrollIndicator={false}
      >
        {loading && stamps.length === 0 ? (
          <View style={s.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : (
          <StampGrid
            stamps={stamps}
            loading={loading}
            error={error}
            isOwner
            onRetry={load}
            onStampPress={setSelected}
            emptyTitle="No stamps for this country"
            emptySub="Stamps you earn here will appear once you travel to this country."
          />
        )}
      </ScrollView>

      <StampDetailModal
        stamp={selected}
        isOwner
        visible={selected !== null}
        onClose={() => setSelected(null)}
        onStampUpdated={handleStampUpdated}
        username={null}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.sm,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  title: {
    ...t.title,
    fontSize: 17,
    color: color.ink,
  },
  subtitle: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    paddingVertical: space.xs,
    paddingHorizontal: space.lg,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: space.sm },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
  },
});
