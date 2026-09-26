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
import { getIntelConsent, setIntelConsent, hasValidConsent, type IntelConsentState } from '../../src/services/intelConsent';
import { disclosureFor, needsReconsent } from '../../src/lib/sensing/consentDisclosure';
import {
  ACOUSTIC_PERMISSION_DENIED,
  readAcousticSensingPermission,
  requestAcousticSensingPermission,
  withdrawAcousticSensingPermission,
} from '../../src/services/sensing/acousticSensingPermission';
import {
  acousticCaptureAllowed,
  type AcousticPermission,
} from '../../src/lib/sensing/acousticPermission';

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

  // D4 Intelligence Contributions consent — a persistent, separate control. The
  // server is authoritative; this row reflects and updates that state.
  const [consent, setConsent] = React.useState<IntelConsentState | null | undefined>(undefined);
  React.useEffect(() => {
    let alive = true;
    getIntelConsent().then((s) => { if (alive) setConsent(s); }).catch(() => { if (alive) setConsent(null); });
    return () => { alive = false; };
  }, []);
  const consentOn = hasValidConsent(consent);
  // The words shown are the words of a VERSION: what the person agreed to when
  // on, what a grant would record when off. A version this build has no text
  // for offers no grant — it never shows older words (lib/sensing/consentDisclosure).
  const recorded = disclosureFor(consent?.consentVersion);
  const offered = disclosureFor(consent?.currentDisclosureVersion);
  const reconsent = needsReconsent(consent);
  const toggleConsent = React.useCallback(async (v: boolean) => {
    const next = await setIntelConsent(v, v ? offered?.version : undefined);
    if (next) setConsent(next);
  }, [offered]);

  // §4.1's SEPARATE acoustic permission. Not the call/video microphone: its own
  // scope, its own storage key, its own switch, and off until this row is used.
  const [acoustic, setAcoustic] = React.useState<AcousticPermission | undefined>(undefined);
  React.useEffect(() => {
    let alive = true;
    readAcousticSensingPermission()
      .then((p) => { if (alive) setAcoustic(p); })
      .catch(() => { if (alive) setAcoustic(ACOUSTIC_PERMISSION_DENIED); });
    return () => { alive = false; };
  }, []);
  const acousticOn = acousticCaptureAllowed(acoustic);
  const toggleAcoustic = React.useCallback(async (v: boolean) => {
    setAcoustic(v ? await requestAcousticSensingPermission() : await withdrawAcousticSensingPermission());
  }, []);

  return (
    <SettingsScreen title="Live intel prompts" subtitle="When we may ask you to share a signal">
      <SettingsSection
        title="Intelligence Contributions"
        subtitle="Let your Quick Signals help build aggregated live place intelligence."
      >
        <ToggleRow
          title="Contribute to live place intelligence"
          subtitle={
            consentOn
              ? `On — ${recorded?.summary ?? offered?.summary ?? 'your signals count toward aggregated intelligence.'}${
                  reconsent ? ' The terms have changed since you agreed; turn this off and on again to review them.' : ''
                }`
              : offered
                ? `Off — your signals won't contribute, and capture stays disabled until you turn this on. On: ${offered.summary}`
                : "Off — the terms for contributing can't be shown on this version of the app. Update the app to review them."
          }
          value={consentOn}
          onValueChange={toggleConsent}
          disabled={consent === undefined || (!consentOn && !offered)}
        />
      </SettingsSection>

      {/*
        Sensing spec §4.1: coarse acoustic energy/rhythm ONLY under separate
        explicit permission. This is that permission, and this row is the only
        place it can be granted. It is deliberately its OWN section and its own
        switch: Portava already holds a microphone permission for calls and
        video, and §3 requires purpose-scoped authorization, so the microphone a
        traveller granted to talk to a friend must not silently become a sensor.
        Turning this on is what asks the OS; turning it off withdraws the
        purpose scope and leaves calls untouched.
      */}
      <SettingsSection
        title="Sound level sensing"
        subtitle="Separate from the microphone used for calls and video."
      >
        <ToggleRow
          title="Use a coarse sound level"
          subtitle={
            acousticOn
              ? 'On — Portava takes a loudness and rhythm reading to tell whether a place is lively. No audio is recorded, kept or sent.'
              : 'Off — Portava never listens for this. Granting the microphone for a call does not turn this on.'
          }
          value={acousticOn}
          onValueChange={toggleAcoustic}
          disabled={acoustic === undefined || !consentOn}
        />
      </SettingsSection>

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
