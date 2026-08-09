/**
 * ConciergeCommandBar — "Ask Telegraph" input + prompt chips + response cards.
 *
 * Appears on Trip Detail and Trip Plan pages.
 * Responses appear as AI cards. Add-to-Plan and Create-Meetup actions open
 * bottom-sheet confirmation dialogs before executing.
 * Auth token is obtained internally by the intelligence service.
 */
import React, { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Modal,
  ActivityIndicator, Alert,
} from 'react-native';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';
import { useLocalSearchParams } from 'expo-router';
import { Zap, Send, ChevronDown, ChevronUp, Sparkles, CheckCircle } from 'lucide-react-native';
import { color, space, radius, type as t, icon, avatar, dot } from '../theme/tokens.ts';
import { sendConciergeCommand, confirmCommandAction, declineCommandAction } from '../services/intelligence.ts';

const PROMPT_CHIPS = [
  'Plan tonight',
  'Fill free time',
  'Find food',
  'Find nightlife',
  'Create meetup',
  'Fix conflicts',
  'Add to plan',
  "What's missing?",
];

export interface ConciergeCommandBarHandle {
  focus: () => void;
}

interface ConciergeCommandBarProps {
  tripId: string;
  destination?: string;
  compact?: boolean;
}

interface ProposedAction {
  id: string;
  label: string;
  kind: string;
  params: Record<string, string>;
  requires_confirmation: boolean;
}

interface CommandResponse {
  commandId: string;
  intent: string;
  summary: string;
  suggestions: Array<{ title: string; reason: string; category: string; estimatedTime: string; priceLevel: string }>;
  proposedActions: ProposedAction[];
}

export const ConciergeCommandBar = forwardRef<ConciergeCommandBarHandle, ConciergeCommandBarProps>(
function ConciergeCommandBar({ tripId, destination, compact: _compact = false }, ref) {
  const {
    telegraphPrompt,
    telegraphMeetupId,
    telegraphMeetupTime,
    telegraphMeetupLocation,
  } = useLocalSearchParams<{
    telegraphPrompt?: string;
    telegraphMeetupId?: string;
    telegraphMeetupTime?: string;
    telegraphMeetupLocation?: string;
  }>();
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<CommandResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [confirmAction, setConfirmAction] = useState<{ commandId: string; action: ProposedAction } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const lastHandledPrompt = useRef<string | undefined>(undefined);

  useImperativeHandle(ref, () => ({
    focus: () => { inputRef.current?.focus(); },
  }));

  // Pre-fill + auto-submit when navigated here with ?telegraphPrompt=...
  // Tracks the last-processed value so different chips can each trigger a submit.
  // (e.g. from DailyBriefCard quick-action "Fill free time" or "Find dinner nearby" tap)
  useEffect(() => {
    if (telegraphPrompt && telegraphPrompt !== lastHandledPrompt.current) {
      lastHandledPrompt.current = telegraphPrompt;
      const decoded = decodeURIComponent(telegraphPrompt);
      // Pass structured meetup context if present (forwarded from "Find dinner nearby" quick action)
      const meetupOpts = telegraphMeetupId
        ? {
            meetupId: telegraphMeetupId,
            meetupTime: telegraphMeetupTime,
            meetupLocation: telegraphMeetupLocation,
          }
        : undefined;
      submit(decoded, meetupOpts);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telegraphPrompt]);

  async function submit(
    query: string,
    meetupOpts?: { meetupId?: string; meetupTime?: string; meetupLocation?: string },
  ) {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    setText('');
    inputRef.current?.blur();

    const res = await sendConciergeCommand(query.trim(), { tripId, destination, ...meetupOpts });
    setLoading(false);

    if (!res.ok || !res.data) {
      setError(res.error ?? 'Telegraph is unavailable. Please try again.');
      return;
    }
    setResponse(res.data);
    setExpanded(true);
  }

  async function handleActionTap(action: ProposedAction) {
    if (!response) return;
    if (action.requires_confirmation) {
      setConfirmAction({ commandId: response.commandId, action });
    } else {
      await doConfirm(response.commandId, action);
    }
  }

  async function doConfirm(commandId: string, action: ProposedAction) {
    setConfirming(true);
    setConfirmAction(null);
    const res = await confirmCommandAction(commandId, action.id);
    setConfirming(false);
    if (res.ok) {
      Alert.alert('Done', res.data?.message ?? `${action.label} confirmed.`);
    } else {
      Alert.alert('Error', 'Could not complete that action. You may not have permission.');
    }
  }

  async function handleDecline() {
    if (!response) return;
    await declineCommandAction(response.commandId);
    setConfirmAction(null);
  }

  return (
    <KeyboardSafeScrollView>
      <View style={s.wrap}>
        {/* Header */}
        <View style={s.header}>
          <View style={s.icon}><Zap size={12} color={color.signal} fill={color.signal} /></View>
          <Text style={s.title}>Ask Telegraph</Text>
          {response && (
            <Pressable onPress={() => setExpanded((e) => !e)} hitSlop={8}>
              {expanded ? <ChevronUp size={15} color={color.mute} /> : <ChevronDown size={15} color={color.mute} />}
            </Pressable>
          )}
        </View>

        {/* Input row */}
        <View style={s.inputRow}>
          <TextInput
            ref={inputRef}
            style={s.input}
            value={text}
            onChangeText={setText}
            placeholder="Plan tonight, find food, fill free time…"
            placeholderTextColor={color.faint}
            onSubmitEditing={() => submit(text)}
            returnKeyType="send"
            maxLength={500}
            multiline={false}
          />
          <Pressable
            style={[s.sendBtn, (!text.trim() || loading) && { opacity: 0.4 }]}
            onPress={() => submit(text)}
            disabled={!text.trim() || loading}
            hitSlop={6}
          >
            {loading ? <ActivityIndicator size="small" color={color.onInk} /> : <Send size={14} color={color.onInk} />}
          </Pressable>
        </View>

        {/* Prompt chips */}
        {!response && !loading && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
            {PROMPT_CHIPS.map((chip) => (
              <Pressable key={chip} style={s.chip} onPress={() => submit(chip)}>
                <Text style={s.chipText}>{chip}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {/* Error state */}
        {error && !loading && (
          <View style={s.errorBox}>
            <Text style={s.errorText}>{error}</Text>
            <Pressable onPress={() => setError(null)}><Text style={s.retryText}>Dismiss</Text></Pressable>
          </View>
        )}

        {/* Loading */}
        {loading && (
          <View style={s.loadBox}>
            <ActivityIndicator size="small" color={color.signal} />
            <Text style={s.loadText}>Telegraph is thinking…</Text>
          </View>
        )}

        {/* Response card */}
        {response && expanded && !loading && (
          <ResponseCard
            response={response}
            onActionTap={handleActionTap}
            onDismiss={() => setResponse(null)}
            confirming={confirming}
          />
        )}
      </View>

      {/* Confirmation bottom sheet */}
      <ConfirmationSheet
        visible={!!confirmAction}
        action={confirmAction?.action ?? null}
        onConfirm={() => confirmAction && doConfirm(confirmAction.commandId, confirmAction.action)}
        onDecline={handleDecline}
      />
    </KeyboardSafeScrollView>
  );
});

function ResponseCard({
  response, onActionTap, onDismiss, confirming,
}: {
  response: CommandResponse;
  onActionTap: (a: ProposedAction) => void;
  onDismiss: () => void;
  confirming: boolean;
}) {
  return (
    <View style={rc.wrap}>
      <View style={rc.aiLabel}>
        <Sparkles size={10} color={color.signal} />
        <Text style={rc.aiText}>Telegraph</Text>
      </View>
      <Text style={rc.summary}>{response.summary}</Text>

      {response.suggestions.length > 0 && (
        <View style={rc.sugList}>
          {response.suggestions.map((sg, i) => (
            <View key={i} style={rc.sugRow}>
              <View style={rc.sugDot} />
              <View style={{ flex: 1 }}>
                <Text style={rc.sugTitle} numberOfLines={1}>{sg.title}</Text>
                <Text style={rc.sugReason} numberOfLines={2}>{sg.reason}</Text>
                <Text style={rc.sugMeta}>{sg.estimatedTime} · {sg.priceLevel}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {response.proposedActions.length > 0 && (
        <View style={rc.actionRow}>
          {response.proposedActions.map((a) => (
            <Pressable
              key={a.id}
              style={[rc.actionBtn, confirming && { opacity: 0.5 }]}
              onPress={() => onActionTap(a)}
              disabled={confirming}
            >
              {confirming ? <ActivityIndicator size="small" color={color.signal} /> : <Text style={rc.actionText}>{a.label}</Text>}
            </Pressable>
          ))}
        </View>
      )}

      <Pressable style={rc.dismiss} onPress={onDismiss} hitSlop={8}>
        <Text style={rc.dismissText}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

function ConfirmationSheet({
  visible, action, onConfirm, onDecline,
}: {
  visible: boolean;
  action: ProposedAction | null;
  onConfirm: () => void;
  onDecline: () => void;
}) {
  if (!action) return null;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDecline}>
      <Pressable style={cs.overlay} onPress={onDecline}>
        <View style={cs.sheet}>
          <View style={cs.handle} />
          <Text style={cs.title}>Confirm action</Text>
          <Text style={cs.body}>{action.label}</Text>
          <Text style={cs.sub}>This will make changes to your trip plan. Review before confirming.</Text>
          <View style={cs.btnRow}>
            <Pressable style={cs.cancelBtn} onPress={onDecline}><Text style={cs.cancelText}>Cancel</Text></Pressable>
            <Pressable style={cs.confirmBtn} onPress={onConfirm}>
              <CheckCircle size={14} color={color.onInk} />
              <Text style={cs.confirmText}>Confirm</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  wrap: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, marginHorizontal: space.lg, marginTop: space.xl, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm },
  icon: { width: icon.lg, height: icon.lg, borderRadius: icon.lg / 2, backgroundColor: '#FFF0EE', alignItems: 'center', justifyContent: 'center' },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 13, flex: 1 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm },
  input: { flex: 1, backgroundColor: color.paper, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.md, paddingVertical: 9, ...t.body, color: color.ink, fontSize: 13 },
  sendBtn: { width: avatar.smMd, height: avatar.smMd, borderRadius: avatar.smMd / 2, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  chipRow: { paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.md },
  chip: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze },
  chipText: { ...t.small, color: color.ink, fontSize: 12, fontWeight: '600' },
  errorBox: { margin: space.lg, backgroundColor: '#FFF0EE', borderRadius: radius.sm, padding: space.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  errorText: { ...t.small, color: color.signal, flex: 1, fontSize: 12 },
  retryText: { ...t.small, color: color.signal, fontWeight: '700' },
  loadBox: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.lg, paddingTop: 0 },
  loadText: { ...t.small, color: color.mute, fontSize: 12 },
});

const rc = StyleSheet.create({
  wrap: { margin: space.lg, marginTop: 0, backgroundColor: color.paper, borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze, padding: space.md },
  aiLabel: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: space.sm },
  aiText: { ...t.stamp, fontFamily: 'Courier', color: color.signal, fontSize: 10, letterSpacing: 0.8, fontWeight: '700' },
  summary: { ...t.body, color: color.ink, fontSize: 13, lineHeight: 19, marginBottom: space.md },
  sugList: { gap: 0 },
  sugRow: { flexDirection: 'row', gap: space.sm, paddingVertical: 6, borderTopWidth: 1, borderTopColor: color.haze },
  sugDot: { width: dot.s6, height: dot.s6, borderRadius: dot.s6 / 2, backgroundColor: color.signal, marginTop: 6 },
  sugTitle: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  sugReason: { ...t.small, color: color.mute, fontSize: 11, lineHeight: 16 },
  sugMeta: { ...t.stamp, fontFamily: 'Courier', color: color.faint, fontSize: 10 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  actionBtn: { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.signal, backgroundColor: '#FFF0EE', flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionText: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 12 },
  dismiss: { alignSelf: 'flex-end', marginTop: space.sm },
  dismissText: { ...t.small, color: color.faint, fontSize: 11 },
});

const cs = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: color.paperRaised, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.xl, paddingBottom: space.xxxl, gap: space.md },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.sm },
  title: { ...t.title, color: color.ink, fontSize: 18 },
  body: { ...t.bodyStrong, color: color.ink },
  sub: { ...t.small, color: color.mute, lineHeight: 18 },
  btnRow: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
  cancelBtn: { flex: 1, paddingVertical: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, alignItems: 'center' },
  cancelText: { ...t.body, color: color.ink, fontWeight: '600' },
  confirmBtn: { flex: 1, paddingVertical: space.md, borderRadius: radius.md, backgroundColor: color.signal, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  confirmText: { ...t.body, color: color.onInk, fontWeight: '700' },
});
