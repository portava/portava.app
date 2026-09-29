/**
 * Telegraph WP-08 / TEL-F07 — what an edited message said before (§7.5).
 *
 * Reads `GET /api/threads/:t/messages/:m/edits`, which re-authorizes at read
 * time (active membership, not deleted/unsent, inside the caller's §14.3
 * window) and FAILS CLOSED: an unreadable history is a 503, never
 * `{ versions: [] }`. This sheet keeps that distinction all the way to the
 * screen:
 *
 *   loading   — a spinner, nothing else;
 *   error     — the reason and Try again. A 503 is "unavailable right now",
 *               never "this message was never edited" (DV-83);
 *   empty     — the read succeeded and holds no earlier version. Said as a
 *               fact about the record ("no earlier version is on record"),
 *               because an edit made while history could not be kept
 *               (`versionHistory.recorded: false`) leaves exactly this;
 *   versions  — the current text, then each earlier text, newest first.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, Text, View, ActivityIndicator, ScrollView } from 'react-native';
import { color } from '../../../theme/tokens.ts';
import { getMessageEditHistory, type MessageEditHistory } from '../../../services/messaging.ts';
import { sheet } from './sheetStyles.ts';

export interface EditHistorySheetProps {
  visible: boolean;
  threadId: string;
  messageId: string;
  onClose: () => void;
}

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** The copy for a failed read. Exported so the rule is testable on its own. */
export function editHistoryErrorCopy(code: string | undefined): string {
  switch (code) {
    case 'forbidden': return 'You can no longer see this message’s history.';
    case 'not_found': return 'This message is no longer available.';
    case 'network_unreachable': return 'You appear to be offline. Nothing was loaded.';
    default: return 'We could not load this message’s edit history right now.';
  }
}

export function EditHistorySheet({ visible, threadId, messageId, onClose }: EditHistorySheetProps) {
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<MessageEditHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setHistory(null);
    const r = await getMessageEditHistory(threadId, messageId);
    if (r.ok && r.data) setHistory(r.data);
    else {
      setError(editHistoryErrorCopy(r.code));
      // A refusal is an answer; retrying it would only repeat it.
      setRetryable(r.code !== 'forbidden' && r.code !== 'not_found');
    }
    setLoading(false);
  }, [threadId, messageId]);

  useEffect(() => { if (visible) void load(); }, [visible, load]);

  if (!visible) return null;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={sheet.overlay} onPress={onClose} />
      <View style={sheet.sheet} testID="telegraph-edit-history">
        <View style={sheet.handle} />
        <Text style={sheet.title}>Edit history</Text>
        {loading ? (
          <View style={sheet.center} testID="telegraph-edit-history-loading"><ActivityIndicator color={color.mute} /></View>
        ) : error ? (
          <View testID="telegraph-edit-history-error">
            <Text style={sheet.error}>{error}</Text>
            {retryable ? (
              <Pressable style={sheet.primaryBtn} onPress={() => { void load(); }} accessibilityRole="button" testID="telegraph-edit-history-retry">
                <Text style={sheet.btnLabel}>Try again</Text>
              </Pressable>
            ) : null}
          </View>
        ) : history ? (
          <ScrollView>
            <View style={sheet.card} testID="telegraph-edit-history-current">
              <Text style={sheet.meta}>Now{history.editedAt ? ` · edited ${when(history.editedAt)}` : ''}</Text>
              <Text style={sheet.body}>{history.currentBody ?? ''}</Text>
            </View>
            {history.versions.length === 0 ? (
              <Text style={[sheet.note, { marginTop: 8 }]} testID="telegraph-edit-history-empty">
                No earlier version of this message is on record.
              </Text>
            ) : history.versions.map((v) => (
              <View key={v.version} style={sheet.card} testID={`telegraph-edit-history-v${v.version}`}>
                <Text style={sheet.meta}>Before edit {v.version}{v.editedAt ? ` · ${when(v.editedAt)}` : ''}</Text>
                <Text style={sheet.body}>{v.previousBody ?? ''}</Text>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <Pressable style={sheet.secondaryBtn} onPress={onClose} accessibilityRole="button">
          <Text style={sheet.secondaryLabel}>Close</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

export default EditHistorySheet;
