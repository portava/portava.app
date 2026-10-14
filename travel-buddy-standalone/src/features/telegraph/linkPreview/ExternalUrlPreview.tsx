/**
 * ExternalUrlPreview — the drawn link preview (census-telegraph T404 / T446).
 *
 * TEXT ONLY. A preview carries no image field (owner question Q-LP5, default:
 * none), so this component has no image to load and imports no image
 * component: drawing it contacts no host at all. Adapted from the uncommitted
 * Codex T404 component (lead ruling LR-B58-3), rebuilt on the stored preview.
 *
 * THE HOST FIRST. The ORIGINAL link's host (the server names the host the
 * sender wrote, never a redirect's — Q-LP8 — and in punycode, so a look-alike
 * Unicode name is shown as what it is) is the most prominent line, then the
 * site name, title and description the server stored.
 *
 * A TAP IS THE ONLY WAY THE LINK OPENS: `Linking.openURL` runs inside the
 * press handler and nowhere else (the message-tree guard holds this), and only
 * for the https link to exactly the host shown (`isOpenablePreviewLink`).
 */
import React from 'react';
import { Linking, Pressable, StyleSheet, Text } from 'react-native';
import { color, space, radius } from '../../../theme/tokens.ts';
import { TG } from '../../../theme/telegraphTokens.ts';
import { isOpenablePreviewLink, type WirePreview } from './linkPreviewRules.ts';

export interface ExternalUrlPreviewProps {
  preview: WirePreview;
  /** The viewer's own message (drawn on the sent-bubble colours). */
  mine: boolean;
}

export function ExternalUrlPreview({ preview, mine }: ExternalUrlPreviewProps) {
  const openable = isOpenablePreviewLink(preview.url, preview.host);
  const title = preview.title.trim();
  const description = preview.description.trim();
  const siteName = preview.siteName.trim();
  return (
    <Pressable
      testID={`telegraph-link-preview-${preview.messageId}`}
      accessibilityRole="link"
      accessibilityLabel={`Link to ${preview.host}${title ? `: ${title}` : ''}`}
      accessibilityHint={openable ? 'Opens the link outside Portava' : undefined}
      disabled={!openable}
      onPress={() => {
        if (openable) void Linking.openURL(preview.url).catch(() => {});
      }}
      style={[s.card, mine ? s.cardMine : s.cardOther]}
    >
      <Text style={[s.host, mine && s.textMine]} numberOfLines={1}>{preview.host}</Text>
      {siteName && siteName.toLowerCase() !== preview.host.toLowerCase() ? (
        <Text style={[s.site, mine && s.textMuteMine]} numberOfLines={1}>{siteName}</Text>
      ) : null}
      {title ? <Text style={[s.title, mine && s.textMine]} numberOfLines={2}>{title}</Text> : null}
      {description ? (
        <Text style={[s.description, mine && s.textMuteMine]} numberOfLines={3}>{description}</Text>
      ) : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    marginTop: space.xs,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    gap: 2,
  },
  cardOther: { backgroundColor: TG.chipFill, borderLeftColor: TG.hairline },
  cardMine: { backgroundColor: 'rgba(255,255,255,0.10)', borderLeftColor: TG.sentTextMute },
  host: { fontSize: 12, fontWeight: '700', color: color.ink },
  site: { fontSize: 11, color: color.mute },
  title: { fontSize: 13, fontWeight: '600', color: color.ink },
  description: { fontSize: 12, color: color.mute },
  textMine: { color: TG.sentText },
  textMuteMine: { color: TG.sentTextMute },
});
