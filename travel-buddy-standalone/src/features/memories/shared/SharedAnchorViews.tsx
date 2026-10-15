/**
 * The pieces "Remember this together" is drawn with (census-highlights-memories
 * H53, MEM-ANCHOR-2), used by the Memory screen's panel and by the invitations
 * list alike.
 *
 *   NotSharedYet    the ONE rendering of an anchor that is not shared — whether
 *                   nobody has accepted yet or I am simply the only person I can
 *                   see in it. It takes no arguments, so it cannot differ.
 *   AnchorCard      an anchor I accepted: who I remember it with (accepted
 *                   members only, as the server lists them), each member's own
 *                   Memory as a LINK to /memory/:id and never its content, and
 *                   Leave — one tap, no confirmation.
 *   InvitationCard  an invitation: who asked, Accept (optionally linking one of
 *                   MY Memories, picked from my own list) and Decline — one tap,
 *                   no confirmation.
 *   InviteList      the people the SERVER says the owner can invite, exactly as
 *                   it listed them.
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { color, radius, space, type as t } from '../../../theme/tokens.ts';
import {
  isUuid,
  listOwnMemoriesForLink,
  type AcceptedAnchor,
  type Invitation,
  type OwnMemoryChoice,
  type SharedAnchorPerson,
} from './sharedAnchorsApi.ts';
import {
  ACCEPT_LABEL, DECLINE_LABEL, INVITE_INTRO, INVITE_LABEL, INVITATION_DETAIL, LEAVE_HINT, LEAVE_LABEL,
  LINK_LIST_UNAVAILABLE, LINK_NONE, LINK_PROMPT, NOT_NOW_LABEL, NOT_SHARED_YET, NOT_SHARED_YET_DETAIL,
  OPEN_THEIR_MEMORY, OPEN_YOUR_MEMORY, SHARED_WITH, invitationLine, personLabel,
} from './sharedAnchorCopy.ts';

/** /memory/:id for a Memory id the server gave — the normal Memory screen decides what, if anything, is shown. */
export function openMemory(memoryId: string): void {
  if (!isUuid(memoryId)) return;
  router.push(`/memory/${memoryId}` as never);
}

export function NotSharedYet() {
  return (
    <View testID="shared-anchor-not-shared" style={s.gap}>
      <Text style={s.bodyStrong}>{NOT_SHARED_YET}</Text>
      <Text style={s.caption}>{NOT_SHARED_YET_DETAIL}</Text>
    </View>
  );
}

function LeaveButton({ disabled, spinning, onLeave }: { disabled: boolean; spinning: boolean; onLeave: () => void }) {
  return (
    <View style={s.gap}>
      <Pressable testID="shared-anchor-leave" onPress={onLeave} disabled={disabled} style={[s.secondary, disabled && s.dim]} accessibilityRole="button" accessibilityLabel={LEAVE_LABEL}>
        {spinning ? <ActivityIndicator size="small" color={color.ink} /> : <Text style={s.secondaryText}>{LEAVE_LABEL}</Text>}
      </Pressable>
      <Text style={s.caption}>{LEAVE_HINT}</Text>
    </View>
  );
}

/**
 * `hereMemoryId`: the Memory on screen, so it is not linked to itself.
 * Shared only when the server says so AND someone other than me is listed.
 */
export function AnchorCard({ anchor, hereMemoryId, busy, onLeave }: { anchor: AcceptedAnchor; hereMemoryId: string | null; busy: string | null; onLeave: () => void }) {
  const others = anchor.members.filter((m) => !m.isYou);
  const me = anchor.members.find((m) => m.isYou) ?? null;
  const shared = anchor.shared === true && others.length > 0;
  return (
    <View testID="shared-anchor-card" style={s.card}>
      {shared ? (
        <View style={s.gap}>
          <Text style={s.bodyStrong}>{SHARED_WITH}</Text>
          {others.map((m) => (
            <View key={m.userId} style={s.row} testID={`shared-anchor-member-${m.userId}`}>
              <Text style={s.body} numberOfLines={1}>{personLabel(m)}</Text>
              {m.memoryId && m.memoryId !== hereMemoryId ? (
                <Pressable testID={`shared-anchor-open-${m.memoryId}`} onPress={() => openMemory(m.memoryId as string)} hitSlop={6} accessibilityRole="link" accessibilityLabel={`${OPEN_THEIR_MEMORY}, ${personLabel(m)}`}>
                  <Text style={s.link}>{OPEN_THEIR_MEMORY}</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : (
        <NotSharedYet />
      )}
      {me?.memoryId && me.memoryId !== hereMemoryId ? (
        <Pressable testID={`shared-anchor-open-${me.memoryId}`} onPress={() => openMemory(me.memoryId as string)} hitSlop={6} accessibilityRole="link" accessibilityLabel={OPEN_YOUR_MEMORY}>
          <Text style={s.link}>{OPEN_YOUR_MEMORY}</Text>
        </Pressable>
      ) : null}
      <LeaveButton disabled={busy !== null} spinning={busy === `leave:${anchor.id}`} onLeave={onLeave} />
    </View>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Accept opens a choice of MY OWN Memories (the server's list of my own profile,
 * filtered to rows naming me as owner) plus "do not link". The only id Accept
 * can ever send is one from that list; nothing on screen — the host's Memory
 * included — can be sent instead.
 */
export function InvitationCard({ invitation, viewerId, busy, onAccept, onDecline }: {
  invitation: Invitation;
  viewerId: string;
  busy: string | null;
  onAccept: (ownMemoryId: string | null) => void;
  onDecline: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [own, setOwn] = useState<readonly OwnMemoryChoice[] | null>(null);
  const [ownUnavailable, setOwnUnavailable] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const anyBusy = busy !== null;

  const startAccept = useCallback(async () => {
    setPicking(true);
    setOwn(null);
    setOwnUnavailable(false);
    setChosen(null);
    const r = await listOwnMemoriesForLink(viewerId);
    if (r.ok) setOwn(r.memories); else { setOwn([]); setOwnUnavailable(true); }
  }, [viewerId]);

  const confirm = useCallback(() => {
    const pick = chosen !== null && (own ?? []).some((m) => m.id === chosen) ? chosen : null;
    onAccept(pick);
  }, [chosen, own, onAccept]);

  const decline = (
    <Pressable testID="shared-anchor-decline" onPress={onDecline} disabled={anyBusy} style={[s.secondary, anyBusy && s.dim]} accessibilityRole="button" accessibilityLabel={DECLINE_LABEL}>
      {busy === `decline:${invitation.id}` ? <ActivityIndicator size="small" color={color.ink} /> : <Text style={s.secondaryText}>{DECLINE_LABEL}</Text>}
    </Pressable>
  );

  return (
    <View testID="shared-anchor-invitation" style={s.card}>
      <Text style={s.bodyStrong}>{invitationLine(invitation.invitedBy)}</Text>
      <Text style={s.caption}>{INVITATION_DETAIL}</Text>
      {!picking ? (
        <View style={s.buttons}>
          <Pressable testID="shared-anchor-accept" onPress={() => { void startAccept(); }} disabled={anyBusy} style={[s.primary, anyBusy && s.dim]} accessibilityRole="button" accessibilityLabel={ACCEPT_LABEL}>
            <Text style={s.primaryText}>{ACCEPT_LABEL}</Text>
          </Pressable>
          {decline}
        </View>
      ) : (
        <View testID="shared-anchor-link-picker" style={s.gap}>
          <Text style={s.caption}>{LINK_PROMPT}</Text>
          <Choice testID="shared-anchor-link-none" selected={chosen === null} label={LINK_NONE} onPress={() => setChosen(null)} />
          {own === null ? <ActivityIndicator size="small" color={color.mute} /> : own.map((m) => (
            <Choice key={m.id} testID={`shared-anchor-link-${m.id}`} selected={chosen === m.id} label={[m.title ?? 'Untitled Memory', formatDate(m.createdAt)].filter(Boolean).join(' · ')} onPress={() => setChosen(m.id)} />
          ))}
          {ownUnavailable ? <Text style={s.caption}>{LINK_LIST_UNAVAILABLE}</Text> : null}
          <View style={s.buttons}>
            <Pressable testID="shared-anchor-accept-confirm" onPress={confirm} disabled={anyBusy || own === null} style={[s.primary, (anyBusy || own === null) && s.dim]} accessibilityRole="button" accessibilityLabel={ACCEPT_LABEL}>
              {busy === `accept:${invitation.id}` ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={s.primaryText}>{ACCEPT_LABEL}</Text>}
            </Pressable>
            {decline}
            <Pressable testID="shared-anchor-accept-cancel" onPress={() => setPicking(false)} disabled={anyBusy} hitSlop={6} accessibilityRole="button" accessibilityLabel={NOT_NOW_LABEL}>
              <Text style={s.link}>{NOT_NOW_LABEL}</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function Choice({ testID, selected, label, onPress }: { testID: string; selected: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable testID={testID} onPress={onPress} style={[s.choice, selected && s.choiceOn]} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={label}>
      <Text style={s.body} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

export function InviteList({ people, busy, onInvite }: { people: readonly SharedAnchorPerson[]; busy: string | null; onInvite: (userId: string) => void }) {
  if (people.length === 0) return null;
  return (
    <View testID="shared-anchor-invite-list" style={s.gap}>
      <Text style={s.caption}>{INVITE_INTRO}</Text>
      {people.map((p) => (
        <View key={p.userId} style={s.row} testID={`shared-anchor-invitable-${p.userId}`}>
          <Text style={s.body} numberOfLines={1}>{personLabel(p)}</Text>
          <Pressable testID={`shared-anchor-invite-${p.userId}`} onPress={() => onInvite(p.userId)} disabled={busy !== null} style={[s.secondary, busy !== null && s.dim]} accessibilityRole="button" accessibilityLabel={`${INVITE_LABEL} ${personLabel(p)}`}>
            {busy === `invite:${p.userId}` ? <ActivityIndicator size="small" color={color.ink} /> : <Text style={s.secondaryText}>{INVITE_LABEL}</Text>}
          </Pressable>
        </View>
      ))}
    </View>
  );
}

export const s = StyleSheet.create({
  wrap: { marginTop: space.md, gap: space.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  head: { ...(t.small as object), color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  card: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: space.sm },
  gap: { gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, paddingVertical: space.xs },
  body: { ...(t.body as object), color: color.ink, flexShrink: 1 },
  bodyStrong: { ...(t.bodyStrong as object), color: color.ink },
  caption: { ...(t.small as object), color: color.mute },
  link: { ...(t.small as object), color: color.deep, fontWeight: '700' },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.xs, flexWrap: 'wrap' },
  primary: { backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.sm, paddingHorizontal: space.lg, alignItems: 'center' },
  primaryText: { ...(t.bodyStrong as object), color: color.onInk },
  secondary: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.sm, paddingHorizontal: space.lg, alignItems: 'center' },
  secondaryText: { ...(t.bodyStrong as object), color: color.ink },
  choice: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.sm, paddingHorizontal: space.md },
  choiceOn: { borderColor: color.deep },
  dim: { opacity: 0.5 },
});
