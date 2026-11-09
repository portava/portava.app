import React from 'react';
import { SettingsSection, ToggleRow, SettingsRow, FieldHint } from '../settings/SettingsUI.tsx';
import {
  ACOUSTIC_PERMISSION_DENIED,
  getAcousticSensingPermissionSnapshot,
  onAcousticSensingPermissionChange,
  readAcousticSensingPermission,
  requestAcousticSensingPermission,
  withdrawAcousticSensingPermission,
  type AcousticPermissionSnapshot,
} from '../../services/sensing/acousticSensingPermission.ts';
import {
  acousticCaptureAllowed,
} from '../../lib/sensing/acousticPermission.ts';

export function AcousticSensingSection({ captureAllowed }: { captureAllowed: boolean }) {
  // §4.1's SEPARATE acoustic permission. Not the call/video microphone: its own
  // scope, its own storage key, its own switch, and off until this row is used.
  const [acoustic, setAcoustic] = React.useState<AcousticPermissionSnapshot | undefined>(undefined);
  const acousticAlive = React.useRef(false);
  const acousticGrantAllowed = React.useRef(false);
  acousticGrantAllowed.current = captureAllowed;
  React.useEffect(() => {
    let alive = true;
    acousticAlive.current = true;
    const revision = getAcousticSensingPermissionSnapshot().revision;
    const unsubscribe = onAcousticSensingPermissionChange((state) => { if (alive) setAcoustic(state); });
    readAcousticSensingPermission()
      .then((permission) => {
        const state = getAcousticSensingPermissionSnapshot();
        if (alive && state.revision === revision) setAcoustic({ ...state, permission });
      })
      .catch(() => {
        const state = getAcousticSensingPermissionSnapshot();
        if (alive && state.revision === revision) setAcoustic({ ...state, permission: ACOUSTIC_PERMISSION_DENIED });
      });
    return () => { alive = false; acousticAlive.current = false; unsubscribe(); };
  }, []);
  const acousticOn = acousticCaptureAllowed(acoustic?.permission);
  const acousticPending = acoustic?.persistence === 'pending';
  const acousticPurposeOn = acoustic?.permission.granted === true || (acousticPending && acoustic.intent === 'grant');
  const toggleAcoustic = React.useCallback(async (v: boolean) => {
    if (!acousticAlive.current || (v && !acousticGrantAllowed.current)) return;
    if (v) await requestAcousticSensingPermission();
    else await withdrawAcousticSensingPermission();
  }, []);

  return (
      <SettingsSection
        title="Sound level sensing"
        subtitle="Separate from the microphone used for calls and video."
      >
        <ToggleRow
          title="Use a coarse sound level"
          subtitle={
            acousticOn
              ? 'On — Portava takes a coarse loudness and rhythm reading when area capture is allowed.'
              : acousticPurposeOn
                ? acousticPending ? 'Waiting for your explicit microphone choice and saved permission.' : 'Purpose permission is on, but OS microphone permission is not granted. You can still turn this purpose off.'
                : 'Off for sound-level sensing. Granting the microphone for a call does not turn this on.'
          }
          value={acousticPurposeOn}
          onValueChange={toggleAcoustic}
          disabled={acoustic === undefined || (!acousticPurposeOn && (!captureAllowed || acousticPending))}
        />
        {acousticPending ? <FieldHint>Updating sound-level permission…</FieldHint> : null}
        {acoustic?.persistence === 'failed' ? (
          <FieldHint tone="error">
            {acoustic.intent === 'withdraw'
              ? "Sound-level permission is off for this run, but couldn't be saved. Your prior saved setting may return after an app restart. Retry saving withdrawal."
              : "Couldn't save the sound-level grant. Sound-level permission stays off for this run. Your prior saved setting may return after an app restart. Turn it on again only if you still want to grant it."}
          </FieldHint>
        ) : null}
        {acoustic?.persistence === 'failed' && acoustic.intent === 'withdraw' ? (
          <SettingsRow title="Retry saving withdrawal" onPress={() => { void toggleAcoustic(false); }} chevron={false} />
        ) : null}
        <FieldHint>
          Sound-level sensing uses a temporary microphone recording to measure loudness and rhythm. This sensing path sends coarse summaries, not the recording. Temporary files may remain if cleanup fails or the app exits.
        </FieldHint>
      </SettingsSection>
  );
}
