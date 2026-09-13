/**
 * Telegraph §6.2 — renderers for the typed kinds this tree can carry.
 *
 * LOCATION · ACTION · ANNOUNCEMENT · SAFETY · GIF · MEDIA_ALBUM · MEMORY_NOTE
 *
 * §11.3 is enforced here rather than assumed:
 *   - "Do not encode delivery/availability solely by color": every kind
 *     renders its own WORD (a label), so the colour is reinforcement.
 *   - "Provide reduced-motion behavior for media, GIFs and animations": a GIF
 *     shows its still frame when the viewer has asked for reduced motion, or
 *     when data-saver is on. `isGifAnimated` is the one predicate that decides
 *     it, and it is pure.
 *   - "Captions/transcripts must be optional derivatives; original media
 *     remains accessible": a GIF's `altText` is an accessibility label, never a
 *     replacement for the asset.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { DisplayMediaImage } from '../../../components/ui/DisplayMediaImage.tsx';
import { space, radius, type as t } from '../../../theme/tokens.ts';
import { useReducedMotionSetting } from '../../wall/hooks/useReducedMotionSetting.ts';
import { useTelegraphPalette, type TelegraphPalette } from '../theme/telegraphTheme.ts';
import { parseKindEnvelope, type SendableKind } from './kindsApi.ts';

const CARD_MAX_WIDTH = 280;

/**
 * §6.3 / §11.3 — whether a GIF may animate.
 *
 * Pure, and deliberately so: "reduced motion OR data saver" is a rule, and a
 * rule that lives inside a component cannot be asserted without rendering one.
 */
export function isGifAnimated(opts: { reduceMotion: boolean; dataSaver: boolean }): boolean {
  return !opts.reduceMotion && !opts.dataSaver;
}

export interface TypedMessageRendererProps {
  msgType: string | null;
  body: string | null;
  mine: boolean;
  /** §11.3 / §6.3 — a viewer-level preference; the thread passes it down. */
  dataSaver?: boolean;
  onPressAction?: (action: string, payload: any) => void;
  /**
   * §19 — pressed when the viewer acknowledges an ANNOUNCEMENT that asked for
   * one. UNDEFINED MEANS THE SURFACE CANNOT ACKNOWLEDGE, and the button is not
   * drawn at all: until this prop existed the only mount passed nothing, so
   * the "Got it" button was rendered and inert on every announcement in the
   * app. A button that does nothing is worse than an absent one — so an
   * acknowledgement affordance now requires a handler to appear.
   */
  onAcknowledge?: (payload: any) => void;
  /** True once this viewer has acknowledged; the button becomes a statement. */
  acknowledged?: boolean;
}

/** True when this renderer knows the kind — the dispatcher asks first. */
export function rendersTypedKind(msgType: string | null | undefined): boolean {
  if (typeof msgType !== 'string') return false;
  return ['media_album', 'gif', 'location', 'action', 'announcement', 'safety', 'memory_note'].includes(
    msgType.toLowerCase(),
  );
}

export function TypedMessageRenderer({
  msgType,
  body,
  mine,
  dataSaver = false,
  onPressAction,
  onAcknowledge,
  acknowledged = false,
}: TypedMessageRendererProps) {
  const palette = useTelegraphPalette();
  const reduceMotion = useReducedMotionSetting();
  const styles = React.useMemo(() => makeStyles(palette), [palette]);
  const envelope = parseKindEnvelope(msgType, body);

  if (!envelope) {
    return (
      <View style={styles.wrap} testID="telegraph-typed-unreadable">
        <Text style={styles.meta}>Message</Text>
      </View>
    );
  }

  const p = envelope.payload ?? {};

  switch (envelope.kind as SendableKind) {
    case 'LOCATION':
      return (
        <View style={styles.wrap} testID="telegraph-kind-location">
          <Text style={styles.kindWord}>LOCATION</Text>
          <Text style={styles.title}>{p.label}</Text>
          {p.approximateLabel ? <Text style={styles.subtitle}>{p.approximateLabel}</Text> : null}
          {/* §4.3: the precision the SENDER chose is shown, not inferred. */}
          <Text style={styles.meta}>{precisionWord(p.precision)}</Text>
          {p.caption ? <Text style={styles.caption}>{p.caption}</Text> : null}
        </View>
      );

    case 'ACTION':
      return (
        <View style={styles.wrap} testID="telegraph-kind-action">
          <Text style={styles.kindWord}>ACTION</Text>
          <Text style={styles.title}>{p.title}</Text>
          <Text style={styles.meta}>{prettyAction(p.action)}</Text>
          {/*
            §8.2: a proposal, never a done deed, until someone confirms — and
            the confirm control appears only where a confirm can actually
            happen. It used to be drawn unconditionally over an optional
            `onPressAction` that the conversation screen never passed, so
            "Confirm" was inert on every ACTION message in the app. The
            handler is still not wired on that screen (an ACTION typed message
            carries no command id for /telegraph/commands/:id/confirm-action
            to execute), and this is what saying so looks like.
          */}
          {onPressAction ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Confirm ${prettyAction(p.action)}`}
              onPress={() => onPressAction(p.action, p)}
              style={styles.actionButton}
              testID="telegraph-kind-action-confirm"
            >
              <Text style={styles.actionButtonText}>Confirm</Text>
            </Pressable>
          ) : (
            <Text style={styles.caption} testID="telegraph-kind-action-unconfirmable">
              Confirmation is not available on this screen
            </Text>
          )}
        </View>
      );

    case 'ANNOUNCEMENT':
      return (
        <View style={styles.announcement} testID="telegraph-kind-announcement">
          <Text style={styles.kindWord}>ANNOUNCEMENT</Text>
          <Text style={styles.title}>{p.title}</Text>
          {p.body ? <Text style={styles.caption}>{p.body}</Text> : null}
          {p.requiresAcknowledgement && acknowledged ? (
            <Text style={styles.caption} testID="telegraph-kind-announcement-acked">
              Acknowledged
            </Text>
          ) : null}
          {/*
            §19 — the button appears only when the surface can actually write
            the acknowledgement. `onAcknowledge` undefined used to still draw
            it, and every mount in the app left it undefined.
          */}
          {p.requiresAcknowledgement && !acknowledged && onAcknowledge ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Acknowledge announcement"
              onPress={() => onAcknowledge(p)}
              style={styles.actionButton}
              testID="telegraph-kind-announcement-ack"
            >
              <Text style={styles.actionButtonText}>Got it</Text>
            </Pressable>
          ) : null}
          {p.requiresAcknowledgement && !acknowledged && !onAcknowledge ? (
            <Text style={styles.caption} testID="telegraph-kind-announcement-ack-unavailable">
              Acknowledgement is not available on this screen
            </Text>
          ) : null}
        </View>
      );

    case 'SAFETY':
      return (
        <View style={styles.safety} testID="telegraph-kind-safety">
          {/* §11.1: the attention colour is reserved for safety. This is it. */}
          <Text style={styles.safetyWord}>{safetyWord(p.kind)}</Text>
          <Text style={styles.title}>{p.label}</Text>
          {p.approximateLabel ? <Text style={styles.subtitle}>{p.approximateLabel}</Text> : null}
          {p.note ? <Text style={styles.caption}>{p.note}</Text> : null}
        </View>
      );

    case 'GIF': {
      const animated = isGifAnimated({ reduceMotion, dataSaver });
      const uri = animated ? p.url : (p.stillUrl ?? p.url);
      return (
        <View style={styles.wrap} testID="telegraph-kind-gif">
          <Text style={styles.kindWord}>GIF</Text>
          <DisplayMediaImage
            uri={uri}
            width={CARD_MAX_WIDTH - space.md * 2}
            height={160}
            alt={p.altText ?? 'GIF'}
            style={styles.gif}
          />
          {!animated ? (
            <Text style={styles.meta} testID="telegraph-kind-gif-still">
              {reduceMotion ? 'Still frame — reduced motion is on' : 'Still frame — data saver is on'}
            </Text>
          ) : null}
          {p.provider ? <Text style={styles.meta}>via {p.provider}</Text> : null}
        </View>
      );
    }

    case 'MEDIA_ALBUM': {
      const assets: any[] = Array.isArray(p.assets) ? p.assets : [];
      return (
        <View style={styles.wrap} testID="telegraph-kind-album">
          <Text style={styles.kindWord}>ALBUM · {assets.length}</Text>
          <View style={styles.albumGrid}>
            {assets.slice(0, 4).map((a, i) => (
              <DisplayMediaImage
                key={`${a.url}-${i}`}
                uri={a.thumbnailUrl ?? a.url}
                width={110}
                height={110}
                alt={`Album item ${i + 1} of ${assets.length}`}
                style={styles.albumCell}
              />
            ))}
          </View>
          {assets.length > 4 ? <Text style={styles.meta}>+{assets.length - 4} more</Text> : null}
          {p.caption ? <Text style={styles.caption}>{p.caption}</Text> : null}
        </View>
      );
    }

    case 'MEMORY_NOTE':
      return (
        <View style={styles.wrap} testID="telegraph-kind-memory-note">
          <Text style={styles.kindWord}>MEMORY NOTE</Text>
          {p.text ? <Text style={styles.title}>{p.text}</Text> : null}
          {p.occurredAt ? <Text style={styles.meta}>{String(p.occurredAt).slice(0, 10)}</Text> : null}
          {Array.isArray(p.mediaAssetIds) && p.mediaAssetIds.length > 0 ? (
            <Text style={styles.meta}>{p.mediaAssetIds.length} item(s)</Text>
          ) : null}
        </View>
      );

    default:
      return (
        <View style={styles.wrap} testID="telegraph-typed-unknown">
          <Text style={styles.meta}>Message</Text>
        </View>
      );
  }
}

function precisionWord(p: unknown): string {
  switch (p) {
    case 'exact':
      return 'Exact location';
    case 'venue':
      return 'Venue';
    default:
      return 'Approximate area';
  }
}

function safetyWord(kind: unknown): string {
  switch (kind) {
    case 'need_help':
      return 'NEEDS HELP';
    case 'all_clear':
      return 'ALL CLEAR';
    case 'heads_up':
      return 'HEADS UP';
    default:
      return 'CHECK-IN';
  }
}

function prettyAction(a: unknown): string {
  if (typeof a !== 'string') return 'Action';
  return a
    .toLowerCase()
    .split('_')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
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
    announcement: {
      maxWidth: CARD_MAX_WIDTH,
      borderRadius: radius.md,
      borderLeftWidth: 3,
      borderLeftColor: p.operational,
      borderWidth: 1,
      borderColor: p.recvBorder,
      backgroundColor: p.surfaceRaised,
      padding: space.md,
      gap: 4,
    },
    safety: {
      maxWidth: CARD_MAX_WIDTH,
      borderRadius: radius.md,
      borderWidth: 2,
      borderColor: p.attention,
      backgroundColor: p.surfaceRaised,
      padding: space.md,
      gap: 4,
    },
    kindWord: { ...t.small, color: p.mute, letterSpacing: 0.5 },
    safetyWord: { ...t.small, color: p.attention, fontWeight: '800', letterSpacing: 0.5 },
    title: { ...t.body, color: p.recvText, fontWeight: '700' },
    subtitle: { ...t.small, color: p.mute },
    caption: { ...t.small, color: p.recvText },
    meta: { ...t.small, color: p.mute },
    gif: { borderRadius: radius.sm, marginVertical: 4 },
    albumGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginVertical: 4 },
    albumCell: { borderRadius: radius.sm },
    actionButton: {
      alignSelf: 'flex-start',
      marginTop: 4,
      paddingHorizontal: space.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: p.operational,
    },
    actionButtonText: { ...t.small, color: p.operationalOn, fontWeight: '700' },
  });
}

export default TypedMessageRenderer;
