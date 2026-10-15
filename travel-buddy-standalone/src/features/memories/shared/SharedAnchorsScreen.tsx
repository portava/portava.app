/**
 * SharedAnchorsScreen — /memory/together: every invitation to "Remember this
 * together" and every anchor I accepted (census-highlights-memories H53,
 * MEM-ANCHOR-2). The in-app invitation notice opens it (its link is this
 * constant path; the notice carries no Memory id), and the Memory screen's
 * panel links to it for what belongs to no Memory on screen — an invitation
 * whose host's Memory I may not read, an anchor I joined without linking one of
 * my Memories. So every invitation can be answered, and every anchor left, from
 * somewhere.
 *
 * Flag OFF (the app's, or the server answering as if the routes were not there)
 * ⇒ one neutral line and no request. Decline and Leave are one tap here as on
 * the Memory screen; Accept offers my own Memories to link, or none.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { color, space, type as t } from '../../../theme/tokens.ts';
import { useSession } from '../../../context/SessionContext.tsx';
import type { AcceptedAnchor, Invitation } from './sharedAnchorsApi.ts';
import {
  HUB_ANCHORS, HUB_EMPTY, HUB_INVITATIONS, HUB_TITLE, HUB_UNAVAILABLE, LOAD_ERROR, NEUTRAL_REFUSAL, RETRY_LABEL,
} from './sharedAnchorCopy.ts';
import { useSharedAnchors } from './useSharedAnchors.ts';
import { AnchorCard, InvitationCard, s as v } from './SharedAnchorViews.tsx';

export function SharedAnchorsScreen() {
  const insets = useSafeAreaInsets();
  const { userId } = useSession();
  const viewerId = typeof userId === 'string' && userId.length > 0 ? userId : null;
  const h = useSharedAnchors({ viewerId, memoryId: null, isOwner: false });
  const st = h.state;

  let body: React.ReactNode;
  if (!h.on || viewerId === null || st.kind === 'off' || st.kind === 'absent') {
    body = <Text style={v.caption} testID="shared-anchors-unavailable">{HUB_UNAVAILABLE}</Text>;
  } else if (st.kind === 'loading') {
    body = null;
  } else if (st.kind === 'error') {
    body = (
      <View style={v.gap}>
        <Text style={v.caption} testID="shared-anchor-load-error">{LOAD_ERROR}</Text>
        <Pressable testID="shared-anchor-retry" onPress={() => { void h.reload(); }} hitSlop={6} accessibilityRole="button" accessibilityLabel={RETRY_LABEL}>
          <Text style={v.link}>{RETRY_LABEL}</Text>
        </Pressable>
      </View>
    );
  } else {
    const invitations = st.anchors.filter((a): a is Invitation => a.yourStatus === 'invited');
    const anchors = st.anchors.filter((a): a is AcceptedAnchor => a.yourStatus === 'accepted');
    body = (
      <View style={v.wrap}>
        {h.refused ? <Text style={v.caption} testID="shared-anchor-refused" accessibilityLiveRegion="polite">{NEUTRAL_REFUSAL}</Text> : null}
        {invitations.length === 0 && anchors.length === 0 ? <Text style={v.caption} testID="shared-anchors-empty">{HUB_EMPTY}</Text> : null}
        {invitations.length > 0 ? <Text style={v.head}>{HUB_INVITATIONS}</Text> : null}
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
        {anchors.length > 0 ? <Text style={v.head}>{HUB_ANCHORS}</Text> : null}
        {anchors.map((a) => (
          <AnchorCard key={a.id} anchor={a} hereMemoryId={null} busy={h.busy} onLeave={() => { void h.leave(a.id); }} />
        ))}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }} testID="shared-anchors-screen">
      <View style={[x.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={x.title} numberOfLines={1}>{HUB_TITLE}</Text>
        <View style={{ width: 22 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + space.xxl }}>
        {body}
      </ScrollView>
    </View>
  );
}

const x = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingBottom: space.md, borderBottomWidth: 1, borderColor: color.haze, backgroundColor: color.paper,
  },
  title: { ...(t.bodyStrong as object), color: color.ink, flex: 1, marginHorizontal: space.md },
});
