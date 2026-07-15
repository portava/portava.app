import React, { useState } from 'react';
import { View, Text, ScrollView, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Send } from 'lucide-react-native';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { conversations, me } from '../../src/data/cebu';
import { color, space, radius, type as t } from '../../src/theme/tokens';

export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const convo = conversations.find((c) => c.id === id) ?? conversations[0];
  const other = convo.participants.find((p) => p.id !== me.id)!;
  const [msgs, setMsgs] = useState([{ id: 'm1', mine: false, body: convo.lastMessage }]);
  const [input, setInput] = useState('');
  function send() {
    if (!input.trim()) return;
    setMsgs((m) => [...m, { id: 'm' + Date.now(), mine: true, body: input.trim() }]);
    setInput('');
  }
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: color.paper }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title={other.name} back />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.sm }}>
        {msgs.map((m) => (
          <View key={m.id} style={[styles.bubble, m.mine ? styles.mine : styles.theirs]}>
            <Text style={[t.body, { color: m.mine ? color.onInk : color.ink }]}>{m.body}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={styles.bar}>
        <TextInput style={styles.input} placeholder="Message" placeholderTextColor={color.faint} value={input} onChangeText={setInput} onSubmitEditing={send} returnKeyType="send" />
        <Pressable style={styles.send} onPress={send}><Send size={18} color={color.onInk} /></Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  bubble: { maxWidth: '80%', paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.lg },
  mine: { alignSelf: 'flex-end', backgroundColor: color.ink, borderBottomRightRadius: 4 },
  theirs: { alignSelf: 'flex-start', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderBottomLeftRadius: 4 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md, borderTopWidth: 1, borderTopColor: color.haze },
  input: { flex: 1, ...t.body, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.md },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
});
