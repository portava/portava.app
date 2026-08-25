/**
 * Settings → Live intel prompts — the prompt-pause controls.
 *
 * The spec requires the traveler can silence Intelligence Gathering capture
 * prompts at three scopes: for this session, per venue category, or permanently.
 * These controls never touch what has already been shared — they only stop the
 * app from proactively asking. Explicitly tapping "Share a signal" still works.
 *
 * When `intel_capture_quick_signal` is off the whole feature is inert; the
 * screen says so rather than pretending the toggles do anything.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  SettingsScreen,
  SettingsSection,
  SettingsDivider,
  ToggleRow,
  SettingsRow,
} from '../../src/components/settings/SettingsUI';
import { PP } from '../../src/theme/passportTokens';
import { useIntelPrompts } from '../../src/hooks/useIntelPrompts';
import { VENUE_CATEGORIES, VENUE_LABELS } from '../../src/lib/intel/contracts';
import { isCategoryPaused } from '../../src/lib/intel/promptPauseStorage';

export default function IntelPromptsSettingsScreen() {
  const {
    captureEnabled,
    pauseState,
    sessionPaused,
    pauseSession,
    resumeSession,
    pauseAll,
    pauseCategory,
    resumeEverything,
  } = useIntelPrompts();

  return (
    <SettingsScreen title="Live intel prompts" subtitle="When we may ask you to share a signal">
      {!captureEnabled ? (
        <View style={styles.offNote}>
          <Text style={styles.offNoteText}>
            Live intel capture is currently turned off, so no prompts appear. These preferences are saved and take
            effect if it’s enabled.
          </Text>
        </View>
      ) : null}

      <SettingsSection title="Quick pause" subtitle="Silence prompts without changing anything you’ve shared.">
        <ToggleRow
          title="Pause for this session"
          subtitle="Stops prompts until you next reopen the app."
          value={sessionPaused}
          onValueChange={(v) => (v ? pauseSession() : resumeSession())}
        />
        <SettingsDivider />
        <ToggleRow
          title="Pause all prompts"
          subtitle="No capture prompts anywhere, until you turn this back off."
          value={pauseState.pausedAll}
          onValueChange={pauseAll}
        />
      </SettingsSection>

      <SettingsSection title="Pause by place type" subtitle="Keep prompts where you like them; mute the rest.">
        {VENUE_CATEGORIES.map((cat, i) => (
          <React.Fragment key={cat}>
            {i > 0 ? <SettingsDivider /> : null}
            <ToggleRow
              title={VENUE_LABELS[cat]}
              value={isCategoryPaused(pauseState, cat)}
              onValueChange={(v) => pauseCategory(cat, v)}
              disabled={pauseState.pausedAll}
            />
          </React.Fragment>
        ))}
        <SettingsDivider />
        <ToggleRow
          title="Everywhere else"
          subtitle="Prompts not tied to a specific place type."
          value={isCategoryPaused(pauseState, 'general')}
          onValueChange={(v) => pauseCategory('general', v)}
          disabled={pauseState.pausedAll}
        />
      </SettingsSection>

      <SettingsSection title="Reset">
        <SettingsRow
          title="Resume all prompts"
          subtitle="Clears every pause above and the session pause."
          onPress={resumeEverything}
          danger
          chevron={false}
        />
      </SettingsSection>

      <Text style={styles.footnote}>
        Pausing only stops the app from asking. You can always share a signal yourself from a place, and nothing you’ve
        already shared is affected.
      </Text>
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  offNote: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: PP.borderLight,
    backgroundColor: '#FFFDF7',
  },
  offNoteText: { fontSize: 13, lineHeight: 19, color: PP.inkMuted },
  footnote: { fontSize: 12, lineHeight: 17, color: PP.inkMuted, paddingHorizontal: 4 },
});
