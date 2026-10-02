/**
 * Shared pieces of the testing-mode admin console screens (WP-21): the header,
 * the three honest non-data states, and a small action button.
 *
 * The states are the point. A queue that failed to load renders as an ERROR
 * with a retry (announced to screen readers), and only a queue that loaded
 * with nothing in it renders as EMPTY — an admin must never read "nothing to
 * review" off a request that did not answer.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';

export function AdminHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={s.header}>
      <Pressable
        onPress={() => router.back()}
        style={({ pressed }) => [s.backBtn, pressed && { opacity: 0.6 }]}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <ArrowLeft size={22} color={color.ink} />
      </Pressable>
      <View style={s.headerText}>
        <Text style={s.title}>{title}</Text>
        {!!subtitle && <Text style={s.subtitle}>{subtitle}</Text>}
      </View>
    </View>
  );
}

export function AdminLoading({ testID }: { testID?: string }) {
  return (
    <View style={s.center} testID={testID}>
      <ActivityIndicator color={color.signal} size="large" />
    </View>
  );
}

export function AdminError({ message, onRetry, testID }: { message: string; onRetry: () => void; testID?: string }) {
  return (
    <View style={s.errorBox} testID={testID} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <Text style={s.errorText}>{message}</Text>
      <AdminButton label="Try again" onPress={onRetry} />
    </View>
  );
}

export function AdminEmpty({ message, testID }: { message: string; testID?: string }) {
  return (
    <View style={s.emptyBox} testID={testID}>
      <Text style={s.emptyText}>{message}</Text>
    </View>
  );
}

export function AdminButton({
  label, onPress, tone = 'neutral', disabled, testID,
}: { label: string; onPress: () => void; tone?: 'neutral' | 'primary' | 'danger'; disabled?: boolean; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        s.btn,
        tone === 'primary' && s.btnPrimary,
        tone === 'danger' && s.btnDanger,
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      <Text style={[s.btnText, tone === 'primary' && s.btnTextOnFill, tone === 'danger' && s.btnTextDanger]}>{label}</Text>
    </Pressable>
  );
}

export const adminStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  body: { paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md },
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.xs,
  },
  cardTitle: { ...t.bodyStrong, color: color.ink },
  meta: { ...t.small, color: color.mute },
  mono: { ...t.small, color: color.mute, fontFamily: 'Courier' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
  sectionTitle: { ...t.heading, color: color.ink, marginTop: space.sm },
  input: {
    ...t.body,
    color: color.ink,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  label: { ...t.small, color: color.mute, fontWeight: '700' },
  notice: { ...t.small, color: color.success, fontWeight: '700' },
  formError: { ...t.small, color: color.ink, fontWeight: '700' },
  tabs: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm },
});

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  backBtn: { width: 36, height: 36, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  headerText: { flex: 1 },
  title: { ...t.title, color: color.ink },
  subtitle: { ...t.small, color: color.mute },
  center: { paddingVertical: space.xxl, alignItems: 'center', justifyContent: 'center' },
  errorBox: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.signal,
    borderLeftWidth: 4,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
    alignItems: 'flex-start',
  },
  errorText: { ...t.body, color: color.ink },
  emptyBox: { paddingVertical: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute, textAlign: 'center' },
  btn: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  btnPrimary: { backgroundColor: color.deep, borderColor: color.deep },
  btnDanger: { borderColor: color.signal, borderWidth: 2 },
  btnText: { ...t.small, color: color.ink, fontWeight: '700' },
  btnTextOnFill: { color: color.onInk },
  btnTextDanger: { color: color.ink },
});
