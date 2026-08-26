/**
 * Quick Signal composer (Intelligence Gathering / IG-03) — the <=5-second
 * structured report.
 *
 * Launched from a place (subjectId prefilled) or with a venue category. Location
 * and time are prefilled and verified privately (coordinates are never shown and
 * never attached to a public post — the write defaults to `private` visibility).
 * There is NO free-text caption anywhere: the traveler taps one option and a
 * structured observation is sent. Every write carries an Idempotency-Key
 * (minted inside the service / PromptBlock).
 *
 * Gating (inert no-op when off): the whole screen requires
 * `intel_capture_quick_signal`. It is fully suppressed during an active Safe
 * Return / emergency. It never shows a blank/unknown-subject prompt.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Signpost, Sparkles } from 'lucide-react-native';
import { color, space, radius, typography } from '../../src/theme/tokens';
import { IntelModalScaffold } from '../../src/components/intel/IntelModalScaffold';
import { PromptBlock } from '../../src/components/intel/PromptBlock';
import { OptionPills } from '../../src/components/intel/OptionPills';
import { SuppressedNotice, PrivateLocationBadge, SentToast } from '../../src/components/intel/IntelBits';
import { TravelButton } from '../../src/components/primitives';
import { useIntelPrompts } from '../../src/hooks/useIntelPrompts';
import { getCurrentGps } from '../../src/services/location';
import {
  QUICK_SIGNAL_PROMPTS,
  QUICK_SIGNAL_CONTEXTS,
  VENUE_CATEGORIES,
  VENUE_LABELS,
  VENUE_PROMPTS,
  VENUE_QUESTION_SETS,
  DEFAULT_VISIBILITY,
  PARTY_SIZE_BUCKETS,
  PARTY_SIZE_LABELS,
  PARTY_SIZE_PROMPT,
  type QuickSignalContext,
  type VenueCategory,
  type PromptQuestion,
  type PartySizeBucket,
} from '../../src/lib/intel/contracts';

function asContext(v: string | undefined): QuickSignalContext {
  return (QUICK_SIGNAL_CONTEXTS as readonly string[]).includes(v ?? '') ? (v as QuickSignalContext) : 'arrival';
}
function asVenue(v: string | undefined): VenueCategory | null {
  return (VENUE_CATEGORIES as readonly string[]).includes(v ?? '') ? (v as VenueCategory) : null;
}

/** Build a standalone PromptQuestion for a bare Quick Signal context. */
function contextQuestion(context: QuickSignalContext): PromptQuestion {
  const phase1 = context === 'arrival' || context === 'inside' || context === 'entrance';
  return {
    id: context,
    topic: context,
    prompt: QUICK_SIGNAL_PROMPTS[context].prompt,
    kind: 'context',
    context,
    options: QUICK_SIGNAL_PROMPTS[context].options,
    phase1,
  };
}

export default function QuickSignalScreen() {
  const params = useLocalSearchParams<{
    subjectId?: string;
    subjectName?: string;
    venue?: string;
    context?: string;
    zoneId?: string;
  }>();

  const subjectId = typeof params.subjectId === 'string' ? params.subjectId : undefined;
  const subjectName = typeof params.subjectName === 'string' ? params.subjectName : undefined;
  const zoneId = typeof params.zoneId === 'string' ? params.zoneId : null;
  const venue = asVenue(params.venue);
  const context = asContext(params.context);

  const { captureEnabled, safeReturnActive, trailEnabled } = useIntelPrompts();

  const [verified, setVerified] = useState(false);
  const [sent, setSent] = useState(false);
  // §independent-group signal: the "who are you here with?" answer, collected once
  // and attached to every label-eligible write on this screen. Null = skipped
  // (the server fail-closes: no group_key, no credit toward the group floor).
  const [partySize, setPartySize] = useState<PartySizeBucket | null>(null);
  const [lastObservation, setLastObservation] = useState<{ id: string; claimType: string; value: unknown } | null>(null);
  const timeLabel = useMemo(
    () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    [],
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Privately verify presence (coordinates are never displayed or sent here).
  useEffect(() => {
    let alive = true;
    getCurrentGps()
      .then((r) => {
        if (alive) setVerified(!!r.granted && r.lat != null && r.lng != null);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const venueQuestions: PromptQuestion[] = useMemo(
    () => (venue ? VENUE_QUESTION_SETS[venue].arrival : [contextQuestion(context)]),
    [venue, context],
  );

  // §6 topics for this venue that aren't wired to a Phase-1 question yet.
  const plannedTopics = useMemo(() => {
    if (!venue) return [];
    const covered = new Set(venueQuestions.map((q) => q.topic));
    return VENUE_PROMPTS[venue].arrivalInside.filter((topic) => !covered.has(topic));
  }, [venue, venueQuestions]);

  const singleQuick = !venue; // one prompt → success state after the send

  // The party question is asked only when at least one prompt on this screen is
  // label-eligible (a crowd/queue/access signal that can feed a public live
  // label). Exit/movement-only screens never show it.
  const labelEligible = useMemo(() => venueQuestions.some((q) => q.phase1), [venueQuestions]);

  function handleSent(_q: PromptQuestion, _option: string, observation?: { id: string; claimType: string; value: unknown }) {
    if (observation?.id) setLastObservation({ id: observation.id, claimType: observation.claimType, value: observation.value });
    if (!singleQuick) return;
    setSent(true);
    // Auto-close only when there's no follow-up Moment affordance to offer.
    if (!observation?.id) {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => {
        if (router.canGoBack()) router.back();
      }, 1000);
    }
  }

  const title = venue ? `${VENUE_LABELS[venue]} · Quick Signal` : 'Quick Signal';
  const subtitle = subjectName ?? 'Share what it’s like right now';

  // ── Suppression / guards ────────────────────────────────────────────────
  let body: React.ReactNode;
  if (!captureEnabled) {
    body = <SuppressedNotice reason="disabled" />;
  } else if (safeReturnActive) {
    body = <SuppressedNotice reason="safe_return" />;
  } else if (!subjectId) {
    body = (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyTitle}>Open this from a place</Text>
        <Text style={styles.emptyBody}>
          Quick Signals attach to the place you’re at. Open a place, then tap “Share a signal”.
        </Text>
      </View>
    );
  } else if (sent) {
    body = (
      <View style={{ gap: space.lg }}>
        <SentToast label="Thanks — signal sent" />
        <Text style={styles.thanksNote}>Kept private. It helps other travelers read the room.</Text>
        {lastObservation ? (
          <TravelButton
            label="Turn it into a Moment"
            variant="secondary"
            icon={<Sparkles size={16} color={color.ink} />}
            onPress={() =>
              router.push({
                pathname: '/intel/moment' as any,
                params: {
                  observationId: lastObservation.id,
                  subjectId: subjectId ?? '',
                  subjectName: subjectName ?? '',
                  claimType: lastObservation.claimType,
                },
              })
            }
          />
        ) : null}
        <TravelButton
          label="Done"
          variant="ghost"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)' as any))}
        />
      </View>
    );
  } else {
    body = (
      <>
        <PrivateLocationBadge placeName={subjectName} verified={verified} timeLabel={timeLabel} />

        {labelEligible ? (
          <View style={styles.partyBlock} testID="intel-party-size">
            <Text style={styles.partyPrompt}>{PARTY_SIZE_PROMPT}</Text>
            <OptionPills
              options={PARTY_SIZE_BUCKETS}
              onSelect={(v) => setPartySize((prev) => (prev === v ? null : (v as PartySizeBucket)))}
              selectedOption={partySize}
              labelFor={(v) => PARTY_SIZE_LABELS[v as PartySizeBucket]}
              testIDPrefix="intel-party"
            />
            <Text style={styles.partyHint}>
              Optional — it lets your report count toward how busy a place really is, never who you are with.
            </Text>
          </View>
        ) : null}

        <View style={{ gap: space.xl }}>
          {venueQuestions.map((q) => (
            <PromptBlock
              key={q.id}
              subjectId={subjectId}
              question={q}
              visibility={DEFAULT_VISIBILITY}
              zoneId={zoneId}
              partySize={partySize ?? undefined}
              onSent={handleSent}
            />
          ))}
        </View>

        {plannedTopics.length > 0 ? (
          <View style={styles.plannedWrap}>
            <Text style={styles.plannedLabel}>More {venue ? VENUE_LABELS[venue].toLowerCase() : ''} signals soon</Text>
            <View style={styles.plannedChips}>
              {plannedTopics.map((topic) => (
                <View key={topic} style={styles.plannedChip}>
                  <Text style={styles.plannedChipText}>{topic}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <Text style={styles.privacyFootnote}>
          Sent as a structured report — no free text. Kept private by default; your exact location is never shared.
        </Text>
      </>
    );
  }

  const footer =
    venue && trailEnabled && subjectId && !sent ? (
      <TravelButton
        label="Leaving soon? Share your exit"
        variant="secondary"
        icon={<Signpost size={16} color={color.ink} />}
        onPress={() =>
          router.push({
            pathname: '/intel/trail' as any,
            params: { subjectId, subjectName: subjectName ?? '', venue },
          })
        }
      />
    ) : undefined;

  return (
    <IntelModalScaffold title={title} subtitle={subtitle} footer={footer}>
      {body}
    </IntelModalScaffold>
  );
}

const styles = StyleSheet.create({
  emptyCard: {
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    gap: 6,
  },
  emptyTitle: { ...typography.cardTitle, color: color.ink },
  emptyBody: { ...typography.caption, color: color.mute, lineHeight: 19 },
  thanksNote: { ...typography.caption, color: color.mute },
  partyBlock: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  partyPrompt: { ...typography.cardTitle, color: color.ink },
  partyHint: { ...typography.caption, color: color.faint, lineHeight: 18 },
  plannedWrap: { gap: space.sm },
  plannedLabel: { ...typography.metadata, color: color.faint, textTransform: 'uppercase' },
  plannedChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  plannedChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    borderStyle: 'dashed',
    backgroundColor: color.paper,
  },
  plannedChipText: { ...typography.label, color: color.faint },
  privacyFootnote: { ...typography.caption, color: color.faint, lineHeight: 18 },
});
