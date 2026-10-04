/**
 * Join requests — the hosts' review screen (TRIP-F06, WP-10; census-trips §77, §79).
 *
 * Every pending request on every trip the viewer owns or co-hosts (GET
 * /trips/join-requests), grouped by trip, each approved or declined in place.
 * The list is JoinRequestsList, the same component the trip page mounts for a
 * single trip. Trip titles are enrichment only: if they cannot be read the
 * requests still list, under a neutral heading.
 */
import React, { useEffect, useState } from 'react';
import { View, ScrollView, StyleSheet, Text, Pressable } from 'react-native';
import { router } from 'expo-router';

import { AppHeader } from '../../src/components/ui/AppHeader';
import { useSession } from '../../src/context/SessionContext';
import { listMyTrips } from '../../src/services/trips';
import { JoinRequestsList } from '../../src/features/trips/joinRequests/JoinRequestsList.tsx';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { usePlainBottomInset } from '../../src/hooks/useBottomInset';

export default function TripJoinRequestsScreen() {
  const { isAuthed } = useSession();
  const bottomInset = usePlainBottomInset();
  const [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isAuthed) return;
    let cancelled = false;
    listMyTrips()
      .then((rows) => {
        if (cancelled) return;
        const m: Record<string, string> = {};
        for (const r of rows) m[r.id] = r.title ?? r.destinationCity ?? 'Your trip';
        setTitles(m);
      })
      .catch(() => { /* headings fall back to a neutral label */ });
    return () => { cancelled = true; };
  }, [isAuthed]);

  return (
    <View style={s.root}>
      <AppHeader variant="detail" title="Join requests" onBack={router.back} />
      {!isAuthed ? (
        <View style={s.center}>
          <Text style={s.body}>Sign in to review who has asked to join your trips.</Text>
          <Pressable style={s.button} onPress={() => router.back()} accessibilityRole="button">
            <Text style={s.buttonText}>Go back</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: bottomInset + space.lg }} testID="join-requests-screen">
          <JoinRequestsList tripTitles={titles} />
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  body: { ...t.small, color: color.mute, textAlign: 'center' },
  button: { marginTop: space.lg, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: color.signal },
  buttonText: { color: '#fff', fontWeight: '700' },
});
