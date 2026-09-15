/**
 * Telegraph §22 — the traveller-facing half of the travel scam signals.
 *
 * The server computes `safetySignals` for the RECIPIENT of a message and never
 * for its sender (`domain/telegraph/policies/travelScamSignals.ts`). This is
 * what a traveller actually sees: a short, specific, dismissible note under a
 * message, saying what pattern was recognised and what to do about it.
 *
 * THE COPY IS A QUESTION, NOT AN ACCUSATION
 * =========================================
 * Every one of the six families has an innocent reading. A friend really does
 * sometimes say "I lost my card, can you send me money"; a hostel owner really
 * does sometimes ask you to book directly. A banner that said "THIS IS A SCAM"
 * would be wrong often, would be resented when it was wrong, and would be
 * ignored by the time it was right. So the copy names the pattern and asks the
 * one question that defeats the scam — "check who you are talking to another
 * way" — and the person decides.
 *
 * DISMISSIBLE, AND IT STAYS DISMISSED PER MESSAGE
 * ===============================================
 * A warning that cannot be dismissed is a warning that gets scrolled past. It
 * dismisses per message id and only for this mount; nothing is persisted,
 * because a persisted dismissal across sessions would let one accidental tap
 * silence a warning the person would want back on a second read.
 *
 * RENDERS NOTHING when there is nothing to say. The server omits the field
 * entirely on a clean message, so the common case costs one null check.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ShieldAlert, X } from 'lucide-react-native';

import { color, radius, space, typography } from '../../../theme/tokens.ts';
import type { MessageSafetySignals, ScamFamily, SignalSeverity } from '../types/index.ts';

/** What each family is, in one line a traveller can act on. */
const FAMILY_COPY: Record<ScamFamily, { title: string; advice: string }> = {
  OFF_PLATFORM_PAYMENT: {
    title: 'Asks to pay outside Portava',
    advice: 'Payments made outside the app have no booking record and no protection.',
  },
  FAKE_TAXI: {
    title: 'Unofficial ride offer',
    advice: 'Use the official rank or a metered app. Agree the price before you get in.',
  },
  VISA_HELP: {
    title: 'Visa help that promises an outcome',
    advice: 'No one can guarantee a visa. Check the official embassy site before paying anyone.',
  },
  TICKET_RESALE: {
    title: 'Private ticket resale',
    advice: 'A transferred screenshot is not a ticket. Buy through the venue or the official reseller.',
  },
  FAKE_HOTEL: {
    title: 'Asks to book or deposit directly',
    advice: 'Book through the platform you found them on, so there is a record if the room is not there.',
  },
  URGENT_MONEY_REQUEST: {
    title: 'Urgent request for money',
    advice: 'Contact this person another way — a call or a different app — before sending anything.',
  },
};

const LINK_COPY: Record<string, string> = {
  SHORTENER: 'a shortened link that hides where it goes',
  PUNYCODE_HOST: 'a web address using look-alike characters',
  MIXED_SCRIPT_HOST: 'a web address mixing alphabets',
  IP_LITERAL_HOST: 'a link to a bare IP address',
  CREDENTIALS_IN_URL: 'a link with a username and password in it',
  LOOKALIKE_OFFICIAL_HOST: 'a link that looks like Portava but is not',
  NON_HTTPS: 'an unencrypted link',
};

const SEVERITY_STYLE: Record<SignalSeverity, { bg: string; border: string; fg: string }> = {
  notice: { bg: '#F3F2EE', border: color.haze, fg: color.mute },
  caution: { bg: '#FDF6E7', border: '#EBD9A8', fg: color.warn },
  warning: { bg: '#FDEDEA', border: '#F4C4B8', fg: color.signalDim },
};

export interface MessageSafetyBannerProps {
  messageId: string;
  signals: MessageSafetySignals | null | undefined;
  /** Optional: opens the thread's existing report/block sheet. */
  onReport?: () => void;
}

export function MessageSafetyBanner({ messageId, signals, onReport }: MessageSafetyBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (!signals || dismissed) return null;
  const hasContent = (signals.scam?.length ?? 0) > 0 || (signals.links?.length ?? 0) > 0;
  if (!hasContent) return null;

  const severity: SignalSeverity = signals.severity ?? 'caution';
  const tone = SEVERITY_STYLE[severity];

  const linkNotes = (signals.links ?? [])
    .flatMap((l) => l.findings.filter((f) => LINK_COPY[f]).map((f) => LINK_COPY[f]!))
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 2);

  return (
    <View
      testID={`safety-banner-${messageId}`}
      accessibilityRole="alert"
      style={[s.wrap, { backgroundColor: tone.bg, borderColor: tone.border }]}
    >
      <View style={s.headerRow}>
        <ShieldAlert size={15} color={tone.fg} />
        <Text style={[s.heading, { color: tone.fg }]} numberOfLines={2}>
          {signals.scam.length > 0
            ? FAMILY_COPY[signals.scam[0]!.family].title
            : 'Check this link before you tap it'}
        </Text>
        <Pressable
          testID={`safety-banner-dismiss-${messageId}`}
          accessibilityLabel="Dismiss safety note"
          hitSlop={10}
          onPress={() => setDismissed(true)}
          style={s.dismiss}
        >
          <X size={13} color={color.mute} />
        </Pressable>
      </View>

      {signals.scam.slice(0, 2).map((sig) => (
        <Text key={sig.family} testID={`safety-advice-${sig.family}`} style={s.advice}>
          {FAMILY_COPY[sig.family].advice}
        </Text>
      ))}

      {linkNotes.length > 0 && (
        <Text testID={`safety-link-note-${messageId}`} style={s.advice}>
          {`This message contains ${linkNotes.join(' and ')}.`}
        </Text>
      )}

      {onReport && (
        <Pressable
          testID={`safety-banner-report-${messageId}`}
          accessibilityRole="button"
          onPress={onReport}
          hitSlop={8}
          style={s.reportBtn}
        >
          <Text style={[s.reportText, { color: tone.fg }]}>Report this message</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    marginTop: space.xs,
    gap: space.xs,
    maxWidth: 300,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading: { ...(typography.label as object), flex: 1 },
  dismiss: { padding: 2 },
  advice: { ...(typography.caption as object), color: color.mute },
  reportBtn: { alignSelf: 'flex-start', paddingTop: 2 },
  reportText: { ...(typography.caption as object), textDecorationLine: 'underline' },
});

export default MessageSafetyBanner;
