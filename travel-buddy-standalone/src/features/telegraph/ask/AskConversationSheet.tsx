/**
 * Telegraph §21 "Ask this conversation" — WP-08 / TEL-F16.
 *
 * "When did we agree to meet?" answered from THIS conversation only, through
 * `askConversation` → `GET /api/threads/:id/ask`. The server resolves the
 * caller's own membership and §14.3 window before it retrieves anything, so
 * the answer can never cite a message the person could not scroll to.
 *
 * §21 prefers structured plans, places and decisions over inferred prose, and
 * the server returns them as two fields for that reason. The sheet keeps the
 * order: "From plans and places" first, then "From messages".
 *
 * FOUR OUTCOMES, KEPT APART
 *   - an answer (either list non-empty);
 *   - nothing matched, and the search was complete: said plainly;
 *   - nothing matched, but the search was DEGRADED: said as a floor — "we could
 *     not search all of this conversation" — never as "nothing matched",
 *     which would tell the person their own message does not exist;
 *   - the request failed: the reason and Try again.
 */
import React, { useState } from 'react';
import { Modal, Pressable, Text, TextInput, View, ActivityIndicator, ScrollView } from 'react-native';
import { color } from '../../../theme/tokens.ts';
import { askConversation, type TelegraphSearchError } from '../services/telegraphSearch.ts';
import type { SearchHit } from '../types/index.ts';
import { sheet } from '../messageActions/sheetStyles.ts';

export interface AskConversationSheetProps {
  visible: boolean;
  threadId: string;
  onClose: () => void;
  /** Optional: jump to the cited message. */
  onOpenMessage?: (hit: SearchHit) => void;
}

type Answer = { structured: SearchHit[]; prose: SearchHit[]; degraded: boolean };

export function askErrorCopy(e: TelegraphSearchError | undefined): string {
  switch (e) {
    case 'query_too_short': return 'Ask with at least two characters.';
    case 'network_unreachable': return 'You appear to be offline. Nothing was searched.';
    case 'unauthenticated': return 'Please sign in again to ask.';
    case 'not_configured': return 'Asking is not available in this build.';
    default: return 'We could not answer that right now.';
  }
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function AskConversationSheet({ visible, threadId, onClose, onOpenMessage }: AskConversationSheetProps) {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!visible) return null;
  const canAsk = question.trim().length >= 2 && !busy;

  async function ask() {
    if (question.trim().length < 2 || busy) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    const r = await askConversation(threadId, question);
    setBusy(false);
    if (!r.ok) { setError(askErrorCopy(r.error)); return; }
    setAnswer({ structured: r.structured, prose: r.prose, degraded: r.degraded });
  }

  const renderHit = (h: SearchHit, kind: 's' | 'p') => (
    <Pressable
      key={`${kind}-${h.messageId}`}
      style={sheet.card}
      onPress={onOpenMessage ? () => onOpenMessage(h) : undefined}
      disabled={!onOpenMessage}
      testID={`telegraph-ask-hit-${h.messageId}`}
    >
      <Text style={sheet.meta}>{h.objectTitle ? `${h.objectTitle} · ` : ''}{when(h.createdAt)}</Text>
      <Text style={sheet.body} numberOfLines={3}>{h.snippet}</Text>
    </Pressable>
  );

  const empty = answer && answer.structured.length === 0 && answer.prose.length === 0;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={sheet.overlay} onPress={onClose} />
      <View style={sheet.sheet} testID="telegraph-ask-sheet">
        <View style={sheet.handle} />
        <Text style={sheet.title}>Ask this conversation</Text>
        <Text style={sheet.sub}>Answers come only from messages you can see here.</Text>
        <TextInput
          value={question}
          onChangeText={setQuestion}
          onSubmitEditing={() => { void ask(); }}
          placeholder="When did we agree to meet?"
          placeholderTextColor={color.faint}
          returnKeyType="search"
          editable={!busy}
          style={sheet.input}
          accessibilityLabel="Your question"
          testID="telegraph-ask-input"
        />
        <Pressable
          style={[sheet.primaryBtn, !canAsk && sheet.btnDisabled]}
          disabled={!canAsk}
          onPress={() => { void ask(); }}
          accessibilityRole="button"
          testID="telegraph-ask-submit"
        >
          {busy ? <ActivityIndicator color={color.onInk} /> : <Text style={sheet.btnLabel}>Ask</Text>}
        </Pressable>

        {error ? (
          <View testID="telegraph-ask-error">
            <Text style={sheet.error}>{error}</Text>
            <Pressable style={sheet.secondaryBtn} onPress={() => { void ask(); }} accessibilityRole="button" testID="telegraph-ask-retry">
              <Text style={sheet.secondaryLabel}>Try again</Text>
            </Pressable>
          </View>
        ) : null}

        {answer ? (
          <ScrollView style={{ marginTop: 8 }}>
            {answer.degraded ? (
              <Text style={sheet.error} testID="telegraph-ask-degraded">
                We could not search all of this conversation, so this answer may be incomplete.
              </Text>
            ) : null}
            {empty ? (
              <Text style={[sheet.note, { marginTop: 8 }]} testID={answer.degraded ? 'telegraph-ask-empty-degraded' : 'telegraph-ask-empty'}>
                {answer.degraded
                  ? 'Nothing found in the part we could search. Try again in a moment.'
                  : 'Nothing in this conversation answers that.'}
              </Text>
            ) : null}
            {answer.structured.length > 0 ? (
              <View testID="telegraph-ask-structured">
                <Text style={[sheet.meta, { marginTop: 8 }]}>From plans and places</Text>
                {answer.structured.map((h) => renderHit(h, 's'))}
              </View>
            ) : null}
            {answer.prose.length > 0 ? (
              <View testID="telegraph-ask-prose">
                <Text style={[sheet.meta, { marginTop: 8 }]}>From messages</Text>
                {answer.prose.map((h) => renderHit(h, 'p'))}
              </View>
            ) : null}
          </ScrollView>
        ) : null}

        <Pressable style={sheet.secondaryBtn} onPress={onClose} accessibilityRole="button">
          <Text style={sheet.secondaryLabel}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

export default AskConversationSheet;
