/**
 * MediaActionRail — the media action rail (spec §14/§15/§15.1/§15.2/§32).
 *
 * A bottom-sheet rail of the eligible, real-world actions for a media item, fed
 * by GET /media/:id/actions. It renders ONLY the actions the server returned
 * (each already auth/eligibility-gated, §47) and taps each through to its
 * resolved destination via the EXISTING app navigation / affordances — it never
 * re-implements a target, never shows a dead/disabled action, and never throws:
 * a 404 / empty set degrades to a clean "no actions" state.
 *
 * ADDITIVE + flag-gated: mounted only when MEDIA_WORLD_SHELL_ENABLED is on, so
 * the existing media viewer is untouched when the World shell is off.
 *
 * The three §15 signature affordances are wired here:
 *   • Ask Compass / Create Plan → POST /compass/ask carrying the mediaId (§32).
 *   • I Want This → POST/DELETE /media/:id/intent — a want SIGNAL, a distinct
 *     affordance from like/save (§15.1); optimistic toggle with degrade.
 *   • Do This Experience → GET /media/experiences/:id/plan, then route into the
 *     trip-plan flow PROPOSE-ONLY (the user confirms; never auto-added, §15.2).
 */
import React, { useCallback, useState } from 'react';
import { View, Text, Modal, Pressable, StyleSheet, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X,
  Map,
  Navigation,
  Search,
  Compass,
  CalendarPlus,
  Bookmark,
  Plus,
  Footprints,
  Eye,
  Users,
  Target,
  Send,
  Flag,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react-native';

import { color, space, radius, type as t, icon as iconToken } from '../../../theme/tokens.ts';
import { closeThenNavigate } from '../../../lib/deferredNavigate.ts';
import { usePlanPicker } from '../../../components/PlanPickerController.tsx';
import { saveMedia, reportMedia } from '../../../services/mediaInteractions.ts';
import { fetchExperiencePlan, resolveMediaActionExecution } from '../services/mediaActions.ts';
import type { MediaAction, MediaActionId, MediaEntityKind } from '../types/mediaActions.ts';
import { useMediaActions } from '../hooks/useMediaActions.ts';
import { useMediaAnalytics } from '../../../hooks/useMediaAnalytics.ts';
import { emitMediaNorthStar } from '../telemetry/mediaTelemetry.ts';

// ── Icon + tone per action ────────────────────────────────────────────────────

const ACTION_ICON: Record<MediaActionId, LucideIcon> = {
  show_on_map: Map,
  see_nearby: Navigation,
  find_similar: Search,
  ask_compass: Compass,
  create_plan: CalendarPlus,
  save: Bookmark,
  add_to_trip: Plus,
  do_this_experience: Footprints,
  view_experience: Eye,
  meet_here: Users,
  i_want_this: Target,
  share_telegraph: Send,
  report: Flag,
};

function iconFor(id: string): LucideIcon {
  return ACTION_ICON[id as MediaActionId] ?? Compass;
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface MediaActionRailProps {
  mediaId: string | null | undefined;
  visible: boolean;
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MediaActionRail({ mediaId, visible, onClose }: MediaActionRailProps) {
  const insets = useSafeAreaInsets();
  const planPicker = usePlanPicker();
  const { status, actions, entityRefs, wanted, wantPending, toggleWant } = useMediaActions(
    mediaId,
    visible,
  );
  // §45 north-star outcome telemetry — reuses the EXISTING media analytics
  // helper (batched, deduped, fire-and-forget, fail-soft).
  const { record } = useMediaAnalytics();
  // Per-action async guard (Do This Experience fetches its plan before routing).
  const [busyId, setBusyId] = useState<string | null>(null);

  const runAction = useCallback(
    (action: MediaAction) => {
      const exec = resolveMediaActionExecution(action, entityRefs);

      // Fire the §45 outcome event at the media-originated action point: this is
      // where a media object CAUSES a real-world action (Place Open / Compass /
      // Trip Add / Plan / Correction). Coarse metadata only — never the caption,
      // note, prompt, or a coordinate. Self-filters (no-op for non-outcome
      // actions) and never throws, so it cannot affect the action below.
      const entityIdOf = (kind: MediaEntityKind): string | undefined =>
        entityRefs.find((r) => r.kind === kind)?.id;
      emitMediaNorthStar(record, action.id, {
        mediaId: mediaId ?? undefined,
        entityKind: entityRefs.find((r) => r.kind === 'place')
          ? 'place'
          : entityRefs[0]?.kind,
        placeId: entityIdOf('place'),
        tripId: entityIdOf('trip'),
        surface: 'action_rail',
      });

      switch (exec.kind) {
        case 'navigate':
          closeThenNavigate(onClose, exec.route);
          return;

        case 'compass':
          // Ask Compass / Create Plan — hand the mediaId to Compass so the reply
          // is grounded in the media context (§32). Reuses the AI chat surface.
          closeThenNavigate(onClose, {
            pathname: '/(tabs)/ai',
            params: { mediaId: exec.mediaId, prefillMessage: exec.prompt },
          });
          return;

        case 'intent':
          // I Want This — a toggle SIGNAL; keep the sheet open so the state flip
          // is visible. Distinct from like/save.
          toggleWant();
          return;

        case 'save':
          if (mediaId) void saveMedia(mediaId);
          onClose();
          return;

        case 'report':
          if (mediaId) void reportMedia(mediaId, 'not_interested');
          onClose();
          return;

        case 'plan_picker':
          // Add to Trip — open the existing plan-picker (propose-only: the user
          // picks the trip and confirms; nothing is written here).
          onClose();
          setTimeout(() => {
            planPicker.open({
              id: exec.source.id,
              type: exec.source.type,
              title: exec.source.title,
              category: exec.source.category,
            });
          }, 320);
          return;

        case 'experience_plan': {
          // Do This Experience — fetch the executable plan, then route into the
          // trip-plan flow PROPOSE-ONLY. Degrade: no plan → no-op, never throws.
          if (busyId) return;
          setBusyId(action.id);
          void fetchExperiencePlan(exec.experienceId).then((r) => {
            setBusyId(null);
            if (!r.ok || !r.data) return; // not eligible / empty → nothing to propose
            const title = r.data.stops[0]?.title ?? 'This experience';
            onClose();
            setTimeout(() => {
              planPicker.open({ id: exec.experienceId, type: 'experience', title });
            }, 320);
          });
          return;
        }

        case 'unsupported':
        default:
          return;
      }
    },
    [busyId, entityRefs, mediaId, onClose, planPicker, toggleWant, record],
  );

  // Render only actions the client can actually execute (hides any future /
  // unrecognised server id) — the guarantee of "no dead actions".
  const renderable = actions.filter(
    (a) => resolveMediaActionExecution(a, entityRefs).kind !== 'unsupported',
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="Close actions" />

      <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={s.handle} />

        <View style={s.header}>
          <View style={s.headerLeft}>
            <Compass size={iconToken.s20} color={color.deep} strokeWidth={1.8} />
            <Text style={s.title}>Actions</Text>
          </View>
          <Pressable onPress={onClose} style={s.closeBtn} hitSlop={8} accessibilityLabel="Close">
            <X size={iconToken.s20} color={color.mute} strokeWidth={1.8} />
          </Pressable>
        </View>

        <ScrollView
          style={s.scrollArea}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          {status === 'loading' ? (
            <View style={s.centered}>
              <ActivityIndicator size="small" color={color.mute} />
            </View>
          ) : renderable.length === 0 ? (
            <Text style={s.empty}>
              {status === 'error'
                ? 'Couldn’t load actions. Pull down to try again.'
                : 'No actions available for this item.'}
            </Text>
          ) : (
            renderable.map((action) => {
              const Icon = iconFor(action.id);
              const isWant = action.id === 'i_want_this';
              const active = isWant && wanted;
              const rowBusy = busyId === action.id || (isWant && wantPending);
              return (
                <Pressable
                  key={action.id}
                  style={({ pressed }) => [s.row, active && s.rowActive, pressed && s.rowPressed]}
                  onPress={() => runAction(action)}
                  accessibilityRole="button"
                  accessibilityLabel={action.label}
                  accessibilityState={isWant ? { selected: wanted } : undefined}
                >
                  <View style={[s.rowIcon, active && s.rowIconActive]}>
                    <Icon
                      size={iconToken.s20}
                      color={active ? color.signal : color.ink}
                      strokeWidth={1.8}
                      fill={active ? color.signal : 'transparent'}
                    />
                  </View>
                  <Text style={[s.rowLabel, active && s.rowLabelActive]} numberOfLines={1}>
                    {isWant && wanted ? 'I want this ✓' : action.label}
                  </Text>
                  {rowBusy ? (
                    <ActivityIndicator size="small" color={color.mute} />
                  ) : (
                    <ChevronRight size={iconToken.s18} color={color.haze} strokeWidth={1.8} />
                  )}
                </Pressable>
              );
            })
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const SHEET_RADIUS = 20;

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.paper,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    paddingTop: space.sm,
    paddingHorizontal: space.lg,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: -4 } },
      android: { elevation: 12 },
    }),
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    marginBottom: space.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  title: {
    ...t.heading,
    color: color.ink,
    fontSize: 17,
  },
  closeBtn: {
    padding: 4,
  },
  scrollArea: {
    maxHeight: 420,
  },
  scrollContent: {
    paddingBottom: space.md,
  },
  centered: {
    paddingVertical: space.xl,
    alignItems: 'center',
  },
  empty: {
    ...t.body,
    color: color.mute,
    paddingVertical: space.lg,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.xs,
    borderRadius: radius.md,
  },
  rowActive: {
    backgroundColor: 'rgba(255,77,46,0.08)', // subtle signal tint (§ vermilion)
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowIcon: {
    width: iconToken.s24,
    alignItems: 'center',
  },
  rowIconActive: {},
  rowLabel: {
    ...t.body,
    color: color.ink,
    flex: 1,
  },
  rowLabelActive: {
    color: color.signal,
    fontWeight: '700',
  },
});
