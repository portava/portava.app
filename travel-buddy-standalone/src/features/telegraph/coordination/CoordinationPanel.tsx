/**
 * Telegraph §2.2's "OPTIONAL COORDINATION PANEL" and §9's coordination mode.
 *
 *   §2.2  HEADER / SHARED CONTEXT RAIL / OPTIONAL COORDINATION PANEL
 *          (meeting point · ETA · arrivals · return state) / MESSAGE STREAM
 *   §9    "When a shared plan approaches its leave-by/start window, the thread
 *          can TEMPORARILY transform from normal conversation into a
 *          coordination surface."
 *   §9.1  the seven quick states, and the rule that a user-declared status
 *          must stay distinguishable from a system-derived estimate.
 *
 * TEMPORARILY is enforced by the server: the panel renders only while
 * `coordinating` is true, which excludes PREPARING. A plan three days out does
 * not turn a conversation into a coordination surface.
 *
 * §9.1's rule is enforced by LAYOUT, not only by a field name: the DERIVED
 * state is the panel's title line and is labelled "derived from the plan";
 * every declared status sits under "What people said", carries the person and
 * the time they said it, and the two are never in the same row.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import {
  STATE_AFFORDANCES,
  coordinationStateLabel,
  fetchCoordination,
  postQuickState,
  postVote,
  quickStateLabel,
  type CoordinationResponse,
  type QuickState,
} from './coordinationApi.ts';
import { sendTypedMessage } from '../kinds/kindsApi.ts';

export interface CoordinationPanelProps {
  threadId: string;
  /** Test seam: render this instead of fetching. */
  initialResponse?: CoordinationResponse | null;
  onChanged?: () => void;
}

export function CoordinationPanel({ threadId, initialResponse = null, onChanged }: CoordinationPanelProps) {
  const palette = useTelegraphPalette();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const [data, setData] = useState<CoordinationResponse | null>(initialResponse);
  const [loading, setLoading] = useState(initialResponse === null);
  const [failed, setFailed] = useState(false);
  // §30A.5 / §19 — composing a crew-wide notice.
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [noticeTitle, setNoticeTitle] = useState('');
  const [noticeNeedsAck, setNoticeNeedsAck] = useState(true);
  const [noticeError, setNoticeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetchCoordination(threadId);
    if (r.ok) {
      setData(r.data);
      setFailed(false);
    } else {
      setFailed(true);
    }
    setLoading(false);
  }, [threadId]);

  useEffect(() => {
    if (initialResponse !== null) return;
    void load();
  }, [initialResponse, load]);

  const declare = useCallback(
    async (state: QuickState) => {
      const r = await postQuickState(threadId, state);
      if (r.ok) {
        onChanged?.();
        if (initialResponse === null) void load();
      }
    },
    [threadId, onChanged, load, initialResponse],
  );

  const vote = useCallback(
    async (decisionId: string, optionId: string) => {
      const r = await postVote(threadId, decisionId, optionId);
      if (r.ok) {
        onChanged?.();
        if (initialResponse === null) void load();
      }
    },
    [threadId, onChanged, load, initialResponse],
  );

  /**
   * §30A.5's ANNOUNCEMENT, given a producer.
   *
   * The kind, its schema, its renderer and (since §19's acknowledgement) its
   * write-back all existed before this control did — and NOTHING IN THE APP
   * COULD SEND ONE. §6.1's composer menu is the spec's eight entries and
   * ANNOUNCEMENT is not among them, so the whole chain was reachable only by
   * calling the API by hand. A crew-wide notice belongs where the crew is
   * coordinating, which is this panel.
   */
  const postNotice = useCallback(async () => {
    const title = noticeTitle.trim();
    if (title.length === 0) {
      setNoticeError('A notice needs something to say.');
      return;
    }
    const r = await sendTypedMessage(threadId, 'ANNOUNCEMENT', {
      title,
      requiresAcknowledgement: noticeNeedsAck,
    });
    if (!r.ok) {
      setNoticeError(r.message ?? r.error);
      return;
    }
    setNoticeError(null);
    setNoticeTitle('');
    setNoticeOpen(false);
    onChanged?.();
    if (initialResponse === null) void load();
  }, [threadId, noticeTitle, noticeNeedsAck, onChanged, load, initialResponse]);

  if (loading && !data) {
    return (
      <View style={styles.loading} accessibilityLabel="Loading coordination">
        <ActivityIndicator size="small" color={palette.operational} />
      </View>
    );
  }
  // A failed read renders nothing: an empty coordination panel would say "the
  // plan is not happening", which is a different and wrong statement.
  if (failed || !data) return null;

  const c = data.coordination;
  const openDecisions = c.decisions.filter((d) => !d.resolved);
  const hasDecisionsOrCommitments = openDecisions.length > 0 || c.commitments.length > 0;

  // §9: only while the thread is actually coordinating — or when there is an
  // unresolved decision or commitment, which is §2.3's PLAN layer and belongs
  // above the stream whatever the clock says.
  if (!c.coordinating && !hasDecisionsOrCommitments) return null;

  const affordances = c.state ? STATE_AFFORDANCES[c.state] : [];

  return (
    <View style={styles.wrap} testID="telegraph-coordination-panel">
      {c.coordinating ? (
        <View style={styles.headerRow}>
          <Text style={styles.state} testID="telegraph-coordination-state">
            {coordinationStateLabel(c.state)}
          </Text>
          {/* §9.1: this line is DERIVED. It says so. */}
          <Text style={styles.derived}>derived from the plan</Text>
        </View>
      ) : null}

      {c.plan && c.coordinating ? (
        <Text style={styles.planTitle} numberOfLines={1}>
          {c.plan.title}
        </Text>
      ) : null}

      {c.coordinating ? (
        <Text style={styles.counts} testID="telegraph-coordination-counts">
          {c.arrivedCount} arrived · {c.onMyWayCount} on the way
        </Text>
      ) : null}

      {affordances.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          {affordances.map((s) => (
            <Pressable
              key={s}
              testID={`telegraph-quick-state-${s}`}
              accessibilityRole="button"
              accessibilityLabel={quickStateLabel(s)}
              onPress={() => void declare(s)}
              style={[styles.chip, s === 'NEED_HELP' ? styles.chipAttention : null]}
            >
              <Text style={[styles.chipText, s === 'NEED_HELP' ? styles.chipTextAttention : null]}>
                {quickStateLabel(s)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {c.quickStates.length > 0 ? (
        <View testID="telegraph-coordination-declared">
          <Text style={styles.sectionLabel}>What people said</Text>
          {c.quickStates.slice(0, 5).map((q) => (
            <Text key={`${q.userId}-${q.at}`} style={styles.declaredRow} numberOfLines={1}>
              {quickStateLabel(q.state)}
              {q.approximateLabel ? ` · ${q.approximateLabel}` : ''}
            </Text>
          ))}
        </View>
      ) : null}

      {/*
        §30A.5 — the announcement composer. It sits under the declared statuses
        because a notice is an operational change, not a status, and §19 keeps
        acknowledgement distinct from Seen.
      */}
      <View testID="telegraph-announcement-composer">
        {noticeOpen ? (
          <View>
            <TextInput
              testID="telegraph-announcement-title"
              accessibilityLabel="Announcement"
              placeholder="Tell the crew something"
              placeholderTextColor={palette.mute}
              value={noticeTitle}
              onChangeText={setNoticeTitle}
              style={styles.noticeInput}
              maxLength={200}
            />
            <Pressable
              testID="telegraph-announcement-ack-toggle"
              accessibilityRole="switch"
              accessibilityState={{ checked: noticeNeedsAck }}
              accessibilityLabel="Ask people to confirm they saw it"
              onPress={() => setNoticeNeedsAck((v) => !v)}
              style={styles.chip}
            >
              <Text style={styles.chipText}>
                {noticeNeedsAck ? 'Asking for confirmation' : 'No confirmation asked'}
              </Text>
            </Pressable>
            <Pressable
              testID="telegraph-announcement-send"
              accessibilityRole="button"
              accessibilityLabel="Post announcement"
              onPress={() => void postNotice()}
              style={styles.chip}
            >
              <Text style={styles.chipText}>Post</Text>
            </Pressable>
            {noticeError ? (
              <Text style={styles.meta} testID="telegraph-announcement-error">
                {noticeError}
              </Text>
            ) : null}
          </View>
        ) : (
          <Pressable
            testID="telegraph-announcement-open"
            accessibilityRole="button"
            accessibilityLabel="Post an announcement"
            onPress={() => setNoticeOpen(true)}
            style={styles.chip}
          >
            <Text style={styles.chipText}>Post an announcement</Text>
          </Pressable>
        )}
      </View>

      {c.rendezvous.length > 0 ? (
        <View testID="telegraph-coordination-rendezvous">
          <Text style={styles.sectionLabel}>Meeting point</Text>
          <Text style={styles.declaredRow} numberOfLines={2}>
            {c.rendezvous[0]!.payload?.checkpoint}
            {c.rendezvous[0]!.payload?.landmark ? ` — ${c.rendezvous[0]!.payload.landmark}` : ''}
          </Text>
          {c.rendezvous[0]!.payload?.fallbackPoint ? (
            <Text style={styles.meta} numberOfLines={1}>
              Fallback: {c.rendezvous[0]!.payload.fallbackPoint}
            </Text>
          ) : null}
        </View>
      ) : null}

      {openDecisions.map((d) => (
        <View key={d.decisionId} style={styles.decision} testID={`telegraph-decision-${d.decisionId}`}>
          <Text style={styles.sectionLabel}>Undecided</Text>
          <Text style={styles.planTitle} numberOfLines={2}>
            {d.question}
          </Text>
          <View style={styles.chipRow}>
            {d.options.map((o) => (
              <Pressable
                key={o.id}
                testID={`telegraph-decision-option-${d.decisionId}-${o.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${o.label}, ${d.tally[o.id] ?? 0} votes`}
                onPress={() => void vote(d.decisionId, o.id)}
                style={styles.chip}
              >
                <Text style={styles.chipText}>
                  {o.label} · {d.tally[o.id] ?? 0}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}

      {c.commitments.map((cm) => (
        <View key={cm.commitmentId} testID={`telegraph-commitment-${cm.commitmentId}`}>
          <Text style={styles.sectionLabel}>{cm.completedBy ? 'Done' : cm.overdue ? 'Overdue' : 'Agreed'}</Text>
          <Text style={styles.declaredRow} numberOfLines={2}>
            {cm.what}
          </Text>
        </View>
      ))}
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
    loading: { paddingVertical: space.md, alignItems: 'center' },
    headerRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
    state: { ...t.body, color: p.operational, fontWeight: '800', letterSpacing: 0.3 },
    derived: { ...t.small, color: p.mute },
    planTitle: { ...t.body, color: p.recvText, fontWeight: '700' },
    counts: { ...t.small, color: p.mute },
    sectionLabel: { ...t.small, color: p.mute, letterSpacing: 0.4, marginTop: 4 },
    declaredRow: { ...t.small, color: p.recvText },
    meta: { ...t.small, color: p.mute },
    chipRow: { flexDirection: 'row', gap: 6, paddingVertical: 2, flexWrap: 'wrap' },
    chip: {
      paddingHorizontal: space.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: p.chipFill,
    },
    // §11.1: the attention colour is RESERVED for safety. Need help is safety.
    chipAttention: { backgroundColor: p.attention },
    chipText: { ...t.small, color: p.recvText },
    chipTextAttention: { color: p.attentionOn, fontWeight: '700' },
    decision: { gap: 4 },
    noticeInput: {
      ...t.small,
      color: p.recvText,
      backgroundColor: p.chipFill,
      borderRadius: radius.md,
      paddingHorizontal: space.md,
      paddingVertical: 8,
      marginBottom: 6,
    },
  });
}

export default CoordinationPanel;
