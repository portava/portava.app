/**
 * SensingConsentSection — OD-MAP-6's three separate passive-sensing consents as
 * three switches, each OFF until the person turns it on, each revocable here.
 *
 * Every switch shows the four things the lead's Q-L20 ruling requires, in plain
 * words: what is captured, where it goes, who sees it, how to turn it off
 * (lib/sensing/consentSplit.ts — the draft is pending legal review).
 *
 * Rules this section holds:
 *   - A consent that could not be READ is shown as "couldn't load", with a retry,
 *     and its switch cannot be moved — never as "off".
 *   - Turning ON needs the feature to be available server-side AND this build to
 *     have the words the server has in force. Turning OFF is always possible:
 *     revocable means revocable.
 *   - A switch shows what the SERVER recorded after the change; a failed change
 *     leaves the switch where it was and says so.
 *   - Each later consent says it has an effect only while the earlier ones are on,
 *     and shows whether it is in effect now.
 */
import React from 'react';
import { SettingsSection, ToggleRow, SettingsRow, FieldHint } from '../settings/SettingsUI.tsx';
import { SENSING_CONSENT_SCOPES, wordsFor, type SensingConsentScope } from '../../lib/sensing/consentSplit.ts';
import {
  readSensingConsent,
  setSensingConsent,
  type SensingConsentRead,
  type SensingConsentState,
} from '../../services/sensingConsent.ts';

function subtitleFor(scope: SensingConsentScope, state: SensingConsentState): string {
  const c = state.consents[scope];
  const words = wordsFor(scope, c.currentVersion);
  if (!words) return 'The words for this setting can’t be shown on this version of the app. Update the app to review them.';
  const status = c.granted
    ? c.current
      ? c.effective ? 'On.' : 'On, but not in effect until the settings above are on.'
      : 'On under older words — turn this off and on again to review the current ones.'
    : 'Off.';
  return [status, words.what, words.where, words.who, words.needs, words.off].filter(Boolean).join(' ');
}

export function SensingConsentSection() {
  const [read, setRead] = React.useState<SensingConsentRead | undefined>(undefined);
  const [attempt, setAttempt] = React.useState(0);
  const [busy, setBusy] = React.useState<SensingConsentScope | null>(null);
  const [writeFailed, setWriteFailed] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    setRead(undefined);
    void readSensingConsent().then((r) => { if (alive) setRead(r); });
    return () => { alive = false; };
  }, [attempt]);

  const state = read?.status === 'ok' ? read.state : null;

  const toggle = React.useCallback(async (scope: SensingConsentScope, next: boolean) => {
    if (!state) return;
    setBusy(scope);
    setWriteFailed(null);
    const out = await setSensingConsent(scope, next, state.consents[scope].currentVersion);
    setBusy(null);
    if (!out.ok) {
      setWriteFailed(
        out.reason === 'words_unavailable'
          ? 'This version of the app can’t show the current words for that setting, so it wasn’t turned on. Update the app.'
          : out.reason === 'refused'
            ? 'That setting can’t be turned on right now. Nothing was changed.'
            : 'Couldn’t save that change — your setting is unchanged. Please try again.',
      );
      return;
    }
    if (out.state) setRead({ status: 'ok', state: out.state });
    else setAttempt((n) => n + 1); // saved, but the read-back failed: load it again rather than guess
  }, [state]);

  return (
    <SettingsSection
      title="Area sensing"
      subtitle="Three separate choices. Each is off until you turn it on, and you can turn any of them off here at any time. None of them is part of your general app permissions."
    >
      {read === undefined ? (
        <FieldHint>Loading…</FieldHint>
      ) : !state ? (
        <>
          <FieldHint tone="error">Couldn’t load these settings, so they can’t be changed right now. Your choices haven’t been changed.</FieldHint>
          <SettingsRow title="Try again" onPress={() => setAttempt((n) => n + 1)} chevron={false} testID="sensing-consent-retry" />
        </>
      ) : (
        SENSING_CONSENT_SCOPES.map((scope) => {
          const c = state.consents[scope];
          const canTurnOn = state.available && wordsFor(scope, c.currentVersion) !== null;
          return (
            <ToggleRow
              key={scope}
              title={wordsFor(scope, c.currentVersion)?.title ?? scope}
              subtitle={subtitleFor(scope, state)}
              value={c.granted}
              onValueChange={(v) => { void toggle(scope, v); }}
              // OFF is always reachable; ON only when the feature is available and the words are known.
              disabled={busy !== null || (!c.granted && !canTurnOn)}
              switchTestID={`sensing-consent-${scope}`}
            />
          );
        })
      )}
      {state && !state.available ? (
        <FieldHint>Area sensing isn’t available yet, so these can’t be turned on. Anything already on can still be turned off.</FieldHint>
      ) : null}
      {writeFailed ? <FieldHint tone="error">{writeFailed}</FieldHint> : null}
    </SettingsSection>
  );
}
