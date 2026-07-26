/**
 * @deprecated Use `AppHeader` from `src/components/ui/AppHeader` instead.
 * All primary tab screens and nested stack screens have been migrated to AppHeader variants.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { color, space, type as t } from '../theme/tokens.ts';

export function ScreenHeader({
  title,
  back,
  right,
}: {
  title: string;
  back?: boolean;
  right?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingTop: insets.top + space.sm }]}>
      {back && (
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.back}>
          <ChevronLeft size={26} color={color.ink} />
        </Pressable>
      )}
      <Text style={styles.title}>{title}</Text>
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, paddingBottom: space.md,
    backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  back: { marginLeft: -6 },
  title: { ...t.title, color: color.ink },
});
