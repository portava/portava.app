/**
 * Telegraph Thread — upgraded DM thread with structured message types.
 *
 * Renders six message kinds:
 *   user_message            — standard chat bubble
 *   translated_user_message — bubble + auto-translation badge
 *   ai_activity_recommendation — TelegraphRecommendationCard
 *   activity_invite         — TelegraphActivityInviteCard
 *   add_to_plan_confirmation — compact confirmation card
 *   system_notice           — centered TelegraphSystemNotice pill
 *
 * The ⚡ button in the compose bar calls POST /api/telegraph/recommend
 * and inserts the returned ActivityRecommendations inline in the thread.
 */
import React, { useState, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList,
  KeyboardAvoidingView, Platform, StyleSheet, Alert,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Zap, Send, Globe, Check } from 'lucide-react-native';
import { conversations, telegraphMessages, me } from '../../src/data/cebu';
import type { TelegraphMessage, TelegraphActivityRecommendation } from '../../src/types/models';
import { TelegraphRecommendationCard } from '../../src/components/TelegraphRecommendationCard';
import { TelegraphSystemNotice } from '../../src/components/TelegraphSystemNotice';
import { TelegraphActivityInviteCard } from '../../src/components/TelegraphActivityInviteCard';
import { getActivityRecommendations } from '../../src/services/telegraph';
import { color, space, radius, type as t } from '../../src/theme/tokens';

const LANG_NAME: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German',
  ja: 'Japanese', ko: 'Korean', zh: 'Chinese', pt: 'Portuguese',
  it: 'Italian', ru: 'Russian', ar: 'Arabic', th: 'Thai',
  vi: 'Vietnamese', id: 'Indonesian', tl: 'Filipino',
  sv: 'Swedish', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', hi: 'Hindi',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* ─── Translation badge ─── */
function TranslationBadge({
  sourceLanguage, targetLanguage, showOriginal, onToggle,
}: {
  sourceLanguage?: string;
  targetLanguage?: string;
  showOriginal: boolean;
  onToggle: () => void;
}) {
  if (!sourceLanguage || !targetLanguage || sourceLanguage === targetLanguage) return null;
  const fromName = LANG_NAME[sourceLanguage] ?? sourceLanguage.toUpperCase();
  const toName = LANG_NAME[targetLanguage] ?? targetLanguage.toUpperCase();
  return (
    <Pressable style={styles.translationBadge} onPress={onToggle}>
      <Globe size={10} color={color.signal} />
      <Text style={styles.translationBadgeText}>
        {showOriginal
          ? `Show ${toName} translation`
          : `Translated from ${fromName}`}
      </Text>
    </Pressable>
  );
}

/* ─── User/translated message bubble ─── */
function UserMessageBubble({ msg, isMine }: { msg: TelegraphMessage; isMine: boolean }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const isTranslated = msg.kind === 'translated_user_message' && msg.translationStatus === 'done' && msg.translatedText;
  const displayText = isTranslated && !showOriginal ? msg.translatedText! : (msg.originalText ?? '');

  return (
    <View style={[styles.bubbleRow, isMine && styles.bubbleRowMine]}>
      <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleOther]}>
        <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>
          {displayText}
        </Text>
        <Text style={[styles.bubbleTime, isMine && styles.bubbleTimeMine]}>
          {formatTime(msg.createdAt)}
        </Text>
      </View>
      {isTranslated && (
        <TranslationBadge
          sourceLanguage={msg.sourceLanguage}
          targetLanguage={msg.targetLanguage}
          showOriginal={showOriginal}
          onToggle={() => setShowOriginal((v) => !v)}
        />
      )}
    </View>
  );
}

/* ─── Add-to-plan confirmation card ─── */
function AddToPlanCard({ msg }: { msg: TelegraphMessage }) {
  return (
    <View style={styles.bubbleRowMineCenter}>
      <View style={styles.planCard}>
        <View style={styles.planRow}>
          <Check size={13} color="#2E7D5B" />
          <Text style={styles.planTitle}>
            {msg.planConfirmed ? 'Added to trip plan' : 'Saving to plan…'}
          </Text>
        </View>
        {msg.planItemTitle ? <Text style={styles.planItem}>{msg.planItemTitle}</Text> : null}
      </View>
    </View>
  );
}

/* ─── Message renderer (switches on kind) ─── */
function MessageRow({
  msg, myId, onDismissRec, onAddToTrip, onInviteAccept, onInviteDecline,
}: {
  msg: TelegraphMessage;
  myId: string;
  onDismissRec: (id: string) => void;
  onAddToTrip: (rec: TelegraphActivityRecommendation) => void;
  onInviteAccept: (msgId: string) => void;
  onInviteDecline: (msgId: string) => void;
}) {
  const isMine = msg.senderId === myId;

  switch (msg.kind) {
    case 'user_message':
    case 'translated_user_message':
      return <UserMessageBubble msg={msg} isMine={isMine} />;

    case 'ai_activity_recommendation':
      if (!msg.recommendation) return null;
      return (
        <View style={styles.recWrap}>
          <TelegraphRecommendationCard
            rec={msg.recommendation}
            onAddToTrip={onAddToTrip}
            onDismiss={onDismissRec}
          />
        </View>
      );

    case 'activity_invite':
      return (
        <TelegraphActivityInviteCard
          activityTitle={msg.activityTitle ?? 'Activity'}
          activityTime={msg.activityTime}
          inviteStatus={msg.inviteStatus ?? 'pending'}
          isMine={isMine}
          onAccept={() => onInviteAccept(msg.id)}
          onDecline={() => onInviteDecline(msg.id)}
        />
      );

    case 'add_to_plan_confirmation':
      return <AddToPlanCard msg={msg} />;

    case 'system_notice':
      return <TelegraphSystemNotice text={msg.noticeText ?? ''} />;

    default:
      return null;
  }
}

/* ─── Screen ─── */
export default function TelegraphThread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();

  const convo = conversations.find((c) => c.id === id);
  const other = convo?.participants.find((p) => p.id !== me.id);

  const seedMessages: TelegraphMessage[] = convo
    ? (telegraphMessages[convo.id] ?? [
        {
          id: 'seed_fallback',
          kind: 'user_message' as const,
          senderId: other?.id ?? 'unknown',
          recipientId: me.id,
          originalText: convo.lastMessage,
          translationStatus: 'not_needed' as const,
          createdAt: convo.lastAt,
        },
      ])
    : [];

  const [messages, setMessages] = useState<TelegraphMessage[]>(seedMessages);
  const [draft, setDraft] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const listRef = useRef<FlatList>(null);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  }, []);

  /* ── Send user_message ── */
  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    const newMsg: TelegraphMessage = {
      id: `tm_local_${Date.now()}`,
      kind: 'user_message',
      senderId: me.id,
      recipientId: other?.id ?? 'unknown',
      originalText: text,
      translationStatus: 'not_needed',
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, newMsg]);
    setDraft('');
    scrollToBottom();
  }, [draft, other, scrollToBottom]);

  /* ── ⚡ Telegraph Suggest ── */
  const handleSuggest = useCallback(async () => {
    if (suggesting) return;
    setSuggesting(true);

    const loadingId = `tm_loading_${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        id: loadingId,
        kind: 'system_notice' as const,
        senderId: 'telegraph_system',
        recipientId: me.id,
        noticeText: '⚡ Telegraph is reading your trip profile…',
        createdAt: new Date().toISOString(),
      },
    ]);
    scrollToBottom();

    try {
      const recentContext = messages
        .filter((m) => (m.kind === 'user_message' || m.kind === 'translated_user_message') && m.originalText)
        .slice(-4)
        .map((m) => m.originalText)
        .join(' / ');

      const result = await getActivityRecommendations({
        interests: me.interests,
        travelStyle: me.travelStyle,
        destination: 'Cebu, Philippines',
        conversationContext: recentContext || undefined,
        recipientName: other?.name,
        count: 3,
      });

      setMessages((prev) => {
        const without = prev.filter((m) => m.id !== loadingId);
        if (!result.recommendations.length) {
          return [
            ...without,
            {
              id: `tm_empty_${Date.now()}`,
              kind: 'system_notice' as const,
              senderId: 'telegraph_system',
              recipientId: me.id,
              noticeText: 'No suggestions available for this context.',
              createdAt: new Date().toISOString(),
            },
          ];
        }
        const recMsgs: TelegraphMessage[] = result.recommendations.map((rec) => ({
          id: `tm_rec_${rec.id}`,
          kind: 'ai_activity_recommendation' as const,
          senderId: 'telegraph_system',
          recipientId: me.id,
          recommendation: rec,
          recommendationReason: 'Suggested for your Cebu trip',
          createdAt: new Date().toISOString(),
        }));
        return [...without, ...recMsgs];
      });
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== loadingId));
    } finally {
      setSuggesting(false);
      scrollToBottom();
    }
  }, [suggesting, messages, other, scrollToBottom]);

  /* ── Dismiss recommendation ── */
  const handleDismissRec = useCallback((recId: string) => {
    setMessages((prev) =>
      prev.filter((m) => !(m.kind === 'ai_activity_recommendation' && m.recommendation?.id === recId))
    );
  }, []);

  /* ── Add to Trip ── */
  const handleAddToTrip = useCallback((rec: TelegraphActivityRecommendation) => {
    const confirmMsg: TelegraphMessage = {
      id: `tm_plan_${Date.now()}`,
      kind: 'add_to_plan_confirmation',
      senderId: me.id,
      recipientId: other?.id ?? 'unknown',
      planItemTitle: rec.title,
      planConfirmed: true,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, confirmMsg]);
    scrollToBottom();
    Alert.alert('Added to Trip', `"${rec.title}" has been saved to your trip plan.`);
  }, [other, scrollToBottom]);

  /* ── Activity invite responses ── */
  const handleInviteAccept = useCallback((msgId: string) => {
    setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, inviteStatus: 'accepted' as const } : m));
  }, []);
  const handleInviteDecline = useCallback((msgId: string) => {
    setMessages((prev) => prev.map((m) => m.id === msgId ? { ...m, inviteStatus: 'declined' as const } : m));
  }, []);

  if (!convo || !other) {
    return (
      <View style={styles.missing}>
        <Text style={styles.missingText}>Conversation not found</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <View style={styles.headerMeta}>
          <Text style={styles.headerName}>{other.name}</Text>
          <View style={styles.headerTagRow}>
            <Zap size={9} color={color.signal} fill={color.signal} />
            <Text style={styles.headerTag}>Telegraph</Text>
            {other.defaultLanguage && other.defaultLanguage !== (me.defaultLanguage ?? 'en') && (
              <>
                <Text style={styles.headerDot}> · </Text>
                <Globe size={9} color={color.mute} />
                <Text style={styles.headerTag}>Auto-translate</Text>
              </>
            )}
          </View>
        </View>
      </View>

      {/* ── Message list ── */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <MessageRow
            msg={item}
            myId={me.id}
            onDismissRec={handleDismissRec}
            onAddToTrip={handleAddToTrip}
            onInviteAccept={handleInviteAccept}
            onInviteDecline={handleInviteDecline}
          />
        )}
        onLayout={scrollToBottom}
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
      />

      {/* ── Compose bar ── */}
      <View style={[styles.compose, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <Pressable
          style={[styles.suggestBtn, suggesting && styles.suggestBtnActive]}
          onPress={handleSuggest}
          disabled={suggesting}
          accessibilityLabel="Get Telegraph suggestions"
        >
          <Zap size={16} color={suggesting ? color.signal : color.mute} />
        </Pressable>

        <TextInput
          style={styles.inputField}
          placeholder="Message…"
          placeholderTextColor={color.faint}
          value={draft}
          onChangeText={setDraft}
          multiline
        />

        <Pressable
          style={[styles.sendBtn, draft.trim() ? styles.sendBtnActive : styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!draft.trim()}
        >
          <Send size={16} color={draft.trim() ? color.onInk : color.faint} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.paper },

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
  headerTagRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  headerTag: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, letterSpacing: 0.4 },
  headerDot: { ...t.small, color: color.faint, fontSize: 10 },

  list: { paddingHorizontal: space.lg, paddingVertical: space.md },

  /* Bubbles */
  bubbleRow: { alignSelf: 'flex-start', maxWidth: '80%' },
  bubbleRowMine: { alignSelf: 'flex-end' },
  bubbleRowMineCenter: { alignSelf: 'flex-end', maxWidth: '75%' },
  bubble: { borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm },
  bubbleOther: {
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderBottomLeftRadius: 4,
  },
  bubbleMine: { backgroundColor: color.signal, borderBottomRightRadius: 4 },
  bubbleText: { ...t.body, color: color.ink, lineHeight: 20 },
  bubbleTextMine: { color: color.onInk },
  bubbleTime: { ...t.stamp, fontFamily: 'Courier', color: color.faint, fontSize: 10, marginTop: 2, textAlign: 'right' },
  bubbleTimeMine: { color: color.onInk + '88' },

  /* Translation badge */
  translationBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingTop: 3,
  },
  translationBadgeText: { ...t.small, color: color.signal, fontSize: 10, fontFamily: 'Courier' },

  /* Rec / invite wrappers */
  recWrap: { alignSelf: 'flex-start' },

  /* Plan confirmation */
  planCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    borderLeftWidth: 3,
    borderLeftColor: '#2E7D5B',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 3,
  },
  planRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  planTitle: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  planItem: { ...t.small, color: color.mute, paddingLeft: 20 },

  /* Compose */
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
  suggestBtn: {
    width: 38, height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
  },
  suggestBtnActive: { borderColor: color.signal, backgroundColor: color.signal + '15' },
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

  /* Fallback */
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  missingText: { ...t.body, color: color.mute },
});
