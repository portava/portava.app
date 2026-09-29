/**
 * MemoryParticipantsSection — who is tagged, and the tag decisions (HM-F12).
 *
 * §17 over `PATCH /memories/:id/tags/:userId`, and the kernel decides who may:
 *   - the TAGGED person approves their own tag (ADD_PERSON as consent — §5:
 *     "only after participant consent"); nobody can approve for them;
 *   - the tagged person or the Memory's OWNER removes a tag (REMOVE_PERSON);
 *   - being tagged makes nobody a co-owner (§10), so a participant sees no
 *     owner controls.
 *
 * The list is exactly what the server disclosed to THIS viewer (§10 rungs):
 * a participant this viewer may not identify is counted, not named. A removed
 * tag is not a participant and is not shown.
 *
 * The owner can open their shared history with an APPROVED participant
 * (PeopleMemoryProjection). A pending tag is not a shared experience yet.
 *
 * MemoryTagConsentFallback is for the tagged person who may not READ the
 * Memory (§23: "participant membership alone does not grant full Memory
 * access"): `GET /memories/:id/tags` still answers a tagged person, so they can
 * decide about their own tag without being shown the Memory itself.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Users } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../../theme/tokens.ts';
import { getMemoryTags, respondToMemoryTag, type MemoryParticipant } from '../../../services/memorySocial.ts';

function displayName(p: MemoryParticipant): string {
  return p.name || (p.handle ? `@${p.handle}` : 'Someone');
}

function statusLabel(status: string | null): string {
  if (status === 'approved') return 'Approved';
  if (status === 'pending') return 'Waiting for them';
  return status ?? '';
}

function useTagDecision(memoryId: string, onDone: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const decide = useCallback(async (userId: string, action: 'approve' | 'remove') => {
    if (busy) return;
    setBusy(`${userId}:${action}`);
    const res = await respondToMemoryTag(memoryId, userId, action);
    setBusy(null);
    if (!res.ok) { Alert.alert(action === 'approve' ? 'Could not approve the tag' : 'Could not remove the tag', res.message); return; }
    onDone();
  }, [busy, memoryId, onDone]);
  return { busy, decide };
}

function ConsentControls({ memoryId, me, onDone }: { memoryId: string; me: MemoryParticipant; onDone: () => void }) {
  const { busy, decide } = useTagDecision(memoryId, onDone);
  const confirmRemove = () => Alert.alert('Remove your tag?', 'You will no longer be shown as being in this memory.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => { void decide(me.userId, 'remove'); } },
  ]);
  return (
    <View style={s.consent} testID="memory-tag-consent">
      <Text style={s.bodyStrong}>{me.status === 'pending' ? 'You were tagged in this memory' : 'You are tagged in this memory'}</Text>
      <Text style={s.caption}>{me.status === 'pending' ? 'Approve to be shown in it, or remove the tag. Only you can approve it.' : 'You can remove your tag at any time.'}</Text>
      <View style={s.buttons}>
        {me.status === 'pending' ? (
          <Pressable testID="memory-tag-approve" onPress={() => decide(me.userId, 'approve')} disabled={busy !== null} style={[s.primary, busy !== null && s.dim]} accessibilityRole="button">
            {busy === `${me.userId}:approve` ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={s.primaryText}>Approve</Text>}
          </Pressable>
        ) : null}
        <Pressable testID="memory-tag-remove-self" onPress={confirmRemove} disabled={busy !== null} style={[s.secondary, busy !== null && s.dim]} accessibilityRole="button">
          {busy === `${me.userId}:remove` ? <ActivityIndicator size="small" color={color.ink} /> : <Text style={s.secondaryText}>Remove my tag</Text>}
        </Pressable>
      </View>
    </View>
  );
}

export function MemoryParticipantsSection({
  memoryId, participants, anonymousCount, viewerId, isOwner, onChanged,
}: {
  memoryId: string;
  participants: MemoryParticipant[];
  anonymousCount: number;
  viewerId: string | null;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const { busy, decide } = useTagDecision(memoryId, onChanged);
  const shown = participants.filter((p) => p.status !== 'removed');
  const me = viewerId ? shown.find((p) => p.userId === viewerId) ?? null : null;
  if (shown.length === 0 && anonymousCount === 0) return null;

  const confirmOwnerRemove = (p: MemoryParticipant) => Alert.alert(`Remove ${displayName(p)}?`, 'They will no longer be tagged in this memory.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => { void decide(p.userId, 'remove'); } },
  ]);

  return (
    <View style={s.wrap} testID="memory-participants">
      <View style={s.headRow}>
        <Users size={14} color={color.mute} />
        <Text style={s.head}>People in this memory</Text>
      </View>
      {me ? <ConsentControls memoryId={memoryId} me={me} onDone={onChanged} /> : null}
      {shown.filter((p) => p.userId !== viewerId).map((p) => (
        <View key={p.userId} style={s.row} testID={`memory-participant-${p.userId}`}>
          <Pressable
            style={s.nameCol}
            disabled={!(isOwner && p.status === 'approved')}
            onPress={() => router.push({ pathname: '/memory/people-history' as never, params: { personId: p.userId, name: displayName(p) } } as never)}
            accessibilityRole={isOwner && p.status === 'approved' ? 'button' : undefined}
            accessibilityLabel={isOwner && p.status === 'approved' ? `Your memories with ${displayName(p)}` : undefined}
          >
            <Text style={[s.bodyStrong, isOwner && p.status === 'approved' && s.link]} numberOfLines={1}>{displayName(p)}</Text>
            <Text style={s.caption}>{statusLabel(p.status)}</Text>
          </Pressable>
          {isOwner ? (
            <Pressable testID={`memory-participant-remove-${p.userId}`} onPress={() => confirmOwnerRemove(p)} disabled={busy !== null} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Remove ${displayName(p)}`}>
              {busy === `${p.userId}:remove` ? <ActivityIndicator size="small" color={color.mute} /> : <Text style={s.remove}>Remove</Text>}
            </Pressable>
          ) : null}
        </View>
      ))}
      {anonymousCount > 0 ? (
        <Text style={s.caption}>{anonymousCount === 1 ? '1 more person' : `${anonymousCount} more people`}</Text>
      ) : null}
    </View>
  );
}

export function MemoryTagConsentFallback({ memoryId, viewerId }: { memoryId: string; viewerId: string | null }) {
  const [me, setMe] = useState<MemoryParticipant | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!viewerId) return;
    const res = await getMemoryTags(memoryId);
    // Only a tagged person is answered at all; anyone else gets not_found, and
    // then there is nothing to decide and nothing is shown.
    if (!res.ok) { setMe(null); return; }
    setMe(res.tags.find((p) => p.userId === viewerId && p.status !== 'removed') ?? null);
  }, [memoryId, viewerId]);

  useEffect(() => { void load(); }, [load]);

  if (done) return <Text style={[s.caption, s.center]} testID="memory-tag-consent-done">{done}</Text>;
  if (!me) return null;
  return (
    <View style={s.fallback}>
      <Text style={[s.caption, s.center]}>You cannot view this memory, but you were tagged in it.</Text>
      <ConsentControls
        memoryId={memoryId}
        me={me}
        onDone={() => { setDone(me.status === 'pending' ? 'Your answer was saved.' : 'Your tag was removed.'); }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginTop: space.md, gap: space.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  head: { ...(t.small as object), color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, paddingVertical: space.xs },
  nameCol: { flex: 1 },
  bodyStrong: { ...(t.bodyStrong as object), color: color.ink },
  link: { color: color.signalStrong },
  caption: { ...(t.small as object), color: color.mute },
  remove: { ...(t.small as object), color: color.signalStrong, fontWeight: '700' },
  consent: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: space.xs },
  buttons: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  primary: { backgroundColor: color.signalStrong, borderRadius: radius.md, paddingVertical: space.sm, paddingHorizontal: space.lg, alignItems: 'center' },
  primaryText: { ...(t.bodyStrong as object), color: color.onInk },
  secondary: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.sm, paddingHorizontal: space.lg, alignItems: 'center' },
  secondaryText: { ...(t.bodyStrong as object), color: color.ink },
  dim: { opacity: 0.5 },
  fallback: { marginHorizontal: space.xl, gap: space.sm },
  center: { textAlign: 'center' },
});
