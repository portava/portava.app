/**
 * Pure gates for the event page's participant surfaces (PLAT-F30):
 * posts, photos, comments, and "save as memory".
 *
 * Each one mirrors the server rule it fronts in
 * artifacts/api-server/src/routes/events.ts, so the app offers an action only
 * where the server will take it. The server stays the authority: a refusal it
 * still makes (e.g. the host turned attendee posts off — that setting is not in
 * the event payload) is shown as its message, never as success.
 */

export interface EventViewerLike {
  isHost?: boolean | null;
  myRole?: string | null;
  myRsvp?: string | null;
  /** The STORED state (`event.state`), not the clock-derived display state. */
  state?: string | null;
}

/** Host or co-host — `isHostOrCoHost` / `getEventRole` on the server. */
export function isEventStaff(ev: EventViewerLike): boolean {
  return !!ev.isHost || ev.myRole === 'host' || ev.myRole === 'co_host';
}

/**
 * Who may READ posts, photos and comments: host/co-host, or a Going / Maybe
 * RSVP (GET /events/:id/posts, /media, /comments all apply this scope).
 */
export function isEventParticipant(ev: EventViewerLike): boolean {
  return isEventStaff(ev) || ev.myRsvp === 'going' || ev.myRsvp === 'maybe';
}

/**
 * Who is OFFERED a composer: host/co-host, or a Going RSVP (POST posts /
 * comments / media). Posts and comments from attendees additionally need the
 * host's `attendee_comments_enabled`, which only the server knows.
 */
export function canOfferEventContribution(ev: EventViewerLike): boolean {
  return isEventStaff(ev) || ev.myRsvp === 'going';
}

/**
 * Save-as-memory (POST /events/:id/memory): the STORED state is `completed`
 * and the viewer is host/co-host or a Going attendee. The display state can
 * read "completed" from the clock before the server has completed the event,
 * and the server refuses that, so the stored state decides.
 */
export function canSaveEventAsMemory(ev: EventViewerLike): boolean {
  return ev.state === 'completed' && (isEventStaff(ev) || ev.myRsvp === 'going');
}
