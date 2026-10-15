/**
 * SharedAnchorPanel — "Remember this together" on the Memory screen
 * (census-highlights-memories H53, §5; B58 cluster MEM-ANCHOR-2). Mounted once,
 * line-neutrally, in app/memory/[id].tsx.
 *
 * What it shows on Memory M, all of it from the server's answers and nothing
 * inferred:
 *   - to M's OWNER: the people the server says can be invited (an APPROVED tag on
 *     M, nobody blocked, nobody already asked — the server decides, the app only
 *     lists), each with Invite;
 *   - an anchor I accepted that M is linked to (mine, or another member's M as the
 *     server lets me see it): who I remember it with, or "Not shared yet", and
 *     Leave;
 *   - an invitation to me from M's owner (when the server lets me see M):
 *     Accept / Decline;
 *   - to the owner, a link to the invitations list when there are invitations or
 *     anchors that belong to no Memory on screen.
 * A non-owner never sees an invite control and never causes the invitable read.
 *
 * FLAG OFF (the app's flag, or the server answering as if the routes were not
 * there) ⇒ null, and no request beyond the one that found the routes absent —
 * with the app's flag OFF, none at all. A failed read is never "nothing here":
 * the owner is told it could not be loaded; anyone else is shown nothing.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Users } from 'lucide-react-native';
import { color } from '../../../theme/tokens.ts';
import { SHARED_ANCHORS_PATH, type AcceptedAnchor, type Invitation } from './sharedAnchorsApi.ts';
import { HUB_LINK, LOAD_ERROR, NEUTRAL_REFUSAL, PANEL_TITLE, RETRY_LABEL } from './sharedAnchorCopy.ts';
import { useSharedAnchors } from './useSharedAnchors.ts';
import { AnchorCard, InvitationCard, InviteList, s } from './SharedAnchorViews.tsx';

export function SharedAnchorPanel({ memoryId, isOwner, viewerId }: { memoryId: string; isOwner: boolean; viewerId: string | null }) {
  const h = useSharedAnchors({ viewerId, memoryId, isOwner });
  if (!h.on || viewerId === null) return null;
  const st = h.state;
  if (st.kind === 'off' || st.kind === 'absent' || st.kind === 'loading') return null;

  if (st.kind === 'error') {
    if (!isOwner) return null;
    return (
      <View style={s.wrap} testID="shared-anchor-panel">
        <View style={s.headRow}><Users size={14} color={color.mute} /><Text style={s.head}>{PANEL_TITLE}</Text></View>
        <Text style={s.caption} testID="shared-anchor-load-error">{LOAD_ERROR}</Text>
        <Pressable testID="shared-anchor-retry" onPress={() => { void h.reload(); }} hitSlop={6} accessibilityRole="button" accessibilityLabel={RETRY_LABEL}>
          <Text style={s.link}>{RETRY_LABEL}</Text>
        </Pressable>
      </View>
    );
  }

  const invitations = st.anchors.filter((a): a is Invitation => a.yourStatus === 'invited' && a.memoryId === memoryId);
  const anchors = st.anchors.filter((a): a is AcceptedAnchor => a.yourStatus === 'accepted' && a.members.some((m) => m.memoryId === memoryId));
  const people = isOwner ? st.people : [];
  const elsewhere = isOwner
    ? st.anchors.filter((a) => (a.yourStatus === 'invited' ? a.memoryId !== memoryId : !a.members.some((m) => m.isYou && m.memoryId !== null))).length
    : 0;

  if (invitations.length === 0 && anchors.length === 0 && people.length === 0 && elsewhere === 0 && !h.refused) return null;

  return (
    <View style={s.wrap} testID="shared-anchor-panel">
      <View style={s.headRow}><Users size={14} color={color.mute} /><Text style={s.head}>{PANEL_TITLE}</Text></View>
      {h.refused ? <Text style={s.caption} testID="shared-anchor-refused" accessibilityLiveRegion="polite">{NEUTRAL_REFUSAL}</Text> : null}
      {invitations.map((a) => (
        <InvitationCard
          key={a.id}
          invitation={a}
          viewerId={viewerId}
          busy={h.busy}
          onAccept={(own) => { void h.accept(a.id, own); }}
          onDecline={() => { void h.decline(a.id); }}
        />
      ))}
      {anchors.map((a) => (
        <AnchorCard key={a.id} anchor={a} hereMemoryId={memoryId} busy={h.busy} onLeave={() => { void h.leave(a.id); }} />
      ))}
      {isOwner ? <InviteList people={people} busy={h.busy} onInvite={(userId) => { void h.invite(userId); }} /> : null}
      {elsewhere > 0 ? (
        <Pressable testID="shared-anchor-hub-link" onPress={() => router.push(SHARED_ANCHORS_PATH as never)} hitSlop={6} accessibilityRole="link" accessibilityLabel={HUB_LINK}>
          <Text style={s.link}>{`${HUB_LINK} (${elsewhere})`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
