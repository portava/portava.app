import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSession } from '../../context/SessionContext.tsx';
import { supabase } from '../../lib/supabase.ts';
import { memoryOwnerSessionId } from '../../services/memoryOwnerRequest.ts';
import {
  readMemoryDoNotResurface, writeMemoryDoNotResurface,
  type MemoryResurfacingRequest, type MemoryResurfacingResult,
} from '../../services/memoryResurfacingControls.ts';
import { color, radius, space, type as typography } from '../../theme/tokens.ts';

interface Props { ownerId: string; memoryId: string }

export function MemoryResurfacingControl({ ownerId, memoryId }: Props) {
  const { userId } = useSession();
  const target = useRef({ ownerId, memoryId, userId });
  target.current = { ownerId, memoryId, userId };
  const isTargetCurrent = useCallback(() => target.current.ownerId === ownerId
    && target.current.memoryId === memoryId && target.current.userId === ownerId, [ownerId, memoryId]);
  if (!userId || userId !== ownerId) return null;
  return <OwnerControl key={`${ownerId}:${memoryId}`} ownerId={ownerId} memoryId={memoryId} isTargetCurrent={isTargetCurrent} />;
}

function OwnerControl({ ownerId, memoryId, isTargetCurrent }: Props & { isTargetCurrent: () => boolean }) {
  const scopeRef = useRef<MemoryResurfacingRequest | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(true);
  const [result, setResult] = useState<MemoryResurfacingResult | null>(null);
  const [attempt, setAttempt] = useState(0);

  const run = useCallback(async (scope: MemoryResurfacingRequest, on?: boolean) => {
    if (busyRef.current || scopeRef.current !== scope || !scope.isCurrent()) return;
    busyRef.current = true; setBusy(true); setResult(null);
    const next = on === undefined ? await readMemoryDoNotResurface(scope) : await writeMemoryDoNotResurface(scope, on);
    if (scopeRef.current !== scope || !scope.isCurrent()) return;
    busyRef.current = false; setBusy(false); setResult(next);
  }, []);

  useFocusEffect(useCallback(() => {
    const controller = new AbortController();
    let active = true;
    let capturedSession: string | null = null;
    scopeRef.current = null; busyRef.current = false; setBusy(true); setResult(null);
    const current = () => active && !controller.signal.aborted && isTargetCurrent();
    const invalidateSession = () => {
      if (!current()) return;
      controller.abort(); scopeRef.current = null; busyRef.current = false;
      setBusy(false); setResult({ ok: false, kind: 'unauthenticated', pending: null });
    };
    const timer = setTimeout(() => {
      if (!current() || capturedSession !== null) return;
      controller.abort(); setBusy(false); setResult({ ok: false, kind: 'unavailable', pending: null });
    }, 15000);
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!current()) return;
      const sessionId = memoryOwnerSessionId(session?.access_token);
      if (event === 'SIGNED_OUT' || session?.user.id !== ownerId || !sessionId
        || (capturedSession !== null && capturedSession !== sessionId)
        || (capturedSession === null && event !== 'INITIAL_SESSION')) {
        clearTimeout(timer); invalidateSession(); return;
      }
      if (capturedSession !== null) return;
      capturedSession = sessionId;
      clearTimeout(timer);
      const scope: MemoryResurfacingRequest = { ownerId, memoryId, sessionId, signal: controller.signal,
        isCurrent: current, acceptsSession: next => next === sessionId, invalidateSession };
      scopeRef.current = scope;
      void Promise.resolve().then(() => run(scope));
    });
    return () => {
      active = false; controller.abort(); clearTimeout(timer); subscription.unsubscribe();
      scopeRef.current = null; busyRef.current = false; setBusy(false); setResult(null);
    };
  }, [ownerId, memoryId, isTargetCurrent, run, attempt]));

  const pending = result?.pending ?? null;
  const known = result?.ok === true ? result : null;
  const terminal = result && !result.ok && ['feature_disabled', 'not_found', 'unauthenticated', 'cancelled', 'conflict'].includes(result.kind);
  const retry = () => {
    if (busyRef.current || terminal) return;
    const scope = scopeRef.current;
    if (!scope) { setAttempt(value => value + 1); return; }
    void run(scope, pending?.on);
  };
  let message = 'Return to this Memory to check this setting.';
  if (busy) message = 'Checking resurfacing setting…';
  else if (result && !result.ok) {
    message = result.kind === 'feature_disabled' ? 'This setting is not available yet.'
      : result.kind === 'not_found' ? 'This Memory is no longer available.'
      : result.kind === 'unauthenticated' ? 'Your session changed. Reopen this Memory.'
      : result.kind === 'conflict' ? 'This change conflicts with an earlier operation. Its current setting is unconfirmed.'
      : 'The current setting could not be confirmed.';
  }
  return (
    <View style={styles.container} testID="memory-resurfacing-control">
      <Text style={styles.title}>Do not resurface</Text>
      <Text style={styles.explanation}>Keep this Memory in your library; stop proactive resurfacing. Sharing and recap settings are unchanged.</Text>
      {known && !busy ? <Text style={styles.status}>{`Last checked: ${known.on ? 'On' : 'Off'}.`}</Text> : <Text style={styles.status} accessibilityLiveRegion="polite">{message}</Text>}
      {known?.intentMatched === false ? <Text style={styles.status}>The current setting differs from that change. Review it before changing it again.</Text> : null}
      {pending && !busy ? <Text style={styles.status}>{pending.acknowledged
        ? 'The change was acknowledged; its current setting is unconfirmed.'
        : 'The previous change is unconfirmed. Retry it before changing this setting again.'}</Text> : null}
      {known && !pending && !busy ? (
        <Pressable style={styles.button} accessibilityRole="switch" accessibilityLabel="Do not resurface"
          accessibilityState={{ checked: known.on, disabled: busy }}
          onPress={() => { const scope = scopeRef.current; if (scope) void run(scope, !known.on); }}>
          <Text style={styles.buttonText}>{known.on ? 'Turn off' : 'Turn on'}</Text>
        </Pressable>
      ) : null}
      {!busy && result && !terminal && (pending || !result.ok) ? (
        <Pressable style={styles.button} accessibilityRole="button" onPress={retry}>
          <Text style={styles.buttonText}>{pending ? pending.acknowledged ? 'Check setting' : 'Retry change' : 'Retry'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: space.lg, padding: space.lg, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, gap: space.sm },
  title: { ...typography.bodyStrong, color: color.ink },
  explanation: { ...typography.small, color: color.mute },
  status: { ...typography.small, color: color.ink },
  button: { minHeight: 44, paddingHorizontal: space.lg, justifyContent: 'center', alignSelf: 'flex-start', backgroundColor: color.deep, borderRadius: radius.sm },
  buttonText: { ...typography.bodyStrong, color: color.onInk },
});
