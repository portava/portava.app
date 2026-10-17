/**
 * SharedExperienceInvitations — the invitee's half of "Remember this together"
 * (§5 participant consent; census-highlights-memories H53), at the top of the
 * person's own timeline.
 *
 * Each invitation names who asked. It names the Memory only when the person may
 * already read it. Accepting is the consent that creates the shared experience;
 * the person may link ONE of their own Memories to it, or none. Declining is
 * final for that Memory. Nothing here edits anyone else's Memory.
 *
 * HONEST STATES. Not deployed / switched off → nothing is shown, EXCEPT the
 * ways out (H53, "never trap a person"): when remembering together is switched
 * off, the person's own pending invitations, the experiences they joined and
 * their own Memories that host one are still listed, by the flag-off exits
 * read, each with its one exit — Decline, Leave, End. No invitations and
 * nothing to leave → nothing is shown. A read that FAILED → "Could not check"
 * with Try again.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { useSession } from '../../context/SessionContext.tsx';
import { getUserMemories, type Memory } from '../../services/memories.ts';
import {
  acceptSharedInvitation, declineSharedInvitation, endSharedExperience, leaveSharedExperience, listMySharedExits, listSharedInvitations,
  personLabel, type SharedExits, type SharedInvitation,
} from '../../services/memorySharedExperiences.ts';

type State = { s: 'loading' } | { s: 'hidden' } | { s: 'error'; message: string } | { s: 'ok'; invitations: SharedInvitation[] }
  | { s: 'exits'; exits: SharedExits };
type Picker = { s: 'closed' } | { s: 'loading'; invitationId: string } | { s: 'error'; invitationId: string } | { s: 'open'; invitationId: string; memories: Memory[] };

/** The signed-in person's pending invitations; nothing when signed out. */
export function SharedExperienceInvitations() {
  const { userId } = useSession();
  return userId ? <InvitationsList viewerId={userId} /> : null;
}

function InvitationsList({ viewerId }: { viewerId: string }) {
  const [state, setState] = useState<State>({ s: 'loading' });
  const [picker, setPicker] = useState<Picker>({ s: 'closed' });
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    setState({ s: 'loading' });
    const r = await listSharedInvitations();
    if (!r.ok && r.kind === 'feature_disabled') {
      // Switched off: the ways in are gone, the ways out are not (H53).
      const x = await listMySharedExits();
      if (!x.ok) { setState(x.kind === 'feature_disabled' ? { s: 'hidden' } : { s: 'error', message: x.message }); return; }
      const e = x.exits;
      setState(e.invitations.length + e.memberships.length + e.hosting.length === 0 ? { s: 'hidden' } : { s: 'exits', exits: e });
      return;
    }
    if (!r.ok) { setState({ s: 'error', message: r.message }); return; }
    setState(r.invitations.length === 0 ? { s: 'hidden' } : { s: 'ok', invitations: r.invitations });
  }, []);

  useEffect(() => { void load(); }, [load]);

  const answer = useCallback(async (invitationId: string, accept: boolean, memoryId: string | null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setNotice(null);
    try {
      const r = accept ? await acceptSharedInvitation(invitationId, memoryId) : await declineSharedInvitation(invitationId);
      setNotice(r.ok ? (accept ? 'You are remembering this together. Your own Memory stays yours.' : 'Declined. You will not be asked again for this Memory.') : r.message);
      setPicker({ s: 'closed' });
      await load();
    } finally {
      inFlight.current = false;
    }
  }, [load]);

  const openPicker = useCallback(async (invitationId: string) => {
    setPicker({ s: 'loading', invitationId });
    const mine = await getUserMemories(viewerId);
    if (!mine.ok) { setPicker({ s: 'error', invitationId }); return; }
    setPicker({ s: 'open', invitationId, memories: mine.memories.filter((m) => m.ownerId === viewerId).slice(0, 20) });
  }, [viewerId]);

  if (state.s === 'hidden') return null;
  if (state.s === 'exits') return <SharedExitsList exits={state.exits} reload={load} />;
  if (state.s === 'loading') return <View style={s.box} testID="shared-invitations-loading"><ActivityIndicator color={color.deep} /></View>;
  if (state.s === 'error') {
    return (
      <View style={s.box} testID="shared-invitations-error">
        <Text style={s.body}>{state.message}</Text>
        <Pressable testID="shared-invitations-retry" style={s.button} accessibilityRole="button" onPress={() => void load()}>
          <Text style={s.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.box} testID="shared-invitations">
      <Text style={s.title}>Remember together</Text>
      {state.invitations.map((inv) => (
        <View key={inv.invitationId} style={s.item} testID={`shared-invitation-${inv.invitationId}`}>
          <Text style={s.body}>{inv.memoryTitle
            ? `${personLabel(inv.host)} invited you to remember “${inv.memoryTitle}” together.`
            : `${personLabel(inv.host)} invited you to remember a Memory together.`}</Text>
          <View style={s.actions}>
            <Pressable testID={`shared-invitation-accept-${inv.invitationId}`} style={s.button} accessibilityRole="button"
              onPress={() => void answer(inv.invitationId, true, null)}>
              <Text style={s.buttonText}>Accept</Text>
            </Pressable>
            <Pressable testID={`shared-invitation-link-${inv.invitationId}`} style={s.secondary} accessibilityRole="button"
              onPress={() => void openPicker(inv.invitationId)}>
              <Text style={s.link}>Accept and link my Memory</Text>
            </Pressable>
            <Pressable testID={`shared-invitation-decline-${inv.invitationId}`} style={s.secondary} accessibilityRole="button"
              onPress={() => void answer(inv.invitationId, false, null)}>
              <Text style={s.link}>Decline</Text>
            </Pressable>
          </View>
          {picker.s !== 'closed' && picker.invitationId === inv.invitationId ? (
            picker.s === 'loading' ? <ActivityIndicator color={color.deep} />
              : picker.s === 'error' ? <Text style={s.body} testID="shared-invitation-picker-error">Your Memories could not be loaded. Try again, or accept without linking one.</Text>
                : picker.memories.length === 0 ? <Text style={s.body}>You have no Memory to link yet. You can accept without one.</Text>
                  : (
                    <View testID={`shared-invitation-picker-${inv.invitationId}`}>
                      {picker.memories.map((m) => (
                        <Pressable key={m.id} testID={`shared-invitation-pick-${m.id}`} style={s.secondary} accessibilityRole="button"
                          onPress={() => void answer(inv.invitationId, true, m.id)}>
                          <Text style={s.link}>{m.title?.trim() || 'Untitled memory'}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )
          ) : null}
        </View>
      ))}
      {notice ? <Text style={s.notice} accessibilityLiveRegion="polite" testID="shared-invitations-notice">{notice}</Text> : null}
    </View>
  );
}

/**
 * The ways out while remembering together is switched off. Ids only — the
 * server sends nothing about anyone else, so nothing about anyone else is shown.
 * Leave and End confirm first, as on the Memory screen; Decline is final for
 * that Memory, as it always is.
 */
function SharedExitsList({ exits, reload }: { exits: SharedExits; reload: () => Promise<void> }) {
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const run = useCallback(async (work: () => Promise<{ ok: boolean; message?: string }>, done: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setNotice(null);
    try {
      const r = await work();
      setNotice(r.ok ? done : (r.message ?? 'That did not work. Please try again.'));
      if (r.ok) await reload();
    } finally {
      inFlight.current = false;
    }
  }, [reload]);
  const confirmThen = (title: string, message: string, action: string, work: () => void) =>
    Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: action, style: 'destructive', onPress: work }]);

  return (
    <View style={s.box} testID="shared-exits">
      <Text style={s.title}>Remember together</Text>
      <Text style={s.body}>Remembering together is switched off right now. You can still step out of anything you are part of.</Text>
      {exits.invitations.map((i) => (
        <View key={i.invitationId} style={s.item}>
          <Text style={s.body}>An invitation to remember a Memory together is waiting for your answer.</Text>
          <Pressable testID={`shared-exit-decline-${i.invitationId}`} style={s.secondary} accessibilityRole="button"
            onPress={() => void run(() => declineSharedInvitation(i.invitationId), 'Declined. You will not be asked again for this Memory.')}>
            <Text style={s.link}>Decline</Text>
          </Pressable>
        </View>
      ))}
      {exits.memberships.map((m) => (
        <View key={m.experienceId} style={s.item}>
          <Text style={s.body}>You are remembering a Memory together with others.</Text>
          <Pressable testID={`shared-exit-leave-${m.experienceId}`} style={s.secondary} accessibilityRole="button"
            onPress={() => confirmThen('Leave this shared memory?', 'Your own Memory stays yours. You will no longer be part of it.', 'Leave',
              () => void run(() => leaveSharedExperience(m.experienceId), 'You left. Your own Memory stays yours.'))}>
            <Text style={s.link}>Leave</Text>
          </Pressable>
        </View>
      ))}
      {exits.hosting.map((h) => (
        <View key={h.hostMemoryId} style={s.item}>
          <Text style={s.body}>One of your Memories is being remembered together, or has an invitation waiting.</Text>
          <Pressable testID={`shared-exit-end-${h.hostMemoryId}`} style={s.secondary} accessibilityRole="button"
            onPress={() => confirmThen('End this for everyone?', 'Everyone keeps their own Memory. The shared link and any waiting invitations are removed.', 'End',
              () => void run(() => endSharedExperience(h.hostMemoryId), 'Ended. Everyone keeps their own Memory.'))}>
            <Text style={s.link}>End for everyone</Text>
          </Pressable>
        </View>
      ))}
      {notice ? <Text style={s.notice} accessibilityLiveRegion="polite" testID="shared-exits-notice">{notice}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  box: { margin: space.lg, padding: space.lg, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, gap: space.sm },
  title: { ...(t.bodyStrong as object), color: color.ink },
  item: { gap: space.xs },
  body: { ...(t.small as object), color: color.ink },
  notice: { ...(t.small as object), color: color.mute },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  button: { minHeight: 44, paddingHorizontal: space.lg, justifyContent: 'center', backgroundColor: color.deep, borderRadius: radius.sm },
  buttonText: { ...(t.bodyStrong as object), color: color.onInk },
  secondary: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  link: { ...(t.small as object), color: color.deep, fontWeight: '600' },
});
