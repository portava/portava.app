/**
 * Telegraph §7.3 — the receipt under a message you sent, and §7.4's unsend.
 *
 *   "For direct chats, show Sent/Delivered/Seen. For groups, derive 'Seen by N'
 *    and optionally list viewers when policy allows."
 *
 * DELIVERED IS ABSENT, AND THAT IS THE HONEST RENDERING. §7.1 has the state and
 * this deployment has no delivery signal at all, so a "Delivered" tick would be
 * decoration pretending to be information. The component renders Sent or Seen,
 * and exposes the server's own reason on the accessibility label so the absence
 * is legible rather than merely quiet.
 *
 * THE UNSEND AFFORDANCE IS A TEACHING SURFACE, NOT A GUARD. It disappears the
 * moment a recipient has seen the message, which is how a sender learns §7.4's
 * rule; the server checks again regardless, and a refusal that arrives anyway
 * (because someone read it between render and press) is shown as the sentence
 * the server sent.
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { space, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import {
  canOfferUnsend,
  receiptLabel,
  unsendMessage,
  type MessageReceipt,
} from './lifecycleApi.ts';

export interface MessageReceiptRowProps {
  threadId: string;
  messageId: string;
  /** Null while the receipt has not been read yet — render nothing, not "Sent". */
  receipt: MessageReceipt | null;
  onUnsent?: (messageId: string) => void;
  /** Test seam. */
  unsend?: typeof unsendMessage;
}

export function MessageReceiptRow({
  threadId,
  messageId,
  receipt,
  onUnsent,
  unsend = unsendMessage,
}: MessageReceiptRowProps) {
  const palette = useTelegraphPalette();
  const styles = makeStyles(palette);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const press = useCallback(async () => {
    setBusy(true);
    setRefusal(null);
    const r = await unsend(threadId, messageId);
    setBusy(false);
    if (r.ok) {
      onUnsent?.(messageId);
      return;
    }
    // The server's sentence, not ours: it knows how many people saw it.
    setRefusal(r.message ?? 'That message could not be unsent.');
  }, [threadId, messageId, onUnsent, unsend]);

  // An unread receipt is not a receipt. Rendering "Sent" here would assert a
  // state nobody measured.
  if (!receipt) return null;

  return (
    <View style={styles.row}>
      <Text
        style={styles.label}
        testID={`telegraph-receipt-${messageId}`}
        accessibilityLabel={`${receiptLabel(receipt)}. ${receipt.deliveredUnavailableReason}`}
      >
        {receiptLabel(receipt)}
      </Text>

      {canOfferUnsend(receipt) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Unsend this message"
          accessibilityHint="Only possible while nobody has seen it"
          onPress={press}
          hitSlop={6}
          testID={`telegraph-unsend-${messageId}`}
        >
          {busy ? (
            <ActivityIndicator size="small" color={palette.mute} />
          ) : (
            <Text style={styles.action}>Unsend</Text>
          )}
        </Pressable>
      ) : null}

      {refusal ? (
        <Text style={styles.refusal} testID={`telegraph-unsend-refused-${messageId}`}>
          {refusal}
        </Text>
      ) : null}
    </View>
  );
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
    label: { ...t.small, color: p.mute },
    action: { ...t.small, color: p.operational, fontWeight: '700' },
    // §11.1: attention colours are for safety and urgent changes. A refused
    // unsend is neither, so it is stated plainly.
    refusal: { ...t.small, color: p.mute, flexShrink: 1 },
  });
}

export default MessageReceiptRow;
