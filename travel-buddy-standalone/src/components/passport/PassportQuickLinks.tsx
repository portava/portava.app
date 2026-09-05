/**
 * PassportQuickLinks — the owner's entry points into the standalone Passport
 * detail surfaces (spec §3 "high-priority previews", §28).
 *
 * The detail screens (My World, Trust & Credentials, Travel Identity, Journeys,
 * Plans, Availability) already exist and are route-registered, but nothing on the
 * passport tab surfaced them. This block adds a clear, tappable navigation entry
 * for each, plus a Share entry that opens the Passport QR / Bump share sheet.
 *
 * Navigation is via router.push to the registered routes (see
 * src/navigation/portavaRoutes.ts); Share is delegated to the parent (`onShare`)
 * because the share sheet's data lives with the owner's passport hook.
 *
 * Pure/import-safe: React Native core + lucide glyphs + expo-router only, so it
 * mounts inside the existing passport-tab component tests without new mocks.
 * Light "paper" palette via passportTokens (PP).
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
  Globe2,
  ShieldCheck,
  Fingerprint,
  Route as RouteIcon,
  BookOpen,
  CalendarClock,
  CalendarCheck,
  Share2,
  ChevronRight,
} from 'lucide-react-native';
import { space, radius, avatar, icon } from '../../theme/tokens.ts';
import { PP, PP_LABEL } from '../../theme/passportTokens.ts';
import { yearbookHref } from '../../features/passport/passportNav.ts';

export interface PassportQuickLinksProps {
  /** Opens the Passport QR / Bump share sheet (§25). */
  onShare: () => void;
}

interface LinkRow {
  key: string;
  label: string;
  sublabel: string;
  Icon: typeof Globe2;
  onPress: () => void;
  testID: string;
}

export function PassportQuickLinks({ onShare }: PassportQuickLinksProps) {
  // `as any` on the route strings mirrors the existing passport.tsx call sites —
  // these are registered routes, but expo-router's generated href union does not
  // include them in this standalone typings setup.
  const rows: LinkRow[] = [
    {
      key: 'my-world',
      label: 'My World',
      sublabel: 'Countries, cities and your travel map',
      Icon: Globe2,
      onPress: () => router.push('/passport/my-world' as any),
      testID: 'quicklink-my-world',
    },
    {
      key: 'trust',
      label: 'Trust & Credentials',
      sublabel: 'Your trust standing and what it unlocks',
      Icon: ShieldCheck,
      onPress: () => router.push('/passport/trust' as any),
      testID: 'quicklink-trust',
    },
    {
      key: 'travel-identity',
      label: 'Travel Identity',
      sublabel: 'Your Travel DNA and traits',
      Icon: Fingerprint,
      onPress: () => router.push('/passport/travel-identity' as any),
      testID: 'quicklink-travel-identity',
    },
    {
      key: 'journeys',
      label: 'Journeys',
      sublabel: 'Trips, grouped year by year',
      Icon: RouteIcon,
      onPress: () => router.push('/passport/journeys' as any),
      testID: 'quicklink-journeys',
    },
    {
      key: 'yearbook',
      label: 'Yearbook',
      sublabel: 'Your travel year by year, with the receipts',
      Icon: BookOpen,
      // The §9 Yearbook route is built by passportNav's yearbookHref() rather
      // than hard-coded here, so the route string (and its year param) has a
      // single definition that this call site cannot drift away from.
      onPress: () => router.push(yearbookHref() as any),
      testID: 'quicklink-yearbook',
    },
    {
      key: 'plans',
      label: 'Plans',
      sublabel: 'Where you are headed next',
      Icon: CalendarClock,
      onPress: () => router.push('/passport/plans' as any),
      testID: 'quicklink-plans',
    },
    {
      key: 'availability',
      label: 'Set availability',
      sublabel: 'When and where you are open to meet',
      Icon: CalendarCheck,
      onPress: () => router.push('/passport/availability' as any),
      testID: 'quicklink-availability',
    },
    {
      key: 'share',
      label: 'Share passport',
      sublabel: 'QR, link or Bump to exchange',
      Icon: Share2,
      onPress: onShare,
      testID: 'quicklink-share',
    },
  ];

  return (
    <View style={s.wrap} accessibilityLabel="Passport sections">
      <Text style={s.sectionLabel}>Explore your passport</Text>
      <View style={s.card}>
        {rows.map((row, i) => {
          const Glyph = row.Icon;
          return (
            <Pressable
              key={row.key}
              testID={row.testID}
              onPress={row.onPress}
              accessibilityRole="button"
              accessibilityLabel={row.label}
              style={({ pressed }) => [
                s.row,
                i < rows.length - 1 && s.rowDivider,
                pressed && s.rowPressed,
              ]}
            >
              <View style={s.rowIcon}>
                <Glyph size={icon.s20} color={PP.ink} />
              </View>
              <View style={s.rowText}>
                <Text style={s.rowLabel} numberOfLines={1}>
                  {row.label}
                </Text>
                <Text style={s.rowSublabel} numberOfLines={1}>
                  {row.sublabel}
                </Text>
              </View>
              <ChevronRight size={icon.s18} color={PP.inkMuted} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: 16, marginTop: space.lg, gap: space.sm },
  sectionLabel: { ...PP_LABEL, marginLeft: 2 },
  card: {
    backgroundColor: PP.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: PP.borderLight,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 12,
  },
  rowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PP.borderLight,
  },
  rowPressed: { backgroundColor: PP.paperDeep },
  rowIcon: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    backgroundColor: PP.paperDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: 1 },
  rowLabel: { fontSize: 15, fontWeight: '600', color: PP.ink },
  rowSublabel: { fontSize: 12, color: PP.inkMuted },
});

export default PassportQuickLinks;
