/**
 * Telegraph §30A.9 content capabilities — the AUTHOR's control over who may forward a message (census T407).
 *
 *   PUT /api/threads/:threadId/messages/:messageId/content-capability  { capability }  -> 200 { messageId, capability }
 *
 * The server enforces every capability at the forward and re-checks it under lock; it also decides who
 * may set one (the author, on a live message that is not itself a forward). This sheet only says, in
 * words, what each choice does, sends the author's choice, and shows what the server READ BACK. A
 * refusal is the server's sentence, and nothing on screen changes.
 *
 * Offered only on the author's own message that is not a forward, with forwarding on and the
 * conversation affirmatively not end-to-end encrypted (conversationProjection.offersForward).
 */
import React, { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';
import { radius, space, type as t } from '../../../theme/tokens.ts';
import { useTelegraphTheme, type TelegraphPalette } from '../theme/telegraphTheme.ts';

export type ContentCapability = 'SOURCE_POLICY' | 'ALLOW' | 'EXPIRES_WITH_SOURCE' | 'NO_FORWARD';

/** The four rules, in the order offered, each in the words the server's rule means. */
export const FORWARDING_RULES: ReadonlyArray<{ capability: ContentCapability; label: string; detail: string }> = [
  { capability: 'SOURCE_POLICY', label: 'Only you', detail: 'Only you can forward your words. A shared place or plan follows the item itself.' },
  { capability: 'ALLOW', label: 'Anyone here', detail: 'Anyone in this conversation can forward it.' },
  { capability: 'EXPIRES_WITH_SOURCE', label: 'Anyone here, until you take it back', detail: 'Anyone here can forward it, and every forward disappears if you unsend or delete this message.' },
  { capability: 'NO_FORWARD', label: 'Nobody', detail: 'Nobody can forward it, including you.' },
];

export const isContentCapability = (v: unknown): v is ContentCapability =>
  typeof v === 'string' && FORWARDING_RULES.some((r) => r.capability === v);

export type RuleResult = { ok: true; capability: ContentCapability } | { ok: false; error: string; message: string };

const NOT_CHANGED = 'The forwarding rule was not changed. Please try again.';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export async function setForwardingRule(threadId: string, messageId: string, capability: ContentCapability): Promise<RuleResult> {
  if (!threadId || !messageId || !isContentCapability(capability)) return { ok: false, error: 'malformed', message: NOT_CHANGED };
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured', message: NOT_CHANGED };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated', message: NOT_CHANGED };
  try {
    const res = await fetch(`${apiBase()}/api/threads/${threadId}/messages/${messageId}/content-capability`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ capability }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) return { ok: false, error: String(body?.error ?? res.status), message: typeof body?.message === 'string' && body.message ? body.message : NOT_CHANGED };
    // What the server stored, never what was asked for.
    return isContentCapability(body?.capability) ? { ok: true, capability: body.capability } : { ok: false, error: 'malformed_response', message: NOT_CHANGED };
  } catch {
    return { ok: false, error: 'network', message: NOT_CHANGED };
  }
}

export function ForwardingRuleSheet({
  visible,
  threadId,
  messageId,
  current,
  onClose,
  onSaved,
}: {
  visible: boolean;
  threadId: string | null;
  messageId: string | null;
  /** The capability the server says is in force for this message (the thread read's `contentCapability`). */
  current: ContentCapability | null;
  onClose: () => void;
  onSaved?: (capability: ContentCapability) => void;
}) {
  const { palette, styles } = useTelegraphTheme(makeStyles);
  const [inForce, setInForce] = useState<ContentCapability | null>(current);
  const [saving, setSaving] = useState<ContentCapability | null>(null);
  const [error, setError] = useState<string | null>(null);
  React.useEffect(() => { if (visible) { setInForce(current); setError(null); } }, [visible, current]);

  const choose = async (c: ContentCapability) => {
    if (!threadId || !messageId || saving) return;
    setSaving(c);
    setError(null);
    const r = await setForwardingRule(threadId, messageId, c);
    setSaving(null);
    if (r.ok) { setInForce(r.capability); onSaved?.(r.capability); }
    else setError(r.message);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close forwarding rule" />
      <View style={styles.sheet} testID="forwarding-rule-sheet">
        <Text style={styles.title} accessibilityRole="header">Who can forward this</Text>
        {FORWARDING_RULES.map((r) => {
          const on = inForce === r.capability;
          return (
            <Pressable
              key={r.capability}
              testID={`forwarding-rule-${r.capability}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, disabled: saving !== null }}
              disabled={saving !== null}
              onPress={() => { void choose(r.capability); }}
              style={[styles.row, on && styles.rowOn]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>{r.label}{on ? ' ✓' : ''}</Text>
                <Text style={styles.detail}>{r.detail}</Text>
              </View>
              {saving === r.capability ? <ActivityIndicator color={palette.operational} /> : null}
            </Pressable>
          );
        })}
        {error ? <Text style={styles.error} testID="forwarding-rule-error">{error}</Text> : null}
      </View>
    </Modal>
  );
}

const makeStyles = (p: TelegraphPalette) => StyleSheet.create({ // census T123/T124: the scheme's palette
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { backgroundColor: p.surface, padding: space.lg, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, gap: space.sm },
  title: { ...t.bodyStrong, color: p.recvText },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: space.sm, paddingHorizontal: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: p.haze, minHeight: 44 },
  rowOn: { borderColor: p.operational },
  label: { ...t.body, color: p.recvText },
  detail: { ...t.small, color: p.mute },
  error: { ...t.small, color: p.recvText, fontWeight: '600' },
});

export default ForwardingRuleSheet;
