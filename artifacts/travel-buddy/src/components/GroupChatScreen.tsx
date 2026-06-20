/**
 * GroupChatScreen — reusable group chat UI for trip and circle contexts.
 *
 * Handles all 5 states:
 *   loading, empty, no-access (removed), pending-invite, error
 *
 * Reuses the MessageBubble shape from direct messages.
 * Keyboard-safe composer — stays above keyboard on iOS and Android.
 * Fits 390 px and 430 px viewports.
 */
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
  Image,
} from 'react-native';
import { router } from 'expo-router';
import { ArrowLeft, Send, Users } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useGroupChat } from '../hooks/useGroupChat';
import { useSession } from '../context/SessionContext';
import { color, space, radius, type as t } from '../theme/tokens';
import type { Message } from '../services/messaging';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function GroupMessageBubble({
  item,
  mine,
}: {
  item: Message;
  mine: boolean;
}) {
  if (item.deleted) {
    return (
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
        <Text style={[styles.bubbleText, { fontStyle: 'italic', color: mine ? color.onInk + 'AA' : color.mute }]}>
          This message was deleted.
        </Text>
      </View>
    );
  }

  const bodyToShow = item.displayBody ?? item.body ?? '';

  return (
    <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
      {!mine && item.senderName ? (
        <Text style={styles.senderName}>{item.senderName}</Text>
      ) : null}
      <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{bodyToShow}</Text>
      <Text style={[styles.bubbleTime, mine && styles.bubbleTimeMine]}>
        {formatTime(item.createdAt)}
        {item.editedAt ? '  ·  edited' : ''}
      </Text>
    </View>
  );
}

interface Props {
  type: 'trip' | 'circle';
  id: string;
  title?: string;
  memberLabel?: string;
}

export function GroupChatScreen({ type, id, title, memberLabel }: Props) {
  const insets = useSafeAreaInsets();
  const { userId } = useSession();
  const { state, thread, messages, sending, errorMessage, reload, send } = useGroupChat(type, id);
  const [input, setInput] = useState('');
  const listRef = useRef<FlatList>(null);

  const displayTitle = thread?.title ?? title ?? (type === 'trip' ? 'Trip Chat' : 'Circle Chat');
  const isNoAccess = state === 'no_access' || thread?.memberAccess === 'removed';

  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages.length]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending || isNoAccess) return;
    setInput('');
    await send(text);
    listRef.current?.scrollToEnd({ animated: true });
  }

  const Header = (
    <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
      <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
        <ArrowLeft size={20} color={color.ink} />
      </Pressable>
      <View style={styles.headerMeta}>
        <Text style={styles.headerName} numberOfLines={1}>{displayTitle}</Text>
        {memberLabel ? (
          <View style={styles.headerTagRow}>
            <Users size={9} color={color.mute} />
            <Text style={styles.headerTag}>{memberLabel}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );

  if (state === 'loading') {
    return (
      <View style={styles.screen}>
        {Header}
        <View style={styles.center}>
          <ActivityIndicator color={color.signal} />
        </View>
      </View>
    );
  }

  if (state === 'pending_invite') {
    return (
      <View style={styles.screen}>
        {Header}
        <View style={styles.center}>
          <Text style={styles.stateIcon}>✉️</Text>
          <Text style={styles.stateTitle}>Invite Pending</Text>
          <Text style={styles.stateNote}>Accept the invite to join this chat.</Text>
        </View>
      </View>
    );
  }

  if (state === 'no_access') {
    return (
      <View style={styles.screen}>
        {Header}
        <View style={styles.center}>
          <Text style={styles.stateIcon}>🔒</Text>
          <Text style={styles.stateTitle}>No longer a member</Text>
          <Text style={styles.stateNote}>You no longer have access to this chat.</Text>
        </View>
      </View>
    );
  }

  if (state === 'error') {
    return (
      <View style={styles.screen}>
        {Header}
        <View style={styles.center}>
          <Text style={styles.stateNote}>{errorMessage ?? "Couldn't load chat. Try again."}</Text>
          <Pressable style={styles.retryBtn} onPress={reload}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {Header}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyIcon}>💬</Text>
            <Text style={styles.stateTitle}>Start the conversation</Text>
            <Text style={styles.stateNote}>
              {type === 'trip'
                ? 'Start the trip conversation.'
                : 'Say something to your circle.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const mine = item.senderId === userId;
          return (
            <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
              {!mine && (
                <View style={[styles.avatar, styles.avatarSmall]}>
                  {item.senderAvatarUrl ? (
                    <Image source={{ uri: item.senderAvatarUrl }} style={styles.avatarSmall} />
                  ) : (
                    <Text style={styles.avatarInitial}>
                      {(item.senderName?.[0] ?? '?').toUpperCase()}
                    </Text>
                  )}
                </View>
              )}
              <GroupMessageBubble item={item} mine={mine} />
            </View>
          );
        }}
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
      />

      <View style={[styles.compose, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        {isNoAccess ? (
          <View style={styles.noAccessBar}>
            <Text style={styles.noAccessText}>You no longer have access to this chat.</Text>
          </View>
        ) : (
          <>
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
              style={[
                styles.sendBtn,
                (input.trim() && !sending) ? styles.sendBtnActive : styles.sendBtnDisabled,
              ]}
              onPress={handleSend}
              disabled={!input.trim() || sending}
            >
              {sending ? (
                <ActivityIndicator size="small" color={color.onInk} />
              ) : (
                <Send size={16} color={input.trim() ? color.onInk : color.faint} />
              )}
            </Pressable>
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },

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
  backBtn: { padding: 4, flexShrink: 0 },
  headerMeta: { flex: 1, minWidth: 0 },
  headerName: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  headerTagRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 3 },
  headerTag: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, letterSpacing: 0.4 },

  stateIcon: { fontSize: 36, marginBottom: space.md },
  stateTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center', marginBottom: space.sm },
  stateNote: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 20 },

  retryBtn: {
    marginTop: space.lg,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    backgroundColor: color.signal,
    borderRadius: radius.pill,
  },
  retryText: { ...t.bodyStrong, color: color.onInk },

  emptyIcon: { fontSize: 32, marginBottom: space.md },

  list: { paddingHorizontal: space.lg, paddingVertical: space.md, flexGrow: 1 },

  bubbleRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, maxWidth: '86%' },
  bubbleRowMine: { alignSelf: 'flex-end', flexDirection: 'row-reverse' },

  avatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: color.haze, overflow: 'hidden', flexShrink: 0 },
  avatarSmall: { width: 28, height: 28, borderRadius: 14 },
  avatarInitial: { fontSize: 12, color: color.ink, textAlign: 'center', lineHeight: 28 },

  bubble: {
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: 6,
    flexShrink: 1,
    maxWidth: '100%',
  },
  bubbleOther: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderBottomLeftRadius: 4,
  },
  bubbleMine: { backgroundColor: color.signal, borderBottomRightRadius: 4 },

  senderName: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, marginBottom: 2, letterSpacing: 0.2 },

  bubbleText: { ...t.body, color: color.ink, lineHeight: 20, flexWrap: 'wrap' },
  bubbleTextMine: { color: color.onInk },

  bubbleTime: { ...t.stamp, fontFamily: 'Courier', color: color.faint, fontSize: 10, marginTop: 2, textAlign: 'right' },
  bubbleTimeMine: { color: color.onInk + '88' },

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

  noAccessBar: {
    flex: 1,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  noAccessText: { ...t.small, color: color.mute, textAlign: 'center' },
});
