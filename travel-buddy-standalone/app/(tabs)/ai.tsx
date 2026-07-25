import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  ActivityIndicator, ScrollView, RefreshControl,
} from 'react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { useNavBarScrollHandler, NavBarFiller } from '../../src/hooks/useNavBarCollapse';
import { Sparkles, Send, Plane, MessageCircle, Map, PlusCircle } from 'lucide-react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  postCompassFrontloadEvent, postCompassAskStream,
  confirmCompassProposal, declineCompassProposal,
} from '../../src/services/compass';
import type { CompassAskResponse, CompassPendingProposal, CompassUiPlace } from '../../src/services/compass';
import { CompassChatBlocks } from '../../src/components/compass/CompassChatBlocks';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import { usePlanPicker } from '../../src/components/PlanPickerController';
import { CompassHome } from '../../src/components/compass/CompassHome';
import { CompassLive } from '../../src/components/compass/CompassLive';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

type ChatEntry =
  | { kind: 'user';    id: string; text: string }
  | { kind: 'ai_text'; id: string; text: string }
  | { kind: 'rec';     id: string; rec: CompassAskResponse }
  | { kind: 'typing';  id: string }
  // Live-streaming assistant reply — replaced by a 'rec' entry on finalize.
  | { kind: 'stream';  id: string; text: string };

export default function AiChat() {
  const router = useRouter();
  const planPicker = usePlanPicker();
  const [entries, setEntries]       = useState<ChatEntry[]>([]);
  const [input, setInput]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [layoverOpen, setLayoverOpen] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const navScrollHandler = useNavBarScrollHandler();

  // Auto-follow the newest text while a reply streams. Pauses when the user
  // scrolls up mid-stream; resumes once they return near the bottom.
  const followBottom = useRef(true);
  const streamingRef = useRef(false);

  // Pull-to-refresh — always available. On the empty chat it refreshes the
  // Compass Home surface; mid-conversation it re-syncs the live-session
  // surface (deliberate semantics: the chat transcript is local and is never
  // re-run on a pull). The spinner is cleared by whichever surface owns the
  // refresh for the current state.
  const [refreshing, setRefreshing]     = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const onPullRefresh = useCallback(() => {
    setRefreshing(true);
    setRefreshNonce((n) => n + 1);
  }, []);

  useFocusEffect(useCallback(() => {
    postCompassFrontloadEvent({ eventType: 'navigation', screen: 'ai_chat' }).catch(() => {});
  }, []));

  function scrollToEnd() {
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 80);
  }

  // Wraps the nav-bar handler so we can also track whether the user is pinned
  // to the bottom (within a small threshold) — standard chat auto-follow.
  const onChatScroll = useCallback((e: any) => {
    navScrollHandler(e);
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom =
      contentSize.height - layoutMeasurement.height - contentOffset.y;
    followBottom.current = distanceFromBottom < 48;
  }, [navScrollHandler]);

  // While streaming, keep pinned to the newest text as the content grows —
  // unless the user has scrolled up.
  const onContentSizeChange = useCallback(() => {
    if (streamingRef.current && followBottom.current) {
      scroll.current?.scrollToEnd({ animated: false });
    }
  }, []);

  async function send(promptOverride?: string) {
    const text = (promptOverride ?? input).trim();
    if (!text || loading) return;
    if (!promptOverride) setInput('');

    const userId = 'u_' + Date.now();
    const typingId = 'typing_' + Date.now();

    setEntries((prev) => [
      ...prev,
      { kind: 'user',   id: userId,   text },
      { kind: 'typing', id: typingId },
    ]);
    setLoading(true);
    followBottom.current = true;   // a fresh send always re-pins to the bottom
    streamingRef.current = true;
    scrollToEnd();

    // Stream the reply so it types out live; postCompassAskStream falls back
    // to the plain non-streaming request on any SSE failure.
    const streamId = 'stream_' + Date.now();
    const result = await postCompassAskStream(text, {}, {
      onDelta: (messageSoFar) => {
        setEntries((prev) => {
          const without = prev.filter((e) => e.id !== typingId && e.id !== streamId);
          return [...without, { kind: 'stream', id: streamId, text: messageSoFar }];
        });
      },
    });

    setEntries((prev) => {
      const without = prev.filter((e) => e.id !== typingId && e.id !== streamId);
      if (!result.ok || !result.data) {
        return [
          ...without,
          {
            kind: 'ai_text',
            id: 'err_' + Date.now(),
            text: "Couldn't reach Compass right now — try again in a moment.",
          },
        ];
      }
      return [...without, { kind: 'rec', id: 'rec_' + Date.now(), rec: result.data }];
    });
    streamingRef.current = false;
    setLoading(false);
    if (followBottom.current) scrollToEnd();
  }

  // Phase 4: confirm/decline an add_to_trip proposal. Nothing is written to a
  // trip until confirm succeeds server-side.
  const [resolvedProposals, setResolvedProposals] = useState<Record<string, 'confirmed' | 'declined' | 'busy' | 'expired'>>({});

  async function resolveProposal(
    rec: CompassAskResponse,
    proposal: CompassPendingProposal,
    decision: 'confirm' | 'decline',
  ) {
    if (!rec.conversationId || resolvedProposals[proposal.proposalId]) return;
    setResolvedProposals((p) => ({ ...p, [proposal.proposalId]: 'busy' }));
    const fn = decision === 'confirm' ? confirmCompassProposal : declineCompassProposal;
    const result = await fn(proposal.proposalId, rec.conversationId);
    if (!result.ok && result.error === 'http_410') {
      // Proposal expired server-side — show it as expired, don't re-enable the buttons.
      setResolvedProposals((p) => ({ ...p, [proposal.proposalId]: 'expired' }));
      setEntries((prev) => [...prev, {
        kind: 'ai_text', id: 'pexp_' + Date.now(),
        text: `That proposal for "${proposal.title}" has expired — just ask me again if you still want it.`,
      }]);
      scrollToEnd();
      return;
    }
    if (!result.ok) {
      setResolvedProposals((p) => {
        const next = { ...p };
        delete next[proposal.proposalId];
        return next;
      });
      setEntries((prev) => [...prev, {
        kind: 'ai_text', id: 'perr_' + Date.now(),
        text: "Couldn't update that proposal — try again in a moment.",
      }]);
      return;
    }
    setResolvedProposals((p) => ({ ...p, [proposal.proposalId]: decision === 'confirm' ? 'confirmed' : 'declined' }));
    setEntries((prev) => [...prev, {
      kind: 'ai_text', id: 'pok_' + Date.now(),
      text: decision === 'confirm'
        ? `Added "${proposal.title}" to your trip.`
        : `Okay — I won't add "${proposal.title}".`,
    }]);
    scrollToEnd();
  }

  // Phase 5: place cards route trip-adds through the existing PlanPicker flow —
  // the user confirms the write in the picker; nothing mutates on a bare tap.
  function addPlaceToPlan(place: CompassUiPlace) {
    planPicker.open({
      id:       place.id,
      type:     'place',
      title:    place.name,
      category: place.category ?? 'activity',
    });
  }

  // Phase 5: no dead-end quick actions — every whitelisted actionType lands on
  // a real screen (or continues the conversation).
  function handleAction(rec: CompassAskResponse, kind: string) {
    switch (kind) {
      case 'addTrip':
        planPicker.open({
          id:       rec.conversationId ?? 'compass_suggestion',
          type:     'compass_suggestion',
          title:    rec.message.slice(0, 120),
          category: 'activity',
        });
        break;
      case 'buildItinerary':
        send(`Build a 3-day itinerary based on: ${rec.message.slice(0, 80)}`);
        break;
      case 'askCommunity':
      case 'startPoll':
        router.push('/(tabs)/messages');
        break;
      case 'explore':
      case 'viewPlace':
        router.push('/(tabs)/discovery' as any);
        break;
      case 'viewEvent':
        router.push('/(tabs)/events' as any);
        break;
      case 'openMap':
        router.push('/map' as any);
        break;
      case 'viewPassport':
        router.push('/(tabs)/passport' as any);
        break;
      case 'findBuddy':
        router.push('/(rent-a-buddy)' as any);
        break;
      case 'viewTrips':
        router.push('/(tabs)/trips' as any);
        break;
      case 'shareTip':
        router.push('/create' as any);
        break;
      default:
        break;
    }
  }

  return (
    <KeyboardSafeScrollView style={{ backgroundColor: color.paper }}>
      <ScreenHeader title="AI Buddy" back />
      <ScrollView
        ref={scroll}
        contentContainerStyle={{ padding: space.lg, gap: space.md }}
        onScroll={onChatScroll}
        onContentSizeChange={onContentSizeChange}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} tintColor={color.signal} />
        }
      >
        {/* Phase 12: live-session surface — explicit start/stop, nudges, summary. */}
        <CompassLive
          refreshNonce={refreshNonce}
          onRefreshed={() => setRefreshing(false)}
        />
        {entries.length === 0 ? (
          // Phase 10: context-aware Compass Home replaces the blank-chat state.
          <CompassHome
            onAsk={(prompt) => send(prompt)}
            refreshNonce={refreshNonce}
            onRefreshed={() => setRefreshing(false)}
          />
        ) : null}
        {entries.map((e) => {
          if (e.kind === 'user') {
            return (
              <View key={e.id} style={styles.userBubble}>
                <Text style={styles.userText}>{e.text}</Text>
              </View>
            );
          }
          if (e.kind === 'typing') {
            return (
              <View key={e.id} style={styles.aiBubble}>
                <View style={styles.aiHead}>
                  <Sparkles size={15} color={color.signal} />
                  <Text style={styles.aiHeadText}>AI BUDDY</Text>
                </View>
                <ActivityIndicator size="small" color={color.signal} style={{ marginTop: 4 }} />
              </View>
            );
          }
          if (e.kind === 'stream') {
            return (
              <View key={e.id} style={styles.aiBubble}>
                <View style={styles.aiHead}>
                  <Sparkles size={15} color={color.signal} />
                  <Text style={styles.aiHeadText}>AI BUDDY</Text>
                </View>
                <Text style={styles.aiText}>{e.text}▌</Text>
              </View>
            );
          }
          if (e.kind === 'ai_text') {
            return (
              <View key={e.id} style={styles.aiBubble}>
                <View style={styles.aiHead}>
                  <Sparkles size={15} color={color.signal} />
                  <Text style={styles.aiHeadText}>AI BUDDY</Text>
                </View>
                <Text style={styles.aiText}>{e.text}</Text>
              </View>
            );
          }
          return (
            <RecCard
              onAddPlaceToPlan={addPlaceToPlan}
              key={e.id}
              rec={e.rec}
              proposalStates={resolvedProposals}
              onProposal={(proposal, decision) => resolveProposal(e.rec, proposal, decision)}
              onAction={(kind) => handleAction(e.rec, kind)}
            />
          );
        })}
        <NavBarFiller />
      </ScrollView>

      <View style={styles.inputBar}>
        <Pressable
          style={styles.layoverBtn}
          onPress={() => setLayoverOpen(true)}
          accessibilityLabel="Layover mode"
          accessibilityRole="button"
        >
          <Plane size={16} color="#fff" />
        </Pressable>
        <TextInput
          style={styles.input}
          placeholder="Ask about Cebu, your saves, or a plan…"
          placeholderTextColor={color.faint}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={() => send()}
          returnKeyType="send"
          editable={!loading}
        />
        <Pressable
          style={[styles.sendBtn, loading && styles.sendBtnDisabled]}
          onPress={() => send()}
          accessibilityLabel="Send message"
          accessibilityRole="button"
          disabled={loading}
        >
          <Send size={18} color={color.onInk} />
        </Pressable>
      </View>

      <LayoverModeSheet
        visible={layoverOpen}
        onClose={() => setLayoverOpen(false)}
      />
    </KeyboardSafeScrollView>
  );
}

// ── Rec card ──────────────────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, React.ReactNode> = {
  addTrip:        <PlusCircle size={13} color={color.onInk} />,
  buildItinerary: <Map size={13} color={color.onInk} />,
  askCommunity:   <MessageCircle size={13} color={color.onInk} />,
};

function RecCard({
  rec,
  onAction,
  onProposal,
  proposalStates,
  onAddPlaceToPlan,
}: {
  rec: CompassAskResponse;
  onAction: (kind: string) => void;
  onProposal: (proposal: CompassPendingProposal, decision: 'confirm' | 'decline') => void;
  proposalStates: Record<string, 'confirmed' | 'declined' | 'busy' | 'expired'>;
  onAddPlaceToPlan: (place: CompassUiPlace) => void;
}) {
  return (
    <View style={styles.rec}>
      <View style={styles.aiHead}>
        <Sparkles size={15} color={color.signal} />
        <Text style={styles.aiHeadText}>AI BUDDY</Text>
      </View>
      <Text style={styles.recBody}>{rec.message}</Text>

      {/* Phase 5: dynamic UI blocks — server-validated, real tool entities only */}
      <CompassChatBlocks
        blocks={rec.uiBlocks}
        payload={rec.payload}
        onAddPlaceToPlan={onAddPlaceToPlan}
      />

      {(rec.pendingProposals ?? []).map((p) => {
        const state = proposalStates[p.proposalId];
        return (
          <View key={p.proposalId} style={styles.proposal}>
            <Text style={styles.proposalTitle}>
              Add "{p.title}" to {p.tripTitle ?? 'your trip'}?
            </Text>
            {state === 'confirmed' ? (
              <Text style={styles.proposalDone}>Added ✓</Text>
            ) : state === 'declined' ? (
              <Text style={styles.proposalDone}>Declined</Text>
            ) : state === 'expired' ? (
              <Text style={styles.proposalDone}>Expired — ask again to re-create it</Text>
            ) : (
              <View style={styles.actions}>
                <Pressable
                  style={[styles.actionBtn, state === 'busy' && styles.sendBtnDisabled]}
                  disabled={state === 'busy'}
                  onPress={() => onProposal(p, 'confirm')}
                  accessibilityLabel="Confirm proposal"
                  accessibilityRole="button"
                >
                  <Text style={styles.actionText}>Confirm</Text>
                </Pressable>
                <Pressable
                  style={[styles.declineBtn, state === 'busy' && styles.sendBtnDisabled]}
                  disabled={state === 'busy'}
                  onPress={() => onProposal(p, 'decline')}
                  accessibilityLabel="Decline proposal"
                  accessibilityRole="button"
                >
                  <Text style={styles.declineText}>Decline</Text>
                </Pressable>
              </View>
            )}
          </View>
        );
      })}

      {(rec.quickActions ?? []).length > 0 ? (
        <View style={styles.actions}>
          {(rec.quickActions ?? []).map((a) => (
            <Pressable
              key={a.actionType}
              style={styles.actionBtn}
              onPress={() => onAction(a.actionType)}
            >
              {ACTION_ICONS[a.actionType] ?? null}
              <Text style={styles.actionText}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  userBubble:    { alignSelf: 'flex-end', maxWidth: '82%', backgroundColor: color.ink, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.lg, borderBottomRightRadius: 4 },
  userText:      { ...t.body, color: color.onInk },
  aiBubble:      { alignSelf: 'flex-start', maxWidth: '90%', backgroundColor: color.paperRaised, padding: space.lg, borderRadius: radius.lg, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: color.haze },
  aiHead:        { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: space.sm },
  aiHeadText:    { ...t.stamp, fontFamily: 'Courier', color: color.signal },
  aiText:        { ...t.body, color: color.ink },
  rec:           { backgroundColor: color.paperRaised, padding: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, ...shadow.card, gap: 4 },
  recPick:       { ...t.heading, color: color.ink, marginBottom: space.sm },
  recLabel:      { ...t.stamp, fontFamily: 'Courier', color: color.mute, marginTop: space.sm },
  recBody:       { ...t.body, color: color.ink },
  usedRow:       { flexDirection: 'row', marginTop: space.md },
  actions:       { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  actionBtn:     { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: color.ink },
  proposal:      { marginTop: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper, gap: 6 },
  proposalTitle: { ...t.small, fontWeight: '700', color: color.ink },
  proposalDone:  { ...t.small, color: color.mute },
  declineBtn:    { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  declineText:   { ...t.small, fontWeight: '700', color: color.ink },
  actionText:    { ...t.small, fontWeight: '700', color: color.onInk },
  inputBar:      { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderTopWidth: 1, borderTopColor: color.haze, backgroundColor: color.paper },
  input:         { flex: 1, ...t.body, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.md },
  sendBtn:       { width: 44, height: 44, borderRadius: 22, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.45 },
  layoverBtn:    { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1565C0', alignItems: 'center', justifyContent: 'center' },
});
