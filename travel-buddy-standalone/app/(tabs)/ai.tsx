import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  ActivityIndicator, ScrollView, RefreshControl,
} from 'react-native';
import { KeyboardSafeScrollView } from '../../src/components/ui/KeyboardSafeView';
import { useNavBarScrollHandler, NavBarFiller } from '../../src/hooks/useNavBarCollapse';
import { Sparkles, Send, Plane, MessageCircle, Map, PlusCircle, Wand2 } from 'lucide-react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  postCompassFrontloadEvent, postCompassAskStream,
  confirmCompassProposal, declineCompassProposal,
} from '../../src/services/compass';
import type { CompassAskResponse, CompassPendingProposal, CompassUiPlace } from '../../src/services/compass';
import { CompassChatBlocks } from '../../src/components/compass/CompassChatBlocks';
import { AppHeader } from '../../src/components/ui/AppHeader';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import { usePlanPicker } from '../../src/components/PlanPickerController';
import { CompassHome } from '../../src/components/compass/CompassHome';
import { CompassLive } from '../../src/components/compass/CompassLive';
import { useLocationContext } from '../../src/context/LocationContext';
import { useAiWritingAssist } from '../../src/hooks/useAiWritingAssist.ts';
import {
  CompassStarters,
  AiWritingAssist,
  buildCompassStarters,
  COMPASS_FIELD_IDS,
} from '../../src/platform/input-assistance';
import { color, space, radius, type as t, shadow, avatar } from '../../src/theme/tokens';

type ChatEntry =
  | { kind: 'user';    id: string; text: string }
  | { kind: 'ai_text'; id: string; text: string }
  | { kind: 'rec';     id: string; rec: CompassAskResponse }
  | { kind: 'typing';  id: string }
  // Failed request (timeout, network, server error) — always offers a retry
  // of the exact prompt that failed, so a slow or stalled reply never leaves
  // the user stuck with no next step.
  | { kind: 'ai_error'; id: string; text: string; prompt: string }
  // Live-streaming assistant reply — replaced by a 'rec' entry on finalize.
  | { kind: 'stream';  id: string; text: string };

export default function AiChat() {
  const router = useRouter();
  const { prefillMessage, mediaId } = useLocalSearchParams<{ prefillMessage?: string; mediaId?: string }>();
  const planPicker = usePlanPicker();
  // Pre-seed Compass with the user's resolved city (GPS → last-known → home)
  // so it never has to ask "where are you right now?" when the app already
  // knows — mirrors the "Using home city" notice shown on Discovery.
  const { resolvedLocation } = useLocationContext();
  const currentCity = resolvedLocation.place.city ?? undefined;
  const [entries, setEntries]       = useState<ChatEntry[]>([]);
  const [input, setInput]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [layoverOpen, setLayoverOpen] = useState(false);
  // Phase 7 (§22/§56): opt-in AI continuation for the compass prompt. Until the
  // user taps "Improve with AI" nothing is requested; the deterministic starters
  // below are shown without any opt-in and are unaffected by the AI flag.
  const [aiOptIn, setAiOptIn]       = useState(false);
  const promptAssist = useAiWritingAssist({
    context: 'compass_prompt',
    fieldId: COMPASS_FIELD_IDS.compassPrompt,
    text: input,
    optedIn: aiOptIn,
    city: currentCity ?? null,
    sessionContext: { surface: 'compass' },
  });
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

  // Layover's "Ask locals" hands off a ready-made prompt (airport + city +
  // time-to-spare context) via router params — auto-send it once so the
  // traveler lands in a live conversation instead of a blank chat that
  // silently dropped their layover context.
  const sentPrefillRef = useRef(false);
  useEffect(() => {
    if (!prefillMessage || sentPrefillRef.current) return;
    sentPrefillRef.current = true;
    // The media action rail hands off both a prompt and (optionally) the media
    // id so Compass grounds its first reply in the media context (§32); the
    // context only needs to ride the initiating turn — follow-ups carry it via
    // the conversation id.
    send(prefillMessage, typeof mediaId === 'string' ? mediaId : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillMessage]);

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

  async function send(promptOverride?: string, mediaIdOverride?: string) {
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
    const result = await postCompassAskStream(text, { city: currentCity, mediaId: mediaIdOverride }, {
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
        const isTimeout = result.error === 'timeout';
        return [
          ...without,
          {
            kind: 'ai_error',
            id: 'err_' + Date.now(),
            text: isTimeout
              ? "Compass is unavailable right now — that's taking longer than it should."
              : "Compass is unavailable right now — couldn't reach it.",
            prompt: text,
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
      <AppHeader
        variant="detail"
        title="AI Buddy"
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/' as any))}
      />
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
          if (e.kind === 'ai_error') {
            return (
              <View key={e.id} style={styles.aiBubble}>
                <View style={styles.aiHead}>
                  <Sparkles size={15} color={color.signal} />
                  <Text style={styles.aiHeadText}>AI BUDDY</Text>
                </View>
                <Text style={styles.aiText}>{e.text}</Text>
                <Pressable
                  onPress={() => send(e.prompt)}
                  disabled={loading}
                  style={({ pressed }) => [styles.retryButton, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.retryButtonText}>Retry</Text>
                </Pressable>
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

      {/* Phase 7 (§56): compass-prompt assistance above the input bar.
          - deterministic starters when the field is empty mid-conversation
            (the zero-state's starters are owned by CompassHome above);
          - an OPT-IN AI continuation once the traveler has typed. Both degrade
            to nothing when there is nothing to show, and nothing is ever sent
            automatically — a tap only fills the editable input. */}
      {(input.trim() === '' && entries.length > 0) || input.trim().length >= 1 ? (
        <View style={styles.assistBar}>
          {input.trim() === '' && entries.length > 0 ? (
            <CompassStarters
              starters={buildCompassStarters({ surface: 'compass', cityName: currentCity ?? null })}
              onSelect={(prompt) => setInput(prompt)}
            />
          ) : null}

          {input.trim().length >= 1 ? (
            aiOptIn ? (
              <View style={styles.aiZone}>
                <AiWritingAssist
                  proposals={promptAssist.proposals}
                  loading={promptAssist.loading}
                  heading="Improve this prompt"
                  onInsert={(p) => setInput(p.insertText)}
                />
                {!promptAssist.loading && promptAssist.proposals.length === 0 ? (
                  <Text style={styles.assistNote}>No AI suggestion right now.</Text>
                ) : null}
                <Pressable
                  onPress={() => setAiOptIn(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Turn off AI prompt suggestions"
                  hitSlop={6}
                >
                  <Text style={styles.assistToggleOff}>Turn off AI suggestions</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                onPress={() => setAiOptIn(true)}
                style={styles.aiOptInBtn}
                accessibilityRole="button"
                accessibilityLabel="Improve this prompt with AI"
              >
                <Wand2 size={14} color={color.signal} />
                <Text style={styles.aiOptInText}>Improve with AI</Text>
              </Pressable>
            )
          ) : null}
        </View>
      ) : null}

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

// The model sometimes returns a raw camelCase actionType (e.g. "explore") as
// the chip's `label` instead of a human-readable string — this canonical map
// is the source of truth for chip text so a raw key never reaches the UI.
// Keys must mirror the backend's ALLOWED_QUICK_ACTION_TYPES.
const ACTION_LABELS: Record<string, string> = {
  addTrip:        'Add to Trip',
  buildItinerary: 'Build Itinerary',
  askCommunity:   'Ask Community',
  explore:        'Explore Area',
  viewEvent:      'View Event',
  viewPlace:      'View Place',
  startPoll:      'Start Poll',
  shareTip:       'Share Tip',
  openMap:        'Open Map',
  viewPassport:   'View Passport',
  findBuddy:      'Find Buddy',
  viewTrips:      'View Trips',
};

/** A raw actionType key looks like "openMap"/"view_place" — never contains a
 *  space — while a genuine human label always does (or is a single common
 *  word we already know isn't one of our keys). Used only as a last-resort
 *  guard for actionTypes not yet in ACTION_LABELS. */
function isLikelyRawActionKey(label: string, actionType: string): boolean {
  return label === actionType;
}

function displayLabelFor(actionType: string, label: string): string {
  if (ACTION_LABELS[actionType]) return ACTION_LABELS[actionType];
  if (isLikelyRawActionKey(label, actionType)) {
    // Fall back to a readable form of the key itself rather than showing it raw.
    return actionType.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  }
  return label;
}

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
              <Text style={styles.actionText}>{displayLabelFor(a.actionType, a.label)}</Text>
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
  retryButton:     { alignSelf: 'flex-start', marginTop: space.md, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: color.ink },
  retryButtonText: { ...t.small, fontWeight: '700', color: color.onInk },
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
  assistBar:     { paddingHorizontal: space.md, paddingTop: space.sm, gap: space.sm, backgroundColor: color.paper },
  aiZone:        { gap: space.xs },
  assistNote:    { ...t.small, color: color.mute, paddingHorizontal: space.sm },
  assistToggleOff: { ...t.small, color: color.faint, paddingHorizontal: space.sm },
  aiOptInBtn:    { flexDirection: 'row', alignSelf: 'flex-start', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  aiOptInText:   { ...t.small, fontWeight: '700', color: color.signal },
  inputBar:      { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderTopWidth: 1, borderTopColor: color.haze, backgroundColor: color.paper },
  input:         { flex: 1, ...t.body, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.md },
  sendBtn:       { width: avatar.s44, height: avatar.s44, borderRadius: avatar.s44 / 2, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.45 },
  layoverBtn:    { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, backgroundColor: '#1565C0', alignItems: 'center', justifyContent: 'center' },
});
