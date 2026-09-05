/**
 * EventPassportScreen — what a scanned temporary event Passport looks like
 * (spec §25, §31, Phase 8).
 *
 * Everything on this screen came from ONE server call
 * (`resolveEventPassport`), which returns the narrow `event` projection: photo,
 * FIRST name, @handle, verification, permitted home country, the broad
 * at-event city, what they are currently up for, and the server-projected
 * Follow/Connect flags. There is nothing else to render, because the server
 * never sends anything else.
 *
 * Two rules this screen deliberately does NOT implement, because they are the
 * server's (§30 "Actions must be server-projected"):
 *
 *   • Whether the share is still valid. Expiry, revocation, the event ending
 *     and co-attendance are all decided server-side on the read; this screen
 *     only renders the refusal it was given.
 *   • Whether Follow / Connect may be offered. `actions.can_follow` /
 *     `can_message` are rendered as sent — never re-derived from trust or
 *     verification.
 */
import React from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, MapPin, Clock, UserPlus, MessageCircle, ShieldAlert } from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import { CachedImage } from '../../components/CachedImage.tsx';
import { VerifiedStamp } from '../../components/ui/VerifiedStamp.tsx';
import { resolveEventPassport, type EventPassportProjectionView } from './eventPassport.ts';
import { shareRemainingLabel } from './eventPassportShareUtils.ts';

interface Props {
  token?: string;
  /** Test seam: skip the network and render this state directly. */
  initialState?: ScreenState;
}

export type ScreenState =
  | { kind: 'loading' }
  | { kind: 'ready'; passport: EventPassportProjectionView; expiresAt: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'disabled' };

/**
 * Every refusal renders as the SAME neutral message: an expired share, a revoked
 * one, an unknown token and "you are not at this event" all land here.
 *
 * SCOPE OF THIS INVARIANT — it is enforced HERE, on the screen, not by the API.
 * `sendEventShareRefusal` (artifacts/api-server/src/routes/passport.ts) does
 * distinguish them on the wire: 404 for an unknown token, and three separate
 * 403 messages for revoked / expired / not-at-the-event. This screen
 * deliberately collapses all of that into one line so the rendered surface is
 * not an oracle for whether a given person minted a share for a given event.
 *
 * That layering is intentional rather than an oversight: reaching any of those
 * responses at all requires BOTH an authenticated caller and possession of a
 * 48-hex token, so the API's extra detail is only ever told to someone who
 * already holds the handle — while an operator debugging a refusal still gets a
 * usable reason. If the API is ever made uniform, this comment (and the
 * server's refusal table) must move together.
 */
const REFUSAL_COPY = 'This event Passport is not available.';

export default function EventPassportScreen({ token, initialState }: Props) {
  const insets = useSafeAreaInsets();
  const [state, setState] = React.useState<ScreenState>(initialState ?? { kind: 'loading' });

  React.useEffect(() => {
    if (initialState) return;
    let cancelled = false;
    if (!token) {
      setState({ kind: 'unavailable', message: REFUSAL_COPY });
      return;
    }
    (async () => {
      const res = await resolveEventPassport(token);
      if (cancelled) return;
      if (res.ok && !res.enabled) { setState({ kind: 'disabled' }); return; }
      if (!res.ok || !res.data) { setState({ kind: 'unavailable', message: REFUSAL_COPY }); return; }
      setState({
        kind: 'ready',
        passport: res.data.passport,
        expiresAt: res.data.share.expiresAt,
      });
    })();
    return () => { cancelled = true; };
  }, [token, initialState]);

  const goBack = React.useCallback(() => {
    if (router.canGoBack?.()) router.back();
    else router.replace('/(tabs)/passport' as any);
  }, []);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable onPress={goBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back">
          <ArrowLeft size={icon.s20} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>Event Passport</Text>
        <View style={{ width: icon.s20 }} />
      </View>

      {state.kind === 'loading' && (
        <View style={s.center}><ActivityIndicator color={color.signal} /></View>
      )}

      {state.kind === 'disabled' && (
        <View style={s.center}>
          <Text style={s.msg}>Event Passports are not available yet.</Text>
        </View>
      )}

      {state.kind === 'unavailable' && (
        <View style={s.center}>
          <ShieldAlert size={icon.s24} color={color.mute} />
          <Text style={s.msg}>{state.message}</Text>
          <Text style={s.msgSub}>
            Event Passports are only for people at the event, and they expire when it ends.
          </Text>
        </View>
      )}

      {state.kind === 'ready' && (
        <EventPassportBody passport={state.passport} expiresAt={state.expiresAt} />
      )}
    </View>
  );
}

export function EventPassportBody({
  passport,
  expiresAt,
}: {
  passport: EventPassportProjectionView;
  expiresAt: string;
}) {
  const remaining = shareRemainingLabel({ expiresAt });
  const restricted = Boolean(passport.restricted);
  return (
    <ScrollView contentContainerStyle={s.body}>
      <View style={s.card}>
        {passport.identity.avatarUrl ? (
          <CachedImage
            source={{ uri: passport.identity.avatarUrl }}
            style={s.avatar}
            fallbackLabel=""
            accessibilityLabel={`${passport.identity.firstName ?? 'Traveler'}'s photo`}
          />
        ) : (
          <View style={[s.avatar, s.avatarFallback]} />
        )}

        <View style={s.nameRow}>
          <Text style={s.name}>{passport.identity.firstName ?? 'Traveler'}</Text>
          {passport.identity.verified ? <VerifiedStamp size="sm" /> : null}
        </View>
        {passport.identity.handle ? (
          <Text style={s.handle}>@{passport.identity.handle}</Text>
        ) : null}

        {passport.identity.homeCountry ? (
          <Text style={s.meta}>{passport.identity.homeCountry}</Text>
        ) : null}

        {passport.atEventCity ? (
          <View style={s.chipRow}>
            <MapPin size={12} color={color.deep} />
            {/* Broad city only — §23/TABLE 25 forbid a venue or a coordinate. */}
            <Text style={s.chipText}>At this event · {passport.atEventCity}</Text>
          </View>
        ) : null}

        {passport.intents.length > 0 ? (
          <View style={s.intentRow}>
            {passport.intents.map((i) => (
              <View key={i} style={s.intentChip}><Text style={s.intentText}>{i}</Text></View>
            ))}
          </View>
        ) : null}

        {remaining ? (
          <View style={s.chipRow}>
            <Clock size={12} color={color.mute} />
            {/* §31: the share is explicitly temporary, and says so. */}
            <Text style={s.expiryText}>Shared for this event · {remaining}</Text>
          </View>
        ) : null}
      </View>

      {restricted ? (
        <Text style={s.msgSub}>This traveler is not available to you right now.</Text>
      ) : (
        <View style={s.actions}>
          {passport.actions.can_follow ? (
            <View style={s.actionBtn}>
              <UserPlus size={icon.s16} color={color.ink} />
              <Text style={s.actionText}>Follow</Text>
            </View>
          ) : null}
          {passport.actions.can_message ? (
            <View style={s.actionBtn}>
              <MessageCircle size={icon.s16} color={color.ink} />
              <Text style={s.actionText}>Message</Text>
            </View>
          ) : null}
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  headerTitle: { ...t.heading, color: color.ink },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.xl, gap: space.sm },
  msg: { ...t.body, color: color.ink, textAlign: 'center' },
  msgSub: { ...t.small, color: color.mute, textAlign: 'center', paddingHorizontal: space.xl },
  body: { padding: space.lg, gap: space.lg },
  card: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    padding: space.xl,
    alignItems: 'center',
    gap: space.xs,
  },
  avatar: { width: avatar.s96, height: avatar.s96, borderRadius: avatar.s96 / 2 },
  avatarFallback: { backgroundColor: color.haze },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.sm },
  name: { ...t.title, color: color.ink },
  handle: { ...t.body, color: color.mute },
  meta: { ...t.small, color: color.mute },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
  chipText: { ...t.small, color: color.deep },
  expiryText: { ...t.small, color: color.mute },
  intentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.sm, justifyContent: 'center' },
  intentChip: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
  },
  intentText: { ...t.small, color: color.ink },
  actions: { flexDirection: 'row', gap: space.md, justifyContent: 'center' },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  actionText: { ...t.body, color: color.ink },
});
