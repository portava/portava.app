/**
 * Trail — the "where next?" movement follow-up (Intelligence Gathering / IG-06).
 *
 * Two things the spec asks for on the Trail: an exit sheet (why you're leaving /
 * what's next) and a visibility picker that decides who — if anyone — can see
 * the movement. Private is the default; nothing is public unless the traveler
 * deliberately chooses it here.
 *
 * Gated on BOTH `intel_capture_quick_signal` and `intel_trail_followup` (the
 * Trail rides the capture write path). Off ⇒ inert. Fully suppressed during an
 * active Safe Return / emergency.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { color, space, radius, typography } from '../../src/theme/tokens';
import { IntelModalScaffold } from '../../src/components/intel/IntelModalScaffold';
import { PromptBlock } from '../../src/components/intel/PromptBlock';
import { VisibilityPicker } from '../../src/components/intel/VisibilityPicker';
import { SuppressedNotice } from '../../src/components/intel/IntelBits';
import { useIntelPrompts } from '../../src/hooks/useIntelPrompts';
import {
  EXIT_REASONS,
  DEFAULT_VISIBILITY,
  VISIBILITY_META,
  type PromptQuestion,
  type Visibility,
} from '../../src/lib/intel/contracts';

/** The exit-reason set, wired to submit on the Trail path. */
const EXIT_QUESTION: PromptQuestion = {
  id: 'exit',
  topic: 'why leave',
  prompt: 'Why are you leaving?',
  kind: 'context',
  context: 'exit',
  options: EXIT_REASONS,
  phase1: true,
};

export default function TrailScreen() {
  const params = useLocalSearchParams<{ subjectId?: string; subjectName?: string; venue?: string }>();
  const subjectId = typeof params.subjectId === 'string' ? params.subjectId : undefined;
  const subjectName = typeof params.subjectName === 'string' ? params.subjectName : undefined;

  const { captureEnabled, trailEnabled, safeReturnActive } = useIntelPrompts();
  const [visibility, setVisibility] = useState<Visibility>(DEFAULT_VISIBILITY);

  const shareNote = useMemo(() => {
    if (visibility === 'private') return 'Kept to yourself. Nothing is shared.';
    return VISIBILITY_META[visibility].description;
  }, [visibility]);

  let body: React.ReactNode;
  if (!captureEnabled || !trailEnabled) {
    body = <SuppressedNotice reason="disabled" />;
  } else if (safeReturnActive) {
    body = <SuppressedNotice reason="safe_return" />;
  } else if (!subjectId) {
    body = (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyTitle}>Open this from a place</Text>
        <Text style={styles.emptyBody}>The Trail follow-up attaches to the place you’re leaving.</Text>
      </View>
    );
  } else {
    body = (
      <>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Who can see this?</Text>
          <VisibilityPicker value={visibility} onChange={setVisibility} />
          <Text style={styles.shareNote}>{shareNote}</Text>
        </View>

        <View style={styles.divider} />

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Heading out</Text>
          <PromptBlock subjectId={subjectId} question={EXIT_QUESTION} visibility={visibility} />
          <Text style={styles.footnote}>
            Your reason helps others read whether a spot is worth it. Shared at the visibility you chose above.
          </Text>
        </View>
      </>
    );
  }

  return (
    <IntelModalScaffold title="Where next?" subtitle={subjectName ?? 'Trail follow-up'}>
      {body}
    </IntelModalScaffold>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.md },
  sectionTitle: { ...typography.sectionTitle, color: color.ink },
  shareNote: { ...typography.caption, color: color.mute },
  divider: { height: 1, backgroundColor: color.haze },
  footnote: { ...typography.caption, color: color.faint, lineHeight: 18 },
  emptyCard: {
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    gap: 6,
  },
  emptyTitle: { ...typography.cardTitle, color: color.ink },
  emptyBody: { ...typography.caption, color: color.mute, lineHeight: 19 },
});
