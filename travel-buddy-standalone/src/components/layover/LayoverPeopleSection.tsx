/**
 * LayoverPeopleSection — opt-in city-level presence sharing + local
 * Rent-a-Buddy surfacing (booking stays in the marketplace flow).
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, Switch, ScrollView } from 'react-native';
import { Avatar } from '../ui/Avatar.tsx';
import { CachedImage } from '../CachedImage.tsx';
import { Users, Star, BadgeCheck } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { LayoverBuddiesAnswer, LayoverBuddy, LayoverBuddySafetyGate, LayoverPresenceAnswer } from '../../services/layover.ts';
import { primaryIdentityText } from '../../lib/displayIdentity.ts';

/**
 * census-layover L127 / L128 / L294 — the presence ANSWER, not just its count.
 *
 * `GET /api/airport/sessions/:id/presence` returns `disclosePresence`'s whole
 * result (`artifacts/api-server/src/services/airport/LayoverPrivacyGuard.ts:468`).
 * This card used to take `presenceCount` alone, so three different situations
 * arrived here as the integer 0 and left as one sentence — "No other shared
 * layovers here right now — you're the first.":
 *
 *   a measured zero                    TRUE, and worth saying
 *   a read that fell closed            `degraded: true`
 *   the traveller's own switch         `withheld: ['ghost_mode', …]`
 *
 * The server publishes the discriminator; the card now reads it. Nothing here
 * re-derives WHICH kind of zero it is — `degraded` and `withheld` are the
 * server's own fields and the only two this card branches on.
 *
 * The shape is `services/layover.ts`'s `LayoverPresenceAnswer` and NOT a copy.
 * A second presence vocabulary on the client is the failure mode this tree has
 * already paid for twice; one type, named after the server's own response, is
 * the whole point.
 */
interface Props {
  city: string | null;
  shareEnabled: boolean;
  shareBusy: boolean;
  presence: LayoverPresenceAnswer;
  buddies: LayoverBuddiesAnswer | null; // the WHOLE /buddies answer, null before the first read (census §48)
  canEdit: boolean;
  onToggleShare: (enabled: boolean) => void;
  onOpenBuddy: (buddy: LayoverBuddy) => void;
}

function initials(name: string | null, handle: string | null): string {
  const src = primaryIdentityText({ name, handle }).replace(/^@/, '').trim() || '?';
  const parts = src.split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

export function LayoverPeopleSection({
  city, shareEnabled, shareBusy, presence, buddies,
  canEdit, onToggleShare, onOpenBuddy,
}: Props) {
  const { count: presenceCount, travelers } = presence;
  // ORDER MATTERS AND IS THE SERVER'S. `preferences_unreadable` and
  // `ghost_mode_unreadable` appear in `withheld` AND set `degraded`, because
  // the gate fell closed rather than read a choice. Checking `degraded` first
  // means a traveller is never told their own setting hid them when nobody
  // managed to read that setting.
  const unmeasured = presence.degraded;
  const withheldByChoice = !unmeasured && (presence.withheld?.length ?? 0) > 0;
  /**
   * census L128 — THE RUNG IS THE SERVER'S STATEMENT, NOT THE ARRAY'S LENGTH.
   *
   * `level` is `disclosePresence`'s own answer about WHICH §14 rung it served
   * (LayoverPrivacyGuard.ts:468). `L0_AGGREGATE` means the count was the whole
   * disclosure, so identities are not shown here however many happen to be in
   * `travelers` — the array is not the authority on what was disclosed.
   *
   * ABSENT `level` is NOT treated as L0. A server that predates the privacy
   * guard states no rung at all, and inventing one for it would be this client
   * making the §14 decision rather than reading it.
   *
   * IMPLEMENTED, NOT IN FORCE. Aggregate-first is gated server-side on
   * `layover_presence_ladder_enabled` (migration 2740, seeded FALSE and
   * unapplied), so every response today is `L2_DISCOVERY` and this branch is
   * dark in production. It exists so that enabling the flag is a server
   * decision that needs no client change — not because the rung is live.
   */
  const aggregateOnly = presence.level === 'L0_AGGREGATE';
  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Users size={18} color={color.ink} />
        <Text style={styles.heading}>People{city ? ` in ${city}` : ''}</Text>
      </View>

      {/* Opt-in presence */}
      <View style={styles.shareRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.shareTitle}>Show me to other layover travelers</Text>
          <Text style={styles.shareDesc}>
            City-level only — never your exact location. You see others only while you're sharing too.
          </Text>
        </View>
        <Switch
          value={shareEnabled}
          disabled={!canEdit || shareBusy}
          onValueChange={onToggleShare}
          trackColor={{ true: color.deep, false: color.haze }}
        />
      </View>

      {shareEnabled && (
        <View style={styles.presenceBox}>
          {presenceCount > 0 && !unmeasured && !withheldByChoice ? (
            <>
              {!aggregateOnly && (
                <View style={styles.avatarRow} testID="layover-presence-travelers">
                  {travelers.slice(0, 6).map((p) => (
                    <View key={p.id} style={styles.avatarWrap}>
                      <Avatar uri={p.avatarUrl} name={p.name ?? p.handle} size={32} style={styles.avatarRing} />
                    </View>
                  ))}
                </View>
              )}
              <Text style={styles.presenceText}>
                {presenceCount} {presenceCount === 1 ? 'traveler is' : 'travelers are'} also on a layover here
              </Text>
              {aggregateOnly && (
                <Text style={styles.presenceUnknown} testID="layover-presence-aggregate-only">
                  Only the number is shared here — not who they are.
                </Text>
              )}
            </>
          ) : unmeasured ? (
            <Text style={styles.presenceUnknown} testID="layover-presence-unmeasured">
              We couldn't check who else is here right now. This isn't a count of
              zero — it's an answer we didn't get.
            </Text>
          ) : withheldByChoice ? (
            <Text style={styles.presenceUnknown} testID="layover-presence-withheld">
              Your sharing settings are keeping you hidden here, so you're not
              seeing other travelers either.
            </Text>
          ) : (
            <Text style={styles.presenceText}>No other shared layovers here right now — you're the first.</Text>
          )}
        </View>
      )}

      {/* Rent-a-Buddy: the list, or the server's reason there is none (§48). */}<BuddiesNotice answer={buddies} />
      {buddies?.ok && buddies.buddies.length > 0 && (
        <>
          <Text style={styles.buddyHead}>Local buddies for a few hours</Text>
          <Text style={styles.buddySub}>Booked through the regular Rent-a-Buddy flow</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.buddyRow}>
            {buddies.buddies.map((b) => (
              <Pressable key={b.id} style={styles.buddyCard} onPress={() => onOpenBuddy(b)}>
                {b.coverPhotoUrl
                  ? <CachedImage source={{ uri: b.coverPhotoUrl }} style={styles.buddyPhoto} />
                  : <View style={[styles.buddyPhoto, styles.buddyPhotoFallback]}>
                      <Text style={styles.buddyPhotoInitials}>{initials(b.displayName, null)}</Text>
                    </View>}
                {b.availableDuringLayover === true && (
                  <View style={styles.availTag}><Text style={styles.availTagText}>free during your layover</Text></View>
                )}
                <View style={styles.buddyBody}>
                  <View style={styles.buddyNameRow}>
                    <Text style={styles.buddyName} numberOfLines={1}>{primaryIdentityText(b)}</Text>
                    {b.verified && <BadgeCheck size={13} color={color.deep} />}
                  </View>
                  <View style={styles.buddyMeta}>
                    {b.averageRating != null && (
                      <View style={styles.ratingRow}>
                        <Star size={11} color={color.warn} fill={color.warn} />
                        <Text style={styles.metaStamp}>{Number(b.averageRating).toFixed(1)} ({b.reviewCount})</Text>
                      </View>
                    )}
                    {b.hourlyRateUsd != null && <Text style={styles.metaStamp}>${b.hourlyRateUsd}/hr</Text>}
                  </View>
                </View>
              </Pressable>
            ))}
          </ScrollView>
          <BuddiesCaptions answer={buddies} />
        </>
      )}
    </View>
  );
}

/**
 * Why the certified gate withheld the list, from the gate's OWN fields — the
 * same verdict and return state the countdown on this screen shows. Nothing
 * here re-derives whether leaving is possible.
 */
function gateSentence(gate: LayoverBuddySafetyGate | null): string {
  if (gate && gate.returnState && gate.returnState !== 'NORMAL') {
    return "It's time to head back to the airport, so local buddies aren't offered right now.";
  }
  if (gate?.verdict === 'no') {
    return "There's not enough time to leave the airport and get back, so local buddies aren't offered.";
  }
  if (gate?.verdict === 'stay_airside') {
    return "You're staying airside this time, so local buddies aren't offered.";
  }
  return "Local buddies aren't offered for this layover right now.";
}

/**
 * census-layover L273 / L254 / L294 — every buddy answer that is NOT a list.
 *
 * The card used to render the Rent-a-Buddy row only when `buddies.length > 0`
 * and the dashboard filled `buddies` with `[]` for a failed read, so four
 * different answers left the screen as no section at all:
 *
 *   failed read (503 / offline)   say so, with the server's sentence
 *   safety gate refused           say why, from the certified verdict
 *   marketplace switched off      say so
 *   degraded with nobody shown    say that it is not a count
 *
 * A MEASURED empty list renders nothing and claims nothing: the route serves
 * the top of a bounded page, not a census of the city, so "nobody here" would
 * be a claim it never made.
 */
function BuddiesNotice({ answer }: { answer: LayoverBuddiesAnswer | null }) {
  if (!answer) return null;
  let id: string;
  let text: string;
  if (!answer.ok) {
    id = 'layover-buddies-unavailable';
    text = answer.message;
  } else if (answer.refusal === 'rent_buddy_not_enabled') {
    id = 'layover-buddies-off';
    text = "Booking a local buddy isn't switched on yet.";
  } else if (answer.refusal) {
    id = 'layover-buddies-gate';
    text = gateSentence(answer.safetyGate);
  } else if (answer.buddies.length === 0 && answer.degraded) {
    id = 'layover-buddies-unmeasured';
    text = answer.degradedReasons.includes('blocks_unreadable')
      ? "We couldn't check your block list, so nobody is shown right now. This isn't a count of zero."
      : "We couldn't check local buddies right now. This isn't a count of zero.";
  } else {
    return null;
  }
  return (
    <>
      <Text style={styles.buddyHead}>Local buddies for a few hours</Text>
      <Text style={styles.presenceUnknown} testID={id}>{text}</Text>
    </>
  );
}

/**
 * What qualifies a list that WAS served. A "free during your layover" badge is
 * drawn only for a measured `true` (above); `null` is "not checked", and this
 * says so instead of letting it read as `false` (census §23.8). A tight window
 * served only verified, non-new profiles (`trustRequirement`, L254), and the
 * traveller is told why the list is short rather than left to guess.
 */
function BuddiesCaptions({ answer }: { answer: LayoverBuddiesAnswer | null }) {
  if (!answer?.ok) return null;
  const availabilityUnknown = answer.buddies.some((b) => b.availableDuringLayover === null);
  return (
    <>
      {answer.trustRequirement?.applied ? (
        <Text style={styles.buddySub} testID="layover-buddies-verified-only">
          Your window is tight, so only verified buddies are shown.
        </Text>
      ) : null}
      {availabilityUnknown ? (
        <Text style={styles.buddySub} testID="layover-buddies-availability-unknown">
          We couldn&rsquo;t check who&rsquo;s free during your layover.
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  card:      { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headRow:   { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading:   { ...t.heading, color: color.ink },

  shareRow:  { flexDirection: 'row', alignItems: 'center', gap: space.md },
  shareTitle:{ ...t.bodyStrong, color: color.ink },
  shareDesc: { ...t.small, color: color.faint, marginTop: 2 },

  presenceBox: { backgroundColor: color.paper, borderRadius: radius.md, padding: space.md, gap: space.sm },
  avatarRow: { flexDirection: 'row' },
  avatarWrap:{ marginRight: -8 },
  // Sizing/shape come from <Avatar size>; this is the separation ring only.
  avatarRing: { borderWidth: 2, borderColor: color.paperRaised },
  presenceText: { ...t.small, color: color.mute },
  // Deliberately NOT the warning colour: neither state is an error the
  // traveller caused, and neither is a safety signal.
  presenceUnknown: { ...t.small, color: color.faint },

  buddyHead: { ...t.bodyStrong, color: color.ink, marginTop: space.sm },
  buddySub:  { ...t.small, color: color.faint, marginTop: -4 },
  buddyRow:  { gap: space.md, paddingVertical: space.xs },
  buddyCard: { width: 150, backgroundColor: color.paper, borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: color.haze },
  buddyPhoto:{ width: '100%', height: 84 },
  buddyPhotoFallback: { backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  buddyPhotoInitials: { ...t.title, color: color.onInk },
  availTag:  { position: 'absolute', top: 6, left: 6, backgroundColor: color.success, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  availTagText: { fontSize: 9, fontWeight: '700', color: color.onInk, letterSpacing: 0.3 },
  buddyBody: { padding: space.sm, gap: 4 },
  buddyNameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  buddyName: { ...t.small, fontWeight: '700', color: color.ink, flexShrink: 1 },
  buddyMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaStamp: { ...t.stamp, color: color.faint },
});
