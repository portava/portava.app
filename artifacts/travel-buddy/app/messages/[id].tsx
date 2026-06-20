import React, { useRef, useEffect, useState, useCallback } from 'react';
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
  Alert,
  Modal,
  ScrollView,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Zap, Send, Users, Globe, Check } from 'lucide-react-native';
import { useThreadMessages, useLanguageSettings } from '../../src/hooks/useMessaging';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { TelegraphSuggestionTray } from '../../src/components/TelegraphSuggestionTray';
import type { Message } from '../../src/services/messaging';
import type { TelegraphSuggestion, MeetupPrefill } from '../../src/services/telegraphChat';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function MessageBubble({
  item,
  mine,
  autoTranslate,
  defaultShowOriginal,
  isGroupThread,
}: {
  item: Message;
  mine: boolean;
  autoTranslate: boolean;
  defaultShowOriginal: boolean;
  isGroupThread: boolean;
}) {
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
    <View>
      {isGroupThread && !mine && item.senderName && (
        <Text style={styles.senderLabel}>
          {item.senderName}
          {item.senderHandle ? ` @${item.senderHandle}` : ''}
        </Text>
      )}
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
    </View>
  );
}

// ── Add-to-Plan sheet ─────────────────────────────────────────────────────────

function AddToPlanSheet({
  visible,
  suggestion,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  suggestion: TelegraphSuggestion | null;
  onClose: () => void;
  onConfirm: (tripId: string) => void;
}) {
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);

  if (!suggestion) return null;

  function handleConfirm() {
    if (!selectedTripId) {
      Alert.alert('Select a trip', 'Please choose a trip to add this to.');
      return;
    }
    onConfirm(selectedTripId);
    setSelectedTripId(null);
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={sheetStyles.overlay} onPress={onClose} />
      <View style={sheetStyles.sheet}>
        <View style={sheetStyles.handle} />
        <Text style={sheetStyles.title}>Add to Trip Plan</Text>
        <Text style={sheetStyles.subtitle} numberOfLines={2}>
          {suggestion.title}
        </Text>

        <Text style={sheetStyles.sectionLabel}>Choose your trip</Text>
        <View style={sheetStyles.tripOption}>
          <Text style={sheetStyles.tripName}>My Trip</Text>
          <Pressable
            style={[
              sheetStyles.radioBtn,
              selectedTripId === 'current' && sheetStyles.radioBtnSelected,
            ]}
            onPress={() => setSelectedTripId('current')}
          >
            {selectedTripId === 'current' && <Check size={12} color={color.onInk} />}
          </Pressable>
        </View>

        <Text style={sheetStyles.hint}>
          To add to a specific trip, open the trip chat and use the suggestion there.
        </Text>

        <Pressable style={sheetStyles.confirmBtn} onPress={handleConfirm}>
          <Text style={sheetStyles.confirmLabel}>Add to Plan</Text>
        </Pressable>
        <Pressable style={sheetStyles.cancelBtn} onPress={onClose}>
          <Text style={sheetStyles.cancelLabel}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

// ── Create Meetup sheet ───────────────────────────────────────────────────────

function CreateMeetupSheet({
  visible,
  prefill,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  prefill: MeetupPrefill | null;
  onClose: () => void;
  onConfirm: (title: string, location: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');

  useEffect(() => {
    if (prefill) {
      setTitle(prefill.title);
      setLocation(prefill.location);
    }
  }, [prefill]);

  if (!prefill) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={sheetStyles.overlay} onPress={onClose} />
      <View style={sheetStyles.sheet}>
        <View style={sheetStyles.handle} />
        <Text style={sheetStyles.title}>Create Meetup</Text>

        <Text style={sheetStyles.sectionLabel}>Title</Text>
        <TextInput
          style={sheetStyles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="Meetup title"
          placeholderTextColor={color.faint}
        />

        <Text style={sheetStyles.sectionLabel}>Location</Text>
        <TextInput
          style={sheetStyles.input}
          value={location}
          onChangeText={setLocation}
          placeholder="Where?"
          placeholderTextColor={color.faint}
        />

        {prefill.suggestedTime && (
          <Text style={sheetStyles.hint}>Suggested time: {prefill.suggestedTime}</Text>
        )}

        <Pressable
          style={sheetStyles.confirmBtn}
          onPress={() => {
            if (!title.trim()) {
              Alert.alert('Add a title', 'Please enter a title for the meetup.');
              return;
            }
            onConfirm(title.trim(), location.trim());
          }}
        >
          <Text style={sheetStyles.confirmLabel}>Create Meetup</Text>
        </Pressable>
        <Pressable style={sheetStyles.cancelBtn} onPress={onClose}>
          <Text style={sheetStyles.cancelLabel}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function TelegraphThread() {
  const { id, title, threadType } = useLocalSearchParams<{ id: string; title?: string; threadType?: string }>();
  const insets = useSafeAreaInsets();
  const { userId } = useSession();
  const { messages, loading, error, sending, send } = useThreadMessages(id ?? null);
  const { data: langSettings } = useLanguageSettings();
  const [input, setInput] = useState('');
  const [lastSentMessage, setLastSentMessage] = useState<string | undefined>(undefined);
  const [addToPlanSuggestion, setAddToPlanSuggestion] = useState<TelegraphSuggestion | null>(null);
  const [meetupPrefill, setMeetupPrefill] = useState<MeetupPrefill | null>(null);
  const listRef = useRef<FlatList>(null);

  const autoTranslate = langSettings?.auto_translate_messages ?? true;
  const defaultShowOriginal = langSettings?.show_original_messages ?? false;
  const isGroupThread = threadType === 'trip' || threadType === 'circle';

  const headerTitle = title && title.trim() ? title : 'Chat';
  const HeaderIcon = threadType === 'trip' ? Globe : threadType === 'circle' ? Users : null;

  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages.length]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setLastSentMessage(text);
    await send(text);
    listRef.current?.scrollToEnd({ animated: true });
  }

  const handleAddToPlan = useCallback(
    async (suggestion: TelegraphSuggestion): Promise<string | null> => {
      return new Promise((resolve) => {
        setAddToPlanSuggestion(suggestion);
        // The sheet calls resolve via onConfirm; we store the resolver to call later
        // Simplified: we use inline Alert for trip selection in DM threads
        if (threadType !== 'trip') {
          Alert.alert(
            'Add to Trip Plan',
            `Add "${suggestion.title}" to your trip plan?`,
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
              {
                text: 'Add',
                onPress: () => {
                  setAddToPlanSuggestion(null);
                  resolve('current');
                },
              },
            ],
          );
        } else {
          resolve(id ?? null);
          setAddToPlanSuggestion(null);
        }
      });
    },
    [threadType, id],
  );

  const handleCreateMeetup = useCallback((prefill: MeetupPrefill) => {
    setMeetupPrefill(prefill);
  }, []);

  const handleViewPlace = useCallback((suggestion: TelegraphSuggestion) => {
    Alert.alert(
      suggestion.title,
      suggestion.reason + (suggestion.location_context ? `\n\n📍 ${suggestion.location_context}` : ''),
      [{ text: 'OK' }],
    );
  }, []);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={20} color={color.ink} />
          </Pressable>
          <View style={styles.headerMeta}>
            <Text style={styles.headerName}>{headerTitle}</Text>
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
            <Text style={styles.headerName}>{headerTitle}</Text>
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
        {HeaderIcon && (
          <View style={styles.headerIconBadge}>
            <HeaderIcon size={14} color={color.onInk} />
          </View>
        )}
        <View style={styles.headerMeta}>
          <Text style={styles.headerName} numberOfLines={1}>{headerTitle}</Text>
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
                isGroupThread={isGroupThread}
              />
            </View>
          );
        }}
        onLayout={() => listRef.current?.scrollToEnd({ animated: false })}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
      />

      {/* Telegraph suggestion tray — above the composer */}
      {id && (
        <TelegraphSuggestionTray
          threadId={id}
          lastSentMessage={lastSentMessage}
          onAddToPlan={handleAddToPlan}
          onCreateMeetup={handleCreateMeetup}
          onViewPlace={handleViewPlace}
        />
      )}

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

      {/* Create Meetup sheet */}
      <CreateMeetupSheet
        visible={!!meetupPrefill}
        prefill={meetupPrefill}
        onClose={() => setMeetupPrefill(null)}
        onConfirm={(t, l) => {
          setMeetupPrefill(null);
          Alert.alert('Meetup created!', `"${t}" at ${l || 'TBD'}`);
        }}
      />
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
  headerIconBadge: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headerMeta: { flex: 1 },
  headerName: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  headerTagRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2, gap: 3 },
  headerTag: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, letterSpacing: 0.4 },

  senderLabel: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    fontFamily: 'Courier',
    marginBottom: 2,
    marginLeft: 2,
  },

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

const sheetStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: space.xl,
    paddingBottom: 40,
    gap: space.sm,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginBottom: space.md,
  },
  title: { ...t.heading, color: color.ink, fontWeight: '700', fontSize: 18 },
  subtitle: { ...t.body, color: color.mute, fontSize: 13 },
  sectionLabel: { ...t.stamp, fontFamily: 'Courier', fontSize: 11, color: color.mute, marginTop: space.md, letterSpacing: 0.5 },
  tripOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: space.sm },
  tripName: { ...t.body, color: color.ink },
  radioBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioBtnSelected: { backgroundColor: color.signal, borderColor: color.signal },
  hint: { ...t.small, color: color.mute, fontSize: 12 },
  input: {
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    ...t.body,
    color: color.ink,
  },
  confirmBtn: {
    marginTop: space.md,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  confirmLabel: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
  cancelBtn: { paddingVertical: 10, alignItems: 'center' },
  cancelLabel: { ...t.body, color: color.mute },
});
