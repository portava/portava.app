import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { applyCompassReplan, compassReplanAction } from '../../services/layoverCompassReplan.ts';
import { color, space, type as t } from '../../theme/tokens.ts';

export function LayoverCompassReplanAction({ sessionId, action: value, onRechecked }: { sessionId: string; action: unknown; onRechecked: (message: string) => void }) {
  const action = compassReplanAction(value);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false), [finished, setFinished] = useState(false), [message, setMessage] = useState<string | null>(null);
  if (!action) return null;
  const expired = Date.parse(action.expiresAt) <= Date.now();
  const apply = async () => {
    if (busyRef.current || finished) return;
    if (Date.parse(action.expiresAt) <= Date.now()) { setMessage('This recheck offer expired. Ask Compass again.'); return; }
    busyRef.current = true; setBusy(true); setMessage(null);
    const result = await applyCompassReplan(sessionId, action.id);
    if (!mounted.current) return;
    busyRef.current = false; setBusy(false); setMessage(result.message);
    if (result.ok) {
      setFinished(true);
      if (result.state !== 'failed') onRechecked(result.message);
    }
  };
  return <View style={{ gap: space.sm }} testID="compass-replan-action">
    <Text style={{ ...t.small, color: color.mute }}>Refresh recommendations using your saved flight details and current verified conditions. Report changed flight details before rechecking.</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Recheck plan with saved details" testID="compass-replan-apply" disabled={busy || finished || expired} onPress={apply}>
      {busy ? <ActivityIndicator /> : <Text style={{ ...t.bodyStrong, color: color.deep }}>Recheck plan with saved details</Text>}
    </Pressable>
    {message || expired ? <Text accessibilityRole="alert" testID="compass-replan-result" style={{ ...t.small, color: color.mute }}>{message ?? 'This recheck offer expired. Ask Compass again.'}</Text> : null}
  </View>;
}
