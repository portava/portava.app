/**
 * memorySurfaceParts — the shared chrome of the two owner-only Compass memory
 * screens (CompassRemembersScreen, MemoryRecapsScreen): a header, and the
 * loading / error-with-retry / notice states. Light "paper" palette, the same
 * header shape as JourneysScreen.
 */
import React from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, AlertTriangle } from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import type { MemorySurfaceError } from '../../services/compassMemorySurfaces.ts';

export function MemoryHeader({ title, Icon }: { title: string; Icon: React.ComponentType<{ size?: number; color?: string }> }) {
  return (
    <View style={ms.header}>
      <Pressable style={ms.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Go back">
        <ArrowLeft size={icon.s20} color={color.ink} />
      </Pressable>
      <View style={ms.titleRow}>
        <Icon size={icon.s16} color={color.deep} />
        <Text style={ms.title} numberOfLines={1}>{title}</Text>
      </View>
      <View style={ms.backBtn} />
    </View>
  );
}

export function MemoryLoading({ label }: { label: string }) {
  return (
    <View style={ms.center} accessibilityLabel={label}>
      <ActivityIndicator color={color.signal} />
    </View>
  );
}

/** Copy for a failed request. A failure is never shown as an empty surface. */
export function errorCopy(error: MemorySurfaceError, message?: string): string {
  switch (error) {
    case 'network': return 'Check your connection and try again.';
    case 'unauthenticated': return 'Sign in again to see this.';
    case 'not_configured': return 'This build is not connected to the Portava server.';
    default: return message ?? 'Portava could not load this right now. Please try again.';
  }
}

export function MemoryError({ title, message, onRetry, testID }: { title: string; message: string; onRetry?: () => void; testID?: string }) {
  return (
    <View style={ms.center} testID={testID}>
      <AlertTriangle size={icon.s26} color={color.warn} />
      <Text style={ms.centerTitle}>{title}</Text>
      <Text style={ms.centerText}>{message}</Text>
      {onRetry ? (
        <Pressable style={ms.retryBtn} onPress={onRetry} accessibilityRole="button" accessibilityLabel="Try again">
          <Text style={ms.retryText}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** An inline notice that part of a surface could not be read. */
export function UnavailableNotice({ text, onRetry, testID }: { text: string; onRetry?: () => void; testID?: string }) {
  return (
    <View style={ms.notice} testID={testID}>
      <AlertTriangle size={icon.s14} color={color.warn} />
      <Text style={ms.noticeText}>{text}</Text>
      {onRetry ? (
        <Pressable onPress={onRetry} hitSlop={8} accessibilityRole="button" accessibilityLabel="Try again">
          <Text style={ms.noticeAction}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const ms = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.md, paddingVertical: space.sm,
    borderBottomWidth: 1, borderBottomColor: color.haze, gap: space.sm,
  },
  backBtn: { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs },
  title: { ...t.heading, color: color.ink, fontSize: 17 },
  scrollContent: { padding: space.lg, gap: space.md },
  subtitle: { ...t.small, color: color.mute },
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: space.xxxl, paddingHorizontal: space.xl, gap: space.sm },
  centerTitle: { ...t.bodyStrong, color: color.ink, marginTop: space.xs, textAlign: 'center' },
  centerText: { ...t.small, color: color.mute, textAlign: 'center' },
  retryBtn: { marginTop: space.md, paddingHorizontal: space.xl, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  retryText: { ...t.bodyStrong, color: color.signal, fontSize: 14 },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  noticeText: { ...t.small, color: color.ink, flex: 1 },
  noticeAction: { ...t.bodyStrong, color: color.signal, fontSize: 14 },
  card: { padding: space.md, gap: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  sectionTitle: { ...t.bodyStrong, color: color.ink },
  sectionText: { ...t.small, color: color.mute },
  note: { ...t.small, color: color.mute },
});
