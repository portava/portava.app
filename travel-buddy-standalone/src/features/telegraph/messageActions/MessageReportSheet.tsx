/**
 * Telegraph WP-08 / TEL-F09 — report ONE message.
 *
 * Files through `POST /api/messages/:messageId/report` (`reportMessage`), the
 * Telegraph route, and not through `/api/moderation/report` or `/api/reports`,
 * which the two chat screens used before. Only this route:
 *   - writes the unified `reports` table the admin surface reads
 *     (census-telegraph §32.2 — one queue, not two);
 *   - snapshots the message into restricted moderation storage BEFORE it
 *     answers (§22), so a sender who notices and unsends or deletes cannot
 *     take the evidence with it;
 *   - tells the reporter, and only the reporter (`safety.reported`).
 * Decision TM-TEL-D4 in census-telegraph §38.
 *
 * The reason is the server's vocabulary (`MESSAGE_REPORT_REASONS`), so the
 * server computes severity from it. The reported person is never told.
 *
 * States: choosing → sending → sent (with an optional Block offer where the
 * caller supplies one) or an inline error that keeps the choice, so a failed
 * report can be sent again without starting over.
 */
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View, ActivityIndicator } from 'react-native';
import { color } from '../../../theme/tokens.ts';
import {
  reportMessage,
  MESSAGE_REPORT_REASONS,
  type MessageReportReasonCode,
} from '../../../services/messaging.ts';
import { sheet } from './sheetStyles.ts';

export interface MessageReportSheetProps {
  visible: boolean;
  messageId: string;
  onClose: () => void;
  /** Offered after a successful report, e.g. "Block Ana" in a direct thread. */
  blockLabel?: string;
  onBlock?: () => void;
}

/** What the server stores as `reason_detail`: the label, plus what they wrote. */
export function reportReasonText(code: MessageReportReasonCode, detail: string): string {
  const label = MESSAGE_REPORT_REASONS.find((r) => r.code === code)?.label ?? 'Something else';
  const extra = detail.trim();
  return (extra ? `${label}: ${extra}` : label).slice(0, 200);
}

export function MessageReportSheet({ visible, messageId, onClose, blockLabel, onBlock }: MessageReportSheetProps) {
  const [reason, setReason] = useState<MessageReportReasonCode | null>(null);
  const [detail, setDetail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) { setReason(null); setDetail(''); setSending(false); setSent(false); setError(null); }
  }, [visible, messageId]);

  if (!visible) return null;

  async function submit() {
    if (!reason || sending) return;
    setSending(true);
    setError(null);
    const r = await reportMessage(messageId, reportReasonText(reason, detail), reason);
    setSending(false);
    if (r.ok) setSent(true);
    else setError(r.message ?? 'Your report was not sent. Please try again.');
  }

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={sheet.overlay} onPress={sending ? undefined : onClose} />
      <View style={sheet.sheet} testID="telegraph-message-report">
        <View style={sheet.handle} />
        {sent ? (
          <View testID="telegraph-message-report-sent">
            <Text style={sheet.title}>Report sent</Text>
            <Text style={sheet.sub}>
              Thank you. Our team will review this message. The person you reported is not told.
            </Text>
            {onBlock && blockLabel ? (
              <Pressable style={sheet.dangerBtn} onPress={() => { onClose(); onBlock(); }} accessibilityRole="button" testID="telegraph-message-report-block">
                <Text style={sheet.btnLabel}>{blockLabel}</Text>
              </Pressable>
            ) : null}
            <Pressable style={sheet.secondaryBtn} onPress={onClose} accessibilityRole="button">
              <Text style={sheet.secondaryLabel}>Done</Text>
            </Pressable>
          </View>
        ) : (
          <View>
            <Text style={sheet.title}>Report this message</Text>
            <Text style={sheet.sub}>What’s wrong with it? The sender is not told who reported it.</Text>
            {MESSAGE_REPORT_REASONS.map((r) => {
              const selected = reason === r.code;
              return (
                <Pressable
                  key={r.code}
                  style={[sheet.option, selected && sheet.optionSelected]}
                  onPress={() => setReason(r.code)}
                  disabled={sending}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  testID={`telegraph-message-report-reason-${r.code}`}
                >
                  <Text style={[sheet.optionText, selected && sheet.optionTextSelected]}>{r.label}</Text>
                </Pressable>
              );
            })}
            {reason ? (
              <TextInput
                value={detail}
                onChangeText={setDetail}
                placeholder="Anything else we should know? (optional)"
                placeholderTextColor={color.faint}
                multiline
                maxLength={160}
                editable={!sending}
                style={sheet.input}
                testID="telegraph-message-report-detail"
              />
            ) : null}
            {error ? <Text style={sheet.error} testID="telegraph-message-report-error">{error}</Text> : null}
            <Pressable
              style={[sheet.dangerBtn, (!reason || sending) && sheet.btnDisabled]}
              disabled={!reason || sending}
              onPress={() => { void submit(); }}
              accessibilityRole="button"
              testID="telegraph-message-report-submit"
            >
              {sending ? <ActivityIndicator color={color.onInk} /> : <Text style={sheet.btnLabel}>Send report</Text>}
            </Pressable>
            <Pressable style={sheet.secondaryBtn} onPress={onClose} disabled={sending} accessibilityRole="button">
              <Text style={sheet.secondaryLabel}>Cancel</Text>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
}

export default MessageReportSheet;
