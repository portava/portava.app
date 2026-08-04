/**
 * Internal Portava share icon preview.
 *
 * Dev-only route for visually verifying the custom PortavaShareIcon at the
 * sizes/themes it will actually ship at (compact list row, feed action bar,
 * toolbar, share-sheet row, large control) before wiring it into product
 * surfaces. Does not change any production sharing behavior.
 */
import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { PortavaShareIcon } from '../../src/components/icons/PortavaShareIcon.tsx';
import { PortavaShareButton } from '../../src/components/share/PortavaShareButton.tsx';
import { color, radius, space, type as t } from '../../src/theme/tokens.ts';

const SIZES: { label: string; size: number }[] = [
  { label: 'Compact (14px)', size: 14 },
  { label: 'Feed action (20px)', size: 20 },
  { label: 'Toolbar (22px)', size: 22 },
  { label: 'Share-sheet row (24px)', size: 24 },
  { label: 'Large control (32px)', size: 32 },
];

function Swatch({ background, iconColor, title }: { background: string; iconColor: string; title: string }) {
  return (
    <View style={[styles.section, { backgroundColor: background }]}>
      <Text style={[styles.sectionTitle, { color: iconColor }]}>{title}</Text>
      <View style={styles.row}>
        {SIZES.map(({ label, size }) => (
          <View key={label} style={styles.cell}>
            <View style={styles.iconWell}>
              <PortavaShareIcon size={size} color={iconColor} />
            </View>
            <Text style={[styles.cellLabel, { color: iconColor }]}>{label}</Text>
          </View>
        ))}
      </View>
      <View style={styles.buttonRow}>
        <PortavaShareButton
          onPress={() => {}}
          iconSize={20}
          color={iconColor}
          accessibilityLabel="Share this post (preview)"
        />
        <Text style={[styles.cellLabel, { color: iconColor }]}>PortavaShareButton (44x44 hit target)</Text>
      </View>
    </View>
  );
}

export default function ShareIconPreviewScreen() {
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
            accessibilityLabel="Back"
            hitSlop={8}
          >
            <Ionicons name="arrow-back" size={22} color={color.ink} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>INTERNAL PREVIEW</Text>
            <Text style={styles.title}>Portava share icon</Text>
          </View>
        </View>

        <Text style={styles.intro}>
          Modern Open Connected: an almost-complete loop, open at the lower
          right, flowing into a tapered arrow toward the upper right. Check
          each size for a clearly visible opening, an unclipped arrowhead,
          and even weight against Lucide siblings.
        </Text>

        <View style={[styles.section, { backgroundColor: color.paperRaised, alignItems: 'center' }]}>
          <Text style={styles.sectionTitle}>Hero (160px)</Text>
          <View style={{ borderWidth: 1, borderColor: '#ccc' }}>
            <PortavaShareIcon size={160} color={color.ink} />
          </View>
        </View>

        <Swatch background={color.paperRaised} iconColor={color.ink} title="Light surface — ink" />
        <Swatch background={color.ink} iconColor={color.onInk} title="Dark / immersive surface — onInk" />
        <Swatch background="#000000" iconColor="#FFFFFF" title="Full-bleed media overlay — white" />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  content: { paddingHorizontal: space.lg, paddingBottom: space.xxxl, gap: space.lg },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingTop: space.sm },
  backButton: { padding: space.xs },
  headerCopy: { flex: 1, gap: space.xs },
  eyebrow: { ...t.stamp, color: color.signal },
  title: { ...t.title, color: color.ink },
  intro: { ...t.body, color: color.mute },
  section: { borderRadius: radius.md, padding: space.lg, gap: space.md },
  sectionTitle: { ...t.heading },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.lg },
  cell: { alignItems: 'center', gap: space.xs, width: 92 },
  iconWell: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellLabel: { ...t.stamp, fontSize: 10, textAlign: 'center' },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
});
