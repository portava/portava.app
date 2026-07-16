import React from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronRight, SlidersHorizontal, AlertCircle, RefreshCw } from 'lucide-react-native';
import { color, space, radius, type as t, shadow, icon, layout } from '../theme/tokens.ts';

/**
 * Travel Buddy shared primitives. New/incomplete sections use these so every
 * surface shares the same cards, headers, chips, buttons, and states. Existing
 * stable screens migrate gradually — these don't force a refactor.
 *
 * All primitives are token-driven (radius/space/shadow/color) so the whole app
 * normalizes by editing tokens, not each screen.
 */

/* ── Page shell: safe-area top + optional desktop max-width centering ── */
export function TravelPageShell({
  children, scroll = true, padded = false, style,
}: { children: React.ReactNode; scroll?: boolean; padded?: boolean; style?: ViewStyle }) {
  const insets = useSafeAreaInsets();
  const inner = (
    <View style={[{ width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center' }, padded && { paddingHorizontal: space.lg }, style]}>
      {children}
    </View>
  );
  if (!scroll) {
    return <View style={[shell.base, { paddingTop: insets.top }]}>{inner}</View>;
  }
  return (
    <ScrollView style={shell.base} contentContainerStyle={{ paddingTop: insets.top, paddingBottom: space.xxxl }} showsVerticalScrollIndicator={false}>
      {inner}
    </ScrollView>
  );
}

/* ── Section header: title + optional "View all" action ── */
export function TravelSectionHeader({
  title, actionLabel = 'View all', onAction, kicker,
}: { title: string; actionLabel?: string; onAction?: () => void; kicker?: string }) {
  return (
    <View style={sh.row}>
      <View style={{ flex: 1 }}>
        {kicker ? <Text style={sh.kicker}>{kicker}</Text> : null}
        <Text style={sh.title}>{title}</Text>
      </View>
      {onAction && (
        <Pressable style={({ pressed }) => [sh.action, pressed && { opacity: layout.pressedOpacity }]} onPress={onAction} hitSlop={layout.hitSlop}>
          <Text style={sh.actionText}>{actionLabel}</Text>
          <ChevronRight size={icon.sm} color={color.signal} />
        </Pressable>
      )}
    </View>
  );
}

/* ── Card: standard rounded surface with border + soft shadow ── */
export function TravelCard({ children, style, onPress, padded = true }: { children: React.ReactNode; style?: ViewStyle; onPress?: () => void; padded?: boolean }) {
  const body = <View style={[card.base, padded && { padding: space.lg }, style]}>{children}</View>;
  if (onPress) {
    return <Pressable onPress={onPress} style={({ pressed }) => pressed && { opacity: layout.pressedOpacity }}>{body}</Pressable>;
  }
  return body;
}

/* ── Chip / pill: filter + tag, with active state ── */
export function TravelChip({ label, active, onPress, icon: leading }: { label: string; active?: boolean; onPress?: () => void; icon?: React.ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [chip.base, active && chip.active, pressed && { opacity: layout.pressedOpacity }]}
      accessibilityRole="button"
    >
      {leading}
      <Text style={[chip.text, active && chip.textActive]}>{label}</Text>
    </Pressable>
  );
}

/* ── Buttons: primary (vermilion), secondary (outline), ghost ── */
export function TravelButton({
  label, onPress, variant = 'primary', icon: leading, full,
}: { label: string; onPress?: () => void; variant?: 'primary' | 'secondary' | 'ghost'; icon?: React.ReactNode; full?: boolean }) {
  const v = btn[variant];
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [btn.base, v.box, full && { flex: 1 }, pressed && { opacity: layout.pressedOpacity }]}
      accessibilityRole="button"
    >
      {leading}
      <Text style={[btn.text, v.text]}>{label}</Text>
    </Pressable>
  );
}

/* ── Icon button: circular ── */
export function TravelIconButton({ icon: glyph, onPress, accessibilityLabel }: { icon: React.ReactNode; onPress?: () => void; accessibilityLabel?: string }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [ib.box, pressed && { opacity: layout.pressedOpacity }]}
      hitSlop={layout.hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {glyph}
    </Pressable>
  );
}

/* ── Filter button with active count badge ── */
export function TravelFilterButton({ count = 0, onPress, label = 'Filter' }: { count?: number; onPress?: () => void; label?: string }) {
  return (
    <Pressable style={({ pressed }) => [fb.box, pressed && { opacity: layout.pressedOpacity }]} onPress={onPress} hitSlop={layout.hitSlop}>
      <SlidersHorizontal size={icon.md} color={color.ink} />
      <Text style={fb.text}>{label}</Text>
      {count > 0 && <View style={fb.badge}><Text style={fb.badgeText}>{count}</Text></View>}
    </Pressable>
  );
}

/* ── States: empty / loading / error ── */
export function TravelEmptyState({ title, sub, action, onAction }: { title: string; sub?: string; action?: string; onAction?: () => void }) {
  return (
    <View style={st.empty}>
      <Text style={st.emptyTitle}>{title}</Text>
      {sub ? <Text style={st.emptySub}>{sub}</Text> : null}
      {action && onAction ? (
        <Pressable style={({ pressed }) => [st.emptyBtn, pressed && { opacity: layout.pressedOpacity }]} onPress={onAction}>
          <Text style={st.emptyBtnText}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function TravelLoadingState({ label }: { label?: string }) {
  return (
    <View style={st.center}>
      <ActivityIndicator color={color.signal} />
      {label ? <Text style={st.loadingText}>{label}</Text> : null}
    </View>
  );
}

export function TravelErrorState({ title = 'Something went wrong', sub, onRetry }: { title?: string; sub?: string; onRetry?: () => void }) {
  return (
    <View style={st.empty}>
      <AlertCircle size={28} color={color.mute} />
      <Text style={st.emptyTitle}>{title}</Text>
      {sub ? <Text style={st.emptySub}>{sub}</Text> : null}
      {onRetry ? (
        <Pressable style={({ pressed }) => [st.emptyBtn, pressed && { opacity: layout.pressedOpacity }]} onPress={onRetry}>
          <RefreshCw size={14} color={color.onInk} />
          <Text style={st.emptyBtnText}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/* ── Horizontal scroll strip ── */
export function HorizontalScrollStrip({ children, gap = space.md }: { children: React.ReactNode; gap?: number }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[strip.row, { gap }]}>
      {children}
    </ScrollView>
  );
}

const shell = StyleSheet.create({
  base: { flex: 1, backgroundColor: color.paper },
});

const sh = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, marginTop: space.xl, marginBottom: space.md },
  kicker: { fontFamily: 'Courier', fontSize: 11, color: color.deep, letterSpacing: 1.5, fontWeight: '700', marginBottom: 2 },
  title: { ...t.title, color: color.ink, fontSize: 20 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  actionText: { ...t.small, color: color.signal, fontWeight: '700' },
});

const card = StyleSheet.create({
  base: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card },
});

const chip = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  active: { backgroundColor: color.signal, borderColor: color.signal },
  text: { ...t.small, fontWeight: '700', color: color.ink },
  textActive: { color: color.onInk },
});

const btnBase = { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md } as ViewStyle;
const btn = {
  base: btnBase,
  text: { ...t.bodyStrong },
  primary: { box: { backgroundColor: color.signal } as ViewStyle, text: { color: color.onInk } },
  secondary: { box: { borderWidth: 1.5, borderColor: color.signal, backgroundColor: color.paperRaised } as ViewStyle, text: { color: color.signal } },
  ghost: { box: { borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised } as ViewStyle, text: { color: color.ink } },
};

const ib = StyleSheet.create({
  box: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
});

const fb = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: space.md, height: 42, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  text: { ...t.bodyStrong, color: color.ink },
  badge: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  badgeText: { ...t.stamp, color: color.onInk, fontFamily: 'Courier' },
});

const st = StyleSheet.create({
  empty: { marginHorizontal: space.lg, padding: space.xl, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: color.haze, alignItems: 'center', gap: space.sm },
  emptyTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  emptySub: { ...t.small, color: color.mute, textAlign: 'center' },
  emptyBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.signal, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.sm, marginTop: space.xs },
  emptyBtnText: { ...t.small, fontWeight: '800', color: color.onInk },
  center: { padding: space.xxl, alignItems: 'center', gap: space.md },
  loadingText: { ...t.small, color: color.mute },
});

const strip = StyleSheet.create({
  row: { paddingHorizontal: space.lg, paddingVertical: space.sm },
});
