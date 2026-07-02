import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, TextInput, Pressable, StyleSheet,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { Sparkles, Send, Plane, MessageCircle, Map, PlusCircle } from 'lucide-react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { postCompassFrontloadEvent, postCompassAsk } from '../../src/services/compass';
import type { CompassAskRecommendation } from '../../src/services/compass';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { Stamp } from '../../src/components/ui';
import { LayoverModeSheet } from '../../src/components/layover/LayoverModeSheet';
import { usePlanPicker } from '../../src/components/PlanPickerController';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

type ChatEntry =
  | { kind: 'user';    id: string; text: string }
  | { kind: 'ai_text'; id: string; text: string }
  | { kind: 'rec';     id: string; rec: CompassAskRecommendation }
  | { kind: 'typing';  id: string };

export default function AiChat() {
  const router = useRouter();
  const planPicker = usePlanPicker();
  const [entries, setEntries]       = useState<ChatEntry[]>([]);
  const [input, setInput]           = useState('');
  const [loading, setLoading]       = useState(false);
  const [layoverOpen, setLayoverOpen] = useState(false);
  const scroll = useRef<ScrollView>(null);

  useFocusEffect(useCallback(() => {
    postCompassFrontloadEvent({ eventType: 'navigation', screen: 'ai_chat' }).catch(() => {});
  }, []));

  function scrollToEnd() {
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 80);
  }

  async function send(promptOverride?: string, modeOverride?: 'recommend' | 'itinerary') {
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
    scrollToEnd();

    const result = await postCompassAsk(text, { mode: modeOverride });

    setEntries((prev) => {
      const without = prev.filter((e) => e.id !== typingId);
      if (!result.ok || !result.data) {
        return [
          ...without,
          {
            kind: 'ai_text',
            id: 'err_' + Date.now(),
            text: "Couldn't reach Compass right now — try again in a moment.",
          },
        ];
      }
      return [...without, { kind: 'rec', id: 'rec_' + Date.now(), rec: result.data }];
    });
    setLoading(false);
    scrollToEnd();
  }

  function handleAction(rec: CompassAskRecommendation, kind: string) {
    switch (kind) {
      case 'addTrip':
        planPicker.open({
          id:       rec.id,
          type:     'compass_suggestion',
          title:    rec.bestPick,
          category: 'activity',
        });
        break;
      case 'buildItinerary':
        send(`Build a 3-day itinerary for ${rec.bestPick}`, 'itinerary');
        break;
      case 'askCommunity':
        router.push('/(tabs)/messages');
        break;
      default:
        break;
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: color.paper }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScreenHeader title="AI Buddy" back />
      <ScrollView
        ref={scroll}
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xl }}
      >
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
          return (
            <RecCard
              key={e.id}
              rec={e.rec}
              onAction={(kind) => handleAction(e.rec, kind)}
            />
          );
        })}
      </ScrollView>

      <View style={styles.inputBar}>
        <Pressable style={styles.layoverBtn} onPress={() => setLayoverOpen(true)}>
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
        <Pressable style={[styles.sendBtn, loading && styles.sendBtnDisabled]} onPress={() => send()}>
          <Send size={18} color={color.onInk} />
        </Pressable>
      </View>

      <LayoverModeSheet
        visible={layoverOpen}
        onClose={() => setLayoverOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

// ── Rec card ──────────────────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, React.ReactNode> = {
  addTrip:        <PlusCircle size={13} color={color.onInk} />,
  buildItinerary: <Map size={13} color={color.onInk} />,
  askCommunity:   <MessageCircle size={13} color={color.onInk} />,
};

function RecCard({
  rec,
  onAction,
}: {
  rec: CompassAskRecommendation;
  onAction: (kind: string) => void;
}) {
  return (
    <View style={styles.rec}>
      <View style={styles.aiHead}>
        <Sparkles size={15} color={color.signal} />
        <Text style={styles.aiHeadText}>BEST PICK</Text>
      </View>
      <Text style={styles.recPick}>{rec.bestPick}</Text>

      <Text style={styles.recLabel}>{rec.whyLabel ?? 'Why'}</Text>
      <Text style={styles.recBody}>{rec.why}</Text>

      <Text style={styles.recLabel}>{rec.socialProofLabel ?? 'Travelers are saying'}</Text>
      <Text style={styles.recBody}>{rec.socialProof}</Text>

      {rec.tradeoff ? (
        <>
          <Text style={styles.recLabel}>{rec.tradeoffLabel ?? 'Tradeoff'}</Text>
          <Text style={styles.recBody}>{rec.tradeoff}</Text>
        </>
      ) : null}

      <View style={styles.usedRow}>
        <Stamp label={`${rec.usedPostIds.length} posts used`} tone="deep" />
      </View>

      <View style={styles.actions}>
        {rec.nextActions.map((a) => (
          <Pressable
            key={a.kind}
            style={styles.actionBtn}
            onPress={() => onAction(a.kind)}
          >
            {ACTION_ICONS[a.kind] ?? null}
            <Text style={styles.actionText}>{a.label}</Text>
          </Pressable>
        ))}
      </View>
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
  rec:           { backgroundColor: color.paperRaised, padding: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, ...shadow.card, gap: 4 },
  recPick:       { ...t.heading, color: color.ink, marginBottom: space.sm },
  recLabel:      { ...t.stamp, fontFamily: 'Courier', color: color.mute, marginTop: space.sm },
  recBody:       { ...t.body, color: color.ink },
  usedRow:       { flexDirection: 'row', marginTop: space.md },
  actions:       { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  actionBtn:     { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: color.ink },
  actionText:    { ...t.small, fontWeight: '700', color: color.onInk },
  inputBar:      { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderTopWidth: 1, borderTopColor: color.haze, backgroundColor: color.paper },
  input:         { flex: 1, ...t.body, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.md },
  sendBtn:       { width: 44, height: 44, borderRadius: 22, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.45 },
  layoverBtn:    { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1565C0', alignItems: 'center', justifyContent: 'center' },
});
