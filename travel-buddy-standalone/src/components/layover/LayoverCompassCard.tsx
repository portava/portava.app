/**
 * LayoverCompassCard — the Ask-Compass panel, extracted from the never-mounted
 * LayoverReturnPanel.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * LayoverReturnPanel was imported by nothing, and it was the only client caller
 * of POST /api/airport/sessions/:id/compass — so that route had no caller at
 * all. Three of the panel's four parts duplicated controls the dashboard
 * already has (a hard-return countdown in LayoverHero, "Set Reminder" in the
 * footer, and a "Safe Return" button that was a bare callback prop with no
 * implementation, now really implemented in LayoverSafeReturnCard). This is the
 * fourth part — the only one that reached a capability nothing else reaches —
 * kept and mounted. The panel itself is deleted rather than left dead.
 *
 * ── WHAT IT WILL DO WHEN THE FLAG IS OFF ─────────────────────────────────────
 * `layover_compass_enabled` gates the route; with it off the server answers
 * feature_disabled and `askCompass` returns null. That renders as a plain
 * "not available" line, not a fabricated answer.
 */
import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ChevronDown, ChevronRight, Compass } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { askCompass, type CompassAnswer } from '../../services/layover.ts';
import { summarizeCertification } from './layoverReturnFacts.ts';
import { fmtClock } from './layoverFormat.ts';

interface Props {
  sessionId: string;
  timezone: string | null;
}

/**
 * The §12 tool names, in the words a traveller uses.
 *
 * An unmapped name falls through to the raw identifier rather than being
 * dropped: a tool the server gained and this file has not heard of is still
 * something the answer rested on, and hiding it would make the line a
 * half-truth about what was consulted.
 */
const TOOL_LABELS: Record<string, string> = {
  getLayoverContext: 'your layover',
  getConnectionState: 'your connection',
  getTimeWallet: 'your time',
  getSafeEnvelope: 'your safe window',
  getReachableExperiences: 'what is reachable',
  simulatePlan: 'your plan',
  getReturnContract: 'your return deadline',
  getAirportState: 'this airport',
  getCrewCandidates: 'people nearby',
  requestConstraintClarification: 'what is still unknown',
  replan: 'a replan',
  explainDecision: 'how this was decided',
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

export function LayoverCompassCard({ sessionId, timezone }: Props) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<CompassAnswer | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const inFlight = useRef(false);

  const handleAsk = useCallback(async () => {
    const q = question.trim();
    if (!q || inFlight.current) return;
    inFlight.current = true;
    setAsking(true);
    setUnavailable(false);
    try {
      const ans = await askCompass(sessionId, q);
      if (ans) { setAnswer(ans); setQuestion(''); }
      else { setAnswer(null); setUnavailable(true); }
    } catch {
      setAnswer(null);
      setUnavailable(true);
    } finally {
      inFlight.current = false;
      setAsking(false);
    }
  }, [question, sessionId]);

  const cert = summarizeCertification(answer?.certification);
  // §12 — the deterministic tools the server ran for THIS answer. Read with a
  // local narrowing rather than through `CompassAnswer`, because that type
  // lives in `services/layover.ts`, which this lane does not own; an older
  // server that does not publish the member renders no line at all.
  const consultedRaw = (answer as unknown as { toolsConsulted?: unknown } | null)?.toolsConsulted;
  const toolsConsulted = Array.isArray(consultedRaw)
    ? consultedRaw.filter((x): x is string => typeof x === 'string')
    : [];

  return (
    <View style={styles.card} testID="layover-compass-card">
      <Pressable
        accessibilityRole="button"
        testID="compass-toggle"
        style={styles.toggle}
        onPress={() => setOpen((o) => !o)}
      >
        <Compass size={16} color={color.deep} />
        <Text style={styles.toggleText}>Ask Compass about this layover</Text>
        {open ? <ChevronDown size={16} color={color.mute} /> : <ChevronRight size={16} color={color.mute} />}
      </Pressable>

      {open ? (
        <View style={styles.panel}>
          {answer ? (
            <View style={styles.answerBox} testID="compass-answer">
              <Text style={styles.answerText}>{answer.answer}</Text>
              {answer.safetyNote ? (
                <Text style={styles.answerSafety} testID="compass-safety-note">{answer.safetyNote}</Text>
              ) : null}
              {answer.clarifyingQuestion ? (
                <Text style={styles.clarify} testID="compass-clarifying">
                  {answer.clarifyingQuestion.question}
                </Text>
              ) : null}
              {toolsConsulted.length > 0 ? (
                <Text style={styles.tools} testID="compass-tools-consulted">
                  Checked: {toolsConsulted.map(toolLabel).join(' · ')}
                </Text>
              ) : null}
              {answer.boundaryViolations.length > 0 ? (
                <Text style={styles.violation} testID="compass-boundary-violation">
                  This answer was corrected against your certified window.
                </Text>
              ) : null}
              {cert ? (
                <Text style={styles.cert} testID="compass-certification">
                  Computed {fmtClock(cert.computedAt, timezone)} · {cert.versionLine}
                </Text>
              ) : null}
            </View>
          ) : null}

          {unavailable ? (
            <Text style={styles.unavailable} testID="compass-unavailable">
              Compass isn't available for this layover right now.
            </Text>
          ) : null}

          <View style={styles.inputRow}>
            <TextInput
              testID="compass-input"
              style={styles.input}
              placeholder="Can I make it to the old town and back?"
              placeholderTextColor={color.faint}
              value={question}
              onChangeText={setQuestion}
              returnKeyType="send"
              onSubmitEditing={handleAsk}
            />
            <Pressable
              accessibilityRole="button"
              testID="compass-ask-btn"
              style={[styles.askBtn, (asking || !question.trim()) && styles.askBtnDim]}
              onPress={handleAsk}
              disabled={asking || !question.trim()}
            >
              {asking
                ? <ActivityIndicator size="small" color={color.onInk} />
                : <Text style={styles.askBtnText}>Ask</Text>}
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card:       { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.lg, paddingVertical: space.md },
  toggle:     { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  toggleText: { ...t.bodyStrong, color: color.ink, flex: 1 },
  panel:      { marginTop: space.md, gap: space.sm },
  answerBox:  { backgroundColor: color.paper, borderRadius: radius.sm, padding: space.md, gap: 4 },
  answerText: { ...t.body, color: color.ink },
  answerSafety: { ...t.small, color: color.warn, fontWeight: '600' },
  clarify:    { ...t.small, color: color.deep, fontWeight: '600' },
  violation:  { ...t.small, color: color.signalDim, fontWeight: '600' },
  tools:          { marginTop: space.xs, fontSize: 11, color: color.mute },
  cert:       { ...t.stamp, color: color.faint, marginTop: 4 },
  unavailable:{ ...t.small, color: color.mute },
  inputRow:   { flexDirection: 'row', gap: space.sm },
  input:      { flex: 1, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm, ...t.body, color: color.ink },
  askBtn:     { backgroundColor: color.ink, borderRadius: radius.sm, paddingHorizontal: space.lg, alignItems: 'center', justifyContent: 'center' },
  askBtnDim:  { opacity: 0.4 },
  askBtnText: { ...t.bodyStrong, color: color.onInk },
});
