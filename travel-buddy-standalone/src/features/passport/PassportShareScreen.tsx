/**
 * PassportShareScreen — the owner's Share entry point (spec §25).
 *
 * Reached from the passport tab's "Share passport" action. It builds the
 * deliberately MINIMAL QR projection from the owner's own profile (via the same
 * usePassport pipeline the tab uses) and presents it in the PassportQrSheet
 * (QR · Share Link · Copy Link · Bump). All privacy invariants live in
 * buildQrProjection / PassportQrSheet — this screen only wires the owner's
 * profile into that allow-list and dismisses back on close.
 */
import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { usePassport } from '../../hooks/usePassport.ts';
import { PassportQrSheet } from './PassportQrSheet.tsx';
import { buildQrProjection } from './passportQrProjection.ts';
import { color, space, type as t } from '../../theme/tokens.ts';

export default function PassportShareScreen() {
  const { profile, stamps, loading } = usePassport();

  const goBack = React.useCallback(() => {
    if (router.canGoBack?.()) router.back();
    else router.replace('/(tabs)/passport' as any);
  }, []);

  if (loading && !profile) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={s.center}>
        <Text style={s.msg}>Sign in to share your passport.</Text>
      </View>
    );
  }

  const projection = buildQrProjection({
    name: profile.displayName ?? profile.name,
    handle: profile.handle,
    username: profile.username,
    avatarUrl: profile.avatarUrl,
    verified: profile.verified,
    verificationLevel: profile.verificationLevel ?? null,
    homeCountry: profile.homeCountry,
    interests: profile.interests,
  });

  const verifiedStamps = (stamps ?? []).filter((st) => !st.locked).length;

  return (
    <View style={s.root}>
      <PassportQrSheet
        visible
        onClose={goBack}
        username={profile.username}
        projection={projection}
        stats={{
          tripCount: profile.tripCount ?? 0,
          stampCount: verifiedStamps,
          tagline: profile.bio ?? null,
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paperRaised },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
    paddingHorizontal: space.xl,
  },
  msg: { ...t.body, color: color.mute, textAlign: 'center' },
});
