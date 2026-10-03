/**
 * Age requirements — where an `underage` identity-check result routes
 * (census-trust §31, TV-2d: "underage routes to an age-policy screen and does
 * NOT allow retry spam").
 *
 * Every sentence states behaviour the server already enforces; nothing here is
 * new policy:
 *   - the profile date of birth must be 18+ (routes/profile.ts age gate);
 *   - Rent a Buddy, and events and meetups whose host set an age limit, check
 *     age through lib/gateAge.ts before admitting anyone;
 *   - a provider result that does not confirm 18+ refuses those gates whatever
 *     birthday is typed (lib/travelerVerification.ts, IDF-25);
 *   - the identity check keeps a yes/no, never the document or its date of
 *     birth (src/lib/verificationDisclosure.ts, pinned against the schema).
 * What ELSE should follow a verified-minor result (suspension, account age
 * restriction) is an open owner decision and is deliberately not stated.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SettingsScreen, SettingsSection } from '../../src/components/settings/SettingsUI';
import { PP } from '../../src/theme/passportTokens';
import { space, type as t } from '../../src/theme/tokens';

const PARAGRAPHS: ReadonlyArray<{ title: string; lines: readonly string[] }> = [
  {
    title: 'Who can use what',
    lines: [
      'Portava is for people aged 18 and over.',
      'Some features check your age before you can take part: Rent a Buddy, and events or meetups whose host has set an age limit.',
    ],
  },
  {
    title: "When an identity check doesn't confirm 18+",
    lines: [
      "If your identity check didn't confirm that you're 18 or over, the features that need a verified adult stay unavailable to you, whatever date of birth is on your profile.",
      "Running the check again won't change that result, so the check isn't offered again here.",
    ],
  },
  {
    title: 'What we keep',
    lines: [
      "From the identity check we keep only a yes-or-no answer to “over 18?”. We never store your document, its number, your selfie, or the date of birth printed on it.",
    ],
  },
];

export default function AgePolicyScreen() {
  return (
    <SettingsScreen title="Age requirements">
      {PARAGRAPHS.map((p) => (
        <SettingsSection key={p.title} title={p.title.toUpperCase()}>
          <View style={styles.body}>
            {p.lines.map((line) => (
              <Text key={line} style={styles.line}>{line}</Text>
            ))}
          </View>
        </SettingsSection>
      ))}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.md, gap: space.sm },
  line: { ...t.body, color: PP.ink, lineHeight: 21 },
});
