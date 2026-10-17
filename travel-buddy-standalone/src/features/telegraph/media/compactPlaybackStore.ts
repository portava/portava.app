/**
 * compactPlaybackStore — Telegraph §6.3 (census-telegraph T62): "Picture-in-
 * picture or compact playback can continue while the user scrolls."
 *
 * ONE message-video playback session at a time, owned by this module and
 * presented by `CompactPlaybackHost`, which the root layout mounts OUTSIDE every
 * list. The thread's bubble only asks for a session (`openMessageVideo`); it
 * never owns the player. That is the whole mechanism: a FlatList that scrolls a
 * bubble out of its window unmounts the bubble, and nothing the bubble owned can
 * keep playing — so the bubble owns nothing.
 *
 * The session has two presentations, `expanded` (full screen) and `compact`
 * (docked). Switching between them restyles the host's frame; the player
 * element stays where it is in the tree, so it is the SAME native player — it
 * is never reloaded and never seeks. Minimize, scroll and expand are one
 * continuous playback.
 *
 * WHERE IT MAY PLAY — fail closed (owner question Q-PB1, default implemented,
 * not approved). A session is scoped to the conversation that opened it and
 * stops, for good, when any of these happens:
 *
 *   route         the screen route (path + params) is no longer the opener's
 *   signed_out    the signed-in account is no longer the one that opened it
 *   source_closed the conversation's message source unmounted, lost access
 *                 (removed / left / pending) or switched thread
 *   message_gone  a bound message is no longer a live video in its source
 *                 (unsent, deleted, hidden, or its media changed), or a
 *                 realtime `message.unsent` / `message.deleted` names it
 *   blocked       a block involving a bound sender is known, or any
 *                 `user.blocked` event arrives on this device
 *   left          a `member.left` for THIS viewer in a bound thread
 *   access_revoked the realtime stream reports `access.revoked`
 *   media_error   the server refuses to sign the media reference for this
 *                 viewer — asked FRESH (the client sign cache evicted first)
 *                 before the player mounts and again during the session
 *                 (`playbackAuthorization.ts`, `CompactPlaybackHost`)
 *   ended / user  playback finished / the viewer pressed Stop
 *
 * And it never starts at all for a video no open conversation holds: binding
 * happens at open time against the registered message sources, and a request
 * nothing can bind is refused (`openMessageVideo` returns false).
 *
 * It never starts on its own: the only entry is the viewer's tap on a
 * thumbnail. Pure module, no React: `useCompactPlaybackSource` (the hooks'
 * side) and `CompactPlaybackHost` (the presenter) are the two React adapters.
 */
import { messageTreeMediaOrNull } from './messageTreeMedia.ts'; // census T446: a session plays Portava storage or nothing
export type PlaybackPresentation = 'expanded' | 'compact';

export type PlaybackStopReason =
  | 'user'
  | 'ended'
  | 'route'
  | 'signed_out'
  | 'source_closed'
  | 'message_gone'
  | 'blocked'
  | 'left'
  | 'access_revoked'
  | 'media_error'
  | 'replaced';

/** The fields of a thread message this module reads. `Message` satisfies it. */
export interface PlaybackSourceMessage {
  id: string;
  senderId?: string | null;
  deleted?: boolean | null;
  msgType?: string | null;
  mediaType?: string | null;
  mediaUrl?: string | null;
}

export interface PlaybackSourceReport {
  /** The thread this source is showing; null while it does not know yet. */
  threadId: string | null;
  /** False when the source can no longer vouch for its messages (no access, error). */
  live: boolean;
  messages: ReadonlyArray<PlaybackSourceMessage>;
}

export interface PlaybackBinding {
  readonly sourceId: number;
  readonly threadId: string | null;
  /** The message ids in that source that carry the playing video. */
  readonly messageIds: readonly string[];
}

export interface PlaybackSession {
  /** Changes on every new session; the host keys the player on it. */
  readonly key: number;
  /** The stored media reference exactly as the thread rendered it. */
  readonly mediaRef: string;
  readonly posterRef: string | null;
  readonly presentation: PlaybackPresentation;
  readonly bindings: readonly PlaybackBinding[];
  readonly senderIds: readonly string[];
}

export interface OpenMessageVideoRequest {
  mediaRef: string | null | undefined;
  posterRef?: string | null;
}

type Listener = () => void;

const listeners = new Set<Listener>();
const sources = new Map<number, PlaybackSourceReport>();
let session: PlaybackSession | null = null;
/** Where and for whom the current session was opened; stamped by the host. */
let openedIn: { key: number; routeKey: string; accountId: string } | null = null;
let nextKey = 1;
let nextSourceId = 1;
let lastStop: PlaybackStopReason | null = null;

function emit(): void {
  for (const l of [...listeners]) {
    try { l(); } catch { /* a listener's failure never blocks a stop */ }
  }
}

function setSession(next: PlaybackSession | null): void {
  session = next;
  emit();
}

/** A message that the thread would render as a playable video of `mediaRef`. */
export function isPlayableVideoMessage(m: PlaybackSourceMessage, mediaRef: string): boolean {
  return (
    m.deleted !== true &&
    m.msgType === 'media' &&
    m.mediaType === 'video' &&
    typeof m.mediaUrl === 'string' &&
    m.mediaUrl === mediaRef
  );
}

// ── Reading ──────────────────────────────────────────────────────────────────

export function subscribeCompactPlayback(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getCompactPlayback(): PlaybackSession | null {
  return session;
}

/** Why the last session ended (null while none has). For the host and tests. */
export function lastPlaybackStopReason(): PlaybackStopReason | null {
  return lastStop;
}

// ── The viewer's actions ─────────────────────────────────────────────────────

/**
 * Start (or bring back) full-screen playback of a thread video. Returns false,
 * and starts nothing, when no live message source holds a playable message
 * carrying this media reference.
 */
export function openMessageVideo(req: OpenMessageVideoRequest): boolean {
  const mediaRef = messageTreeMediaOrNull(req.mediaRef) ?? ''; // census T446: a sender's non-storage URL never plays
  if (!mediaRef) return false;

  const bindings: PlaybackBinding[] = [];
  const senders = new Set<string>();
  for (const [sourceId, report] of sources) {
    if (!report.live) continue;
    const held = report.messages.filter((m) => isPlayableVideoMessage(m, mediaRef));
    if (held.length === 0) continue;
    bindings.push({ sourceId, threadId: report.threadId, messageIds: held.map((m) => m.id) });
    for (const m of held) if (m.senderId) senders.add(m.senderId);
  }
  if (bindings.length === 0) return false;

  // The same video, already docked: bring it back rather than restart it.
  if (session && session.mediaRef === mediaRef) {
    if (session.presentation !== 'expanded') setSession({ ...session, presentation: 'expanded' });
    return true;
  }

  if (session) lastStop = 'replaced';
  setSession({
    key: nextKey++,
    mediaRef,
    posterRef: messageTreeMediaOrNull(req.posterRef ?? null),
    presentation: 'expanded',
    bindings,
    senderIds: [...senders],
  });
  return true;
}

export function minimizePlayback(key: number): void {
  if (!session || session.key !== key || session.presentation === 'compact') return;
  setSession({ ...session, presentation: 'compact' });
}

export function expandPlayback(key: number): void {
  if (!session || session.key !== key || session.presentation === 'expanded') return;
  setSession({ ...session, presentation: 'expanded' });
}

/**
 * Stop playback. With a `key`, only that session is stopped — a late callback
 * from a player that was already replaced cannot stop its successor.
 */
export function stopPlayback(reason: PlaybackStopReason, key?: number): void {
  if (!session) return;
  if (key !== undefined && session.key !== key) return;
  lastStop = reason;
  setSession(null);
}

// ── Context the host observes ────────────────────────────────────────────────

/** Route identity: the path AND its params — `/trip/chat?id=A` is not `?id=B`. */
export function routeKeyOf(
  pathname: string | null | undefined,
  params: Readonly<Record<string, string | string[] | undefined>> | null | undefined,
): string {
  const entries = Object.entries(params ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${pathname ?? ''}?${query}`;
}

/**
 * The host calls this on every render that can change the route or the
 * account. The first call for a session stamps where and for whom it was
 * opened; every later call stops it if either has changed. Nobody signed in
 * at stamp time is itself a stop.
 */
export function reconcilePlaybackContext(routeKey: string, accountId: string | null): void {
  if (!session) return;
  if (openedIn === null || openedIn.key !== session.key) {
    if (!accountId) { stopPlayback('signed_out'); return; }
    openedIn = { key: session.key, routeKey, accountId };
    return;
  }
  if (accountId !== openedIn.accountId) { stopPlayback('signed_out'); return; }
  if (routeKey !== openedIn.routeKey) stopPlayback('route');
}

/** A realtime event that must end this session, or null. Pure. */
export function stopReasonForEvent(
  s: PlaybackSession,
  evt: { type?: unknown; threadId?: unknown; payload?: Record<string, unknown> | null },
  viewerId: string | null,
): PlaybackStopReason | null {
  const type = typeof evt.type === 'string' ? evt.type : '';
  const payload = evt.payload ?? {};
  if (type === 'message.unsent' || type === 'message.deleted') {
    const id = payload.messageId;
    if (typeof id !== 'string') return null;
    return s.bindings.some((b) => b.messageIds.includes(id)) ? 'message_gone' : null;
  }
  // A block made on this device, or on another session of this account. It
  // names only the blocked person; stopping on any block costs one restart.
  if (type === 'user.blocked') return 'blocked';
  // The server is closing this account's stream (e.g. it was blocked).
  if (type === 'access.revoked') return 'access_revoked';
  if (type === 'member.left') {
    if (!viewerId || payload.userId !== viewerId) return null;
    const threadId = typeof evt.threadId === 'string' ? evt.threadId : null;
    // An event that names no thread could be this one: stop.
    if (threadId === null) return 'left';
    return s.bindings.some((b) => b.threadId === null || b.threadId === threadId) ? 'left' : null;
  }
  return null;
}

/** A known block, either direction, with a bound sender. Pure. */
export function stopReasonForBlocks(
  s: PlaybackSession,
  blockedIds: ReadonlySet<string>,
  blockerIds: ReadonlySet<string>,
): PlaybackStopReason | null {
  return s.senderIds.some((id) => blockedIds.has(id) || blockerIds.has(id)) ? 'blocked' : null;
}

// ── Message sources (the hooks' side) ────────────────────────────────────────

export function registerMessageSource(): number {
  const id = nextSourceId++;
  sources.set(id, { threadId: null, live: false, messages: [] });
  return id;
}

export function reportMessageSource(sourceId: number, report: PlaybackSourceReport): void {
  if (!sources.has(sourceId)) return;
  sources.set(sourceId, { threadId: report.threadId, live: report.live, messages: report.messages.map(({ id, senderId, deleted, msgType, mediaType, mediaUrl }) => ({ id, senderId, deleted, msgType, mediaType, mediaUrl })) }); // keep the six fields this module reads — never a message's text (T366 §66 review)
  if (!session) return;
  const binding = session.bindings.find((b) => b.sourceId === sourceId);
  if (!binding) return;
  if (!report.live || report.threadId !== binding.threadId) { stopPlayback('source_closed'); return; }
  const byId = new Map(report.messages.map((m) => [m.id, m] as const));
  const mediaRef = session.mediaRef;
  const allStillPlayable = binding.messageIds.every((id) => {
    const m = byId.get(id);
    return m !== undefined && isPlayableVideoMessage(m, mediaRef);
  });
  if (!allStillPlayable) stopPlayback('message_gone');
}

/** Is the current session bound to this source? (The hooks re-check access only while it is.) */
export function isSourceBound(sourceId: number | null): boolean {
  return sourceId !== null && session !== null && session.bindings.some((b) => b.sourceId === sourceId);
}

export function unregisterMessageSource(sourceId: number): void {
  sources.delete(sourceId);
  if (session && session.bindings.some((b) => b.sourceId === sourceId)) stopPlayback('source_closed');
}

/** Test seam: forget every session, source and listener. */
export function _resetCompactPlaybackForTests(): void {
  listeners.clear();
  sources.clear();
  session = null;
  openedIn = null;
  nextKey = 1;
  nextSourceId = 1;
  lastStop = null;
}

/** Test seam for the T366 §66 review entry: what a source's report RETAINED. Product code never calls it. */
export function retainedSourceMessagesForTest(sourceId: number): ReadonlyArray<PlaybackSourceMessage> {
  return sources.get(sourceId)?.messages ?? [];
}
