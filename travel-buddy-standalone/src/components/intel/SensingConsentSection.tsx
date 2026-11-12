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
import { AppState, Linking, Platform } from 'react-native';
import { areaLocationAccess } from '../../services/sensing/deviceSensorSources.ts';
import { AcousticSensingSection } from './AcousticSensingSection.tsx';
import { SensingErasureControl } from './SensingErasureControl.tsx';
import { useInputAccountEpoch } from '../../platform/input-assistance/hooks/useInputAccountEpoch.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../../services/discoveryViewerScope.ts';
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

function AreaLocationRow() {
  const [access, setAccess] = React.useState<Awaited<ReturnType<typeof areaLocationAccess>> | null>(null);
  const [settingsError, setSettingsError] = React.useState(false);
  const mounted = React.useRef(false);
  React.useEffect(() => {
    mounted.current = true;
    let revision = 0;
    async function refresh() {
      const version = ++revision;
      const result = await areaLocationAccess();
      if (mounted.current && version === revision) setAccess(result);
    }
    void refresh();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { mounted.current = false; subscription.remove(); };
  }, []);
  if (Platform.OS === 'web' || !access || access === 'granted') return null;
  if (access === 'unavailable') return <FieldHint>Location is unavailable on this device. Portava can’t determine your area.</FieldHint>;
  const press = async () => {
    setSettingsError(false);
    if (access === 'settings') {
      try { await Linking.openSettings(); } catch { if (mounted.current) setSettingsError(true); }
    } else {
      const result = await areaLocationAccess(true);
      if (mounted.current) setAccess(result);
    }
  };
  return <>
    <SettingsRow title={access === 'settings' ? 'Open location settings' : 'Allow location while using Portava'}
      subtitle="Area sensing needs foreground location to identify your approximate area."
      onPress={() => { void press(); }} testID="sensing-location-access" />
    {settingsError && <FieldHint tone="error">Open your device settings to change Portava’s location access.</FieldHint>}
  </>;
}

export function SensingConsentSection() {
  const epoch = useInputAccountEpoch();
  return <SensingConsentSectionForOwner key={epoch} />;
}

function SensingConsentSectionForOwner() {
  const owner = React.useRef(currentDiscoveryScope()).current;
  const mounted = React.useRef(true);
  const saving = React.useRef(false);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && isCurrentDiscoveryScope(owner);
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
    if (!state || saving.current || !current()) return;
    saving.current = true;
    setBusy(scope);
    setWriteFailed(null);
    let out: Awaited<ReturnType<typeof setSensingConsent>>;
    try { out = await setSensingConsent(scope, next, state.consents[scope].currentVersion); }
    catch { out = { ok: false, reason: 'failed' }; }
    saving.current = false;
    if (!current()) return;
    setBusy(null);
    if (!out.ok) {
      setWriteFailed(
        out.reason === 'words_unavailable'
          ? 'This version of the app can’t show the current words for that setting, so it wasn’t turned on. Update the app.'
          : out.reason === 'refused'
            ? 'That setting can’t be turned on right now. Nothing was changed.'
            : !next ? 'Couldn’t confirm the withdrawal with the server. The affected sensing is paused on this phone. Please retry turning it off.' : 'Couldn’t save that change — your setting is unchanged. Please try again.',
      );
      return;
    }
    if (out.state) setRead({ status: 'ok', state: out.state });
    else setAttempt((n) => n + 1); // saved, but the read-back failed: load it again rather than guess
  }, [state]);

  return (
    <>
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
      {state?.localWithdrawalPending?.length ? <FieldHint tone="error">A withdrawal is waiting to be saved. The affected sensing stays paused on this phone. Turn the setting off again to retry.</FieldHint> : null}
      {writeFailed ? <FieldHint tone="error">{writeFailed}</FieldHint> : null}
      {state?.available && state.consents.capture.effective && <AreaLocationRow />}
      <SensingErasureControl />
    </SettingsSection>
    <AcousticSensingSection captureAllowed={state?.available === true && state.consents.capture.effective} />
    </>
  );
}
