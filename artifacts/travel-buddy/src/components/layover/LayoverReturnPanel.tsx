/**
 * LayoverReturnPanel
 *
 * Sticky bottom panel showing hard return time countdown, a Set Reminder button,
 * and an expandable Compass explanation card.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet,
  TextInput, ActivityIndicator, Animated, Alert,
} from 'react-native';
import { Clock, Shield, Compass, ChevronUp, ChevronDown } from 'lucide-react-native';
import {
  getSessionSafety,
  askCompass,
  setReturnDeadline,
  type LayoverSafetyResult,
  type CompassAnswer,
} from '../../services/layover';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  onSafeReturn?: () => void;
}

// ── Countdown helper ──────────────────────────────────────────────────────────

function useCountdown(targetIso: string | null): string {
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (!targetIso) { setLabel('—'); return; }
    const tick = () => {
      const diffMs = new Date(targetIso).getTime() - Date.now();
      if (diffMs <= 0) { setLabel('NOW'); return; }
      const h = Math.floor(diffMs / 3_600_000);
      const m = Math.floor((diffMs % 3_600_000) / 60_000);
      const s = Math.floor((diffMs % 60_000) / 1000);
      if (h > 0) setLabel(`${h}h ${m}m`);
      else if (m > 0) setLabel(`${m}m ${s}s`);
      else setLabel(`${s}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetIso]);

  return label;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LayoverReturnPanel({ sessionId, onSafeReturn }: Props) {
  const [safety, setSafety]               = useState<LayoverSafetyResult | null>(null);
  const [loadingSafety, setLoadingSafety] = useState(true);
  const [expanded, setExpanded]           = useState(false);
  const [question, setQuestion]           = useState('');
  const [asking, setAsking]               = useState(false);
  const [compassAnswer, setCompassAnswer] = useState<CompassAnswer | null>(null);
  const [settingReminder, setSettingReminder] = useState(false);

  const loadSafety = useCallback(async () => {
    try {
      const s = await getSessionSafety(sessionId);
      setSafety(s);
    } finally {
      setLoadingSafety(false);
    }
  }, [sessionId]);

  useEffect(() => { loadSafety(); }, [loadSafety]);

  const countdown = useCountdown(safety?.hardReturnTime ?? null);

  const handleSetReminder = async () => {
    setSettingReminder(true);
    try {
      const result = await setReturnDeadline(sessionId, 30);
      if (result) {
        Alert.alert(
          'Reminder set',
          `You'll be reminded 30 minutes before your hard return time: ${new Date(result.hardReturnTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
        );
      }
    } finally {
      setSettingReminder(false);
    }
  };

  const handleAskCompass = async () => {
    if (!question.trim()) return;
    setAsking(true);
    try {
      const ans = await askCompass(sessionId, question.trim());
      setCompassAnswer(ans);
      setQuestion('');
    } finally {
      setAsking(false);
    }
  };

  if (loadingSafety) {
    return (
      <View style={styles.panel}>
        <ActivityIndicator size="small" color="#2196F3" />
      </View>
    );
  }

  if (!safety) return null;

  const isUrgent = safety.usableMinutes < 30;
  const isRisky  = safety.usableMinutes < 60;

  return (
    <View style={[styles.panel, isUrgent && styles.panelUrgent]}>
      {/* Hard return time row */}
      <View style={styles.row}>
        <View style={styles.flex1}>
          <Text style={styles.countdownLabel}>Return to airport</Text>
          <View style={styles.countdownRow}>
            <Clock size={16} color={isUrgent ? '#C62828' : '#333'} />
            <Text style={[styles.countdown, isUrgent && styles.countdownUrgent]}>
              {countdown}
            </Text>
            <Text style={styles.hardTime}>
              by {new Date(safety.hardReturnTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
          <Text style={[styles.overallLabel, { color: isUrgent ? '#C62828' : isRisky ? '#E65100' : '#2E7D32' }]}>
            {safety.overallLabel}
          </Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            style={[styles.reminderBtn, settingReminder && styles.btnDisabled]}
            onPress={handleSetReminder}
            disabled={settingReminder}
          >
            {settingReminder
              ? <ActivityIndicator size="small" color="#fff" />
              : <><Clock size={13} color="#fff" /><Text style={styles.reminderBtnText}>Reminder</Text></>}
          </Pressable>
          <Pressable style={styles.safeReturnBtn} onPress={onSafeReturn}>
            <Shield size={13} color="#fff" />
            <Text style={styles.reminderBtnText}>Safe Return</Text>
          </Pressable>
        </View>
      </View>

      {/* Buffer breakdown */}
      <Text style={styles.bufferSub}>
        {safety.usableMinutes} min usable · {safety.returnBufferMin} min buffer (
        base {safety.breakdown.baseBuffer}
        {safety.breakdown.immigrationExtra > 0 ? ` + imm ${safety.breakdown.immigrationExtra}` : ''}
        {safety.breakdown.bagsExtra > 0 ? ` + bags ${safety.breakdown.bagsExtra}` : ''}
        {` + traffic ${safety.breakdown.trafficExtra}`}
        )
      </Text>

      {/* Expandable Compass panel */}
      <Pressable style={styles.compassToggle} onPress={() => setExpanded((e) => !e)}>
        <Compass size={14} color="#2196F3" />
        <Text style={styles.compassToggleText}>Ask Compass</Text>
        {expanded ? <ChevronDown size={14} color="#2196F3" /> : <ChevronUp size={14} color="#2196F3" />}
      </Pressable>

      {expanded && (
        <View style={styles.compassPanel}>
          {compassAnswer && (
            <View style={styles.answerBox}>
              <Text style={styles.answerText}>{compassAnswer.answer}</Text>
              {compassAnswer.safetyNote && (
                <Text style={styles.answerSafety}>{compassAnswer.safetyNote}</Text>
              )}
            </View>
          )}
          <View style={styles.compassInputRow}>
            <TextInput
              style={styles.compassInput}
              placeholder="Ask a layover question…"
              value={question}
              onChangeText={setQuestion}
              multiline={false}
              returnKeyType="send"
              onSubmitEditing={handleAskCompass}
            />
            <Pressable
              style={[styles.compassSendBtn, (asking || !question.trim()) && styles.btnDisabled]}
              onPress={handleAskCompass}
              disabled={asking || !question.trim()}
            >
              {asking
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.compassSendText}>Ask</Text>}
            </Pressable>
          </View>
          <Text style={styles.compassHint}>
            Example: "Can I leave the airport?" · "What can I do with 4 hours at TPE?"
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  panel:           { backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e0e0e0', padding: 14, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: -2 }, elevation: 8 },
  panelUrgent:     { backgroundColor: '#FFF8E1', borderTopColor: '#FFCA28' },
  row:             { flexDirection: 'row', alignItems: 'flex-start' },
  flex1:           { flex: 1 },
  countdownLabel:  { fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  countdownRow:    { flexDirection: 'row', alignItems: 'center', gap: 6 },
  countdown:       { fontSize: 22, fontWeight: '800', color: '#1a1a1a' },
  countdownUrgent: { color: '#C62828' },
  hardTime:        { fontSize: 13, color: '#666' },
  overallLabel:    { fontSize: 12, fontWeight: '500', marginTop: 2 },
  bufferSub:       { fontSize: 11, color: '#aaa', marginTop: 4 },
  actions:         { flexDirection: 'column', gap: 6, marginLeft: 12 },
  reminderBtn:     { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#2196F3', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  safeReturnBtn:   { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#388E3C', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  reminderBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  btnDisabled:     { opacity: 0.5 },
  compassToggle:   { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#f0f0f0' },
  compassToggleText: { flex: 1, fontSize: 13, color: '#2196F3', fontWeight: '500' },
  compassPanel:    { marginTop: 10 },
  answerBox:       { backgroundColor: '#E3F2FD', borderRadius: 8, padding: 12, marginBottom: 8 },
  answerText:      { fontSize: 14, color: '#1a1a1a', lineHeight: 20 },
  answerSafety:    { fontSize: 12, color: '#1565C0', marginTop: 6, fontStyle: 'italic' },
  compassInputRow: { flexDirection: 'row', gap: 8 },
  compassInput:    { flex: 1, borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 10, fontSize: 14 },
  compassSendBtn:  { backgroundColor: '#2196F3', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  compassSendText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  compassHint:     { fontSize: 11, color: '#aaa', marginTop: 6 },
});
