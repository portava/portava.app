/**
 * Admin — Testing console (testing-mode WP-21).
 *
 * One entry point for the admin actions a tester needs to close an in-app
 * loop, reached from Settings → Connected features (admin only). Each row opens
 * a screen over routes that were API-only before this package.
 *
 * The remaining admin surfaces (Compass weights, creator ledger, Trails
 * curation, ranking config, circle, safety candidates, notification admin and
 * coverage missions) are API-only by decision: the exact calls a tester runs
 * with an admin JWT are in docs/ops/testing-mode-flows.md. They are listed here
 * so their absence reads as a decision and not as a missing screen.
 */
import React, { useEffect } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useSession } from '../../src/context/SessionContext';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { AdminHeader, adminStyles as a } from '../../src/components/admin/AdminConsoleParts';
import { color } from '../../src/theme/tokens';

const SCREENS: Array<{ path: string; title: string; detail: string; flow: string }> = [
  { path: '/admin/hidden-gems', title: 'Hidden gem review', detail: 'Approve or reject submitted gems; resolve reports', flow: 'PLAT-F39' },
  { path: '/admin/local-guides', title: 'Local guides', detail: 'Approve or decline guide applications', flow: 'PLAT-F38' },
  { path: '/admin/live-scopes', title: 'Live-label scopes', detail: 'Promote or withdraw where LIVE labels may show', flow: 'SEN-F06' },
  { path: '/admin/user-stamps', title: 'User stamps', detail: "Award, revoke and restore a person's stamps", flow: 'PASS-F23' },
  { path: '/admin/airports', title: 'Airports', detail: 'Airport profiles and caution zones for layover tests', flow: 'LAY-F16' },
];

const API_ONLY = [
  'Compass weights, versions and rollback (COMP-F20)',
  'Creator ledger hold / release / reverse (DISC-F22)',
  'Trails curation and trend-integrity review (DISC-F23)',
  'Ranking config and metrics (DISC-F24)',
  'Circle reports, disable a context, kill switch (MAP-F15)',
  'Coverage missions (SEN-F10)',
  'Safety candidates (SEN-F12)',
  'Notification templates, notices, delivery health (PLAT-F21)',
];

export default function AdminConsoleScreen() {
  const insets = useSafeAreaInsets();
  const { isAuthed, loading: sessionLoading } = useSession();
  useRequireAdmin();

  useEffect(() => {
    if (!sessionLoading && !isAuthed) router.replace('/(auth)/sign-in' as any);
  }, [isAuthed, sessionLoading]);

  return (
    <View style={[a.screen, { paddingTop: insets.top }]}>
      <AdminHeader title="Testing console" subtitle="Admin actions that close the in-app test loops" />
      <ScrollView contentContainerStyle={a.body}>
        {SCREENS.map((s) => (
          <Pressable
            key={s.path}
            onPress={() => router.push(s.path as any)}
            accessibilityRole="button"
            accessibilityLabel={s.title}
            testID={`console-${s.path.replace('/admin/', '')}`}
            style={({ pressed }) => [a.card, { flexDirection: 'row', alignItems: 'center' }, pressed && { opacity: 0.7 }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={a.cardTitle}>{s.title}</Text>
              <Text style={a.meta}>{s.detail} · {s.flow}</Text>
            </View>
            <ChevronRight size={18} color={color.mute} />
          </Pressable>
        ))}

        <Text style={a.sectionTitle}>API-only (admin JWT)</Text>
        <View style={a.card} testID="console-api-only">
          <Text style={a.meta}>
            These have server routes but no screen. The calls a tester runs are in docs/ops/testing-mode-flows.md.
            The circle kill switch is also the flag find_your_circle_disabled on the Feature Flags screen.
          </Text>
          {API_ONLY.map((line) => <Text key={line} style={a.meta}>• {line}</Text>)}
        </View>
      </ScrollView>
    </View>
  );
}
