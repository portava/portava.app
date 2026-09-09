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
  cert:       { ...t.stamp, color: color.faint, marginTop: 4 },
  unavailable:{ ...t.small, color: color.mute },
  inputRow:   { flexDirection: 'row', gap: space.sm },
  input:      { flex: 1, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm, ...t.body, color: color.ink },
  askBtn:     { backgroundColor: color.ink, borderRadius: radius.sm, paddingHorizontal: space.lg, alignItems: 'center', justifyContent: 'center' },
  askBtnDim:  { opacity: 0.4 },
  askBtnText: { ...t.bodyStrong, color: color.onInk },
});
