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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { openMapsNavigation } from '../../../lib/maps.ts';
import { SafeReturnSetupSheet } from '../../../components/safeReturn/SafeReturnSetupSheet.tsx';
import {
  proposeSharedRide,
  respondToAction,
  type CloseoutView,
  type SharedRideView,
} from './coordinationApi.ts';

/**
 * §9's per-state cells, drawn (census T6, T106, T107, T108).
 *
 *   Active     NEXT STEP — one line, the server's derived reading, labelled so;
 *              optional LOCATION SCOPE — a scoped LOCATION share, opened only
 *              where the screen can open the location sheet.
 *   Returning  SAFE RETURN — the existing setup sheet, offered where the crew
 *              is heading back; SHARED TRANSPORT — a SPLIT_RIDE proposal people
 *              join or leave.
 *   Complete   CLOSEOUT — a short-lived card with EXPLICIT options. Showing it
 *              creates nothing; "Done" puts it away for this plan.
 *   §8.1       NAVIGATION — "Directions" on a meeting point hands off to the
 *              device's maps app. It reads no position and declares no status:
 *              starting navigation is not "on my way" (§9.1 keeps declared and
 *              derived apart), so nothing is posted.
 *
 * A control appears only where its action can complete: a callback the screen
 * did not pass draws nothing, the rule §19 set for the announcement button.
 */
export function closeoutDismissKey(threadId: string, planObjectId: string): string {
  return `telegraph.closeout.dismissed.${threadId}.${planObjectId}`;
}

/** The query a maps app is handed for a meeting point: the checkpoint, then the landmark. */
export function rendezvousDestination(payload: unknown): { name: string; city: string | null } | null {
  const p = payload !== null && typeof payload === 'object' ? (payload as { checkpoint?: unknown; landmark?: unknown }) : null;
  const checkpoint = typeof p?.checkpoint === 'string' ? p.checkpoint.trim() : '';
  if (!checkpoint) return null;
  const landmark = typeof p?.landmark === 'string' && p.landmark.trim() ? p.landmark.trim() : null;
  return { name: checkpoint, city: landmark };
}

export interface CoordinationPanelProps {
  threadId: string;
  /** Test seam: render this instead of fetching. */
  initialResponse?: CoordinationResponse | null;
  onChanged?: () => void;
  /** The signed-in viewer, so a shared ride can say "you're in". Absent → no join control. */
  viewerId?: string | null;
  /** Opens the §10.3 recap sheet. Absent → the closeout offers no recap button. */
  onOpenRecap?: () => void;
  /** Opens the screen's LOCATION share sheet. Absent → no location-scope control. */
  onShareLocation?: () => void;
}

export function CoordinationPanel({
  threadId,
  initialResponse = null,
  onChanged,
  viewerId = null,
  onOpenRecap,
  onShareLocation,
}: CoordinationPanelProps) {
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
  // §9 Returning / Complete.
  const [safeReturnOpen, setSafeReturnOpen] = useState(false);
  const [rideError, setRideError] = useState<string | null>(null);
  const [rideBusy, setRideBusy] = useState(false);
  // null = not yet known; a closeout is not drawn until we know it was not put away.
  const [closeoutDismissed, setCloseoutDismissed] = useState<boolean | null>(null);

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

  const closeoutPlanId = data?.coordination.closeout?.planObjectId ?? null;
  useEffect(() => {
    if (!closeoutPlanId) return;
    let cancelled = false;
    setCloseoutDismissed(null);
    void (async () => {
      let dismissed = false;
      try {
        dismissed = (await AsyncStorage.getItem(closeoutDismissKey(threadId, closeoutPlanId))) === '1';
      } catch {
        // Unreadable storage: show the closeout. Showing an explicit-choice
        // card once more is the recoverable direction; hiding it is not.
      }
      if (!cancelled) setCloseoutDismissed(dismissed);
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, closeoutPlanId]);

  const dismissCloseout = useCallback(async () => {
    setCloseoutDismissed(true);
    if (!closeoutPlanId) return;
    try {
      await AsyncStorage.setItem(closeoutDismissKey(threadId, closeoutPlanId), '1');
    } catch {
      // Put away for this session only.
    }
  }, [threadId, closeoutPlanId]);

  const proposeRide = useCallback(async () => {
    setRideBusy(true);
    const r = await proposeSharedRide(threadId, 'Share a ride back');
    setRideBusy(false);
    if (!r.ok) {
      setRideError(r.message ?? 'The ride could not be proposed.');
      return;
    }
    setRideError(null);
    onChanged?.();
    if (initialResponse === null) void load();
  }, [threadId, onChanged, load, initialResponse]);

  const answerRide = useCallback(
    async (ride: SharedRideView, response: 'CONFIRMED' | 'DECLINED') => {
      setRideBusy(true);
      const r = await respondToAction(threadId, ride.proposalId, response);
      setRideBusy(false);
      if (!r.ok) {
        setRideError(r.message ?? 'Your answer was not saved.');
        return;
      }
      setRideError(null);
      onChanged?.();
      if (initialResponse === null) void load();
    },
    [threadId, onChanged, load, initialResponse],
  );

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

  // §9 Complete: the closeout. Only while the server offers one (a short
  // window after the plan completes) and only once we know this viewer has not
  // put it away — `closeoutDismissed === null` draws nothing yet.
  const closeout: CloseoutView | null = c.closeout ?? null;
  const closeoutVisible = !c.coordinating && closeout !== null && closeoutDismissed === false;

  // §9: only while the thread is actually coordinating — or when there is an
  // unresolved decision or commitment, which is §2.3's PLAN layer and belongs
  // above the stream whatever the clock says.
  // The closeout is drawn whenever the server offers one — also in a thread that
  // still holds a commitment or an open decision, which are exactly the threads
  // that coordinated (verifier F2: it used to be drawn only when there were none).
  const closeoutCard = closeoutVisible && closeout ? (
        <View style={styles.wrap} testID="telegraph-closeout">
          <Text style={styles.state}>Plan complete</Text>
          <Text style={styles.planTitle} numberOfLines={1}>
            {closeout.title}
          </Text>
          {closeout.arrivedCount > 0 ? (
            <Text style={styles.counts} testID="telegraph-closeout-arrived">
              {closeout.arrivedCount} said they arrived
            </Text>
          ) : null}
          <View style={styles.chipRow}>
            {onOpenRecap && closeout.options.includes('CREATE_RECAP') ? (
              <Pressable
                testID="telegraph-closeout-recap"
                accessibilityRole="button"
                accessibilityLabel="Create a recap"
                onPress={onOpenRecap}
                style={styles.chip}
              >
                <Text style={styles.chipText}>Create a recap</Text>
              </Pressable>
            ) : null}
            <Pressable
              testID="telegraph-closeout-done"
              accessibilityRole="button"
              accessibilityLabel="Done"
              onPress={() => void dismissCloseout()}
              style={styles.chip}
            >
              <Text style={styles.chipText}>Done</Text>
            </Pressable>
          </View>
          {closeout.options.includes('SAVE_TO_MEMORY') ? (
            <Text style={styles.meta} testID="telegraph-closeout-memory-hint">
              Nothing is saved unless you choose it. To keep a message or photo, long-press it and choose Save to Memory.
            </Text>
          ) : null}
        </View>
  ) : null;

  if (!c.coordinating && !hasDecisionsOrCommitments) return closeoutCard;

  const affordances = c.state ? STATE_AFFORDANCES[c.state] : [];

  return (
    <>
    {closeoutCard}
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

      {c.coordinating && c.nextStep ? (
        <View style={styles.headerRow} testID="telegraph-coordination-next-step">
          <Text style={styles.declaredRow} numberOfLines={2}>
            Next: {c.nextStep.label}
          </Text>
          {/* §9.1: a next step is the system's reading of the thread. It says so. */}
          <Text style={styles.derived}>suggested</Text>
        </View>
      ) : null}

      {c.coordinating && onShareLocation && c.state !== 'RETURNING' ? (
        <Pressable
          testID="telegraph-coordination-share-location"
          accessibilityRole="button"
          accessibilityLabel="Share your location with this conversation for a limited time"
          onPress={onShareLocation}
          style={styles.chip}
        >
          <Text style={styles.chipText}>Share my location</Text>
        </Pressable>
      ) : null}

      {c.state === 'RETURNING' ? (
        <View testID="telegraph-coordination-returning">
          <Text style={styles.sectionLabel}>Getting back</Text>
          <View style={styles.chipRow}>
            <Pressable
              testID="telegraph-coordination-safe-return"
              accessibilityRole="button"
              accessibilityLabel="Set up Safe Return"
              onPress={() => setSafeReturnOpen(true)}
              style={styles.chip}
            >
              <Text style={styles.chipText}>Set up Safe Return</Text>
            </Pressable>
            <Pressable
              testID="telegraph-coordination-propose-ride"
              accessibilityRole="button"
              accessibilityLabel="Propose sharing a ride back"
              disabled={rideBusy}
              onPress={() => void proposeRide()}
              style={styles.chip}
            >
              <Text style={styles.chipText}>Share a ride back</Text>
            </Pressable>
          </View>
          {(c.sharedRides ?? []).map((ride) => {
            const riding = viewerId ? ride.riders.includes(viewerId) : null;
            return (
              <View key={ride.proposalId} testID={`telegraph-shared-ride-${ride.proposalId}`}>
                <Text style={styles.declaredRow} numberOfLines={1}>
                  {ride.title} · {ride.riders.length} riding
                </Text>
                {!ride.rosterChecked ? (
                  <Text style={styles.meta}>Who is still in this conversation could not be checked.</Text>
                ) : null}
                {riding !== null && viewerId !== ride.proposedBy ? (
                  <Pressable
                    testID={`telegraph-shared-ride-answer-${ride.proposalId}`}
                    accessibilityRole="button"
                    accessibilityLabel={riding ? 'Leave this ride' : 'Join this ride'}
                    disabled={rideBusy}
                    onPress={() => void answerRide(ride, riding ? 'DECLINED' : 'CONFIRMED')}
                    style={styles.chip}
                  >
                    <Text style={styles.chipText}>{riding ? "You're in · Leave" : 'Join'}</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          {rideError ? (
            <Text style={styles.meta} testID="telegraph-shared-ride-error">
              {rideError}
            </Text>
          ) : null}
          <SafeReturnSetupSheet
            visible={safeReturnOpen}
            onClose={() => setSafeReturnOpen(false)}
            onStarted={() => setSafeReturnOpen(false)}
            suggestionReason={c.plan ? `Heading back from ${c.plan.title}.` : 'Heading back.'}
          />
        </View>
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
          {rendezvousDestination(c.rendezvous[0]!.payload) ? (
            <Pressable
              testID="telegraph-rendezvous-directions"
              accessibilityRole="button"
              accessibilityLabel={`Directions to ${c.rendezvous[0]!.payload.checkpoint}`}
              onPress={() => openMapsNavigation(rendezvousDestination(c.rendezvous[0]!.payload)!)}
              style={styles.chip}
            >
              <Text style={styles.chipText}>Directions</Text>
            </Pressable>
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
    </>
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
