import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ChevronDown, ChevronUp } from 'lucide-react-native';
import { PP } from '../../theme/passportTokens.ts';

/** Secondary profile content stays reachable without mounting every panel at
 * page entry. The entire heading is a labelled, keyboard-accessible control. */
export function PassportDisclosure({ title, summary, children, testID }: {
  title: string; summary?: string; children: React.ReactNode; testID: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <View style={styles.section} testID={testID}>
      <Pressable
        testID={`${testID}-toggle`}
        onPress={() => setExpanded((open) => !open)}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={summary}
        accessibilityState={{ expanded }}
        style={({ pressed }) => [styles.heading, pressed && styles.pressed]}
      >
        <View style={styles.labels}>
          <Text style={styles.title}>{title}</Text>
          {summary ? <Text style={styles.summary}>{summary}</Text> : null}
        </View>
        <Chevron size={18} color={PP.inkMuted} />
      </Pressable>
      {expanded ? <View testID={`${testID}-content`}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginHorizontal: 16, marginTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: PP.borderLight },
  heading: { minHeight: 60, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 16 },
  labels: { flex: 1, gap: 3 },
  title: { color: PP.ink, fontSize: 15, fontWeight: '600' },
  summary: { color: PP.inkMuted, fontSize: 12, lineHeight: 17 },
  pressed: { opacity: 0.65 },
});
