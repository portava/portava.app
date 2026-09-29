/**
 * Shared Moment member panels (HM-F17): join requests, pending contributions,
 * contributing one of your own posts, and the approved feed.
 *
 * Every list has its own loading / error-with-retry / empty state: an
 * unreadable list is never shown as an empty one (DV-83). Every write reloads
 * the lists it changes, so what is shown is the server's state, not a guess.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { CachedImage } from '../../components/CachedImage.tsx';
import { color, radius, space, type as t, typography } from '../../theme/tokens.ts';
import {
  addSharedMomentContribution, approveSharedMomentContribution, listContributablePosts,
  listPendingSharedMomentContributions, listSharedMomentJoinRequests, loadSharedMomentFeed,
  removeSharedMomentContribution, respondToSharedMomentJoinRequest,
  type ContributablePost, type MomentRead, type PendingSharedMomentContribution,
  type SharedMomentFeedItem, type SharedMomentJoinRequest,
} from '../../services/sharedMoments.ts';

type ListState<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; items: T[] };

function useList<T>(read: () => Promise<MomentRead<T[]>>, deps: unknown[]) {
  const [state, setState] = useState<ListState<T>>({ kind: 'loading' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const res = await read();
    setState(res.ok ? { kind: 'ready', items: res.data } : { kind: 'error', message: res.message });
  }, deps);
  useEffect(() => { void load(); }, [load]);
  return { state, load };
}

function ListStatus({ state, onRetry, empty, testIDPrefix }: { state: ListState<unknown>; onRetry: () => void; empty: string; testIDPrefix: string }) {
  if (state.kind === 'loading') return <ActivityIndicator color={color.signal} style={s.pad} />;
  if (state.kind === 'error') {
    return (
      <View style={s.pad} testID={`${testIDPrefix}-error`}>
        <Text style={s.body}>{state.message}</Text>
        <Pressable onPress={onRetry} accessibilityRole="button" style={s.link}><Text style={s.linkText}>Try again</Text></Pressable>
      </View>
    );
  }
  if (state.items.length === 0) return <Text style={s.body} testID={`${testIDPrefix}-empty`}>{empty}</Text>;
  return null;
}

// ── Join requests (organiser) ────────────────────────────────────────────────
export function JoinRequestsPanel({ momentId, onMembersChanged }: { momentId: string; onMembersChanged: () => void }) {
  const { state, load } = useList<SharedMomentJoinRequest>(() => listSharedMomentJoinRequests(momentId), [momentId]);
  const [busy, setBusy] = useState<string | null>(null);
  const answer = async (userId: string, response: 'accept' | 'decline') => {
    if (busy) return;
    setBusy(`${userId}:${response}`);
    const ok = await respondToSharedMomentJoinRequest(momentId, userId, response);
    setBusy(null);
    if (!ok) { Alert.alert('Couldn’t answer the request', 'It may already have been answered. Please try again.'); }
    void load();
    if (ok && response === 'accept') onMembersChanged();
  };
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Requests to join</Text>
      <ListStatus state={state} onRetry={load} empty="No one is waiting to join." testIDPrefix="moment-requests" />
      {state.kind === 'ready' ? state.items.map((r) => (
        <View key={r.userId} style={s.row}>
          <Text style={[s.title, s.flex]} numberOfLines={1}>{r.name || (r.handle ? `@${r.handle}` : 'Someone')}</Text>
          <Pressable testID={`moment-request-accept-${r.userId}`} onPress={() => answer(r.userId, 'accept')} disabled={busy !== null} style={s.smallPrimary} accessibilityRole="button">
            <Text style={s.smallPrimaryText}>Accept</Text>
          </Pressable>
          <Pressable testID={`moment-request-decline-${r.userId}`} onPress={() => answer(r.userId, 'decline')} disabled={busy !== null} style={s.smallSecondary} accessibilityRole="button">
            <Text style={s.smallSecondaryText}>Decline</Text>
          </Pressable>
        </View>
      )) : null}
    </View>
  );
}

// ── Pending contributions ─────────────────────────────────────────────────────
export function PendingContributionsPanel({ momentId, canManage, reloadKey, onApproved }: { momentId: string; canManage: boolean; reloadKey: number; onApproved: () => void }) {
  const { state, load } = useList<PendingSharedMomentContribution>(() => listPendingSharedMomentContributions(momentId), [momentId, reloadKey]);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (c: PendingSharedMomentContribution, action: 'approve' | 'remove') => {
    if (busy) return;
    setBusy(`${c.id}:${action}`);
    const ok = action === 'approve'
      ? await approveSharedMomentContribution(momentId, c.id)
      : await removeSharedMomentContribution(momentId, c.id);
    setBusy(null);
    if (!ok) Alert.alert(action === 'approve' ? 'Couldn’t approve' : 'Couldn’t remove', 'It may already have been reviewed. Please try again.');
    void load();
    if (ok && action === 'approve') onApproved();
  };
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{canManage ? 'Waiting for your approval' : 'Your contributions awaiting approval'}</Text>
      <ListStatus state={state} onRetry={load} empty={canManage ? 'Nothing to review.' : 'Nothing waiting.'} testIDPrefix="moment-pending" />
      {state.kind === 'ready' ? state.items.map((c) => (
        <View key={c.id} style={s.card}>
          {c.thumbnailUrl || c.mediaUrl ? <CachedImage source={{ uri: c.thumbnailUrl ?? c.mediaUrl ?? '' }} style={s.image} /> : null}
          <Text style={s.body}>{c.caption ?? (c.mine ? 'Your contribution' : 'A contribution')}</Text>
          {canManage ? (
            <View style={s.row}>
              <Pressable testID={`moment-contribution-approve-${c.id}`} onPress={() => act(c, 'approve')} disabled={busy !== null} style={s.smallPrimary} accessibilityRole="button">
                <Text style={s.smallPrimaryText}>Approve</Text>
              </Pressable>
              <Pressable testID={`moment-contribution-reject-${c.id}`} onPress={() => act(c, 'remove')} disabled={busy !== null} style={s.smallSecondary} accessibilityRole="button">
                <Text style={s.smallSecondaryText}>Remove</Text>
              </Pressable>
            </View>
          ) : <Text style={s.meta}>Awaiting approval</Text>}
        </View>
      )) : null}
    </View>
  );
}

// ── Contribute one of your own posts ─────────────────────────────────────────
export function ContributePanel({ momentId, onContributed }: { momentId: string; onContributed: () => void }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<Record<string, true>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { state, load } = useList<ContributablePost>(() => (open ? listContributablePosts(momentId) : Promise.resolve({ ok: true as const, data: [] })), [momentId, open]);
  const add = async (post: ContributablePost) => {
    if (busy) return;
    setBusy(post.id);
    const ok = await addSharedMomentContribution(momentId, { postId: post.id });
    setBusy(null);
    if (!ok) { Alert.alert('Couldn’t add your post', 'Please try again.'); return; }
    setSent((m) => ({ ...m, [post.id]: true }));
    setNotice('Sent for approval.');
    onContributed();
  };
  if (!open) {
    return (
      <Pressable testID="moment-contribute-open" onPress={() => setOpen(true)} style={s.secondary} accessibilityRole="button">
        <Text style={s.secondaryText}>Add one of your posts</Text>
      </Pressable>
    );
  }
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Your posts from here</Text>
      <Text style={s.meta}>Only you can add your posts. The organiser approves what appears, and your post keeps its own privacy.</Text>
      {notice ? <Text style={s.notice}>{notice}</Text> : null}
      <ListStatus state={state} onRetry={load} empty="You have no posts from this place or trip yet." testIDPrefix="moment-contributable" />
      {state.kind === 'ready' ? state.items.map((p) => {
        const done = p.contributed || sent[p.id];
        return (
          <View key={p.id} style={s.row}>
            <Text style={[s.body, s.flex]} numberOfLines={2}>{p.caption || 'Your post'}</Text>
            {done ? <Text style={s.meta}>Added</Text> : (
              <Pressable testID={`moment-contribute-${p.id}`} onPress={() => add(p)} disabled={busy !== null} style={s.smallPrimary} accessibilityRole="button">
                {busy === p.id ? <ActivityIndicator size="small" color={color.paper} /> : <Text style={s.smallPrimaryText}>Add</Text>}
              </Pressable>
            )}
          </View>
        );
      }) : null}
    </View>
  );
}

// ── Approved feed ─────────────────────────────────────────────────────────────
export function MomentFeedPanel({ momentId, canManage, reloadKey }: { momentId: string; canManage: boolean; reloadKey: number }) {
  const { state, load } = useList<SharedMomentFeedItem>(async () => {
    const res = await loadSharedMomentFeed(momentId);
    return res.ok ? { ok: true, data: res.data.items } : res;
  }, [momentId, reloadKey]);
  const remove = (item: SharedMomentFeedItem) => Alert.alert('Remove this contribution?', 'It will no longer appear in this Moment. The original post is not changed.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Remove', style: 'destructive',
      onPress: () => { void (async () => {
        const ok = await removeSharedMomentContribution(momentId, item.id);
        if (!ok) Alert.alert('Couldn’t remove', 'Please try again.');
        void load();
      })(); },
    },
  ]);
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Approved contributions</Text>
      {state.kind === 'error' ? (
        <View style={s.pad} testID="moment-feed-error">
          <Text style={s.body}>{state.message}</Text>
          <Pressable onPress={load} accessibilityRole="button" style={s.link}><Text style={s.linkText}>Try again</Text></Pressable>
        </View>
      ) : state.kind === 'loading' ? <ActivityIndicator color={color.signal} style={s.pad} />
        : state.items.length === 0 ? (
          <Text style={s.body} testID="moment-feed-empty">Approved contributions will appear here. Source posts remain private unless they are already safe for you to view.</Text>
        ) : state.items.map((item) => (
          <View key={item.id} style={s.card}>
            {item.thumbnailUrl || item.mediaUrl ? <CachedImage source={{ uri: item.thumbnailUrl ?? item.mediaUrl ?? '' }} style={s.image} /> : null}
            <Text style={s.body}>{item.caption ?? 'Shared a contribution'}</Text>
            {canManage ? (
              <Pressable testID={`moment-contribution-remove-${item.id}`} onPress={() => remove(item)} accessibilityRole="button" style={s.link}>
                <Text style={s.linkText}>Remove from Moment</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
    </View>
  );
}

const s = StyleSheet.create({
  section: { gap: space.sm, marginTop: space.md },
  sectionTitle: { ...t.bodyStrong, color: color.ink },
  title: { ...t.bodyStrong, color: color.ink },
  body: { ...typography.body, color: color.mute },
  meta: { ...typography.caption, color: color.mute },
  notice: { ...typography.caption, color: color.success },
  pad: { paddingVertical: space.sm },
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  card: { backgroundColor: color.paperRaised, borderColor: color.haze, borderWidth: 1, borderRadius: radius.md, overflow: 'hidden', padding: space.md, gap: space.sm },
  image: { width: '100%', height: 200, borderRadius: radius.sm },
  smallPrimary: { backgroundColor: color.signalStrong, borderRadius: radius.md, paddingVertical: space.xs, paddingHorizontal: space.md },
  smallPrimaryText: { ...t.bodyStrong, color: color.paper },
  smallSecondary: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.xs, paddingHorizontal: space.md },
  smallSecondaryText: { ...t.bodyStrong, color: color.ink },
  secondary: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, alignItems: 'center', marginTop: space.md },
  secondaryText: { ...t.bodyStrong, color: color.deep },
  link: { paddingVertical: space.xs },
  linkText: { ...t.bodyStrong, color: color.signalStrong },
});
