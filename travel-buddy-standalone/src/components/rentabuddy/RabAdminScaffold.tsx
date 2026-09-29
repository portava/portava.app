/**
 * Shared frame for the Rent-a-Buddy admin screens added in testing mode
 * (lane tm-rab, WP-01): the ADMIN header with a back button, an optional row
 * of status tabs, and the honest body states every admin list needs —
 * loading, "admin only", an error with retry, and a true empty.
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { color, space, radius, type as t, layout } from '../../theme/tokens.ts';
import { TravelLoadingState, TravelErrorState, TravelEmptyState } from '../primitives.tsx';
import { bookingErrorCopy } from '../../services/rentABuddyBookingErrors.ts';

export function RabAdminScaffold({
  title,
  subtitle,
  tabs,
  activeTab,
  onTab,
  children,
}: {
  title: string;
  subtitle?: string;
  tabs?: ReadonlyArray<{ key: string; label: string }>;
  activeTab?: string;
  onTab?: (key: string) => void;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable
          onPress={() => (router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/admin' as any))}
          style={({ pressed }) => [s.back, pressed && { opacity: layout.pressedOpacity }]}
          hitSlop={8}
          accessibilityLabel="Back"
        >
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.stamp}>ADMIN · RENT A BUDDY</Text>
          <Text style={s.title}>{title}</Text>
          {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
        </View>
      </View>
      {tabs && tabs.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.tabs} style={{ flexGrow: 0 }}>
          {tabs.map((tab) => {
            const on = tab.key === activeTab;
            return (
              <Pressable
                key={tab.key}
                onPress={() => onTab?.(tab.key)}
                style={[s.tab, on && s.tabOn]}
                testID={`tab-${tab.key}`}
                accessibilityState={{ selected: on }}
              >
                <Text style={[s.tabText, on && s.tabTextOn]}>{tab.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

/** The body for a list read: loading, admin-only, failed (with retry), empty — or null when there are rows. */
export function adminListState(opts: {
  loading: boolean;
  error: string | null;
  count: number;
  onRetry: () => void;
  loadingLabel: string;
  emptyTitle: string;
  emptySub: string;
}): React.ReactNode | null {
  if (opts.loading) return <TravelLoadingState label={opts.loadingLabel} />;
  if (opts.error === 'forbidden') {
    return <TravelErrorState title="Admin only" sub="This account is not an admin, so the server refused the read." />;
  }
  if (opts.error) {
    return (
      <TravelErrorState
        title="Couldn't load this list"
        sub={bookingErrorCopy(opts.error, 'The read failed — this is not an empty list. Try again.')}
        onRetry={opts.onRetry}
      />
    );
  }
  if (opts.count === 0) return <TravelEmptyState title={opts.emptyTitle} sub={opts.emptySub} />;
  return null;
}

export const adminCard = StyleSheet.create({
  card: { gap: space.xs, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.bodyStrong, color: color.ink, flex: 1 },
  meta: { ...t.small, color: color.mute },
  body: { ...t.body, color: color.ink },
  pill: { ...t.small, color: color.deep, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs, flexWrap: 'wrap' },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.sm, paddingHorizontal: space.md, backgroundColor: color.paper },
  btnPrimary: { backgroundColor: color.ink, borderColor: color.ink },
  btnText: { ...t.bodyStrong, color: color.ink },
  btnTextPrimary: { ...t.bodyStrong, color: color.onInk },
  btnDanger: { borderColor: color.signal },
  btnTextDanger: { ...t.bodyStrong, color: color.signal },
  list: { padding: space.lg, gap: space.md, paddingBottom: 48 },
});

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderColor: color.haze },
  back: { padding: space.xs },
  stamp: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 2, marginBottom: 1 },
  title: { ...t.heading, color: color.ink },
  subtitle: { ...t.small, color: color.mute, marginTop: 2 },
  tabs: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space.sm },
  tab: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  tabOn: { backgroundColor: color.ink, borderColor: color.ink },
  tabText: { ...t.small, color: color.ink },
  tabTextOn: { ...t.small, color: color.onInk, fontWeight: '700' },
});
