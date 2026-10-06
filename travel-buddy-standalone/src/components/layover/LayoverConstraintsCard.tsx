/**
 * LayoverConstraintsCard — "your bags and your connection", on the dashboard.
 *
 * Spec §4 `layover_constraints`, §5's landside guard, §12.1's one question and
 * App B.2 ("Unknown baggage blocks landside plan"). Census-layover L22, L35,
 * L49, L172, L229: the engine could only ever be told "checked bags: yes/no",
 * so a traveller who did not know was recorded as having none.
 *
 * ── THIS CARD RE-DERIVES NOTHING ─────────────────────────────────────────────
 * Whether landside is open, whether the unknown matters, which question to ask
 * and which fields can be kept are all the server's
 * (`GET /api/airport/sessions/:id/constraints`). The card renders `landsideGate`,
 * `question`, `declarable` and `layoverState` as they arrive. There is no
 * client-side rule here about minutes or verdicts — `LayoverReturnPanel.tsx` was
 * deleted at `a718beb5` for carrying its own.
 *
 * ── THE BADGE CANNOT CONTRADICT THE VERDICT CARD ABOVE IT ────────────────────
 * `CanILeaveCard` is mounted directly over this card and both now word the
 * verdict from ONE table (`layoverVerdictFacts.ts`). The badge is green on
 * exactly one path — the verdict is `yes`, the gate is open, and the server
 * named an affirmative state. It used to be green whenever `layoverState` was
 * LANDSIDE_AVAILABLE, which the server sent for an unconfirmed border and for a
 * tight window: "You can go out" under "Time is fine — entry unconfirmed".
 *
 * ── THE STATES THAT ARE NOT THE SAME STATE ───────────────────────────────────
 *   loading      we have not asked yet.
 *   failed       we asked and the read FAILED — including the server's own 503
 *                for a declared set it could not read. Says so, with the
 *                server's sentence and a retry. NEVER rendered as "nothing
 *                declared": that would show a traveller who answered "not sure"
 *                a card saying they have no bags.
 *   unsupported  this server has no such route, or Layover is off. Renders
 *                nothing: there is no claim to make.
 *   ready        the answer. `constraints: null` inside it is a MEASURED
 *                "nothing declared yet", and is shown as what is being counted.
 *
 * ── A SAVE THAT FAILS LEAVES THE LAST TRUE ANSWER ON SCREEN ──────────────────
 * The card never paints the option the traveller pressed until the server has
 * answered with it. A failed save shows the server's sentence and keeps the
 * previous answer; pressing again retries.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { Luggage, RefreshCw, HelpCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  getLayoverConstraints,
  updateLayoverConstraints,
  type DeclarableConstraintField,
  type LayoverConstraintPatch,
  type LayoverConstraintsAnswer,
} from '../../services/layover.ts';
import {
  BAGGAGE_MODE_COPY,
  BAGGAGE_MODE_ORDER,
  CONNECTION_FIELD_COPY,
  TRI_STATE_OPTIONS,
  creationNoteForParam,
  describeClosures,
  legacyBaggageLine,
  questionPatch,
  questionWhy,
  selectedBaggageMode,
  storageNote,
  unsavedNote,
} from './layoverConstraintFacts.ts';
import { describeCautions, describeLandsideBadge } from './layoverVerdictFacts.ts';

interface Props {
  sessionId: string;
  /** The layover is still active; a closed one is shown read-only. */
  canEdit: boolean;
  /** Bumped by the parent on pull-to-refresh so this card reloads with it. */
  refreshKey?: number;
  /**
   * Called after a declaration the server accepted. The verdict, the deadline
   * and the recommendations may all have moved, so the screen re-reads rather
   * than keep rendering the answer the declaration just replaced.
   */
  onChanged?: () => void;
  /**
   * What the start sheet learned from `POST /airport/sessions` about the
   * answers it sent: `not_stored` or `unsaved`, or absent when all was kept.
   * Shown until the traveller declares here — a "not sure" that failed to
   * store must not look stored.
   */
  creationNotice?: string | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'unsupported' }
  | { kind: 'ready'; answer: LayoverConstraintsAnswer };

const READ_FAILED = 'Your bag and connection details could not be loaded.';

const STATE_TONE_FG: Record<string, string> = {
  ask: color.warn,
  closed: color.signalDim,
  // The ONE green. `describeLandsideBadge` returns it only for the verdict `yes`.
  open: color.success,
  // The same amber `CanILeaveCard` draws a cautionary verdict in.
  caution: color.warn,
  return: color.signalDim,
  done: color.mute,
  unknown: color.mute,
};

export function LayoverConstraintsCard({ sessionId, canEdit, refreshKey = 0, onChanged, creationNotice = null }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  /** The control that is saving, e.g. `baggageMode:UNKNOWN`. One save at a time. */
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Cleared by the first declaration the server accepts here. */
  const [declaredHere, setDeclaredHere] = useState(false);
  /** Only the newest read may land: a slow answer must not replace a newer one. */
  const readTicket = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++readTicket.current;
    let next: LoadState;
    try {
      const read = await getLayoverConstraints(sessionId);
      if (read.ok) next = { kind: 'ready', answer: read.answer };
      else if (read.reason === 'unsupported') next = { kind: 'unsupported' };
      else next = { kind: 'failed', message: read.message };
    } catch {
      // The service resolves in every case; this is the belt to that braces, so
      // a future throw becomes a stated failure and not a spinner for ever.
      next = { kind: 'failed', message: READ_FAILED };
    }
    if (ticket !== readTicket.current) return;
    setState(next);
  }, [sessionId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const declare = useCallback(async (key: string, patch: LayoverConstraintPatch) => {
    // A closed layover is read-only whatever was pressed.
    if (saving || !canEdit) return;
    setSaving(key);
    setSaveError(null);
    setNotice(null);
    // A read still in flight was asked BEFORE this declaration and must not
    // land on top of its answer.
    readTicket.current += 1;
    let outcome: Awaited<ReturnType<typeof updateLayoverConstraints>>;
    try {
      outcome = await updateLayoverConstraints(sessionId, patch);
    } catch {
      outcome = { ok: false, reason: 'unreachable', message: 'Your details could not be saved. Please try again.', retryable: true };
    }
    setSaving(null);
    if (!outcome.ok) {
      // The previous answer stays on screen: it is still the last thing the
      // server certified.
      setSaveError(outcome.message);
      return;
    }
    setState({ kind: 'ready', answer: outcome.answer });
    setNotice(unsavedNote(outcome.unsaved));
    setDeclaredHere(true);
    onChanged?.();
  }, [sessionId, saving, canEdit, onChanged]);

  if (state.kind === 'unsupported') return null;

  if (state.kind === 'loading') {
    return (
      <View style={styles.card} testID="layover-constraints-loading">
        <Header />
        <ActivityIndicator color={color.deep} style={{ marginTop: space.md }} />
      </View>
    );
  }

  if (state.kind === 'failed') {
    return (
      <View style={styles.card} testID="layover-constraints-failed">
        <Header />
        {/* NOT "nothing declared". See the header: an unread answer is not an
            empty one. Nothing is said here about what the times above assume,
            because this card did not get an answer that says. */}
        <Text style={styles.body} testID="layover-constraints-failed-message">{state.message}</Text>
        <Pressable
          onPress={() => { setState({ kind: 'loading' }); void load(); }}
          accessibilityRole="button"
          accessibilityLabel="Retry loading your bag and connection details"
          style={styles.retry}
          testID="layover-constraints-retry"
        >
          <RefreshCw size={13} color={color.deep} />
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const { answer } = state;
  // The verdict decides the badge; the state only names WHICH affirmative or
  // journey state it is. See `layoverVerdictFacts.ts`.
  const lifecycle = describeLandsideBadge({
    layoverState: answer.layoverState,
    verdict: answer.verdict,
    gate: answer.landsideGate,
  });
  const closures = describeClosures(answer.landsideGate.closedBy);
  const cautions = describeCautions(answer.landsideGate.cautions);
  const startNote = declaredHere ? null : creationNoteForParam(creationNotice);
  const selectedMode = selectedBaggageMode(answer);
  const declarable = (f: DeclarableConstraintField) => answer.declarable.includes(f);
  const note = storageNote(answer);
  const busy = saving !== null;
  // A closed layover is not asked anything: it is told why, by the closures.
  const question = canEdit ? answer.question : null;
  // One element type for the three questions' options: the bag question's are
  // modes, the two connection questions' are booleans.
  const questionOptions: Array<{ value: string | boolean; label: string }> = question ? question.options : [];

  return (
    <View style={styles.card} testID="layover-constraints-card">
      <View style={styles.headRow}>
        <Header />
        {lifecycle ? (
          <Text
            style={[styles.stateBadge, { color: STATE_TONE_FG[lifecycle.tone] ?? color.mute }]}
            // Named for the TONE, not the server's state token: a stale
            // LANDSIDE_AVAILABLE that this build declines to draw green must
            // not be findable as if it had been.
            testID={`layover-badge-${lifecycle.tone}`}
            accessibilityLabel={`Status: ${lifecycle.label}`}
          >
            {lifecycle.label}
          </Text>
        ) : null}
      </View>

      {/* What the START sheet could not keep. Until the traveller declares
          here, an answer that was not stored must not look stored. */}
      {startNote ? (
        <Text style={styles.notice} testID="layover-constraints-not-stored">{startNote}</Text>
      ) : null}

      {/* §12.1 / App B.2 — the ONE question, and only when the server says the
          answer could change the verdict. */}
      {question ? (
        <View style={styles.questionBox} testID="layover-constraints-question">
          <View style={styles.questionHead}>
            <HelpCircle size={15} color={color.warn} />
            <Text style={styles.questionTitle}>{question.prompt}</Text>
          </View>
          <Text style={styles.questionBody} testID="layover-constraints-question-why">
            {questionWhy(question.field)}
          </Text>
          <View style={styles.chips}>
            {questionOptions.map((opt) => {
              const key = `question:${String(opt.value)}`;
              // The QUESTION's field, not always the bag mode. A value this
              // build cannot express is not offered rather than sent wrong.
              const patch = questionPatch(question, opt.value);
              if (!patch) return null;
              return (
                <Pressable
                  key={String(opt.value)}
                  onPress={() => { void declare(key, patch); }}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={opt.label}
                  accessibilityState={{ disabled: busy, busy: saving === key }}
                  style={[styles.chip, styles.chipStrong, busy && saving !== key ? styles.chipDim : null]}
                  testID={`layover-constraints-answer-${String(opt.value)}`}
                >
                  {saving === key
                    ? <ActivityIndicator size="small" color={color.deep} />
                    : <Text style={styles.chipText}>{opt.label}</Text>}
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {/* What closed landside, in the server's order. Absent when it is open. */}
      {closures.length > 0 && !question ? (
        <View style={styles.closedBox} testID="layover-landside-closed">
          <Text style={styles.closedTitle}>Why we are not suggesting anything outside the airport</Text>
          {closures.map((c) => (
            <Text key={c.code} style={styles.closedLine} testID={`layover-landside-closed-${c.code}`}>·  {c.sentence}</Text>
          ))}
        </View>
      ) : null}

      {/* Nothing forbids landside, and nothing confirms it: said in the same
          amber as the verdict above, never left to read as a yes. */}
      {cautions.length > 0 && closures.length === 0 && !question ? (
        <View style={styles.closedBox} testID="layover-landside-caution">
          <Text style={[styles.closedTitle, { color: color.warn }]}>Why this is not a clear yes</Text>
          {cautions.map((c) => (
            <Text key={c.code} style={styles.closedLine} testID={`layover-landside-caution-${c.code}`}>·  {c.sentence}</Text>
          ))}
        </View>
      ) : null}

      {/* Bags */}
      <View style={styles.block}>
        <Text style={styles.blockTitle}>Your bags</Text>
        {selectedMode ? (
          <Text style={styles.current} testID="layover-constraints-baggage-current">
            {BAGGAGE_MODE_COPY[selectedMode].label} — {BAGGAGE_MODE_COPY[selectedMode].blurb}
          </Text>
        ) : (
          // Nothing four-way is stored. Say what is being COUNTED rather than
          // name a mode the traveller never chose.
          <Text style={styles.current} testID="layover-constraints-baggage-legacy">
            {legacyBaggageLine(answer.baggageCharged)}
          </Text>
        )}
        {canEdit && declarable('baggageMode') ? (
          <View style={styles.chips}>
            {BAGGAGE_MODE_ORDER.map((mode) => {
              const key = `baggageMode:${mode}`;
              const active = selectedMode === mode;
              return (
                <Pressable
                  key={mode}
                  onPress={() => { void declare(key, { baggageMode: mode }); }}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Bags: ${BAGGAGE_MODE_COPY[mode].label}`}
                  accessibilityState={{ disabled: busy, busy: saving === key, selected: active }}
                  style={[styles.chip, active ? styles.chipActive : null, busy && saving !== key ? styles.chipDim : null]}
                  testID={`layover-constraints-baggage-${mode}`}
                >
                  {saving === key
                    ? <ActivityIndicator size="small" color={color.deep} />
                    : <Text style={[styles.chipText, active ? styles.chipTextActive : null]}>{BAGGAGE_MODE_COPY[mode].label}</Text>}
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>

      {/* The two connection facts — offered only where the server can keep them. */}
      {(['recheckRequired', 'airportChangeRequired'] as const).map((field) => {
        if (!declarable(field)) return null;
        const copy = CONNECTION_FIELD_COPY[field];
        const value = answer.constraints ? answer.constraints[field] : null;
        const stated = answer.constraints !== null;
        return (
          <View key={field} style={styles.block}>
            <Text style={styles.blockTitle}>{copy.title}</Text>
            <Text style={styles.blurb}>{copy.blurb}</Text>
            <View style={styles.chips}>
              {TRI_STATE_OPTIONS.map((opt) => {
                const key = `${field}:${String(opt.value)}`;
                const active = stated && value === opt.value;
                const patch: LayoverConstraintPatch = field === 'recheckRequired'
                  ? { recheckRequired: opt.value }
                  : { airportChangeRequired: opt.value };
                return (
                  <Pressable
                    key={String(opt.value)}
                    onPress={() => { void declare(key, patch); }}
                    disabled={busy || !canEdit}
                    accessibilityRole="button"
                    accessibilityLabel={`${copy.title} ${opt.label}`}
                    accessibilityState={{ disabled: busy || !canEdit, busy: saving === key, selected: active }}
                    style={[styles.chip, active ? styles.chipActive : null, busy && saving !== key ? styles.chipDim : null]}
                    testID={`layover-constraints-${field}-${String(opt.value)}`}
                  >
                    {saving === key
                      ? <ActivityIndicator size="small" color={color.deep} />
                      : <Text style={[styles.chipText, active ? styles.chipTextActive : null]}>{opt.label}</Text>}
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}

      {saveError ? (
        <Text style={styles.saveError} testID="layover-constraints-save-error">{saveError}</Text>
      ) : null}
      {notice ? <Text style={styles.notice} testID="layover-constraints-unsaved">{notice}</Text> : null}
      {note ? <Text style={styles.footnote} testID="layover-constraints-storage-note">{note}</Text> : null}
    </View>
  );
}

function Header() {
  return (
    <View style={styles.titleRow}>
      <Luggage size={18} color={color.ink} />
      <Text style={styles.heading}>Your bags and connection</Text>
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
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexShrink: 1 },
  heading: { ...t.heading, color: color.ink },
  stateBadge: { ...t.small, fontWeight: '700' },
  body: { ...t.small, color: color.ink, marginTop: space.xs },
  questionBox: {
    backgroundColor: 'rgba(200,133,26,0.10)',
    borderRadius: radius.md,
    padding: space.md,
    gap: space.xs,
  },
  questionHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  questionTitle: { ...t.bodyStrong, color: color.ink, flex: 1 },
  questionBody: { ...t.small, color: color.mute, lineHeight: 18 },
  closedBox: {
    borderTopWidth: 1,
    borderTopColor: color.haze,
    paddingTop: space.md,
    gap: 2,
  },
  closedTitle: { ...t.small, color: color.signalDim, fontWeight: '700' },
  closedLine: { ...t.small, color: color.ink, lineHeight: 18 },
  block: {
    borderTopWidth: 1,
    borderTopColor: color.haze,
    paddingTop: space.md,
    marginTop: space.xs,
    gap: space.xs,
  },
  blockTitle: { ...t.bodyStrong, color: color.ink },
  current: { ...t.small, color: color.ink, lineHeight: 18 },
  blurb: { ...t.small, color: color.mute },
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
  chipStrong: { borderColor: color.warn },
  chipActive: { backgroundColor: color.deep, borderColor: color.deep },
  chipDim: { opacity: 0.45 },
  chipText: { ...t.small, color: color.ink, fontWeight: '600' },
  chipTextActive: { color: color.onInk },
  saveError: { ...t.small, color: color.signalDim, marginTop: space.xs },
  notice: { ...t.small, color: color.warn, marginTop: space.xs },
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
