/**
 * MapContributionSheet — the §22 capture surface.
 *
 * Spec §22: "The map is also a low-friction capture surface. Contributions are
 * observations, not immediate truth."
 *
 * WHAT THIS SHEET IS FOR
 * ======================
 * One tap to answer one question about what is physically in front of the user
 * right now. The prompts offered come from `contributionPromptsFor`, so an
 * object can never be asked a question it cannot answer (a zone has no door; a
 * forecast has nothing to observe). The first applicable prompt is expanded on
 * open, which is what makes the common case — "how busy is it?" — a single tap.
 *
 * TWO THINGS IT REFUSES TO BE
 * ===========================
 * 1. A RATING. `CONTRIBUTION_FRAMING` sits above the options, unskippable, and
 *    every option is a state of the world rather than a judgement of it. A user
 *    who believes they are rating a place reports how they felt; §21 needs what
 *    they saw. There are no stars here and no free-text field.
 * 2. A WAY TO BUY CONFIDENCE. §22 and §37 both forbid it. The footer says so in
 *    words, and the payload built by `createContribution` has no reward, score
 *    or sponsorship field for a reward to travel in.
 *
 * THE EIGHTH PROMPT IS NOT A ROW, AND THAT IS §21
 * ===============================================
 * §22's eighth prompt is "Current photo/video". It is not listed beside the
 * other seven because it cannot be answered beside them: §21 orders
 *
 *     Observation -> Evidence -> Claim -> ...
 *
 * and `intel_evidence.observation_id` is NOT NULL, so a photo can only attach
 * to an observation that ALREADY EXISTS. A standalone photo asserts nothing and
 * the server refuses it with exactly that ruling. So the prompt is offered at
 * the only moment it is legal: immediately after an answer, as "add a photo to
 * this". One act for the contributor, two calls on the wire.
 *
 * WHY THIS SHEET DOES ITS OWN NETWORK
 * ===================================
 * Same reason `MeetHereSheet` does: a half-finished contribution is worse than
 * none, and the contributor must see it succeed or fail. An observation that
 * landed with a photo that did not is a real outcome of one tap, and the only
 * place it can honestly be said is here. `features/map/truth/contributionFlow`
 * owns the ordering and the words; this file renders them.
 *
 * `onSubmit` therefore no longer performs the submission — it is a NOTIFICATION
 * that a validated contribution was made (telemetry), fired for the observation
 * and for the media evidence alike. A caller must not submit it again.
 *
 * WHAT IT STILL DOES NOT DO
 * =========================
 * This sheet has no camera. It offers the photo/video step only when the caller
 * supplies `onRequestMedia`, and never fabricates an asset URI. Nor does it
 * upload: capture goes through the app's existing `services/media.uploadMedia`
 * (POST /api/media/upload), which strips EXIF/GPS — so no coordinate enters the
 * evidence path, and there is no second uploader here to drift from that one.
 *
 * Dark-mode first (§4).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowRightLeft,
  Ban,
  CalendarClock,
  Camera,
  Clock,
  DoorOpen,
  Sparkles,
  Users,
  X,
} from 'lucide-react-native';
import { color, icon, radius, space, typography } from '../../theme/tokens.ts';
import {
  CONTRIBUTION_FRAMING,
  CONTRIBUTION_OPTIONS,
  CONTRIBUTION_PROMPT_LABELS,
  CONTRIBUTION_REWARD_NOTICE,
  MEDIA_LABELS,
  contributionPromptsFor,
  createContribution,
  type MapContribution,
  type MapContributionKind,
  type MediaKind,
} from '../../features/map/truth/liveTruth.ts';
import {
  attachMediaEvidence,
  beginMedia,
  beginObservation,
  settleMedia,
  settleObservation,
  submitObservation,
  type ContributionFlowState,
  type ContributionTransport,
  type MapMediaAsset,
} from '../../features/map/truth/contributionFlow.ts';
import { submitMapObservation } from '../../services/mapObservations.ts';
import { uploadMedia } from '../../services/media.ts';
import type { MapObject } from '../../types/mapObjects.ts';

const SHEET = '#141412';
const HAIRLINE = 'rgba(250,249,246,0.12)';
const ROW_BG = 'rgba(250,249,246,0.05)';
const ROW_BG_ACTIVE = 'rgba(250,249,246,0.09)';

type IconComponent = React.ComponentType<{ size?: number; color?: string }>;

const PROMPT_ICONS: Record<MapContributionKind, IconComponent> = {
  crowd_level: Users,
  queue: Clock,
  entry_access: DoorOpen,
  vibe: Sparkles,
  event_status: CalendarClock,
  closure: Ban,
  crowd_direction: ArrowRightLeft,
  media: Camera,
};

/**
 * The two seams the §22 act runs on, both filled with services that already
 * exist elsewhere in the app.
 *
 * `upload` is `services/media.uploadMedia` — the SAME POST /api/media/upload
 * every other capture surface uses, which strips EXIF/GPS server-side. There is
 * deliberately no uploader in this file: a second one would be a second set of
 * rules about what leaves the device, and the one that strips location is the
 * one that must be used.
 */
const CONTRIBUTION_TRANSPORT: ContributionTransport = {
  // The contribution names its own subject, so the service's first two
  // arguments come from the payload rather than from a second source that could
  // disagree with it.
  submit: (contribution) =>
    submitMapObservation(contribution.objectId, contribution.objectKind, contribution),
  upload: (asset, kind) =>
    uploadMedia({
      uri: asset.uri,
      mimeType: asset.mimeType ?? null,
      fileSize: asset.fileSize ?? null,
      duration: asset.duration ?? null,
      type: kind === 'video' ? 'video' : 'image',
      // NOTE what is not passed: no width/height guess, and above all no
      // location of any kind. §22 evidence is an artifact, not a position.
    }),
  // No `validateOpts`: the default video ceiling (10s) is the right one for a
  // prompt that asks what a place looks like RIGHT NOW, and inventing a new
  // named surface for it would be a limit nobody had ruled on.
};

export interface MapContributionSheetProps {
  visible: boolean;
  /** The object being observed. */
  object: MapObject | null | undefined;
  onClose: () => void;
  /**
   * Notification that a validated §22 contribution was made — fired for the
   * observation and for the media evidence alike, before each is sent.
   *
   * It is NOT the submission seam. This sheet submits (see the header), so a
   * caller that also posted here would double-write one act.
   */
  onSubmit: (contribution: MapContribution) => void;
  /**
   * Supplied by a caller that can capture media. Resolves the picked asset, or
   * null when the contributor backs out of the picker.
   *
   * When absent the photo/video step is not offered at all, rather than offered
   * and then failing — this sheet has no camera and never fabricates an asset.
   */
  onRequestMedia?: (kind: MediaKind) => Promise<MapMediaAsset | null>;
  /** Injectable clock for deterministic `observedAt` in tests. */
  now?: Date | number;
}

export function MapContributionSheet({
  visible,
  object,
  onClose,
  onSubmit,
  onRequestMedia,
  now,
}: MapContributionSheetProps) {
  const insets = useSafeAreaInsets();

  const allPrompts = contributionPromptsFor(object);
  // The seven PROPOSITIONS. `media` is never a row: it is offered in the
  // confirmation step below, because §21 gives it nowhere else to stand.
  const prompts = allPrompts.filter((k) => k !== 'media');
  /** Whether this object can take a photo AND this caller can capture one. */
  const mediaOffered = onRequestMedia != null && allPrompts.includes('media');

  const [expanded, setExpanded] = useState<MapContributionKind | null>(null);
  /** Non-null once an answer has been given: the act is under way. */
  const [flow, setFlow] = useState<ContributionFlowState | null>(null);
  /** The answer being submitted, kept so a failed step 1 can be retried as-is. */
  const answerRef = useRef<{ kind: MapContributionKind; value: string } | null>(null);
  /** The asset type of the media leg, kept so a failed step 2 can be retried. */
  const mediaKindRef = useRef<MediaKind | null>(null);
  /** Guards against a second act starting while one is in flight. */
  const busyRef = useRef(false);
  /**
   * Which act any in-flight request belongs to.
   *
   * Closing and reopening the sheet starts a NEW act; a reply that arrives
   * after that must not repaint the new one with the old one's outcome — the
   * contributor would read "Report recorded" about a report they are still
   * composing.
   */
  const actRef = useRef(0);

  // Re-open on the first applicable prompt each time the sheet is shown for an
  // object, so the common answer stays one tap away (§22 "low-friction").
  useEffect(() => {
    if (!visible) return;
    setExpanded(prompts.length > 0 ? prompts[0] : null);
    setFlow(null);
    answerRef.current = null;
    mediaKindRef.current = null;
    busyRef.current = false;
    actRef.current += 1;
    // Keyed on the object, not the derived array, so re-renders don't collapse
    // a prompt the user just opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, object?.id]);

  /**
   * STEP 1 — the proposition.
   *
   * Runs on the first answer and on a retry of a FAILED first answer. It is the
   * only path that can create an observation, and it is unreachable once one
   * exists (`flow.retry` is never `'observation'` after `settleObservation`
   * succeeded), so a retry of the photo cannot loop back into a second report.
   */
  const runObservation = useCallback(
    async (kind: MapContributionKind, value: string) => {
      if (!object || busyRef.current) return;
      const contribution = createContribution(object, kind, value, { now });
      // Null means the §22 rules rejected it — never submit junk.
      if (!contribution) return;

      const act = actRef.current;
      busyRef.current = true;
      answerRef.current = { kind, value };
      setFlow(beginObservation(kind, value));
      onSubmit(contribution);

      const outcome = await submitObservation(contribution, CONTRIBUTION_TRANSPORT);
      if (actRef.current !== act) return;
      busyRef.current = false;
      setFlow((prev) => settleObservation(prev ?? beginObservation(kind, value), outcome));
    },
    [object, now, onSubmit],
  );

  /**
   * STEP 2 — the evidence.
   *
   * Takes the observation id step 1 returned. There is no branch here that can
   * submit an observation, which is what makes "retry the photo" incapable of
   * duplicating one.
   */
  const runMedia = useCallback(
    async (mediaKind: MediaKind) => {
      const observationId = flow?.observationId;
      if (!object || !onRequestMedia || !observationId || busyRef.current) return;

      const act = actRef.current;
      mediaKindRef.current = mediaKind;
      busyRef.current = true;
      // The picker runs first and outside the flow's busy phase in spirit, but
      // the lock is held across it so a second tap cannot start a parallel act.
      const asset = await onRequestMedia(mediaKind).catch(() => null);
      if (actRef.current !== act) return;
      // Only announce the attach once there is something to attach: backing out
      // of the picker is not an attempt that failed.
      if (asset) setFlow((prev) => (prev ? beginMedia(prev, mediaKind) : prev));

      const outcome = await attachMediaEvidence(
        { object, observationId, mediaKind, asset, now },
        {
          ...CONTRIBUTION_TRANSPORT,
          // The media contribution is a validated §22 payload too, so the
          // caller hears about it on the same seam as the observation.
          submit: (c) => {
            onSubmit(c);
            return CONTRIBUTION_TRANSPORT.submit(c);
          },
        },
      );
      if (actRef.current !== act) return;
      busyRef.current = false;
      setFlow((prev) => (prev ? settleMedia(prev, outcome, mediaKind) : prev));
    },
    [object, onRequestMedia, flow?.observationId, now, onSubmit],
  );

  const handleOption = (kind: MapContributionKind, value: string) => {
    if (!object) return;
    if (!mediaOffered) {
      // Nothing further to offer, so the sheet keeps its one-tap shape: build,
      // notify, submit, close. Unchanged behaviour for objects that cannot take
      // a photo at all.
      const contribution = createContribution(object, kind, value, { now });
      if (!contribution) return;
      onSubmit(contribution);
      void CONTRIBUTION_TRANSPORT.submit(contribution);
      onClose();
      return;
    }
    void runObservation(kind, value);
  };

  const handleRetry = () => {
    if (!flow) return;
    if (flow.retry === 'observation' && answerRef.current) {
      void runObservation(answerRef.current.kind, answerRef.current.value);
      return;
    }
    // The ONLY other retry. It re-runs upload + attach against the observation
    // that is already stored; step 1 is not re-entered.
    if (flow.retry === 'media' && mediaKindRef.current) {
      void runMedia(mediaKindRef.current);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={s.backdrop}
        onPress={onClose}
        accessibilityLabel="Dismiss"
        accessibilityRole="button"
      />

      <View style={[s.sheet, { paddingBottom: insets.bottom + space.md }]}>
        <View style={s.handle} />

        <View style={s.header}>
          <View style={s.headerText}>
            <Text style={s.eyebrow}>REPORT WHAT YOU SEE</Text>
            {object?.title ? (
              <Text style={s.subject} numberOfLines={1}>{object.title}</Text>
            ) : null}
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={s.closeBtn}
            accessibilityLabel="Close"
            accessibilityRole="button"
          >
            <X size={icon.s16} color={color.onInkMute} />
          </Pressable>
        </View>

        {/* §22 framing — an observation, not a rating. Never conditional. */}
        <Text style={s.framing}>{CONTRIBUTION_FRAMING}</Text>

        {/* §22's eighth prompt, announced where it belongs. A photo supports a
            report; it is not a report. Saying so up front is the difference
            between an order the contributor understands and a refusal they
            walk into. */}
        {!flow && mediaOffered && prompts.length > 0 ? (
          <Text style={s.framing}>Answer one of these, then you can add a photo to it.</Text>
        ) : null}

        {flow ? (
          /* ── The act, once an answer has been given ──────────────────────
             One act to the contributor, two calls on the wire. Every state is
             stated plainly, including the half-landed one: an observation that
             was recorded with a photo that was not. */
          <View style={s.act} testID="map-contribution-act">
            <View style={s.answerCard}>
              <Text style={s.answerEyebrow}>YOU REPORTED</Text>
              <Text style={s.answerText}>{flow.answer}</Text>
            </View>

            <View style={s.statusRow}>
              {flow.busy ? <ActivityIndicator size="small" color={color.onInkMute} /> : null}
              <Text style={s.statusText} testID="map-contribution-status">
                {flow.status}
              </Text>
            </View>
            {flow.detail ? (
              <Text style={s.detailText} testID="map-contribution-detail">
                {flow.detail}
              </Text>
            ) : null}

            {/* §21's eighth prompt, at the only point it is legal: the
                observation it would support now exists. */}
            {mediaOffered && flow.observationId && !flow.busy && flow.retry !== 'media' ? (
              <View style={s.mediaRow}>
                {CONTRIBUTION_OPTIONS.media.map((option) => {
                  const noun = MEDIA_LABELS[option.value as MediaKind].toLowerCase();
                  return (
                    <Pressable
                      key={option.value}
                      style={({ pressed }) => [s.mediaBtn, pressed && s.optionPressed]}
                      onPress={() => void runMedia(option.value as MediaKind)}
                      accessibilityRole="button"
                      accessibilityLabel={`Add a ${noun} to this report`}
                    >
                      <Camera size={icon.s16} color={color.onInk} />
                      <Text style={s.optionText}>{`Add a ${noun}`}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            <View style={s.actActions}>
              {flow.retry && !flow.busy ? (
                <Pressable
                  style={({ pressed }) => [s.actionBtn, pressed && s.optionPressed]}
                  onPress={handleRetry}
                  accessibilityRole="button"
                  accessibilityLabel={
                    flow.retry === 'media' ? 'Try attaching it again' : 'Try again'
                  }
                >
                  <Text style={s.optionText}>
                    {flow.retry === 'media' ? 'Try attaching it again' : 'Try again'}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                style={({ pressed }) => [s.actionBtn, pressed && s.optionPressed]}
                onPress={onClose}
                disabled={flow.busy}
                accessibilityRole="button"
                accessibilityState={{ disabled: flow.busy }}
                accessibilityLabel="Done"
              >
                <Text style={[s.optionText, flow.busy && s.optionTextDim]}>Done</Text>
              </Pressable>
            </View>
          </View>
        ) : prompts.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyText}>
              There is nothing to report about this on the map.
            </Text>
          </View>
        ) : (
          <ScrollView
            style={s.list}
            contentContainerStyle={s.listContent}
            showsVerticalScrollIndicator={false}
          >
            {prompts.map((kind) => {
              const Icon = PROMPT_ICONS[kind];
              const open = expanded === kind;
              return (
                <View key={kind} style={[s.promptCard, open && s.promptCardOpen]}>
                  <Pressable
                    style={s.promptHeader}
                    onPress={() => setExpanded(open ? null : kind)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    accessibilityLabel={CONTRIBUTION_PROMPT_LABELS[kind]}
                  >
                    <Icon size={icon.s16} color={open ? color.signal : color.onInkMute} />
                    <Text style={[s.promptLabel, open && s.promptLabelOpen]}>
                      {CONTRIBUTION_PROMPT_LABELS[kind]}
                    </Text>
                  </Pressable>

                  {open && (
                    <View style={s.optionWrap}>
                      {CONTRIBUTION_OPTIONS[kind].map((option) => (
                        <Pressable
                          key={option.value}
                          style={({ pressed }) => [s.option, pressed && s.optionPressed]}
                          onPress={() => handleOption(kind, option.value)}
                          accessibilityRole="button"
                          accessibilityLabel={`${CONTRIBUTION_PROMPT_LABELS[kind]} ${option.label}`}
                        >
                          <Text style={s.optionText}>{option.label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>
              );
            })}
          </ScrollView>
        )}

        {/* §22 / §37 — participation is rewarded; certainty is not for sale. */}
        <Text style={s.rewardNotice}>{CONTRIBUTION_REWARD_NOTICE}</Text>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '90%',
    backgroundColor: SHEET,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: HAIRLINE,
  },
  handle: {
    alignSelf: 'center',
    marginTop: 10,
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(250,249,246,0.22)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.md,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    ...typography.metadata,
    color: color.onInkMute,
    letterSpacing: 1.1,
  },
  subject: {
    ...typography.sectionTitle,
    color: color.onInk,
    marginTop: 3,
  },
  closeBtn: {
    width: icon.s26,
    height: icon.s26,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(250,249,246,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  framing: {
    ...typography.caption,
    fontSize: 12,
    color: color.onInkMute,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  list: {
    flexGrow: 0,
    marginTop: space.md,
  },
  listContent: {
    paddingHorizontal: space.lg,
    gap: space.sm,
    paddingBottom: space.md,
  },
  promptCard: {
    backgroundColor: ROW_BG,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  promptCardOpen: {
    backgroundColor: ROW_BG_ACTIVE,
    borderColor: HAIRLINE,
  },
  promptHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 46,
    paddingHorizontal: space.md,
  },
  promptLabel: {
    ...typography.cardTitle,
    fontSize: 14,
    color: color.onInkMute,
    flex: 1,
  },
  promptLabelOpen: {
    color: color.onInk,
  },
  optionWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    paddingTop: 2,
  },
  option: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(250,249,246,0.20)',
    backgroundColor: 'rgba(250,249,246,0.06)',
  },
  optionPressed: {
    backgroundColor: 'rgba(255,77,46,0.22)',
    borderColor: color.signal,
  },
  optionText: {
    ...typography.button,
    fontSize: 13,
    color: color.onInk,
  },
  optionTextDim: {
    color: color.onInkMute,
  },

  // ── The act (post-answer) ───────────────────────────────────────────────────
  act: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.md,
  },
  answerCard: {
    backgroundColor: ROW_BG_ACTIVE,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: HAIRLINE,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  answerEyebrow: {
    ...typography.metadata,
    color: color.onInkMute,
    letterSpacing: 1.1,
  },
  answerText: {
    ...typography.cardTitle,
    fontSize: 14,
    color: color.onInk,
    marginTop: 3,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  statusText: {
    ...typography.body,
    fontSize: 14,
    color: color.onInk,
    flex: 1,
  },
  detailText: {
    ...typography.caption,
    fontSize: 12,
    lineHeight: 17,
    color: color.onInkMute,
    marginTop: -space.sm,
  },
  mediaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  mediaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(250,249,246,0.20)',
    backgroundColor: 'rgba(250,249,246,0.06)',
  },
  actActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: space.sm,
  },
  actionBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: 'rgba(250,249,246,0.20)',
    backgroundColor: 'rgba(250,249,246,0.06)',
  },
  empty: {
    paddingHorizontal: space.lg,
    paddingVertical: space.xl,
  },
  emptyText: {
    ...typography.body,
    fontSize: 14,
    color: color.onInkMute,
    textAlign: 'center',
  },
  rewardNotice: {
    ...typography.caption,
    fontSize: 11,
    lineHeight: 15,
    color: 'rgba(250,249,246,0.48)',
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: HAIRLINE,
    marginTop: space.xs,
  },
});
