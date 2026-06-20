import React, { useRef, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Zap, Send } from 'lucide-react-native';
import { useThreadMessages, useLanguageSettings } from '../../src/hooks/useMessaging';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import type { Message } from '../../src/services/messaging';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function MessageBubble({
  item,
  mine,
  autoTranslate,
  defaultShowOriginal,
}: {
  item: Message;
  mine: boolean;
  autoTranslate: boolean;
  defaultShowOriginal: boolean;
}) {
  // Local toggle: starts at the user's global preference (show_original_messages).
  // If auto_translate_messages is off, always show original regardless.
  const [showOriginal, setShowOriginal] = useState(defaultShowOriginal || !autoTranslate);

  if (item.deleted) {
    return (
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
        <Text
          style={[
            styles.bubbleText,
            { fontStyle: 'italic', color: mine ? color.onInk + 'AA' : color.mute },
          ]}
        >
          This message was deleted.
        </Text>
      </View>
    );
  }

  // Decide what body to show.
  // - Sender sees their own body (no translation).
  // - If autoTranslate is off, show original.
  // - If showOriginal is toggled on, show originalBody.
  // - Otherwise show displayBody (translated if available, else original).
  let bodyToShow: string;
  if (mine || !autoTranslate || showOriginal) {
    bodyToShow = item.originalBody ?? item.body ?? '';
  } else {
    bodyToShow = item.displayBody ?? item.body ?? '';
  }

  const showLabel = !mine && item.translationStatus !== null && item.translationStatus !== 'skipped';
  const isTranslated = item.translated && autoTranslate && !showOriginal;
  const isFailed = item.translationStatus === 'failed';
  const isPending = item.translationStatus === 'pending';

  return (
    <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
      <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>
        {bodyToShow}
      </Text>

      <Text style={[styles.bubbleTime, mine && styles.bubbleTimeMine]}>
        {formatTime(item.createdAt)}
        {item.editedAt ? '  ·  edited' : ''}
      </Text>

      {showLabel && (
        <View style={styles.translationRow}>
          {isPending ? (
            <Text style={[styles.transLabel, mine && styles.transLabelMine]}>
              Translating…
            </Text>
          ) : isFailed ? (
            <Text style={[styles.transLabel, { color: color.mute }]}>
              Translation unavailable
            </Text>
          ) : isTranslated && item.translationLabel ? (
            <Text style={[styles.transLabel, mine && styles.transLabelMine]}>
              {item.translationLabel}
            </Text>
          ) : null}

          {item.canShowOriginal && autoTranslate && (
            <Pressable onPress={() => setShowOriginal((v) => !v)} hitSlop={8}>
              <Text style={[styles.transToggle, mine && styles.transToggleMine]}>
                {showOriginal ? 'Show translation' : 'Show original'}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

export default function TelegraphThread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { userId } = useSession();
  const { messages, loading, error, sending, send } = useThreadMessages(id ?? null);
  const { data: langSettings } = useLanguageSettings();
  const [input, setInput] = useState('');
  const listRef = useRef<FlatList>(null);

  // Resolve user's translation preferences (default: auto-translate on, don't default to original).
  const autoTranslate = langSettings?.auto_translate_messages ?? true;
  const defaultShowOriginal = langSettings?.show_original_messages ?? false;

  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages.length]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    await send(text);
    listRef.current?.scrollToEnd({ animated: true });
  }

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={20} color={color.ink} />
          </Pressable>
          <View style={styles.headerMeta}>
            <Text style={styles.headerName}>Chat</Text>
            <View style={styles.headerTagRow}>
              <Zap size={9} color={color.signal} fill={color.signal} />
              <Text style={styles.headerTag}>Telegraph</Text>
            </View>
          </View>
        </View>
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={20} color={color.ink} />
          </Pressable>
          <View style={styles.headerMeta}>
            <Text style={styles.headerName}>Chat</Text>
          </View>
        </View>
        <View style={styles.center}><Text style={styles.errText}>{error}</Text></View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <View style={styles.headerMeta}>
          <Text style={styles.headerName}>Chat</Text>
          <View style={styles.headerTagRow}>
            <Zap size={9} color={color.signal} fill={color.signal} />
            <Text style={styles.headerTag}>Telegraph</Text>
          </View>
        </View>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>No messages yet. Say hello!</Text>
          </View>
        }
        renderItem={({ item }) => {
          const mine = item.senderId === userId;
          return (
            <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
              <MessageBubble
                item={item}
                mine={mine}
                autoTranslate={autoTranslate}
                defaultShowOriginal={defaultShowOriginal}
              />
            </View>
          );
        }}
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
      />

      <View style={[styles.compose, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <TextInput
          style={styles.inputField}
          placeholder="Message…"
          placeholderTextColor={color.faint}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          returnKeyType="send"
          editable={!sending}
          multiline
        />
        <Pressable
          style={[styles.sendBtn, (input.trim() && !sending) ? styles.sendBtnActive : styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || sending}
        >
          {sending ? (
            <ActivityIndicator size="small" color={color.onInk} />
          ) : (
            <Send size={16} color={input.trim() ? color.onInk : color.faint} />
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errText: { ...t.body, color: color.mute },
  emptyText: { ...t.small, color: color.mute },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  backBtn: { padding: 4 },
  headerMeta: { flex: 1 },
  headerName: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  headerTagRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 3 },
  headerTag: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, letterSpacing: 0.4 },

  list: { paddingHorizontal: space.lg, paddingVertical: space.md },

  bubbleRow: { alignSelf: 'flex-start', maxWidth: '82%' },
  bubbleRowMine: { alignSelf: 'flex-end' },

  bubble: { borderRadius: radius.lg, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: 6 },
  bubbleOther: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderBottomLeftRadius: 4,
  },
  bubbleMine: { backgroundColor: color.signal, borderBottomRightRadius: 4 },

  bubbleText: { ...t.body, color: color.ink, lineHeight: 20 },
  bubbleTextMine: { color: color.onInk },

  bubbleTime: {
    ...t.stamp,
    fontFamily: 'Courier',
    color: color.faint,
    fontSize: 10,
    marginTop: 2,
    textAlign: 'right',
  },
  bubbleTimeMine: { color: color.onInk + '88' },

  translationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },

  transLabel: {
    fontSize: 10,
    color: color.mute,
    fontFamily: 'Courier',
    letterSpacing: 0.2,
    flexShrink: 1,
  },
  transLabelMine: { color: color.onInk + '99' },

  transToggle: {
    fontSize: 10,
    color: color.signal,
    fontFamily: 'Courier',
    textDecorationLine: 'underline',
  },
  transToggleMine: { color: color.onInk + 'CC' },

  compose: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  inputField: {
    flex: 1,
    minHeight: 38,
    maxHeight: 110,
    backgroundColor: color.paper,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    ...t.body,
    color: color.ink,
  },
  sendBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  sendBtnActive: { backgroundColor: color.signal },
  sendBtnDisabled: { backgroundColor: color.haze },
});
