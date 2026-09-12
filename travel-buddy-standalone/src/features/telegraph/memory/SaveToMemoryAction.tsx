/**
 * Telegraph §10.2 — "Save to Memory", as ONE explicit user action.
 *
 *   "A user may explicitly save a message, voice note, place share or media
 *    item as a private Memory draft. Telegraph never automatically converts
 *    whole conversations into Memories."
 *
 * This component is the whole of the client-side save path, and it is shaped so
 * the prohibition cannot be worked around by a caller in a hurry:
 *
 *  - it takes ONE `messageId`, never a list and never a thread;
 *  - it does nothing on mount, on scroll, on thread close, or on any timer —
 *    `save()` runs only from `onPress`;
 *  - it reports back what the SERVER said the draft is (`state`,
 *    `visibility`), rather than asserting "Saved privately" from a wish. If a
 *    deployment ever returned a published Memory, this label would say so.
 *
 * §10.2 says *private*, so the confirmation names the privacy rather than
 * leaving the user to assume it.
 */
import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { saveMessageAsMemoryDraft, type MemoryDraft } from './memoryApi.ts';

export interface SaveToMemoryActionProps {
  /** SINGULAR. There is deliberately no `messageIds` prop. */
  messageId: string;
  /** Shown on the button; the kind of thing being saved (§10.2's four). */
  what?: 'message' | 'voice note' | 'place' | 'photo';
  onSaved?: (draft: MemoryDraft) => void;
  /** Test seam: inject the call. */
  save?: typeof saveMessageAsMemoryDraft;
}

type State =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'saved'; draft: MemoryDraft }
  | { phase: 'failed'; message: string };

export function SaveToMemoryAction({
  messageId,
  what = 'message',
  onSaved,
  save = saveMessageAsMemoryDraft,
}: SaveToMemoryActionProps) {
  const palette = useTelegraphPalette();
  const styles = makeStyles(palette);
  const [state, setState] = useState<State>({ phase: 'idle' });

  const onPress = useCallback(async () => {
    setState({ phase: 'saving' });
    const r = await save(messageId);
    if (r.ok) {
      setState({ phase: 'saved', draft: r.data.draft });
      onSaved?.(r.data.draft);
    } else {
      setState({
        phase: 'failed',
        message: r.message ?? 'We could not save that. Nothing was created.',
      });
    }
  }, [messageId, onSaved, save]);

  if (state.phase === 'saved') {
    const d = state.draft;
    // Read back from the server, not assumed: a draft that came back published
    // or visible would be described as such rather than as "private".
    const isPrivateDraft = d.state === 'draft' && d.visibility === 'only_me';
    return (
      <View style={styles.row}>
        <Text style={styles.saved} testID="telegraph-save-memory-saved">
          {isPrivateDraft
            ? 'Saved to your private Memory drafts. Only you can see it.'
            : `Saved as a ${d.state} Memory, visible to ${d.visibility}.`}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Save this ${what} to your Memory drafts`}
        accessibilityHint="Saves only this one item, privately"
        onPress={onPress}
        style={styles.button}
        testID="telegraph-save-memory-button"
      >
        {state.phase === 'saving' ? (
          <ActivityIndicator size="small" color={palette.operationalOn} />
        ) : (
          <Text style={styles.buttonText}>Save to Memory</Text>
        )}
      </Pressable>
      {state.phase === 'failed' ? (
        <Text style={styles.failed} testID="telegraph-save-memory-failed">
          {state.message}
        </Text>
      ) : null}
    </View>
  );
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
    button: {
      paddingHorizontal: space.lg,
      paddingVertical: 8,
      borderRadius: radius.pill,
      backgroundColor: p.operational,
      minHeight: 34,
      justifyContent: 'center',
    },
    buttonText: { ...t.small, color: p.operationalOn, fontWeight: '700' },
    saved: { ...t.small, color: p.mute, flexShrink: 1 },
    // §11.1: attention colours are reserved for safety and urgent changes. A
    // save that did not go through is neither, so it is stated plainly.
    failed: { ...t.small, color: p.mute, flexShrink: 1 },
  });
}

export default SaveToMemoryAction;
