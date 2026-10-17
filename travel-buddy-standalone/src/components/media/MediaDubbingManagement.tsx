import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../context/SessionContext.tsx';
import { color, radius, space } from '../../theme/tokens.ts';
import type { CaptionSource } from '../../services/media/captions.ts';
import { DubbingRequestError, getDubbingOptions, revokeDubbing, subscribeDubbingAuth } from '../../services/media/dubbing.ts';

export interface MediaDubbingManagementProps {
  source: Pick<CaptionSource, 'assetId' | 'version' | 'canEdit'>;
  userId: string;
  open: boolean;
  onClose: () => void;
  onWithdrawn?: () => void;
}

export function MediaDubbingManagement(props: MediaDubbingManagementProps) {
  const session = useSession();
  if (!props.open || !props.source.canEdit || !session.isAuthed || !props.userId || session.userId !== props.userId) return null;
  return <OpenManagement key={JSON.stringify([props.source.assetId, props.source.version, props.userId])} {...props} />;
}

type Pending = { controller: AbortController; timer: ReturnType<typeof setTimeout> };
type Phase = 'loading' | 'unavailable' | 'ready' | 'revoking' | 'retry_cleanup' | 'done';

function OpenManagement({ source, userId, onClose, onWithdrawn }: MediaDubbingManagementProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState('Checking owner permission…');
  const pending = useRef<Pending | null>(null);
  const mounted = useRef(false);
  const foreground = useRef(AppState.currentState === 'active');
  const authorized = useRef(false);

  function stop() {
    if (pending.current) { clearTimeout(pending.current.timer); pending.current.controller.abort(); pending.current = null; }
  }
  function current(request: Pending) {
    return mounted.current && foreground.current && pending.current === request && !request.controller.signal.aborted;
  }
  function invalidate() {
    stop(); authorized.current = false;
    setPhase('unavailable'); setMessage('Permission changed. Reload before withdrawing AI audio.');
  }
  function begin(action: 'loading' | 'revoking'): Pending | null {
    if (!mounted.current || !foreground.current || pending.current) return null;
    const controller = new AbortController();
    const request = { controller, timer: setTimeout(() => {
      if (!current(request)) return;
      stop(); authorized.current = false; setPhase('unavailable');
      setMessage(action === 'loading' ? 'Owner permission could not be confirmed. Reopen the current video and try again.' : 'Withdrawal not confirmed. Reload permission and try again.');
    }, 15_000) };
    pending.current = request; setPhase(action);
    return request;
  }
  function finish(request: Pending) {
    clearTimeout(request.timer);
    if (pending.current === request) pending.current = null;
  }

  async function load() {
    const request = begin('loading'); if (!request) return;
    authorized.current = false; setMessage('Checking owner permission…');
    try {
      const options = await getDubbingOptions({ assetId: source.assetId, userId }, request.controller.signal);
      if (!current(request)) return;
      if (!options.canEdit || options.assetId !== source.assetId || options.sourceVersion !== source.version) throw new Error('stale_owner');
      authorized.current = true; setPhase('ready'); setMessage('You can withdraw AI audio permission even when generation is off.');
    } catch {
      if (current(request)) { setPhase('unavailable'); setMessage('Owner permission could not be confirmed. Reopen the current video and try again.'); }
    } finally { finish(request); }
  }

  async function withdraw() {
    if (!authorized.current) return;
    const request = begin('revoking'); if (!request) return;
    setMessage('Withdrawing AI audio permission…');
    let withdrawn = false;
    try {
      await revokeDubbing({ assetId: source.assetId, userId }, request.controller.signal);
      if (!current(request)) return;
      authorized.current = false; setPhase('done'); setMessage('AI audio permission withdrawn.'); withdrawn = true;
    } catch (error) {
      if (!current(request)) return;
      if (error instanceof DubbingRequestError && error.code === 'cleanup_failed') {
        setPhase('retry_cleanup'); setMessage('Permission withdrawn. Audio cleanup needs another attempt.'); withdrawn = true;
      } else {
        authorized.current = false; setPhase('unavailable'); setMessage('Withdrawal not confirmed. Reload permission and try again.');
      }
    } finally { finish(request); }
    if (withdrawn) onWithdrawn?.();
  }

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeDubbingAuth(invalidate);
    const listener = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (!foreground.current) invalidate();
    });
    if (foreground.current) void load(); else invalidate();
    return () => { mounted.current = false; authorized.current = false; stop(); unsubscribe(); listener.remove(); };
  }, []);

  const removing = phase === 'revoking';
  return <View style={styles.container}>
    <Text accessibilityRole="header" style={styles.title}>Manage AI audio</Text>
    <Text style={styles.help}>Withdraw permission for all AI-generated audio on this video. Original audio and captions are unchanged. This does not enable generation or load a voice model.</Text>
    <Text accessibilityLiveRegion="polite" style={styles.help}>{message}</Text>
    {phase === 'ready' || removing || phase === 'retry_cleanup' ? <Pressable accessibilityRole="button" accessibilityLabel={phase === 'retry_cleanup' ? 'Retry audio cleanup' : 'Remove AI audio'} accessibilityState={{ disabled: removing, busy: removing }} disabled={removing} style={styles.button} onPress={() => { void withdraw(); }}><Text style={styles.text}>{phase === 'retry_cleanup' ? 'Retry audio cleanup' : 'Remove AI audio'}</Text></Pressable> : null}
    {phase === 'unavailable' ? <Pressable accessibilityRole="button" accessibilityLabel="Reload AI audio permissions" style={styles.button} onPress={() => { void load(); }}><Text style={styles.text}>Reload permissions</Text></Pressable> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Close AI audio management" style={styles.button} onPress={() => { invalidate(); onClose(); }}><Text style={styles.text}>Close</Text></Pressable>
  </View>;
}

const styles = StyleSheet.create({
  container: { backgroundColor: color.paper, borderRadius: radius.md, padding: space.md, gap: space.sm },
  title: { color: color.ink, fontSize: 15, fontWeight: '600' },
  help: { color: color.mute, fontSize: 13, lineHeight: 19 },
  text: { color: color.ink, fontSize: 14 },
  button: { minHeight: 44, justifyContent: 'center', padding: space.sm, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm },
});
