/**
 * CaptionAiAssist — opt-in writing help under a Postcard or Memory caption
 * (Input Intelligence spec §22, "Postcards / Memories: writing assistance
 * without inventing travel facts"; census-input-intelligence G141).
 *
 * WHAT IT DOES. It shows "Suggest with AI" under the caption. A tap sends THAT
 * caption, as it is at that moment, through the existing §22 path
 * (`useAiWritingAssist` → the gateway → the existing Compass model) and shows
 * the proposals that come back. A tap on a proposal puts its text into the
 * caption, where the traveller can edit it. Nothing is ever inserted,
 * submitted or posted on its own.
 *
 * ONE TAP, ONE REQUEST. The text sent is the caption at the moment of the tap.
 * Typing afterwards sends nothing; the button comes back as "Suggest again",
 * and only another tap asks again. A Memory caption is the traveller's private
 * words, so it leaves the device only when they ask, and only once per ask.
 *
 * WHAT THE SERVER DOES WITH IT (lib/inputAssistance/travelWriting.ts). The
 * screen names the field (`postcard.caption` / `memory.caption`); for those
 * two the model is sent the caption and nothing else, and every proposal is
 * checked so it holds only the traveller's own words plus connecting and
 * feeling words. On an existing Memory (`memoryId`) the server also refuses
 * when the Memory is not the caller's or carries DO_NOT_RESURFACE,
 * KEEP_PRIVATE_FOREVER or RETAIN_BUT_DO_NOT_PERSONALIZE.
 *
 * WHEN IT SHOWS NOTHING. `compass_ai_writing_enabled` off (read through the app's
 * feature flags; the server checks it again), an empty caption, or `disabled`.
 * With the flag off the screen sends exactly what it sent before this existed.
 *
 * The component names no field id itself: the mounting screen passes one, so
 * the §50 inventory's "mounted" measurement points at the screen.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Sparkles } from 'lucide-react-native';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';
import { useAiWritingAssist } from '../hooks/useAiWritingAssist.ts';
import { AiWritingAssist } from '../platform/input-assistance/compass/AiWritingAssist.tsx';
import { AI_WRITING_ONLY_CAPABILITIES } from '../platform/input-assistance/contexts/clientCapabilities.ts';
import { color, space, radius, type as t } from '../theme/tokens.ts';

/** The server's §22 capability flag (lib/inputAssistance/aiWriting.ts COMPASS_AI_WRITING_FLAG). */
export const CAPTION_AI_FLAG = 'compass_ai_writing_enabled';

export interface CaptionAiAssistProps {
  /** The registered field id the screen mounts (`AI_WRITING_FIELD_IDS.postcardCaption` / `.memoryCaption`). */
  fieldId: string;
  /** The caption as it is now. */
  text: string;
  /** The traveller tapped a proposal: put this text in the caption (editable). */
  onInsert: (text: string) => void;
  /** An EXISTING Memory's id (the edit screen), so the server can apply its owner's controls. */
  memoryId?: string | null;
  /** The screen is busy (creating / uploading): no new request. */
  disabled?: boolean;
  testID?: string;
}

export function CaptionAiAssist({ fieldId, text, onInsert, memoryId, disabled = false, testID = 'caption-ai' }: CaptionAiAssistProps) {
  const { isEnabled } = useFeatureFlags();
  const available = isEnabled(CAPTION_AI_FLAG) && !disabled;
  const current = text.trim();

  // The caption as it was when the traveller tapped; null until they tap.
  const [asked, setAsked] = useState<string | null>(null);
  const sessionContext = useMemo(() => (memoryId ? { memoryId } : undefined), [memoryId]);

  const ai = useAiWritingAssist({
    context: 'caption',
    fieldId,
    text: asked ?? '',
    optedIn: asked !== null,
    enabled: available,
    sessionContext,
    capabilities: AI_WRITING_ONLY_CAPABILITIES,
  });

  // "Answered" = this ask's request has started and finished. The hook raises
  // `loading` in an effect, so the first render after a tap is neither loading
  // nor answered; without this it would flash "no suggestion".
  const [settled, setSettled] = useState(false);
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (asked === null) { started.current = null; setSettled(false); return; }
    if (ai.loading) { started.current = asked; setSettled(false); return; }
    if (started.current === asked || ai.unavailable) setSettled(true);
  }, [asked, ai.loading, ai.unavailable]);

  if (!available || current.length === 0) return null;

  const answered = asked !== null && asked === current;
  if (!answered) {
    return (
      <View style={styles.row}>
        <Pressable
          onPress={() => setAsked(current)}
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel={asked === null ? 'Suggest a caption with AI' : 'Suggest again with AI'}
          accessibilityHint="Sends only this caption to Portava's AI. Nothing is added to it or posted."
          testID={`${testID}-button`}
        >
          <Sparkles size={13} color={color.signal} />
          <Text style={styles.buttonText}>{asked === null ? 'Suggest with AI' : 'Suggest again'}</Text>
        </Pressable>
        <Text style={styles.hint}>Sends only this caption. Nothing is added or posted.</Text>
      </View>
    );
  }

  if (settled && !ai.loading && ai.proposals.length === 0) {
    return (
      <Text style={styles.hint} testID={`${testID}-none`} accessibilityLiveRegion="polite">
        No suggestion that keeps to your own words.
      </Text>
    );
  }

  return (
    <AiWritingAssist
      proposals={ai.proposals}
      loading={ai.loading || !settled}
      heading="AI caption ideas"
      onInsert={(p) => { onInsert(p.insertText); setAsked(null); }}
      testID={`${testID}-proposals`}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm, marginTop: space.xs },
  button: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  buttonText: { ...(t.small as object), fontWeight: '700', color: color.signalStrong }, // vermilion TEXT takes signalStrong for AA (census-media §33)
  hint: { ...(t.small as object), color: color.mute, flexShrink: 1 },
});
