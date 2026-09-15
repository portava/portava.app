/**
 * Telegraph §22 — "Stranger media can be blurred / no autoplay until accepted."
 *
 * census-telegraph T280: `MessageMediaBubble` "renders and autoplays
 * unconditionally". This is the cover that goes over it.
 *
 * COVERED, NOT BLURRED, AND THAT IS THE STRONGER CHOICE
 * ====================================================
 * A blur is a rendering of the image. The bytes are fetched, the decode
 * happens, and on several platforms the blur is a filter over a view that
 * briefly shows the original while it is applied. "No autoplay" has the same
 * problem for video: a poster frame IS the first frame. So this component
 * renders no media source at all — `children` are not mounted until the person
 * taps Show. What a stranger sends cannot appear on a traveller's screen by
 * accident, because it was never fetched.
 *
 * THE DECISION IS THE SERVER'S
 * ============================
 * `senderConnected` comes from the messages read path
 * (`domain/telegraph/policies/senderConnectedness.ts`), which fails CLOSED: an
 * unreadable relationship table reports every sender as unconnected and
 * everything is shielded. This component never computes the answer and must
 * never be given a locally-guessed one — that would put an abuse control on the
 * permissive side of a network failure.
 *
 * ONE TAP, THEN DONE, FOR THAT MESSAGE
 * ====================================
 * Revealing is per message and per mount. It is not persisted and it does not
 * reveal the sender's other media: a person who decides to look at one photo
 * has not decided to look at everything, and asking again is a tap.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { EyeOff } from 'lucide-react-native';

import { color, radius, space, typography } from '../../../theme/tokens.ts';

export interface StrangerMediaShieldProps {
  /** The server's answer. `true` renders children directly. */
  senderConnected: boolean;
  /** True when the server could not establish the relationship. */
  degraded?: boolean;
  /**
   * §16.2 data-saver. A SECOND reason to withhold, with the same mechanism and
   * different copy — because the traveller's question in the two cases is not
   * the same one. "I don't know this person" is about risk; "I turned data
   * saver on" is about money and battery, and telling someone their own setting
   * is why the photo is missing is the difference between a feature and a bug.
   */
  dataSaverOn?: boolean;
  /** 'image' | 'video' — only used for the label. */
  mediaKind: 'image' | 'video';
  messageId: string;
  children: React.ReactNode;
}

export function StrangerMediaShield({
  senderConnected,
  degraded = false,
  dataSaverOn = false,
  mediaKind,
  messageId,
  children,
}: StrangerMediaShieldProps) {
  const [revealed, setRevealed] = useState(false);

  const withheld = !senderConnected || dataSaverOn;
  if (!withheld || revealed) return <>{children}</>;

  // A stranger outranks data-saver in the copy: if both are true, the reason
  // that matters is the one that is about the person.
  const because: 'stranger' | 'degraded' | 'data_saver' =
    !senderConnected ? (degraded ? 'degraded' : 'stranger') : 'data_saver';

  return (
    <View testID={`stranger-media-shield-${messageId}`} style={s.wrap}>
      <EyeOff size={18} color={color.mute} />
      <Text style={s.title}>
        {mediaKind === 'video' ? 'Video hidden' : 'Photo hidden'}
      </Text>
      <Text testID={`stranger-media-reason-${because}`} style={s.body}>
        {because === 'degraded'
          ? "We couldn't check how you know this person right now."
          : because === 'stranger'
            ? "You haven't connected with this person yet."
            : 'Data saver is on, so media loads only when you ask for it.'}
      </Text>
      <Pressable
        testID={`stranger-media-reveal-${messageId}`}
        accessibilityRole="button"
        accessibilityLabel={mediaKind === 'video' ? 'Show video' : 'Show photo'}
        onPress={() => setRevealed(true)}
        hitSlop={8}
        style={s.btn}
      >
        <Text style={s.btnText}>{mediaKind === 'video' ? 'Show video' : 'Show photo'}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    width: 260,
    minHeight: 150,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: '#F3F2EE',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
  },
  title: { ...(typography.label as object), color: color.ink },
  body: { ...(typography.caption as object), color: color.mute, textAlign: 'center' },
  btn: {
    marginTop: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  btnText: { ...(typography.label as object), color: color.ink },
});

export default StrangerMediaShield;
