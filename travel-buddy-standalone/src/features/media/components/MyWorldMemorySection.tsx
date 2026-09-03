/**
 * MyWorldMemorySection — the §31 / §31.1 "What you did · your travel memory"
 * surface inside the My World lens.
 *
 * OWNER-ONLY, PRIVATE. This renders the viewer's OWN derived memory groupings
 * (Returned to Place · Favorite atmosphere · Night out with Trip Crew · Saved
 * visual inspiration · Experience matched expectation · Visited / Discovered
 * Hidden Gem) and their §31.1 Hidden Gem Memory lines ("You discovered this
 * Gem.", "You visited before it became popular.", …). Every entry the backend
 * hands us is `visibility: 'owner_only'`; this section frames the whole thing as
 * private to the viewer and is NEVER shown for another user's My World.
 *
 * It reads from what the owner did — it writes nothing and reuses the same
 * allow/deny boundary as the memory settings (so anything forgotten / hidden /
 * sensitive never reaches here). It is purely presentational: given an empty
 * memory surface it renders NOTHING (returns null), so the lens degrades to a
 * clean empty state (§33/§39). No precise-location UI, no fake-live (§46.2).
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import type { MyWorldMemory } from '../types/myWorld.ts';
import { isMyWorldMemoryEmpty, visibleMemoryGroups } from '../services/mediaProjection.ts';

export interface MyWorldMemorySectionProps {
  memory: MyWorldMemory;
}

const DEFAULT_PRIVACY_NOTE =
  'Built from what you did. It is private to you — never shown on your public profile or anyone else’s My World.';

export function MyWorldMemorySection({ memory }: MyWorldMemorySectionProps) {
  // Degrade cleanly: nothing to remember yet ⇒ render nothing.
  if (isMyWorldMemoryEmpty(memory)) return null;

  const groups = visibleMemoryGroups(memory);
  const gemLines = memory.hiddenGemMemory;

  const privacyNote = memory.notes[0] ?? DEFAULT_PRIVACY_NOTE;

  return (
    <View style={styles.section} accessibilityLabel="Your travel memory, private to you">
      <View style={styles.headerRow}>
        <Text style={styles.title} accessibilityRole="header">
          Your travel memory
        </Text>
        <View style={styles.privatePill}>
          <Text style={styles.privatePillText}>Private to you</Text>
        </View>
      </View>
      <Text style={styles.subtitle}>{privacyNote}</Text>

      {groups.map((g) => (
        <View key={g.group} style={styles.group}>
          <Text style={styles.groupLabel}>{g.label}</Text>
          {g.description ? <Text style={styles.groupDesc}>{g.description}</Text> : null}
          {g.entries.map((e) => (
            <View key={e.id} style={styles.entryRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.entryText}>{e.detail ?? e.title}</Text>
            </View>
          ))}
        </View>
      ))}

      {gemLines.length > 0 ? (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>Hidden Gem Memory</Text>
          <Text style={styles.groupDesc}>Your private history with the Gems you found and kept.</Text>
          {gemLines.map((line, i) => (
            <View key={`${line.gemId}:${line.kind}:${i}`} style={styles.entryRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.entryText}>
                {line.label}
                {line.gemName ? <Text style={styles.gemName}> {line.gemName}</Text> : null}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <Text style={styles.footer}>
        Only you can see this. Nothing here is written to a public feed — it is read from your own activity.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginHorizontal: space.lg,
    marginBottom: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: 'rgba(250,249,246,0.05)',
    gap: space.md,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  title: { color: color.onInk, fontSize: 17, fontWeight: '800', letterSpacing: -0.3, flexShrink: 1 },
  privatePill: {
    paddingHorizontal: space.md,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.10)',
  },
  privatePillText: { color: color.onInkMute, fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },
  subtitle: { color: color.onInkMute, fontSize: 13, lineHeight: 18 },
  group: { gap: space.xs },
  groupLabel: { color: color.onInk, fontSize: 14, fontWeight: '800', letterSpacing: -0.2 },
  groupDesc: { color: color.faint, fontSize: 12, lineHeight: 16, marginBottom: 2 },
  entryRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  bullet: { color: color.onInkMute, fontSize: 14, lineHeight: 20 },
  entryText: { color: color.onInkMute, fontSize: 13, lineHeight: 20, flexShrink: 1 },
  gemName: { color: color.onInk, fontWeight: '700' },
  footer: { color: color.faint, fontSize: 11, lineHeight: 16, fontStyle: 'italic' },
});
