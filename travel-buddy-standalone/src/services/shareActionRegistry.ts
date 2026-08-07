/**
 * shareActionRegistry — the single description of every share action.
 *
 * ## The rule this file exists to enforce
 *
 * No `switch (entity.entityType)` and no `if (entityType === …)` for share
 * behaviour anywhere else in the tree. An entity declares which actions it
 * supports via `ShareableEntity.allowedActions`; the UI asks this registry
 * what each of those ids means. Adding an entity type must never mean editing
 * a component, and adding an action must never mean editing an adapter.
 *
 * This file is the one exception to that rule, and deliberately so: §8 gives
 * the same action different copy depending on the entity ("Send to Traveler"
 * on a trip, "Send Profile" on a profile, "Send through Telegraph" on a
 * postcard), so the entity-aware bit is `labelByEntity` below — contained,
 * declarative, and in the place that is allowed to know.
 *
 * ## What a registry entry is, and is not
 *
 * Entries are DESCRIPTIONS. They carry the label, the icon name, the ordering
 * weight, the conversation target for send actions, and the preconditions.
 * They do not execute anything — there is deliberately no `run()` on them yet.
 * Executors arrive with the sheet in a later phase; keeping them out now means
 * this file stays importable from tests, adapters and analytics without
 * dragging in Clipboard, Share, expo-sharing or the messaging service.
 *
 * ## Provenance — the `source` field on every entry
 *
 *   'spec'        — id named verbatim in §8. Five of these.
 *   'spec-label'  — id transcribed from a §8 per-entity label using the same
 *                   snake_case convention. The action is specced; only the id
 *                   string is ours.
 *   'production'  — not in §8, retained because the trigger exists today and
 *                   the five entity types §8 does not cover still need it.
 *
 * `evidence` cites either the §8 line or the production call site.
 */
import type { ShareActionId, ShareDestination, ShareEntityType } from '../types/models.ts';

/** Where an action sits relative to the recipient picker in the sheet. */
export type ShareActionGroup =
  /** Operates on a chosen conversation — needs a recipient first. */
  | 'send'
  /** Puts the entity somewhere: a trip, a shared moment, Pulse. */
  | 'collect'
  /** Brings a person in. */
  | 'invite'
  /** Operates on the entity itself — no recipient involved. */
  | 'direct'
  /** Acts on the entity rather than sharing it (save, report). */
  | 'secondary';

export type ShareActionSource = 'spec' | 'spec-label' | 'production';

/**
 * Which row of the sheet an action belongs to.
 *
 *   'contextual'  — an action the entity opts into via allowedActions. What
 *                   this specific thing can do.
 *   'destination' — not contextual at all. Copying a link and handing a URL to
 *                   the OS are things you can do to ANY entity that has a URL,
 *                   so no adapter declares them. The entity signals them by
 *                   having a non-null canonicalUrl, which is also what puts
 *                   'external' in its allowedDestinations. The sheet gets this
 *                   row from resolveDestinationActions().
 */
export type ShareActionTier = 'contextual' | 'destination';

export interface ShareActionDescriptor {
  id: ShareActionId;
  /** Contextual (declared by an adapter) or destination (universal). */
  tier: ShareActionTier;
  /** Default copy. Sentence case as §8 writes it, no trailing punctuation. */
  label: string;
  /**
   * Per-entity copy overrides, straight from §8. Absent entity ⇒ `label`.
   * This is the only entity-type knowledge allowed outside the adapters.
   */
  labelByEntity?: Partial<Record<ShareEntityType, string>>;
  /**
   * lucide-react-native icon name, or 'PortavaShareIcon' / 'TelegraphSendIcon'
   * for the brand marks. A name, not a component, so this module stays free of
   * React imports.
   */
  icon: string;
  group: ShareActionGroup;
  /** Ascending sort within a group. Gaps left for insertions. */
  order: number;
  /**
   * For send actions: which conversation target the picker opens on. Used to
   * cross-check against the entity's allowedDestinations, so an entity can
   * never offer a send button for a destination it does not permit.
   */
  destination?: ShareDestination;
  /** True when the action cannot run until a recipient is selected. */
  requiresRecipient: boolean;
  /** True when the action needs `ShareableEntity.canonicalUrl` to be non-null. */
  requiresUrl: boolean;
  source: ShareActionSource;
  /** The §8 line or the production call site this came from. */
  evidence: string;
}

const DESCRIPTORS: ShareActionDescriptor[] = [
  // ── Send ───────────────────────────────────────────────────────────────────
  {
    id: 'send_to_traveler',
    tier: 'contextual',
    label: 'Send to Traveler',
    labelByEntity: {
      // §8 gives this action different copy on three entities.
      profile:  'Send Profile',
      postcard: 'Send through Telegraph',
    },
    icon: 'TelegraphSendIcon',
    group: 'send',
    order: 10,
    destination: 'dm',
    requiresRecipient: true,
    requiresUrl: false,
    source: 'spec-label',
    evidence: '§8 Trip/Plan/Event "Send to Traveler"; Profile "Send Profile"; Postcard "Send through Telegraph"',
  },
  {
    id: 'send_to_circle',
    tier: 'contextual',
    label: 'Send to Circle',
    icon: 'Users',
    group: 'send',
    order: 20,
    destination: 'circle',
    requiresRecipient: true,
    requiresUrl: false,
    source: 'spec',
    evidence: '§8 named id; Plan/Event "Send to Circle"',
  },
  {
    id: 'send_to_trip_crew',
    tier: 'contextual',
    label: 'Send to Trip Crew',
    icon: 'Users',
    group: 'send',
    order: 30,
    destination: 'trip_crew',
    requiresRecipient: true,
    requiresUrl: false,
    source: 'spec-label',
    evidence: '§8 Place "Send to Trip Crew"',
  },

  // ── Collect ────────────────────────────────────────────────────────────────
  {
    id: 'share_to_pulse',
    tier: 'contextual',
    label: 'Share to Pulse',
    icon: 'Radio',
    group: 'collect',
    order: 10,
    requiresRecipient: false,
    requiresUrl: false,
    source: 'spec',
    evidence: '§8 named id; Postcard / Trip / Plan/Event "Share to Pulse"',
  },
  {
    id: 'add_to_trip',
    tier: 'contextual',
    label: 'Add to Trip',
    icon: 'CalendarPlus',
    group: 'collect',
    order: 20,
    requiresRecipient: false,
    requiresUrl: false,
    source: 'spec',
    evidence: '§8 named id; Place / Postcard "Add to Trip". Adds a trip_plan_items row.',
  },
  {
    id: 'save_to_trip',
    tier: 'contextual',
    label: 'Save to Trip',
    icon: 'Bookmark',
    group: 'collect',
    order: 30,
    requiresRecipient: false,
    requiresUrl: false,
    source: 'spec-label',
    evidence: '§8 Place "Save to Trip". Distinct from add_to_trip: this is TripDetail.savedIdeas, not the itinerary.',
  },
  {
    id: 'add_to_shared_moment',
    tier: 'contextual',
    label: 'Add to Shared Moment',
    icon: 'Images',
    group: 'collect',
    order: 40,
    requiresRecipient: false,
    requiresUrl: false,
    source: 'spec',
    evidence: '§8 named id; Place / Postcard "Add to Shared Moment"',
  },

  // ── Invite ─────────────────────────────────────────────────────────────────
  {
    id: 'invite_to_trip',
    tier: 'contextual',
    label: 'Invite to Trip',
    icon: 'UserPlus',
    group: 'invite',
    order: 10,
    requiresRecipient: false,
    requiresUrl: false,
    source: 'spec',
    evidence: '§8 named id; Profile "Invite to Trip" — the entity is the person, the trip is picked',
  },
  {
    id: 'invite_to_plan',
    tier: 'contextual',
    label: 'Invite to Plan',
    icon: 'CalendarPlus',
    group: 'invite',
    order: 20,
    requiresRecipient: false,
    requiresUrl: false,
    source: 'spec-label',
    evidence: '§8 Profile "Invite to Plan"',
  },
  {
    id: 'invite_traveler',
    tier: 'contextual',
    label: 'Invite Traveler',
    icon: 'UserPlus',
    group: 'invite',
    order: 30,
    requiresRecipient: true,
    requiresUrl: false,
    source: 'spec-label',
    evidence: '§8 Trip / Plan/Event "Invite Traveler" — the inverse of invite_to_trip: the entity is the trip or event, the person is picked',
  },

  // ── Recommend ──────────────────────────────────────────────────────────────
  {
    id: 'recommend_to_traveler',
    tier: 'contextual',
    label: 'Recommend to someone',
    labelByEntity: {
      profile:       'Recommend Buddy',
      buddy_profile: 'Recommend Buddy',
    },
    icon: 'ThumbsUp',
    group: 'send',
    order: 40,
    destination: 'dm',
    requiresRecipient: true,
    requiresUrl: false,
    source: 'spec-label',
    evidence: '§8 Place "Recommend to someone"; Profile "Recommend Buddy". Kept distinct from send_to_traveler because §8 lists both on Place.',
    // TODO(share): currently send-shaped — it opens the DM picker and is
    // indistinguishable from send_to_traveler apart from its copy. There is no
    // recommendation record in the schema: nothing stores who recommended what
    // to whom, so a recommendation cannot be listed, counted, acted on or
    // attributed later. If "recommend" is meant to be more than framing on a
    // message, it needs a table before an executor is written against it.
  },

  // ── Link / OS-level ────────────────────────────────────────────────────────
  {
    id: 'copy_link',
    tier: 'destination',
    label: 'Copy link',
    labelByEntity: { trip: 'Copy Trip Link' },
    icon: 'Link',
    group: 'direct',
    order: 10,
    requiresRecipient: false,
    requiresUrl: true,
    source: 'spec-label',
    evidence: '§8 Trip "Copy Trip Link"; production ShareSheet.tsx:243, app/stamp/[stampId].tsx:83, StampDetailModal.tsx:74',
  },
  {
    id: 'share_external',
    tier: 'destination',
    label: 'Share',
    icon: 'PortavaShareIcon',
    group: 'direct',
    order: 20,
    requiresRecipient: false,
    requiresUrl: true,
    source: 'production',
    evidence: '17 raw Share.share() call sites across 13 files (audit §1a #1-16). Not in §8; retained for the entity types §8 does not cover.',
  },
  {
    id: 'share_image',
    tier: 'contextual',
    label: 'Share as image',
    icon: 'Image',
    group: 'direct',
    order: 30,
    requiresRecipient: false,
    // The captured JPEG is the payload; a URL is a nice-to-have in the caption.
    requiresUrl: false,
    source: 'production',
    evidence: 'usePassportShare.ts:74-96, useStampShare.ts:104-126 (audit §1a #11-16)',
  },
  {
    id: 'share_file',
    tier: 'contextual',
    label: 'Save to device',
    icon: 'Download',
    group: 'direct',
    order: 40,
    requiresRecipient: false,
    requiresUrl: false,
    source: 'production',
    evidence: 'HighlightViewer.tsx:520 Sharing.shareAsync (audit §1a #18)',
  },

  // ── Acts on the entity ─────────────────────────────────────────────────────
  {
    id: 'save',
    tier: 'contextual',
    label: 'Save',
    icon: 'Bookmark',
    group: 'secondary',
    order: 10,
    requiresRecipient: false,
    requiresUrl: false,
    source: 'production',
    evidence: 'savePost, saveEvent, saveProfile in services/{posts,events,saves}.ts. Distinct from save_to_trip: this is the caller\'s own saves.',
  },
  {
    id: 'report',
    tier: 'contextual',
    label: 'Report',
    icon: 'Flag',
    group: 'secondary',
    order: 20,
    requiresRecipient: false,
    requiresUrl: false,
    source: 'production',
    evidence: 'submitReport / ReportSheet, rendered on every entity detail screen',
  },
];

/** id → descriptor. The only lookup any caller should need. */
export const SHARE_ACTION_REGISTRY: Readonly<Record<ShareActionId, ShareActionDescriptor>> =
  Object.freeze(
    DESCRIPTORS.reduce((acc, d) => {
      acc[d.id] = Object.freeze(d);
      return acc;
    }, {} as Record<ShareActionId, ShareActionDescriptor>),
  );

/** Every action id, in registry order. Useful for exhaustiveness tests. */
export const ALL_SHARE_ACTION_IDS: readonly ShareActionId[] = Object.freeze(
  DESCRIPTORS.map((d) => d.id),
);

export function getShareAction(id: ShareActionId): ShareActionDescriptor {
  return SHARE_ACTION_REGISTRY[id];
}

/** The §8 copy for this action on this entity, falling back to the default. */
export function shareActionLabel(id: ShareActionId, entityType: ShareEntityType): string {
  const d = SHARE_ACTION_REGISTRY[id];
  return d?.labelByEntity?.[entityType] ?? d?.label ?? '';
}

/** A descriptor with its label already resolved for the entity in hand. */
export interface ResolvedShareAction extends ShareActionDescriptor {
  /** `labelByEntity[entityType] ?? label`, so the sheet never re-derives copy. */
  resolvedLabel: string;
}

const GROUP_ORDER: Record<ShareActionGroup, number> = {
  send: 0, collect: 1, invite: 2, direct: 3, secondary: 4,
};

/**
 * Resolve an entity's `allowedActions` into ordered, labelled descriptors,
 * dropping any action whose precondition the entity cannot meet:
 *
 *   - needs a URL, entity has none
 *   - is a send to a destination the entity does not permit
 *
 * This is the function the sheet will call. It is the reason no component ever
 * needs to know what an entity type is.
 */
export function resolveShareActions(
  allowedActions: readonly ShareActionId[],
  opts: {
    hasUrl: boolean;
    entityType: ShareEntityType;
    /** Omit to skip the destination cross-check. */
    allowedDestinations?: readonly ShareDestination[];
  },
): ResolvedShareAction[] {
  return allowedActions
    .map((id) => SHARE_ACTION_REGISTRY[id])
    .filter((d): d is ShareActionDescriptor => Boolean(d))
    // Destination-tier actions are never contextual. If one shows up in an
    // entity's allowedActions that is an adapter bug, not a request — drop it
    // here so it cannot be rendered twice (once contextually, once in the
    // external row). shareAdapters.test.ts asserts no adapter emits one.
    .filter((d) => d.tier === 'contextual')
    .filter((d) => (d.requiresUrl ? opts.hasUrl : true))
    .filter((d) =>
      d.destination && opts.allowedDestinations
        ? opts.allowedDestinations.includes(d.destination)
        : true,
    )
    .sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.order - b.order)
    .map((d) => ({ ...d, resolvedLabel: shareActionLabel(d.id, opts.entityType) }));
}

/**
 * The sheet's external row: what you can do with any entity that has a URL.
 *
 * Not derived from `allowedActions` — destination-tier actions are universal,
 * so an entity qualifies purely by having a canonical URL. `hasUrl: false`
 * returns an empty array, which is the correct behaviour for a compass
 * recommendation wrapping a booking/suggestion/message: nothing to copy,
 * nothing to hand the OS.
 *
 * Labels come back resolved, so a trip's row reads "Copy Trip Link".
 */
export function resolveDestinationActions(
  opts: { hasUrl: boolean; entityType: ShareEntityType },
): ResolvedShareAction[] {
  if (!opts.hasUrl) return [];
  return DESCRIPTORS
    .filter((d) => d.tier === 'destination')
    .filter((d) => (d.requiresUrl ? opts.hasUrl : true))
    .sort((a, b) => a.order - b.order)
    .map((d) => ({ ...d, resolvedLabel: shareActionLabel(d.id, opts.entityType) }));
}

/** Ids no adapter may declare. Exported so tests can assert the invariant. */
export const DESTINATION_TIER_ACTION_IDS: readonly ShareActionId[] = Object.freeze(
  DESCRIPTORS.filter((d) => d.tier === 'destination').map((d) => d.id),
);
