/**
 * viewerActions — resolve which viewer actions a Passport may OFFER, from the
 * server-projected `capabilities.actions` block and nothing else (§30, F7).
 *
 * Before this, the identity card offered Follow/Message to any signed-in
 * viewer (`isAuthed`), which is client-side policy: a viewer the server had
 * decided may not message (blocked, restricted, privacy) still saw the
 * button and only found out on the failed request. TABLE 29 is explicit —
 * `can_follow`, `can_message`, `can_invite_trip`, `can_make_plan` — so this
 * helper renders those flags verbatim and adds only two structural rules:
 *
 *   • the owner never sees viewer actions on their own Passport;
 *   • no projection (still loading / failed / anonymous) ⇒ nothing is offered.
 *     Fail-CLOSED: an unknown capability is a denied capability.
 *
 * Pure so the gate is unit-testable in isolation.
 */
import type { PassportProjectionView, PassportViewerActions } from '../../services/passportProjection.ts';

export interface ResolvedViewerActions {
  canFollow: boolean;
  canMessage: boolean;
  canInviteTrip: boolean;
  canMakePlan: boolean;
  canViewTrust: boolean;
  canViewAvailability: boolean;
}

export const NO_VIEWER_ACTIONS: ResolvedViewerActions = Object.freeze({
  canFollow: false,
  canMessage: false,
  canInviteTrip: false,
  canMakePlan: false,
  canViewTrust: false,
  canViewAvailability: false,
});

export function resolveViewerActions(
  projection: Pick<PassportProjectionView, 'actions'> | null | undefined,
  ctx: { isOwner: boolean },
): ResolvedViewerActions {
  if (ctx.isOwner || !projection) return NO_VIEWER_ACTIONS;
  const a: Partial<PassportViewerActions> = projection.actions ?? {};
  return {
    canFollow: a.can_follow === true,
    canMessage: a.can_message === true,
    canInviteTrip: a.can_invite_trip === true,
    canMakePlan: a.can_make_plan === true,
    canViewTrust: a.can_view_trust === true,
    canViewAvailability: a.can_view_availability === true,
  };
}
