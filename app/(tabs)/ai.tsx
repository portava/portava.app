import React, { useState, useRef } from 'react';
import { View, Text, ScrollView, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { Sparkles, Send } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { Stamp } from '../../src/components/ui';
import { aiOpening } from '../../src/data/cebu';
import type { ChatMessage, AiRecommendation } from '../../src/types/models';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

/** Mock assistant: social-first reply shape. Swap for API call later. */
function mockReply(prompt: string): ChatMessage {
  const rec: AiRecommendation = {
    id: 'r_' + Date.now(),
    bestPick: 'Base in Mactan, one night downtown',
    why: 'You picked beach + nightlife. Mactan covers beach and diving; Cebu City and IT Park cover the nights.',
    socialProof: 'Maya’s 6am Mactan post and Kojo’s IT Park loop are the most-saved this week.',
    tradeoff: 'Moalboal is stunning but ~3h each way — great as one day trip, not a base.',
    usedPostIds: ['p_1', 'p_2', 'p_5'],
    nextActions: [
      { label: 'Add to trip', kind: 'addTrip' },
      { label: 'Build itinerary', kind: 'buildItinerary' },
      { label: 'Ask community', kind: 'askCommunity' },
    ],
  };
  return { id: 'a_' + Date.now(), role: 'assistant', text: '', recommendation: rec };
}

export default function AiChat() {
  const [msgs, setMsgs] = useState<ChatMessage[]>(aiOpening);
  const [input, setInput] = useState('');
  const scroll = useRef<ScrollView>(null);

  function send() {
    if (!input.trim()) return;
    const user: ChatMessage = { id: 'u_' + Date.now(), role: 'user', text: input.trim() };
    const reply = mockReply(input.trim());
    setMsgs((m) => [...m, user, reply]);
    setInput('');
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 80);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.paper }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title="AI Buddy" back />
      <ScrollView ref={scroll} contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xl }}>
        {msgs.map((m) =>
          m.role === 'user' ? (
            <View key={m.id} style={styles.userBubble}><Text style={styles.userText}>{m.text}</Text></View>
          ) : m.recommendation ? (
            <RecCard key={m.id} rec={m.recommendation} />
          ) : (
            <View key={m.id} style={styles.aiBubble}>
              <View style={styles.aiHead}><Sparkles size={15} color={color.signal} /><Text style={styles.aiHeadText}>AI BUDDY</Text></View>
              <Text style={styles.aiText}>{m.text}</Text>
            </View>
          )
        )}
      </ScrollView>
      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          placeholder="Ask about Cebu, your saves, or a plan…"
          placeholderTextColor={color.faint}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={send}
          returnKeyType="send"
        />
        <Pressable style={styles.sendBtn} onPress={send}><Send size={18} color={color.onInk} /></Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function RecCard({ rec }: { rec: AiRecommendation }) {
  return (
    <View style={styles.rec}>
      <View style={styles.aiHead}><Sparkles size={15} color={color.signal} /><Text style={styles.aiHeadText}>BEST PICK</Text></View>
      <Text style={styles.recPick}>{rec.bestPick}</Text>
      <Text style={styles.recLabel}>Why</Text><Text style={styles.recBody}>{rec.why}</Text>
      <Text style={styles.recLabel}>Travelers are saying</Text><Text style={styles.recBody}>{rec.socialProof}</Text>
      {rec.tradeoff && (<><Text style={styles.recLabel}>Tradeoff</Text><Text style={styles.recBody}>{rec.tradeoff}</Text></>)}
      <View style={styles.usedRow}>
        <Stamp label={`${rec.usedPostIds.length} posts used`} tone="deep" />
      </View>
      <View style={styles.actions}>
        {rec.nextActions.map((a) => (
          <Pressable key={a.kind} style={styles.actionBtn}><Text style={styles.actionText}>{a.label}</Text></Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  userBubble: { alignSelf: 'flex-end', maxWidth: '82%', backgroundColor: color.ink, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.lg, borderBottomRightRadius: 4 },
  userText: { ...t.body, color: color.onInk },
  aiBubble: { alignSelf: 'flex-start', maxWidth: '90%', backgroundColor: color.paperRaised, padding: space.lg, borderRadius: radius.lg, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: color.haze },
  aiHead: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: space.sm },
  aiHeadText: { ...t.stamp, fontFamily: 'Courier', color: color.signal },
  aiText: { ...t.body, color: color.ink },
  rec: { backgroundColor: color.paperRaised, padding: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, ...shadow.card, gap: 4 },
  recPick: { ...t.heading, color: color.ink, marginBottom: space.sm },
  recLabel: { ...t.stamp, fontFamily: 'Courier', color: color.mute, marginTop: space.sm },
  recBody: { ...t.body, color: color.ink },
  usedRow: { flexDirection: 'row', marginTop: space.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md },
  actionBtn: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: color.ink },
  actionText: { ...t.small, fontWeight: '700', color: color.onInk },
  inputBar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderTopWidth: 1, borderTopColor: color.haze, backgroundColor: color.paper },
  input: { flex: 1, ...t.body, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.md },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
});
