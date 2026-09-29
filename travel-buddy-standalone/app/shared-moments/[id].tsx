/**
 * Shared Moment — /shared-moments/:id (HM-F16, HM-F17).
 *
 * Member: the Moment, chat availability, the approved feed, contributing one
 * of your own posts, your contributions awaiting approval; the organiser also
 * answers join requests and approves or removes contributions.
 *
 * Not a member: `GET /:id` answers `not_member`, and the screen asks
 * `GET /:id/preview` what this person may do — accept an invitation, ask to
 * join an approval-required Moment, or nothing (invitation only). The preview
 * refuses exactly as a missing Moment does, so a stranger learns nothing.
 *
 * A read that FAILED is an error with a retry, never "unavailable" (DV-83):
 * the old screen told an invitee whose network blinked that they "may need an
 * invitation" — the one thing they had.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  archiveSharedMoment, getSharedMomentPreview, leaveSharedMoment, loadSharedMoment,
  type SharedMomentDetail, type SharedMomentPreview,
} from '../../src/services/sharedMoments.ts';
import { SharedMomentJoinPanel } from '../../src/features/sharedMoments/SharedMomentJoinPanel.tsx';
import {
  ContributePanel, JoinRequestsPanel, MomentFeedPanel, PendingContributionsPanel,
} from '../../src/features/sharedMoments/SharedMomentPanels.tsx';
import { color, radius, space, type as t, typography } from '../../src/theme/tokens.ts';

type State =
  | { kind: 'loading' }
  | { kind: 'member'; detail: SharedMomentDetail }
  | { kind: 'preview'; preview: SharedMomentPreview }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

export default function SharedMomentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const momentId = Array.isArray(id) ? id[0] : id;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [feedKey, setFeedKey] = useState(0);
  const [pendingKey, setPendingKey] = useState(0);

  const load = useCallback(async () => {
    if (!momentId) { setState({ kind: 'unavailable' }); return; }
    setState({ kind: 'loading' });
    const detail = await loadSharedMoment(momentId);
    if (detail.ok) { setState({ kind: 'member', detail: detail.data }); return; }
    if (detail.code !== 'not_member' && detail.code !== 'not_found' && detail.code !== 'forbidden') {
      setState({ kind: 'error', message: detail.message });
      return;
    }
    const preview = await getSharedMomentPreview(momentId);
    if (preview.ok) setState({ kind: 'preview', preview: preview.data });
    else if (preview.code === 'not_found' || preview.code === 'forbidden') setState({ kind: 'unavailable' });
    else setState({ kind: 'error', message: preview.message });
  }, [momentId]);

  useEffect(() => { void load(); }, [load]);

  if (state.kind === 'loading') {
    return <SafeAreaView style={styles.safe}><ActivityIndicator style={styles.loader} color={color.signal} /></SafeAreaView>;
  }
  if (state.kind === 'error') {
    return (
      <SafeAreaView style={styles.safe}><View style={styles.center}>
        <Text style={styles.title}>Couldn’t open this Moment</Text>
        <Text style={styles.body}>{state.message}</Text>
        <Pressable testID="moment-retry" onPress={load} style={styles.secondary} accessibilityRole="button"><Text style={styles.secondaryText}>Try again</Text></Pressable>
      </View></SafeAreaView>
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <SafeAreaView style={styles.safe}><View style={styles.center} testID="moment-unavailable">
        <Text style={styles.title}>This Moment is unavailable</Text>
        <Text style={styles.body}>You may need an invitation before it can be opened.</Text>
      </View></SafeAreaView>
    );
  }
  if (state.kind === 'preview') {
    return (
      <SafeAreaView style={styles.safe} edges={['bottom']}>
        <Stack.Screen options={{ title: state.preview.moment.title, headerShown: true }} />
        <ScrollView><SharedMomentJoinPanel preview={state.preview} onJoined={load} /></ScrollView>
      </SafeAreaView>
    );
  }

  const { detail } = state;
  const canManage = detail.moment.role === 'owner' || detail.moment.role === 'manager';
  const active = detail.moment.status === 'active';
  const leave = async () => { if (momentId && await leaveSharedMoment(momentId)) router.back(); else Alert.alert('Couldn’t leave Moment'); };
  const archive = async () => { if (momentId && await archiveSharedMoment(momentId)) void load(); else Alert.alert('Couldn’t archive Moment'); };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: detail.moment.title, headerShown: true }} />
      <ScrollView contentContainerStyle={styles.content} testID="moment-member-view">
        <Text style={styles.heading}>{detail.moment.title}</Text>
        {detail.moment.description ? <Text style={styles.body}>{detail.moment.description}</Text> : null}
        <Text style={styles.member}>{detail.members.length} people joined by choice</Text>
        <View style={styles.chat}><Text style={styles.title}>Moment chat</Text><Text style={styles.body}>{detail.chat.available ? 'Chat is available for this Moment.' : detail.chat.reason}</Text></View>
        {canManage && active ? <JoinRequestsPanel momentId={detail.moment.id} onMembersChanged={load} /> : null}
        {active ? <ContributePanel momentId={detail.moment.id} onContributed={() => setPendingKey((k) => k + 1)} /> : null}
        <PendingContributionsPanel momentId={detail.moment.id} canManage={canManage} reloadKey={pendingKey} onApproved={() => setFeedKey((k) => k + 1)} />
        <MomentFeedPanel momentId={detail.moment.id} canManage={canManage} reloadKey={feedKey} />
        {active ? (
          <View style={styles.actions}>
            {canManage
              ? <Pressable onPress={archive} style={styles.secondary}><Text style={styles.secondaryText}>Archive Moment</Text></Pressable>
              : <Pressable onPress={leave} style={styles.secondary}><Text style={styles.secondaryText}>Leave Moment</Text></Pressable>}
          </View>
        ) : <Text style={styles.member}>Archived</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.paper }, loader: { flex: 1 }, center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space.xl, gap: space.sm }, content: { padding: space.lg, gap: space.md },
  heading: { ...t.heading, color: color.ink }, title: { ...t.bodyStrong, color: color.ink }, body: { ...typography.body, color: color.mute }, member: { ...typography.caption, color: color.signal },
  chat: { borderLeftWidth: 3, borderLeftColor: color.signal, paddingLeft: space.md, gap: space.xs },
  actions: { marginTop: space.lg }, secondary: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, alignItems: 'center' }, secondaryText: { ...t.bodyStrong, color: color.deep },
});
