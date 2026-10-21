/**
 * Owner ruling 2026-10-17 — "Allow users to unarchive conversations."
 *
 * The Unarchive action under an archived conversation in the inbox's Archived
 * section (components/TelegraphInboxScreen.tsx). The server is the authority:
 * nothing moves until POST /threads/:id/unarchive answers ok.
 *
 *   idle    → "Unarchive"
 *   pending → "Unarchiving…", busy and disabled, so it cannot be sent twice
 *   ok      → onUnarchived(threadId): the inbox draws the conversation back in
 *             its main list
 *   failed  → says it did not happen (the server's sentence when it sent one)
 *             and the action stays, for a retry
 */
import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ArchiveRestore } from 'lucide-react-native';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { TG_AVATAR } from '../../../theme/telegraphTokens.ts';
import { useTelegraphTheme, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { errorCopy } from '../../../lib/errorCopy.ts';
import { unarchiveThread, type UnarchiveResult } from './archiveApi.ts';

const FAILED_FALLBACK = 'Could not unarchive this conversation. Please try again.';

export interface UnarchiveActionProps {
  threadId: string;
  /** Who or what the conversation is, for the accessibility label. */
  conversationName: string;
  onUnarchived: (threadId: string) => void;
  /** Test seam; the route call by default. */
  unarchive?: (threadId: string) => Promise<UnarchiveResult>;
}

export function UnarchiveAction({ threadId, conversationName, onUnarchived, unarchive = unarchiveThread }: UnarchiveActionProps) {
  const { palette, styles: s } = useTelegraphTheme(makeStyles);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function press() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    const result = await unarchive(threadId).catch((): UnarchiveResult => ({ ok: false, message: null }));
    setPending(false);
    if (result.ok) { onUnarchived(threadId); return; }
    setFailure(errorCopy(result.message ?? undefined, FAILED_FALLBACK));
  }

  return (
    <View style={s.wrap}>
      <Pressable
        testID={`telegraph-unarchive-${threadId}`}
        accessibilityRole="button"
        accessibilityLabel={`Unarchive ${conversationName}`}
        accessibilityState={{ busy: pending, disabled: pending }}
        disabled={pending}
        onPress={() => { void press(); }}
        style={[s.button, pending && s.buttonPending]}
      >
        {pending
          ? <ActivityIndicator size="small" color={palette.operational} />
          : <ArchiveRestore size={14} color={palette.operational} />}
        <Text style={s.label}>{pending ? 'Unarchiving…' : 'Unarchive'}</Text>
      </Pressable>
      {failure ? (
        <Text
          testID={`telegraph-unarchive-failed-${threadId}`}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={s.failure}
        >
          {failure}
        </Text>
      ) : null}
    </View>
  );
}

// The scheme's colours: Unarchive is ordinary emphasis (operational teal). The
// failure line uses the inbox's own error colour (TelegraphInboxScreen's load error).
const makeStyles = (p: TelegraphPalette) => StyleSheet.create({
  // Under the row's text: TelegraphRow's padding, its avatar and the gap after it.
  wrap: { paddingLeft: space.xl + TG_AVATAR.row + space.md, paddingRight: space.xl, paddingBottom: space.sm, gap: 4 },
  button: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: p.haze,
    backgroundColor: p.surfaceRaised,
    minHeight: 32,
  },
  buttonPending: { opacity: 0.7 },
  label: { ...t.small, color: p.operational, fontWeight: '600', fontSize: 13 },
  failure: { ...t.small, color: '#B33', fontSize: 12 },
});
