/**
 * census-telegraph T404 — a stored link preview, drawn under its message.
 *
 * TEXT ONLY (owner question Q-LP5): the site, the title, a line of description
 * and the ORIGINAL host the server fetched (Q-LP8 — a redirect never changes
 * which host is shown). There is no image on the wire and none is drawn, so
 * drawing this makes no request to the linked site (T446). The link opens only
 * on the viewer's own tap, exactly as the same URL in the message text would.
 */
import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, space, type as t } from '../../../theme/tokens.ts';
import { useTelegraphStyles, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import type { LinkPreview } from './linkPreviewApi.ts';

export function LinkPreviewCard({ preview, mine }: { preview: LinkPreview; mine: boolean }) {
  const styles = useTelegraphStyles(makeStyles);
  const title = preview.title.trim() || preview.host;
  const site = preview.siteName.trim() || preview.host;
  return (
    <Pressable
      style={[styles.card, mine && styles.cardMine]}
      onPress={() => { Linking.openURL(preview.url).catch(() => {}); }}
      accessibilityRole="link"
      accessibilityLabel={`${title}, ${preview.host}`}
      testID="telegraph-link-preview"
    >
      <View style={[styles.edge, mine && styles.edgeMine]} />
      <View style={styles.text}>
        <Text style={[styles.site, mine && styles.siteMine]} numberOfLines={1}>{site}</Text>
        <Text style={[styles.title, mine && styles.titleMine]} numberOfLines={2}>{title}</Text>
        {preview.description.trim() ? (
          <Text style={[styles.description, mine && styles.descriptionMine]} numberOfLines={2}>{preview.description.trim()}</Text>
        ) : null}
        <Text style={[styles.host, mine && styles.siteMine]} numberOfLines={1} testID="telegraph-link-preview-host">{preview.host}</Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (p: TelegraphPalette) => StyleSheet.create({
  card: { flexDirection: 'row', marginTop: 6, borderRadius: radius.sm, backgroundColor: p.chipFill, overflow: 'hidden', maxWidth: 260 },
  cardMine: { backgroundColor: 'rgba(255,255,255,0.14)' },
  edge: { width: 3, backgroundColor: p.operational },
  edgeMine: { backgroundColor: p.sentTextMute },
  text: { flex: 1, paddingHorizontal: space.sm, paddingVertical: 6, gap: 2 },
  site: { ...t.small, fontSize: 11, color: p.mute, fontWeight: '600' },
  siteMine: { color: p.sentTextMute },
  title: { ...t.small, color: p.recvText, fontWeight: '700' },
  titleMine: { color: p.sentText },
  description: { ...t.small, fontSize: 12, color: p.mute },
  descriptionMine: { color: p.sentTextMute },
  host: { ...t.small, fontSize: 10, color: p.faint },
});
