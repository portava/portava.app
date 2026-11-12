import React from 'react';
import { Alert } from 'react-native';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../../services/discoveryViewerScope.ts';
import { eraseRecentSensingContributions, isSensingErasurePending, onSensingErasureChange } from '../../services/sensing/sensingErasure.ts';
import { FieldHint, SettingsRow } from '../settings/SettingsUI.tsx';

/** Separate explicit device erasure; ordinary consent withdrawal never calls it. */
export function SensingErasureControl() {
  const owner = React.useRef(currentDiscoveryScope()).current;
  const alive = React.useRef(true);
  const running = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ failed: boolean; text: string } | null>(null);
  const current = () => alive.current && isCurrentDiscoveryScope(owner);
  React.useEffect(() => {
    alive.current = true;
    const refresh = () => { void isSensingErasurePending().then(value => { if (current()) setPending(value); }); };
    const unsubscribe = onSensingErasureChange(refresh); refresh();
    return () => { alive.current = false; unsubscribe(); };
  }, [owner]);
  const erase = async () => {
    if (!current() || running.current) return;
    running.current = true; setBusy(true); setFeedback(null);
    const result = await eraseRecentSensingContributions();
    running.current = false;
    if (!current()) return;
    setBusy(false);
    setFeedback(result.ok
      ? { failed: false, text: result.nothingStored ? 'No recent contributions were stored from this device.' : 'Recent contributions from this device were removed. Previously published anonymous aggregates may remain until they expire. Future contributions follow your current settings.' }
      : { failed: true, text: 'Deletion could not be confirmed. Area sensing stays paused on this device. Retry when connected.' });
  };
  return <>
    <SettingsRow title={busy ? 'Deleting recent contributions…' : pending ? 'Retry deleting contributions' : 'Delete recent contributions'}
      subtitle="Remove the last 72 hours of contributions from this device."
      disabled={busy} chevron={false} testID="sensing-erase-recent"
      onPress={() => Alert.alert('Delete recent contributions?', 'This removes recent area-sensing contributions from this device. Previously published anonymous aggregates may remain until expiry. Your consent settings stay the same.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { void erase(); } },
      ])} />
    {pending && !busy ? <FieldHint>Area sensing is paused on this device until deletion is confirmed.</FieldHint> : null}
    {feedback ? <FieldHint tone={feedback.failed ? 'error' : undefined}>{feedback.text}</FieldHint> : null}
  </>;
}
