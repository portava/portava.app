/**
 * PendingTagInbox — the "Ask me first" inbox (census-discovery §95, lane
 * W11-X3; §81.4 routed hunk R3; DV-76; register D-W11X3-4).
 *
 * Lists the tags of you that wait for your approval (GET /api/me/tags/pending)
 * and answers each one: Approve → POST /api/tags/:id/approve; Decline → the
 * existing DELETE /api/tags/:id, which the server keeps as a suppression so the
 * same tag cannot be re-applied. A tag leaves the list only when the server
 * accepted the answer; a refused answer keeps it and says why.
 *
 * Rendered by the settings screen only when the server offers "Ask me first"
 * (tag_permission_approval_required_enabled, 3468, seeded FALSE). It decides no
 * consent: it only carries the person's own answer to the server.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import {
  approvePendingTag, declinePendingTag, pendingTagLine, type PendingTag,
} from '../services/tagging.ts';

interface Props {
  tags: readonly PendingTag[];
  /** Called once the server accepted an answer, with the tag that left the inbox. */
  onAnswered: (tagId: string) => void;
}

export function PendingTagInbox({ tags, onAnswered }: Props) {
  const [busy, setBusy] = useState<string | null>(null);

  const answer = async (tag: PendingTag, approve: boolean) => {
    if (busy) return;
    setBusy(tag.id);
    const res = approve ? await approvePendingTag(tag.id) : await declinePendingTag(tag.id);
    setBusy(null);
    if (res.ok) onAnswered(tag.id);
    else Alert.alert(approve ? 'Could not approve' : 'Could not decline', res.error ?? 'Please try again.');
  };

  if (tags.length === 0) {
    return (
      <View style={styles.wrap} testID="pending-tag-inbox-empty">
        <Text style={styles.empty}>No tags are waiting for your approval.</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap} testID="pending-tag-inbox">
      <Text style={styles.heading}>Waiting for your approval</Text>
      {tags.map((t) => (
        <View key={t.id} style={styles.row} testID={`pending-tag-${t.id}`}>
          <Text style={styles.line} numberOfLines={2}>{pendingTagLine(t)}</Text>
          {busy === t.id ? (
            <ActivityIndicator size="small" />
          ) : (
            <View style={styles.actions}>
              <Pressable
                onPress={() => answer(t, true)}
                disabled={busy !== null}
                accessibilityRole="button"
                accessibilityLabel={`Approve: ${pendingTagLine(t)}`}
                testID={`pending-tag-approve-${t.id}`}
                style={styles.btn}
              >
                <Text style={styles.btnText}>Approve</Text>
              </Pressable>
              <Pressable
                onPress={() => answer(t, false)}
                disabled={busy !== null}
                accessibilityRole="button"
                accessibilityLabel={`Decline: ${pendingTagLine(t)}`}
                testID={`pending-tag-decline-${t.id}`}
                style={styles.btn}
              >
                <Text style={styles.btnText}>Decline</Text>
              </Pressable>
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingVertical: 8, gap: 8 },
  heading: { fontSize: 13, fontWeight: '700' },
  empty: { fontSize: 12, opacity: 0.7 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  line: { flex: 1, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 8 },
  btn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  btnText: { fontSize: 12, fontWeight: '600' },
});
