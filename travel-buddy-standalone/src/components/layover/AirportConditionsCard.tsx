/**
 * AirportConditionsCard — §10 traveller observations, on the layover dashboard.
 *
 * Census-layover L82 ("Traveler observation — checkpoint timing, queue report,
 * closure; confidence-weighted") has read, every pass: "The class exists and is
 * confidence-weighted the way the spec asks (trust × decay), with a
 * corroboration floor above it. There is NO SUBMISSION SURFACE — no route, no
 * screen, nothing a traveller can report from." This is the screen half of that
 * surface; `GET/POST /api/airport/sessions/:id/observations` is the other.
 *
 * ── THIS CARD RE-DERIVES NOTHING ─────────────────────────────────────────────
 * Every number, every confidence and the decision to show a reading AT ALL come
 * from the server's `TruthValue`. There is no client-side threshold here, and
 * that is deliberate: `LayoverReturnPanel.tsx` was deleted at `a718beb5` for
 * carrying its own `usableMinutes < 30 / < 60` rules that appeared nowhere on
 * the server (census L2, L6), and this file is not going to reintroduce the
 * pattern one card over.
 *
 * ── THE THREE STATES THAT ARE NOT THE SAME STATE ─────────────────────────────
 * This card distinguishes them because collapsing any two is the exact defect
 * census-layover has found four separate times on this domain (§21.4, §23.1:
 * "an unreadable block list was served as an empty city"):
 *
 *   loading            — we have not asked yet.
 *   unavailable        — we asked and the read FAILED. Retryable, and it says
 *                        so. NEVER rendered as "nothing reported".
 *   truth === null     — we asked, the read SUCCEEDED, and there is genuinely
 *                        no reading: nothing unexpired, or what exists sits
 *                        below the corroboration floor. Rendered as "No reading
 *                        yet", never as 0 minutes.
 *
 * ── WHY THE IDEMPOTENCY TOKEN LIVES IN A REF ─────────────────────────────────
 * Migration 2982 gives `airport_fact_observations` a unique `submission_token`
 * so a retried report is a no-op instead of a second row. That only works if
 * the RETRY carries the SAME token, so the token cannot be minted inside the
 * request — it is minted once per (fact, value) intent and held until that
 * intent succeeds. Pressing "20 min" twice after a failure retries one report;
 * pressing "20 min" then "30 min" is two reports, which is what the traveller
 * meant.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { Users, AlertTriangle, RefreshCw } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  getAirportObservations,
  submitAirportObservation,
  type AirportObservationsResult,
  type AirportObservedFact,
  type TravellerFactType,
} from '../../services/layover.ts';

/**
 * How each reportable fact is presented and what a traveller may say about it.
 *
 * The CHOICES are the whole editorial decision in this file. They are coarse on
 * purpose: a traveller standing in a queue knows "about twenty minutes", not
 * "nineteen", and a free-number field would collect a precision nobody has and
 * the reconciler would weight it as if they did. Every value sits inside the
 * server's PLAUSIBLE_RANGE for its fact type, so a press can never be refused
 * as implausible — the range exists to stop a hostile or broken producer, not
 * to scold someone using the buttons.
 */
const FACT_UI: Record<TravellerFactType, {
  title: string;
  blurb: string;
  unit: 'minutes' | 'state';
  choices: Array<{ label: string; value: number }>;
}> = {
  queue_report_minutes: {
    title: 'Queue right now',
    blurb: 'How long is the line you are standing in?',
    unit: 'minutes',
    choices: [
      { label: 'No queue', value: 0 },
      { label: '5 min', value: 5 },
      { label: '15 min', value: 15 },
      { label: '30 min', value: 30 },
      { label: '45 min', value: 45 },
      { label: '60 min+', value: 60 },
    ],
  },
  checkpoint_timing_minutes: {
    title: 'Time through the checkpoint',
    blurb: 'How long did security or immigration actually take you?',
    unit: 'minutes',
    choices: [
      { label: 'Under 5', value: 5 },
      { label: '10 min', value: 10 },
      { label: '20 min', value: 20 },
      { label: '40 min', value: 40 },
      { label: '60 min', value: 60 },
      { label: '90 min+', value: 90 },
    ],
  },
  closure_reported: {
    title: 'Something closed',
    blurb: 'Is a checkpoint, gate area or facility shut?',
    unit: 'state',
    choices: [
      { label: 'All open', value: 0 },
      { label: 'Something is closed', value: 1 },
    ],
  },
};

const FACT_ORDER: TravellerFactType[] = [
  'queue_report_minutes',
  'checkpoint_timing_minutes',
  'closure_reported',
];

function submissionToken(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${h().slice(1)}-${h()}${h()}${h()}`;
}

/** "3 min ago" / "just now". Freshness is the point of a live reading. */
function agoLabel(observedAt: string | null, nowMs: number): string | null {
  if (!observedAt) return null;
  const ms = Date.parse(observedAt);
  if (!Number.isFinite(ms)) return null;
  const mins = Math.floor((nowMs - ms) / 60000);
  if (mins <= 0) return 'just now';
  if (mins === 1) return '1 min ago';
  return `${mins} min ago`;
}

/**
 * The reading itself. `closure_reported` is an ordinal, not a duration, so it
 * is rendered as a state — printing "1 minutes" for a closed checkpoint would
 * be the unit error that makes a whole surface untrustworthy.
 */
function readingLabel(factType: TravellerFactType, value: number): string {
  if (factType === 'closure_reported') return value >= 1 ? 'A closure is reported' : 'Nothing reported closed';
  const rounded = Math.round(value);
  return rounded === 0 ? 'No queue' : `${rounded} min`;
}

interface Props {
  sessionId: string;
  /** Bumped by the parent on pull-to-refresh so this card reloads with it. */
  refreshKey?: number;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; data: AirportObservationsResult };

export function AirportConditionsCard({ sessionId, refreshKey = 0 }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tokens = useRef<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    const data = await getAirportObservations(sessionId);
    // `null` here is a FAILED READ, not an empty airport — see the header.
    setState(data ? { kind: 'ready', data } : { kind: 'unavailable' });
  }, [sessionId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const report = useCallback(async (factType: TravellerFactType, value: number) => {
    const key = `${factType}:${value}`;
    // Held across retries so migration 2982's unique index can recognise the
    // second press as the same report. Cleared only on success.
    let token = tokens.current.get(key);
    if (!token) { token = submissionToken(); tokens.current.set(key, token); }

    setBusy(key);
    setNotice(null);
    const outcome = await submitAirportObservation(sessionId, { factType, value, submissionToken: token });
    setBusy(null);

    if (!outcome.ok) { setNotice(outcome.message); return; }
    tokens.current.delete(key);
    setNotice(outcome.duplicate ? 'Already recorded — thank you.' : 'Thank you — your report is in.');
    // Re-read rather than patching local state from the response, so what the
    // card shows is what the server would serve on a fresh load. This is the
    // same thing a reload does, which is what makes the flow verifiable.
    await load();
  }, [sessionId, load]);

  if (state.kind === 'loading') {
    return (
      <View style={styles.card}>
        <Text style={styles.heading}>Live from the terminal</Text>
        <ActivityIndicator color={color.deep} style={{ marginTop: space.md }} />
      </View>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <View style={styles.card}>
        <Text style={styles.heading}>Live from the terminal</Text>
        {/* NOT "no reports". An outage is a thing we could not read, and saying
            otherwise would be a claim about the airport we have no basis for. */}
        <Text style={styles.body}>Reports for this airport could not be loaded.</Text>
        <Pressable
          onPress={() => { setState({ kind: 'loading' }); void load(); }}
          accessibilityRole="button"
          accessibilityLabel="Retry loading airport reports"
          style={styles.retry}
        >
          <RefreshCw size={13} color={color.deep} />
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const byType = new Map<string, AirportObservedFact>(state.data.facts.map((f) => [f.factType, f]));

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Live from the terminal</Text>
      <Text style={styles.subhead}>
        What other travellers are reporting at {state.data.airportRef}, and your chance to add to it.
      </Text>

      {FACT_ORDER.map((factType) => {
        const ui = FACT_UI[factType];
        const fact = byType.get(factType);
        const truth = fact?.truth ?? null;
        // Distinct community reporters behind the reading. Shown because the
        // corroboration floor is the reason a single report may not move the
        // number, and a traveller who reported something and saw nothing change
        // deserves to know why rather than assume it was dropped.
        const voices = fact?.corroboration?.community ?? 0;
        const ago = truth ? agoLabel(truth.observedAt, Date.now()) : null;

        return (
          <View key={factType} style={styles.block}>
            <Text style={styles.blockTitle}>{ui.title}</Text>

            {truth ? (
              <View style={styles.readingRow}>
                <Text style={styles.reading}>{readingLabel(factType, truth.value)}</Text>
                <View style={styles.metaRow}>
                  <Users size={11} color={color.mute} />
                  <Text style={styles.meta}>
                    {voices === 1 ? '1 traveller' : `${voices} travellers`}
                    {ago ? ` · ${ago}` : ''}
                    {` · ${truth.confidence.toLowerCase()} confidence`}
                  </Text>
                </View>
                {truth.conflict ? (
                  // §10.1 rule 1: a disagreement past tolerance is never
                  // averaged. The server took the CONSERVATIVE side; hiding the
                  // flag would present a contested number as a settled one.
                  <View style={styles.conflictRow}>
                    <AlertTriangle size={12} color={color.warn} />
                    <Text style={styles.conflictText}>
                      Reports disagree — the more cautious one is shown.
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : voices > 0 ? (
              // REPORTED BUT NOT YET PUBLISHED. `queue_report_minutes` and
              // `checkpoint_timing_minutes` are SAFETY_CRITICAL_FACTS, so a
              // community-only reading needs MIN_COMMUNITY_CORROBORATION (2)
              // distinct reporters before the server will stand behind a value
              // — "one stranger cannot move a deadline".
              //
              // Saying only "No reading yet" here would make a traveller who
              // just reported believe their report was dropped. It was not; it
              // is counted and waiting. This is the same distinction the card
              // draws between an outage and an empty airport, one level down.
              <Text style={styles.pending}>
                {voices === 1 ? '1 traveller has' : `${voices} travellers have`} reported —
                waiting for one more before we show a figure.
              </Text>
            ) : (
              <Text style={styles.noReading}>No reading yet.</Text>
            )}

            <Text style={styles.blurb}>{ui.blurb}</Text>
            <View style={styles.chips}>
              {ui.choices.map((choice) => {
                const key = `${factType}:${choice.value}`;
                const isBusy = busy === key;
                return (
                  <Pressable
                    key={choice.label}
                    onPress={() => { void report(factType, choice.value); }}
                    disabled={busy !== null}
                    accessibilityRole="button"
                    accessibilityLabel={`Report ${ui.title}: ${choice.label}`}
                    accessibilityState={{ disabled: busy !== null, busy: isBusy }}
                    style={[styles.chip, busy !== null && !isBusy ? styles.chipDim : null]}
                  >
                    {isBusy
                      ? <ActivityIndicator size="small" color={color.deep} />
                      : <Text style={styles.chipText}>{choice.label}</Text>}
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}

      {notice ? <Text style={styles.notice}>{notice}</Text> : null}

      <Text style={styles.footnote}>
        Reports are anonymous and expire on their own. We accept{' '}
        {state.data.rateLimit.maxPerWindow} of each kind every{' '}
        {state.data.rateLimit.windowMinutes} minutes.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.lg,
    gap: space.sm,
  },
  heading: { ...t.heading, color: color.ink },
  subhead: { ...t.small, color: color.mute },
  body: { ...t.small, color: color.ink, marginTop: space.xs },
  block: {
    borderTopWidth: 1,
    borderTopColor: color.haze,
    paddingTop: space.md,
    marginTop: space.xs,
    gap: space.xs,
  },
  blockTitle: { ...t.bodyStrong, color: color.ink },
  readingRow: { gap: 2 },
  reading: { ...t.title, color: color.deep },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  meta: { ...t.small, color: color.mute, fontSize: 12 },
  noReading: { ...t.body, color: color.faint },
  pending: { ...t.small, color: color.mute, lineHeight: 18 },
  conflictRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.xs,
  },
  conflictText: { ...t.small, color: color.warn, flex: 1, fontSize: 12 },
  blurb: { ...t.small, color: color.mute, marginTop: space.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
  chip: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.pill,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    minWidth: 64,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipDim: { opacity: 0.45 },
  chipText: { ...t.small, color: color.ink, fontWeight: '600' },
  notice: { ...t.small, color: color.success, marginTop: space.xs },
  footnote: { ...t.small, color: color.faint, fontSize: 11, marginTop: space.xs },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.sm,
    alignSelf: 'flex-start',
    minHeight: 36,
  },
  retryText: { ...t.small, color: color.deep, fontWeight: '600' },
});
