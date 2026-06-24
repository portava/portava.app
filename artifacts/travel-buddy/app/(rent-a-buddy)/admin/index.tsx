/**
 * Rent a Buddy Admin Hub
 * Navigation hub linking to all 5 admin sections.
 */
import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Users, BookOpen, ShieldAlert, BarChart2, ClipboardList } from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../../src/theme/tokens';
import { useRentABuddyFlag } from '../../../src/hooks/useRentABuddyFlag';

const SECTIONS = [
  {
    icon: ClipboardList,
    label: 'Applications Queue',
    sub: 'Review pending Buddy applications',
    route: '/(rent-a-buddy)/admin/applications',
    accent: color.deep,
  },
  {
    icon: Users,
    label: 'Buddy Profiles',
    sub: 'Search, feature, suspend, and manage Buddies',
    route: '/(rent-a-buddy)/admin/buddies',
    accent: color.deep,
  },
  {
    icon: BookOpen,
    label: 'All Bookings',
    sub: 'Browse, filter, and inspect marketplace bookings',
    route: '/(rent-a-buddy)/admin/bookings',
    accent: color.deep,
  },
  {
    icon: ShieldAlert,
    label: 'Safety Flags',
    sub: 'Confirm or dismiss open policy violation flags',
    route: '/(rent-a-buddy)/admin/flags',
    accent: color.signal,
  },
  {
    icon: BarChart2,
    label: 'Analytics',
    sub: 'Bookings, revenue, supply & demand by city',
    route: '/(rent-a-buddy)/admin/analytics',
    accent: color.deep,
  },
] as const;

export default function RentABuddyAdminHub() {
  const insets = useSafeAreaInsets();
  const { enabled, loading: flagLoading } = useRentABuddyFlag();
  if (!flagLoading && !enabled) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
        <Text style={{ fontFamily: 'Courier', fontSize: 12, color: '#9CA3AF', textAlign: 'center' }}>
          Rent a Buddy is not enabled in this environment.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.canGoBack() ? router.back() : router.push('/(tabs)/' as any)}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.stamp}>ADMIN</Text>
          <Text style={styles.title}>Rent a Buddy</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          return (
            <Pressable
              key={s.route}
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
              onPress={() => router.push(s.route as any)}
            >
              <View style={[styles.iconWrap, { backgroundColor: s.accent + '18' }]}>
                <Icon size={22} color={s.accent} />
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.cardLabel}>{s.label}</Text>
                <Text style={styles.cardSub}>{s.sub}</Text>
              </View>
            </Pressable>
          );
        })}
        <View style={styles.footer}>
          <Text style={styles.footerText}>All actions verified server-side via admin role check.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderColor: color.haze,
  },
  backBtn: { padding: space.xs },
  headerText: { flex: 1 },
  stamp: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 2, marginBottom: 1 },
  title: { ...t.heading, color: color.ink },
  list: { padding: space.lg, gap: space.md, paddingBottom: 48 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    ...shadow.card,
  },
  iconWrap: { width: 44, height: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1, gap: 2 },
  cardLabel: { ...t.bodyStrong, color: color.ink },
  cardSub: { ...t.small, color: color.mute },
  footer: { marginTop: space.xl, alignItems: 'center' },
  footerText: { ...t.small, color: color.faint, textAlign: 'center' },
});
