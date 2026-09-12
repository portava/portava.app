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
