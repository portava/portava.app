/**
 * RememberTogetherPanel — "Remember this together" on a Memory's detail screen
 * (§5 shared-experience anchor + participant consent; census-highlights-memories
 * H53; server routes/memorySharedExperiences.ts, migration 3997).
 *
 * The HOST (the Memory's owner) may invite people tagged in it. Nothing is
 * shared until one of them accepts, and each person keeps their own Memory —
 * this panel never edits anyone else's. A PARTICIPANT sees who they remember it
 * with and can leave in one tap. A member blocked in either direction is never
 * shown (the server leaves them out).
 *
 * HONEST STATES. Not deployed / switched off (feature_disabled) or not part of
 * any shared experience → nothing is shown. A read that FAILED → "Could not
 * load" with Try again — never an empty panel that reads as "nobody".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import {
  endSharedExperience, getSharedExperience, inviteToRememberTogether, leaveSharedExperience, personLabel, withdrawInvitation,
  type SharedExperienceView,
} from '../../services/memorySharedExperiences.ts';

type State = { s: 'loading' } | { s: 'hidden' } | { s: 'error'; message: string } | { s: 'ok'; view: SharedExperienceView };

export function RememberTogetherPanel({ memoryId, viewerId }: { memoryId: string; viewerId: string }) {
  const [state, setState] = useState<State>({ s: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  // A ref, not state: two taps in one frame would both see an idle state.
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    setState({ s: 'loading' });
    const r = await getSharedExperience(memoryId);
    if (!r.ok) {
      setState(r.kind === 'feature_disabled' ? { s: 'hidden' } : { s: 'error', message: r.message });
      return;
    }
    const v = r.sharedExperience;
    const nothingToShow = !v || (v.viewerRole === 'host' && v.experienceId === null && v.pending.length === 0 && v.invitable.length === 0);
    setState(nothingToShow ? { s: 'hidden' } : { s: 'ok', view: v });
  }, [memoryId]);

  useEffect(() => { void load(); }, [load]);

  const run = useCallback(async (work: () => Promise<{ ok: boolean; message?: string }>, done: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setNotice(null);
    try {
      const r = await work();
      setNotice(r.ok ? done : (r.message ?? 'That did not work. Please try again.'));
      await load();
    } finally {
      inFlight.current = false;
    }
  }, [load]);

  if (state.s === 'hidden') return null;
  if (state.s === 'loading') {
    return <View style={s.box} testID="remember-together-loading"><ActivityIndicator color={color.deep} /></View>;
  }
  if (state.s === 'error') {
    return (
      <View style={s.box} testID="remember-together-error">
        <Text style={s.body}>{state.message}</Text>
        <Pressable testID="remember-together-retry" style={s.button} accessibilityRole="button" onPress={() => void load()}>
          <Text style={s.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const v = state.view;
  const others = v.members.filter((m) => m.userId !== viewerId);
  const confirmThen = (title: string, message: string, action: string, work: () => void) =>
    Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: action, style: 'destructive', onPress: work }]);

  return (
    <View style={s.box} testID="remember-together">
      <Text style={s.title}>Remember this together</Text>
      {v.viewerRole === 'host' ? (
        <Text style={s.body}>Invite people tagged here. Each of you keeps your own Memory, and nothing is shared until someone accepts.</Text>
      ) : null}
      {others.length > 0 ? (
        <Text style={s.body} testID="remember-together-members">{`Remembered together with ${others.map(personLabel).join(', ')}`}</Text>
      ) : null}
      {v.pending.map((p) => (
        <View key={`pending-${p.userId}`} style={s.row} testID={`remember-together-pending-${p.userId}`}>
          <Text style={s.body}>{`${personLabel(p)} — invited`}</Text>
          <Pressable testID={`remember-together-withdraw-${p.userId}`} style={s.linkButton} accessibilityRole="button"
            onPress={() => void run(() => withdrawInvitation(memoryId, p.userId), `Invitation to ${personLabel(p)} withdrawn.`)}>
            <Text style={s.link}>Withdraw</Text>
          </Pressable>
        </View>
      ))}
      {v.invitable.map((p) => (
        <View key={`invitable-${p.userId}`} style={s.row} testID={`remember-together-invitable-${p.userId}`}>
          <Text style={s.body}>{personLabel(p)}</Text>
          <Pressable testID={`remember-together-invite-${p.userId}`} style={s.linkButton} accessibilityRole="button"
            onPress={() => void run(() => inviteToRememberTogether(memoryId, p.userId), `${personLabel(p)} was invited. Nothing is shared unless they accept.`)}>
            <Text style={s.link}>Invite</Text>
          </Pressable>
        </View>
      ))}
      {v.viewerRole === 'host' && (v.experienceId !== null || v.pending.length > 0) ? (
        <Pressable testID="remember-together-end" style={s.button} accessibilityRole="button"
          onPress={() => confirmThen('End for everyone?', 'Everyone keeps their own Memory. The shared link and every invitation are removed.', 'End',
            () => void run(() => endSharedExperience(memoryId), 'Ended. Everyone keeps their own Memory.'))}>
          <Text style={s.buttonText}>End for everyone</Text>
        </Pressable>
      ) : null}
      {v.viewerRole === 'participant' && v.experienceId ? (
        <Pressable testID="remember-together-leave" style={s.button} accessibilityRole="button"
          onPress={() => confirmThen('Leave?', 'You keep your own Memory. You will no longer be shown as remembering this together.', 'Leave',
            () => void run(() => leaveSharedExperience(v.experienceId as string), 'You left. Your own Memory is unchanged.'))}>
          <Text style={s.buttonText}>Leave</Text>
        </Pressable>
      ) : null}
      {notice ? <Text style={s.notice} accessibilityLiveRegion="polite" testID="remember-together-notice">{notice}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  box: { marginTop: space.lg, padding: space.lg, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, gap: space.sm },
  title: { ...(t.bodyStrong as object), color: color.ink },
  body: { ...(t.small as object), color: color.ink, flexShrink: 1 },
  notice: { ...(t.small as object), color: color.mute },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  linkButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  link: { ...(t.small as object), color: color.deep, fontWeight: '600' },
  button: { minHeight: 44, paddingHorizontal: space.lg, justifyContent: 'center', alignSelf: 'flex-start', backgroundColor: color.deep, borderRadius: radius.sm },
  buttonText: { ...(t.bodyStrong as object), color: color.onInk },
});
