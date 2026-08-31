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
 * WHAT IT DOES NOT DO
 * ===================
 * No network. `onSubmit` hands the caller a validated `MapContribution` and the
 * caller owns the §22 pipeline from there (Observation -> Identity/Trust ->
 * Evidence Qualification -> Claim -> Projection). Media capture is likewise
 * delegated: this sheet has no camera, so it offers the photo/video prompt only
 * when the caller supplies `onRequestMedia`, and never fabricates an asset URI.
 *
 * Dark-mode first (§4).
 */
import React, { useEffect, useState } from 'react';
import {
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
  contributionPromptsFor,
  createContribution,
  type MapContribution,
  type MapContributionKind,
  type MediaKind,
} from '../../features/map/truth/liveTruth.ts';
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

export interface MapContributionSheetProps {
  visible: boolean;
  /** The object being observed. */
  object: MapObject | null | undefined;
  onClose: () => void;
  /**
   * Receives a validated §22 observation. The sheet performs NO submission —
   * the caller owns the claim pipeline and the server re-authorizes anyway.
   */
  onSubmit: (contribution: MapContribution) => void;
  /**
   * Supplied by a caller that can capture media. When absent, the photo/video
   * prompt is hidden rather than offered and then failing — this sheet will not
   * emit a media contribution without a real asset.
   */
  onRequestMedia?: (kind: MediaKind) => void;
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
  const prompts = onRequestMedia ? allPrompts : allPrompts.filter((k) => k !== 'media');

  const [expanded, setExpanded] = useState<MapContributionKind | null>(null);

  // Re-open on the first applicable prompt each time the sheet is shown for an
  // object, so the common answer stays one tap away (§22 "low-friction").
  useEffect(() => {
    if (!visible) return;
    setExpanded(prompts.length > 0 ? prompts[0] : null);
    // Keyed on the object, not the derived array, so re-renders don't collapse
    // a prompt the user just opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, object?.id]);

  const handleOption = (kind: MapContributionKind, value: string) => {
    if (!object) return;
    if (kind === 'media') {
      onRequestMedia?.(value as MediaKind);
      onClose();
      return;
    }
    const contribution = createContribution(object, kind, value, { now });
    // Null means the rules rejected it — stay open rather than submitting junk.
    if (!contribution) return;
    onSubmit(contribution);
    onClose();
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

        {prompts.length === 0 ? (
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
