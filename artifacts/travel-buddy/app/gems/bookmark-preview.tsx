/**
 * Internal bookmark comparison preview.
 *
 * This route is intentionally development-only. It gives the team a reachable
 * surface for comparing the Ionicons bookmark used by the Gems screens with
 * the Lucide bookmark used by the immersive media action rail, without
 * changing either production save flow.
 */
import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Bookmark } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../src/theme/tokens';

const GEM_OUTLINE = '#8A9BB5';
const GEM_SAVED = '#4C8BF5';
const FEED_OUTLINE = '#FFFFFF';
const FEED_SAVED = color.signal;

type IconLibrary = 'Ionicons' | 'Lucide';

function BookmarkIcon({
  library,
  saved,
  size,
  outlineColor,
  savedColor,
}: {
  library: IconLibrary;
  saved: boolean;
  size: number;
  outlineColor: string;
  savedColor: string;
}) {
  const iconColor = saved ? savedColor : outlineColor;

  if (library === 'Ionicons') {
    return (
      <Ionicons
        name={saved ? 'bookmark' : 'bookmark-outline'}
        size={size}
        color={iconColor}
      />
    );
  }

  return (
    <Bookmark
      size={size}
      color={iconColor}
      fill={saved ? savedColor : 'transparent'}
      strokeWidth={saved ? 0 : 1.8}
    />
  );
}

function IconColumn({
  library,
  size,
  outlineColor,
  savedColor,
}: {
  library: IconLibrary;
  size: number;
  outlineColor: string;
  savedColor: string;
}) {
  return (
    <View style={styles.iconColumn}>
      <Text style={styles.libraryLabel}>{library}</Text>
      <View style={styles.stateSample}>
        <BookmarkIcon
          library={library}
          saved={false}
          size={size}
          outlineColor={outlineColor}
          savedColor={savedColor}
        />
        <Text style={styles.stateLabel}>Unsaved / outline</Text>
      </View>
      <View style={styles.stateSample}>
        <BookmarkIcon
          library={library}
          saved
          size={size}
          outlineColor={outlineColor}
          savedColor={savedColor}
        />
        <Text style={styles.stateLabel}>Saved / filled</Text>
      </View>
    </View>
  );
}

function ComparisonSection({
  title,
  detail,
  backgroundColor,
  outlineColor,
  savedColor,
  size,
}: {
  title: string;
  detail: string;
  backgroundColor: string;
  outlineColor: string;
  savedColor: string;
  size: number;
}) {
  return (
    <View style={[styles.section, { backgroundColor }]}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionDetail}>{detail}</Text>
      <View style={styles.columns}>
        <IconColumn
          library="Ionicons"
          size={size}
          outlineColor={outlineColor}
          savedColor={savedColor}
        />
        <IconColumn
          library="Lucide"
          size={size}
          outlineColor={outlineColor}
          savedColor={savedColor}
        />
      </View>
    </View>
  );
}

export default function BookmarkPreviewScreen() {
  useEffect(() => {
    if (!__DEV__) {
      router.replace('/gems');
    }
  }, []);

  if (!__DEV__) return null;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Back to Gems"
            hitSlop={8}
          >
            <Ionicons name="arrow-back" size={22} color={color.onInk} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>INTERNAL PREVIEW</Text>
            <Text style={styles.title}>Bookmark comparison</Text>
          </View>
        </View>

        <Text style={styles.intro}>
          Compare the two bookmark libraries before choosing a single save icon.
          This screen has no save action and does not change Gems behavior.
        </Text>

        <ComparisonSection
          title="Gems list / detail"
          detail="Muted outline and blue saved state · 22pt detail action"
          backgroundColor="#1E2D45"
          outlineColor={GEM_OUTLINE}
          savedColor={GEM_SAVED}
          size={22}
        />

        <ComparisonSection
          title="Full-screen Gems feed"
          detail="White outline and vermilion saved state · 28pt action rail"
          backgroundColor={color.ink}
          outlineColor={FEED_OUTLINE}
          savedColor={FEED_SAVED}
          size={28}
        />

        <Text style={styles.note}>
          The Gems list count decoration uses a 13pt Ionicons outline; the
          comparison uses the larger interactive sizes above for a clearer
          visual review.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0A1628',
  },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xxxl,
    gap: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingTop: space.sm,
  },
  backButton: {
    padding: space.xs,
  },
  headerCopy: {
    flex: 1,
    gap: space.xs,
  },
  eyebrow: {
    ...t.stamp,
    color: GEM_SAVED,
  },
  title: {
    ...t.title,
    color: color.onInk,
  },
  intro: {
    ...t.body,
    color: color.onInkMute,
  },
  section: {
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.sm,
  },
  sectionTitle: {
    ...t.heading,
    color: color.onInk,
  },
  sectionDetail: {
    ...t.small,
    color: color.onInkMute,
  },
  columns: {
    flexDirection: 'row',
    gap: space.sm,
    marginTop: space.sm,
  },
  iconColumn: {
    flex: 1,
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(250,249,246,0.08)',
  },
  libraryLabel: {
    ...t.bodyStrong,
    color: color.onInk,
  },
  stateSample: {
    alignItems: 'center',
    gap: space.xs,
    minHeight: 54,
    justifyContent: 'center',
  },
  stateLabel: {
    ...t.stamp,
    color: color.onInkMute,
    textAlign: 'center',
  },
  note: {
    ...t.small,
    color: color.onInkMute,
    paddingHorizontal: space.xs,
  },
});