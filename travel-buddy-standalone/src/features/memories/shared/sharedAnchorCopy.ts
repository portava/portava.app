/**
 * Every sentence "Remember this together" shows (census-highlights-memories
 * H53, MEM-ANCHOR-2), in one place so the tests can hold the screens to it.
 *
 * THE RULE THESE SENTENCES KEEP: the app adds no signal on top of what the
 * server already discloses. There is no sentence here for "left", "declined",
 * "blocked", "removed" or "no longer" — an anchor where I am the only person I
 * can see reads exactly like one nobody has accepted yet (NOT_SHARED_YET), and an
 * anchor that is gone is simply not shown. Every refused action is one neutral
 * sentence (NEUTRAL_REFUSAL), whatever the server's reason.
 */
export const PANEL_TITLE = 'Remember this together';
export const INVITE_INTRO = 'People who approved their tag here can be asked to link their own Memory of it. Each of you keeps your own Memory, and nothing is shared unless they accept.';
export const INVITE_LABEL = 'Invite';

export const NOT_SHARED_YET = 'Not shared yet';
export const NOT_SHARED_YET_DETAIL = 'It becomes shared once two people have accepted. Each person keeps their own Memory.';
export const SHARED_WITH = 'Remembered together with';
export const OPEN_THEIR_MEMORY = 'Open their Memory';
export const OPEN_YOUR_MEMORY = 'Open your Memory';
export const LEAVE_LABEL = 'Leave';
export const LEAVE_HINT = 'You can leave at any time. Your own Memory stays yours.';

export const INVITATION_DETAIL = 'You each keep your own Memory. Nothing is shared unless you accept, and you can leave at any time.';
export const ACCEPT_LABEL = 'Accept';
export const DECLINE_LABEL = 'Decline';
export const LINK_PROMPT = 'Link one of your Memories (optional)';
export const LINK_NONE = 'Do not link a Memory';
export const LINK_LIST_UNAVAILABLE = 'Your Memories could not be loaded. You can still accept without linking one.';
export const NOT_NOW_LABEL = 'Not now';

export const NEUTRAL_REFUSAL = 'That did not go through.';
export const LOAD_ERROR = 'Remember this together could not be loaded.';
export const RETRY_LABEL = 'Try again';

export const HUB_TITLE = 'Remember together';
export const HUB_INVITATIONS = 'Invitations';
export const HUB_ANCHORS = 'Shared Memories';
export const HUB_EMPTY = 'No invitations or shared Memories.';
export const HUB_UNAVAILABLE = 'This is not available.';
export const HUB_LINK = 'See your invitations and shared Memories';

export function personLabel(p: { handle: string | null }): string {
  return p.handle ? `@${p.handle}` : 'Someone';
}

export function invitationLine(p: { handle: string | null }): string {
  return `${personLabel(p)} invited you to remember this together.`;
}
