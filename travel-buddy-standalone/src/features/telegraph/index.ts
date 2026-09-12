/**
 * Telegraph feature surface.
 *
 * Layout mirrors `src/features/wall/` and `src/features/passport/`: one folder
 * per §-scoped concern, each with its own pure logic module, its API client and
 * its components, so the spec sections can be tested without a device.
 */
export { SharedContextRail } from './sharedContext/SharedContextRail.tsx';
export {
  resolveRailPresentation,
  detectCriticalChanges,
  shouldCollapseOnScroll,
  RAIL_MAX_CARDS,
  RAIL_COLLAPSE_SCROLL_PX,
  CRITICAL_STATUSES,
} from './sharedContext/railBehavior.ts';
export { fetchSharedContext, fetchConversationHeader } from './sharedContext/api.ts';
export type {
  SharedContextItem,
  SharedContextResponse,
  ConversationHeaderResponse,
  TelegraphSharedContextProjection,
  RailMode,
} from './sharedContext/types.ts';
export {
  telegraphPalette,
  useTelegraphPalette,
  statusLabelFor,
  TELEGRAPH_PALETTES,
  type TelegraphPalette,
} from './theme/telegraphTheme.ts';
export { PortavaObjectMessage } from './sharing/PortavaObjectMessage.tsx';
export { useShareRevocation, revokedLabel } from './sharing/useShareRevocation.ts';
export {
  resolveShareProjections,
  shareObjectIntoThread,
  parsePortavaObjectBody,
  legacySourceTypeToObjectType,
} from './sharing/shareApi.ts';
export { TypedMessageRenderer, rendersTypedKind, isGifAnimated } from './kinds/TypedMessageRenderer.tsx';
export {
  sendTypedMessage,
  fetchDrawer,
  searchThread,
  parseKindEnvelope,
  DRAWER_TABS,
  SENDABLE_KINDS,
  type DrawerTab,
  type SendableKind,
} from './kinds/kindsApi.ts';
export { ContentDrawerSheet } from './drawer/ContentDrawerSheet.tsx';
export { ComposerPlusMenu } from './composer/ComposerPlusMenu.tsx';
export { TypedComposePrompt, type TypedComposeKind } from './composer/TypedComposePrompt.tsx';
export { COMPOSER_ENTRIES, composerEntry, availableEntryCount, type ComposerEntry, type ComposerEntryId } from './composer/composerMenu.ts';
export { CoordinationPanel } from './coordination/CoordinationPanel.tsx';
export {
  fetchCoordination,
  postQuickState,
  postVote,
  postCoordinationKind,
  quickStateLabel,
  coordinationStateLabel,
  QUICK_STATES,
  STATE_AFFORDANCES,
  type QuickState,
  type CoordinationState,
  type ThreadCoordinationView,
} from './coordination/coordinationApi.ts';
export { RecapSheet } from './memory/RecapSheet.tsx';
export { useThreadRecap, type ThreadRecapState } from './memory/useThreadRecap.ts';
export { SaveToMemoryAction } from './memory/SaveToMemoryAction.tsx';
export {
  fetchRecap,
  saveMessageAsMemoryDraft,
  recapHeadline,
  curateActionLabel,
  RECAP_CURATE_ACTIONS,
  type RecapCounts,
  type RecapCurateAction,
  type RecapResponse,
  type SessionRecap,
  type MemoryDraft,
} from './memory/memoryApi.ts';
export { MessageReceiptRow } from './lifecycle/MessageReceiptRow.tsx';
export {
  fetchReceipts,
  unsendMessage,
  receiptLabel,
  canOfferUnsend,
  type MessageReceipt,
  type ReceiptsResponse,
  type ReceiptStatus,
  type UnsendRefusal,
  type UnsendSuccess,
} from './lifecycle/lifecycleApi.ts';
