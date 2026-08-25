/**
 * IntelModalScaffold — shared chrome for the Intelligence Gathering modal
 * screens (Quick Signal, Venue sheet, Moment, Trail, Claim actions).
 *
 * A slim header (title + optional subtitle + close), safe-area aware, over the
 * place-page paper palette (`tokens.ts`) so capture surfaces feel continuous
 * with the place card that launches them.
 */
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { router } from 'expo-router';
import { color, space, radius, typography, layout } from '../../theme/tokens.ts';

export interface IntelModalScaffoldProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  /** Rendered pinned under the scroll (e.g. a primary action / Done button). */
  footer?: React.ReactNode;
  onClose?: () => void;
  scroll?: boolean;
}

export function IntelModalScaffold({
  title,
  subtitle,
  children,
  footer,
  onClose,
  scroll = true,
}: IntelModalScaffoldProps) {
  const insets = useSafeAreaInsets();
  const close = onClose ?? (() => (router.canGoBack() ? router.back() : router.replace('/(tabs)' as any)));

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top + space.sm, 24) }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        <Pressable
          onPress={close}
          hitSlop={layout.hitSlop}
          accessibilityRole="button"
          accessibilityLabel="Close"
          style={styles.closeBtn}
        >
          <X size={22} color={color.ink} />
        </Pressable>
      </View>

      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.content, { flex: 1 }]}>{children}</View>
      )}

      {footer ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>{footer}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  title: { ...typography.pageTitle, color: color.ink },
  subtitle: { ...typography.caption, color: color.mute, marginTop: 2 },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
  },
  content: {
    padding: space.lg,
    gap: space.xl,
    maxWidth: layout.maxWidth,
    width: '100%',
    alignSelf: 'center',
  },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    backgroundColor: color.paperRaised,
  },
});
