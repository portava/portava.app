/**
 * Telegraph §2.3 — the PLAN and NOW layers, DRAWN (census T11, T12).
 *
 *   TALK  "Normal conversation and expressive content."
 *   PLAN  "Plans, decisions, shared places, attendance, invitations and
 *          unresolved actions."
 *   NOW   "Active coordination: on the way, arrived, meet here, live location
 *          scope, safety and return."
 *
 * The server partitions the thread (`GET /threads/:id/layers`); this strip
 * draws PLAN and NOW above the conversation and hands the screen the ids it
 * drew, which the screen takes out of the stream — so an unresolved action is
 * SEPARATED from conversation, and while a thread is coordinating the stream
 * is genuinely shorter. A PLAN item leaves the strip and returns to the stream
 * once it is resolved; a NOW item does so once it is no longer current (the
 * server's time bound), so an old SAFETY message is never taken out of the
 * conversation.
 *
 * How each item is drawn:
 *   - a §6.2 typed message (SAFETY, LOCATION, ACTION, ANNOUNCEMENT) through the
 *     same TypedMessageRenderer the stream uses — and here its controls WORK:
 *     ACTION's Confirm / Decline answer it (ACTION_RESPONSE), ANNOUNCEMENT's
 *     "Got it" acknowledges it;
 *   - a coordination message (quick state, rendezvous, action proposal) as one
 *     line naming why it is here, with Confirm / Decline on a proposal;
 *   - an open DECISION or COMMITMENT is drawn by the coordination panel above,
 *     with its vote chips, and not twice — but ONLY while the panel says it is
 *     drawing it (`panelDrawnIds`). One the panel is not drawing (its read has
 *     not caught up with a decision posted a moment ago, or failed) is drawn
 *     here as one line: every id this strip takes out of the stream is drawn
 *     somewhere (re-verification R1).
 *
 * A SAFETY item names its sender with what the stream already carries for
 * that sender — their name and handle, or "You" — because the stream is where
 * a group conversation says who sent a message, and the item has left it
 * (re-verification R2). Nothing is looked up.
 *
 * A failed layers read draws nothing and hides nothing.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { TypedMessageRenderer, rendersTypedKind } from '../kinds/TypedMessageRenderer.tsx';
import { acknowledgeAnnouncement, respondToAction } from '../coordination/coordinationApi.ts';
import {
  PANEL_DRAWN_KINDS,
  fetchLayers,
  layeredStreamIds,
  type LayerItemView,
  type LayersResponse,
} from './layersApi.ts';

export interface LayerMessage {
  id: string;
  senderId: string;
  msgType?: string | null;
  body?: string | null;
  /** What the stream shows for the sender (§2.3 NOW safety items). Never fetched here. */
  senderName?: string | null;
  senderHandle?: string | null;
}

/**
 * Who sent it, as the conversation stream shows that sender: "You" for the
 * viewer, otherwise the name (and @handle) a loaded message from them carries.
 * Null when no loaded message names them — the caller says "Someone" rather
 * than inventing a name or showing an id.
 */
export function senderLabelFor(
  messages: readonly LayerMessage[],
  senderId: string | null | undefined,
  viewerId: string | null,
): string | null {
  if (!senderId) return null;
  if (viewerId !== null && senderId === viewerId) return 'You';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.senderId === senderId && m.senderName) return m.senderHandle ? `${m.senderName} @${m.senderHandle}` : m.senderName;
  }
  return null;
}

export interface SemanticLayersStripProps {
  threadId: string;
  viewerId: string | null;
  /** The messages loaded on this screen. Only these can leave the stream. */
  messages: readonly LayerMessage[];
  /** Changes when the conversation changes; a change re-reads the layers. */
  refreshKey?: string | null;
  dataSaver?: boolean;
  /** Told the ids drawn here, which the screen removes from the stream. */
  onLayeredIdsChange?: (ids: ReadonlySet<string>) => void;
  /**
   * The DECISION / COMMITMENT message ids the coordination panel is drawing
   * right now. Those are not drawn twice; any other PLAN item this strip takes
   * out of the stream is drawn here. Absent → the strip draws them all.
   */
  panelDrawnIds?: ReadonlySet<string> | null;
  /** Test seam: render this instead of fetching. */
  initialResponse?: LayersResponse | null;
}

const OPEN_WORDS: Record<string, string> = {
  action_unanswered: 'Waiting for an answer',
  acknowledgement_pending: 'Please acknowledge',
  decision_open: 'Undecided',
  commitment_open: 'Agreed, not done yet',
};
const NOW_WORDS: Record<string, string> = {
  declared_status: 'Status',
  rendezvous: 'Meet here',
  location_scope: 'Location',
  safety: 'Safety',
};

export function SemanticLayersStrip({
  threadId,
  viewerId,
  messages,
  refreshKey = null,
  dataSaver = false,
  onLayeredIdsChange,
  panelDrawnIds = null,
  initialResponse = null,
}: SemanticLayersStripProps) {
  const palette = useTelegraphPalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [layers, setLayers] = useState<LayersResponse | null>(initialResponse);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    const r = await fetchLayers(threadId);
    if (mine !== generation.current) return;
    // A failed read draws nothing and hides nothing — never a stale partition.
    setLayers(r.ok ? r.data : null);
  }, [threadId]);

  useEffect(() => {
    if (initialResponse !== null) return;
    void load();
  }, [initialResponse, load, refreshKey]);

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const layered = useMemo(() => layeredStreamIds(layers, new Set(byId.keys())), [layers, byId]);
  const layeredKey = [...layered].sort().join(',');
  const notifyRef = useRef(onLayeredIdsChange);
  useEffect(() => {
    notifyRef.current = onLayeredIdsChange;
  });
  useEffect(() => {
    // Keyed on the ids, not the Set's identity, so a re-render does not re-tell.
    notifyRef.current?.(new Set(layeredKey ? layeredKey.split(',') : []));
  }, [layeredKey]);

  const answer = useCallback(
    async (messageId: string, response: 'CONFIRMED' | 'DECLINED') => {
      const r = await respondToAction(threadId, messageId, response);
      if (!r.ok) { setError(r.message ?? 'Your answer was not saved.'); return; }
      setError(null);
      if (initialResponse === null) void load();
    },
    [threadId, initialResponse, load],
  );
  const acknowledge = useCallback(
    async (messageId: string) => {
      const r = await acknowledgeAnnouncement(threadId, messageId);
      if (!r.ok) { setError(r.message ?? 'Your acknowledgement was not saved.'); return; }
      setError(null);
      if (initialResponse === null) void load();
    },
    [threadId, initialResponse, load],
  );

  if (!layers) return null;
  // Not twice — and never nowhere: only what the panel is drawing NOW is left to it.
  const plan = layers.plan.filter((i) => !(PANEL_DRAWN_KINDS.includes(i.kind) && panelDrawnIds?.has(i.messageId) === true));
  const now = layers.now;
  if (plan.length === 0 && now.length === 0) return null;

  const draw = (item: LayerItemView) => {
    const m = byId.get(item.messageId);
    const mine = viewerId !== null && item.senderId === viewerId;
    // R2: a safety item says WHO — the stream it left is where that was said.
    const sender = item.nowReason === 'safety' ? (
      <Text style={styles.sender} testID={`telegraph-layer-sender-${item.messageId}`}>
        {senderLabelFor(messages, item.senderId, viewerId) ?? 'Someone'}
      </Text>
    ) : null;
    if (m && rendersTypedKind(m.msgType ?? null)) {
      return (
        <View key={item.messageId} testID={`telegraph-layer-item-${item.messageId}`}>
          {sender}
          <TypedMessageRenderer
            msgType={m.msgType ?? null}
            body={m.body ?? null}
            mine={mine}
            dataSaver={dataSaver}
            onPressAction={item.openReason === 'action_unanswered' && !mine ? () => void answer(item.messageId, 'CONFIRMED') : undefined}
            onAcknowledge={item.openReason === 'acknowledgement_pending' ? () => void acknowledge(item.messageId) : undefined}
          />
          {item.openReason === 'action_unanswered' && !mine ? (
            <Pressable
              testID={`telegraph-layer-decline-${item.messageId}`}
              accessibilityRole="button"
              accessibilityLabel="Decline"
              onPress={() => void answer(item.messageId, 'DECLINED')}
              style={styles.chip}
            >
              <Text style={styles.chipText}>Decline</Text>
            </Pressable>
          ) : null}
        </View>
      );
    }
    const word = item.layer === 'PLAN' ? OPEN_WORDS[item.openReason ?? ''] : NOW_WORDS[item.nowReason ?? ''];
    return (
      <View key={item.messageId} style={styles.row} testID={`telegraph-layer-item-${item.messageId}`}>
        {sender}
        <Text style={styles.word}>{word ?? item.kind}</Text>
        <Text style={styles.title} numberOfLines={1}>{item.title ?? ''}</Text>
        {item.kind === 'ACTION_PROPOSAL' && item.openReason === 'action_unanswered' && !mine ? (
          <View style={styles.chips}>
            <Pressable testID={`telegraph-layer-confirm-${item.messageId}`} accessibilityRole="button" accessibilityLabel="Confirm" onPress={() => void answer(item.messageId, 'CONFIRMED')} style={styles.chip}>
              <Text style={styles.chipText}>Confirm</Text>
            </Pressable>
            <Pressable testID={`telegraph-layer-decline-${item.messageId}`} accessibilityRole="button" accessibilityLabel="Decline" onPress={() => void answer(item.messageId, 'DECLINED')} style={styles.chip}>
              <Text style={styles.chipText}>Decline</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.wrap} testID="telegraph-semantic-layers">
      {now.length > 0 ? (
        <View testID="telegraph-layer-now">
          <Text style={styles.label}>NOW</Text>
          {now.map(draw)}
        </View>
      ) : null}
      {plan.length > 0 ? (
        <View testID="telegraph-layer-plan">
          <Text style={styles.label}>OPEN</Text>
          {plan.map(draw)}
        </View>
      ) : null}
      {error ? <Text style={styles.error} testID="telegraph-layer-error">{error}</Text> : null}
    </View>
  );
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    wrap: {
      backgroundColor: p.surfaceRaised,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: p.hairline,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
      gap: 6,
    },
    label: { ...t.small, color: p.mute, letterSpacing: 0.6, fontWeight: '700' },
    row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
    word: { ...t.small, color: p.operational, fontWeight: '700' },
    sender: { ...t.small, color: p.recvText, fontWeight: '700' },
    title: { ...t.small, color: p.recvText, flexShrink: 1 },
    chips: { flexDirection: 'row', gap: 6 },
    chip: { paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: p.chipFill, alignSelf: 'flex-start' },
    chipText: { ...t.small, color: p.recvText },
    error: { ...t.small, color: p.mute },
  });
}

export default SemanticLayersStrip;
