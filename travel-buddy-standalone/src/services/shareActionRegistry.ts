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
 * ## What a registry entry is, and is not
 *
 * Entries are DESCRIPTIONS. They carry the label, the icon name, the ordering
 * weight, and whether the action needs a recipient picked first. They do not
 * execute anything — there is deliberately no `run()` on them yet. Executors
 * arrive with the sheet in a later phase; keeping them out now means this file
 * stays importable from tests, adapters and analytics without dragging in
 * Clipboard, Share, expo-sharing or the messaging service.
 *
 * ## Provenance of the action list — read before extending
 *
 * The brief's §8 action list is not in this repo. This set was reconstructed
 * from the 28 trigger points inventoried in docs/UNIVERSAL-SHARE-AUDIT.md §1a,
 * so every id below is backed by a trigger that exists in production today —
 * the `evidence` field on each entry cites it. That makes the list defensible
 * but not authoritative: reconcile against §8 before wiring executors. The
 * cost of a correction is confined to this file plus the `allowedActions`
 * arrays in shareAdapters.ts.
 */
import type { ShareActionId } from '../types/models.ts';

/** Where an action sits relative to the recipient picker in the sheet. */
export type ShareActionGroup =
  /** Operates on a chosen conversation — needs a recipient first. */
  | 'send'
  /** Operates on the entity itself — no recipient involved. */
  | 'direct'
  /** Acts on the entity rather than sharing it (save, report). */
  | 'secondary';

export interface ShareActionDescriptor {
  id: ShareActionId;
  /** Button copy. Sentence case, no trailing punctuation. */
  label: string;
  /**
   * lucide-react-native icon name, or 'PortavaShareIcon' for the brand mark.
   * A name, not a component, so this module stays free of React imports.
   */
  icon: string;
  group: ShareActionGroup;
  /** Ascending sort within a group. Gaps left for insertions. */
  order: number;
  /** True when the action cannot run until a recipient is selected. */
  requiresRecipient: boolean;
  /** True when the action needs `ShareableEntity.canonicalUrl` to be non-null. */
  requiresUrl: boolean;
  /** The production trigger this action was derived from. */
  evidence: string;
}

const DESCRIPTORS: ShareActionDescriptor[] = [
  {
    id: 'send_in_app',
    label: 'Send in a chat',
    icon: 'TelegraphSendIcon',
    group: 'send',
    order: 10,
    requiresRecipient: true,
    requiresUrl: false,
    evidence: 'ShareSheet.handleSend + DiscoveryShareSheet + shareGemToTelegraph (audit §1a #22-24)',
  },
  {
    id: 'copy_link',
    label: 'Copy link',
    icon: 'Link',
    group: 'direct',
    order: 10,
    requiresRecipient: false,
    requiresUrl: true,
    evidence: 'ShareSheet.tsx:243, app/stamp/[stampId].tsx:83, StampDetailModal.tsx:74 (audit §1a #19-21)',
  },
  {
    id: 'share_external',
    label: 'Share',
    icon: 'PortavaShareIcon',
    group: 'direct',
    order: 20,
    requiresRecipient: false,
    requiresUrl: true,
    evidence: '17 raw Share.share() call sites across 13 files (audit §1a #1-16)',
  },
  {
    id: 'share_image',
    label: 'Share as image',
    icon: 'Image',
    group: 'direct',
    order: 30,
    requiresRecipient: false,
    // The captured JPEG is the payload; a URL is a nice-to-have in the caption.
    requiresUrl: false,
    evidence: 'usePassportShare.ts:74-96, useStampShare.ts:104-126 (audit §1a #11-16)',
  },
  {
    id: 'share_file',
    label: 'Save to device',
    icon: 'Download',
    group: 'direct',
    order: 40,
    requiresRecipient: false,
    requiresUrl: false,
    evidence: 'HighlightViewer.tsx:520 Sharing.shareAsync (audit §1a #18)',
  },
  {
    id: 'invite_link',
    label: 'Invite link',
    icon: 'UserPlus',
    group: 'direct',
    order: 50,
    requiresRecipient: false,
    // Mints its own token-bearing URL; does not reuse the canonical one.
    requiresUrl: false,
    evidence: 'app/trip/[id].tsx:230 createInviteLink (audit §1a #4)',
  },
  {
    id: 'add_to_trip',
    label: 'Add to trip',
    icon: 'CalendarPlus',
    group: 'secondary',
    order: 10,
    requiresRecipient: false,
    requiresUrl: false,
    evidence: 'TelegraphRecommendationCard onAddToTrip; AddToPlanSheet',
  },
  {
    id: 'save',
    label: 'Save',
    icon: 'Bookmark',
    group: 'secondary',
    order: 20,
    requiresRecipient: false,
    requiresUrl: false,
    evidence: 'savePost, saveEvent, saveProfile in services/{posts,events,saves}.ts',
  },
  {
    id: 'report',
    label: 'Report',
    icon: 'Flag',
    group: 'secondary',
    order: 30,
    requiresRecipient: false,
    requiresUrl: false,
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

/** Every action id, in no particular order. Useful for exhaustiveness tests. */
export const ALL_SHARE_ACTION_IDS: readonly ShareActionId[] = Object.freeze(
  DESCRIPTORS.map((d) => d.id),
);

export function getShareAction(id: ShareActionId): ShareActionDescriptor {
  return SHARE_ACTION_REGISTRY[id];
}

/**
 * Resolve an entity's `allowedActions` into descriptors, dropping any action
 * whose precondition the entity cannot meet (currently: needs a URL, has none)
 * and sorting by group then order.
 *
 * This is the function the sheet will call. It is the reason no component ever
 * needs to know what an entity type is.
 */
export function resolveShareActions(
  allowedActions: readonly ShareActionId[],
  opts: { hasUrl: boolean },
): ShareActionDescriptor[] {
  const GROUP_ORDER: Record<ShareActionGroup, number> = { send: 0, direct: 1, secondary: 2 };
  return allowedActions
    .map((id) => SHARE_ACTION_REGISTRY[id])
    .filter((d): d is ShareActionDescriptor => Boolean(d))
    .filter((d) => (d.requiresUrl ? opts.hasUrl : true))
    .sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.order - b.order);
}
