/**
 * Telegraph §6.2 PORTAVA_OBJECT + §5.2/§5.3 — the card that is a REFERENCE.
 *
 * Every other shared card in this tree renders the JSON the sender serialised
 * at send time. This one renders nothing until the server has said what THIS
 * viewer may see right now, and renders a revoked notice when the answer is
 * "nothing". That is §5.2's third layer, and it is the whole difference
 * between a share and a copy.
 */
import React from 'react';
import { useSharedCardWidth } from './useSharedCardWidth.ts';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { DisplayMediaImage } from '../../../components/ui/DisplayMediaImage.tsx'; import { messageTreeMediaOrNull } from '../media/messageTreeMedia.ts';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { parsePortavaObjectBody } from './shareApi.ts';
import { useShareRevocation, revokedLabel } from './useShareRevocation.ts';
import { SharedMessageMedia } from './SharedMessageMedia.tsx';
import { PlaceLiveInformation } from './PlaceLiveInformation.tsx';

const CARD_MAX_WIDTH = 280;

export interface PortavaObjectMessageProps {
  body: string | null;
  mine: boolean;
  threadId: string | null;
  messageId?: string | null;
}

export function PortavaObjectMessage({ body, mine, threadId, messageId }: PortavaObjectMessageProps) {
  const width = useSharedCardWidth();
  const palette = useTelegraphPalette();
  const styles = React.useMemo(() => makeStyles(palette), [palette]);
  const parsed = parsePortavaObjectBody(body);

  const revocation = useShareRevocation(
    threadId,
    parsed ? { objectType: parsed.objectType, objectId: parsed.objectId, messageId } : null,
  );

  if (!parsed) {
    return (
      <View style={[styles.wrap, { width }]} testID="telegraph-portava-object-unreadable">
        <Text style={styles.notice}>Shared item</Text>
      </View>
    );
  }

  if (revocation.state === 'loading') {
    return (
      <View style={[styles.wrap, { width }]} testID="telegraph-portava-object-loading">
        <Text style={styles.meta}>Loading…</Text>
      </View>
    );
  }

  if (revocation.state === 'unavailable') {
    return (
      <View style={[styles.wrapRevoked, { width }]} testID="telegraph-portava-object-revoked">
        <Text style={styles.revokedText}>{revokedLabel(revocation.reason)}</Text>
        {parsed.caption ? <Text style={styles.captionMuted}>“{parsed.caption}”</Text> : null}
      </View>
    );
  }

  // `unknown` — the resolve could not run. Render the reference itself, which
  // carries nothing from the source: a type, an id and the sender's caption.
  const projection = revocation.resolved?.available ? revocation.resolved.projection : null;
  const title = projection?.title ?? prettyType(parsed.objectType);
  const subtitle = projection?.subtitle ?? null;
  const deepLink = projection?.deepLink ?? null;

  const hasMediaCard = projection && (parsed.objectType === 'POST' || parsed.objectType === 'MEDIA');
  if (hasMediaCard) return <View style={[styles.wrap, { width }, mine && styles.wrapMine]} testID="telegraph-portava-object-card">
    <Text style={styles.kind}>{prettyType(parsed.objectType).toUpperCase()}</Text>
    {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    <SharedMessageMedia key={projection.objectId} projection={projection} messageId={messageId} />
    <Pressable accessibilityRole="button" accessibilityLabel={`View ${prettyType(parsed.objectType)}`} onPress={() => router.push(projection.deepLink as never)}><Text style={styles.title} numberOfLines={3}>{title}</Text></Pressable>
    {parsed.caption ? <Text style={styles.caption}>{parsed.caption}</Text> : null}
  </View>;
  return (
    <Pressable
      style={[styles.wrap, { width }, mine ? styles.wrapMine : null]}
      testID="telegraph-portava-object-card"
      accessibilityRole="button"
      accessibilityLabel={`${prettyType(parsed.objectType)}: ${title}`}
      disabled={!deepLink}
      onPress={() => {
        if (deepLink) router.push(deepLink as any);
      }}
    >
      <Text style={styles.kind}>{prettyType(parsed.objectType).toUpperCase()}</Text>
      {messageTreeMediaOrNull(projection?.imageUrl) ? ( // census T446: storage or nothing
        <DisplayMediaImage uri={messageTreeMediaOrNull(projection?.imageUrl)} width={CARD_MAX_WIDTH - space.md * 2} height={110} style={styles.image} />
      ) : null}
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
      {parsed.caption ? (
        <Text style={styles.caption} numberOfLines={3}>
          {parsed.caption}
        </Text>
      ) : null}
      {parsed.objectType === 'PLACE' && <PlaceLiveInformation value={projection?.liveIntelligence} />}
    </Pressable>
  );
}

function prettyType(objectType: string): string {
  return objectType
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function makeStyles(p: TelegraphPalette) {
  return StyleSheet.create({
    wrap: {
      maxWidth: CARD_MAX_WIDTH,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.recvBorder,
      backgroundColor: p.surfaceRaised,
      padding: space.md,
      gap: 4,
    },
    wrapMine: { borderColor: p.hairline },
    wrapRevoked: {
      maxWidth: CARD_MAX_WIDTH,
      borderRadius: radius.md,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: p.hairline,
      backgroundColor: p.chipFill,
      padding: space.md,
      gap: 4,
    },
    kind: { ...t.small, color: p.mute, letterSpacing: 0.5 },
    image: { width: '100%', height: 110, borderRadius: radius.sm, marginVertical: 4 },
    title: { ...t.body, color: p.recvText, fontWeight: '700' },
    subtitle: { ...t.small, color: p.mute },
    caption: { ...t.small, color: p.recvText },
    captionMuted: { ...t.small, color: p.mute, fontStyle: 'italic' },
    notice: { ...t.small, color: p.mute },
    meta: { ...t.small, color: p.mute },
    revokedText: { ...t.small, color: p.mute, fontStyle: 'italic' },
  });
}

export default PortavaObjectMessage;
