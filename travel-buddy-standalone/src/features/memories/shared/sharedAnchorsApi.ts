/**
 * sharedAnchorsApi — the app's half of census-highlights-memories H53 (§5
 * "Remember this together"; B58 cluster MEM-ANCHOR-2). Server: PR #735
 * (MEM-ANCHOR-1) plus this cluster's one read, both in
 * artifacts/api-server/src/routes/memorySharedAnchors.ts.
 *
 *   GET  /api/me/memory-shared-anchors                   my invitations and the anchors I accepted
 *   GET  /api/memories/:id/shared-anchor/invitable       who I, the owner, can invite (the SERVER decides)
 *   POST /api/memories/:id/shared-anchor/invites         { userId }
 *   POST /api/memory-shared-anchors/:anchorId/accept     { memoryId? } — one of MY Memories, or nothing
 *   POST /api/memory-shared-anchors/:anchorId/decline
 *   POST /api/memory-shared-anchors/:anchorId/leave
 *
 * READS answer a state, never a bare list: `ok`; `absent` — a 404, which is how
 * the server answers every one of these routes while `memory_shared_anchors_enabled`
 * is OFF (the router falls through as if it were not mounted), so the feature
 * does not exist for this caller and nothing is shown; or `error`, which is never
 * rendered as "nothing here".
 *
 * WRITES answer ok or not, and nothing else. The server's refusals are already
 * uniform; this module never reads a status code's meaning or a `reason`, so no
 * screen can say WHY something was refused — not who declined, who left, or who
 * blocked whom. Every refusal is the same neutral sentence (NEUTRAL_REFUSAL).
 *
 * EVERY PAYLOAD IS COPIED FIELD BY FIELD into the shapes below. Anything else a
 * response might carry — another member's Memory title, caption or photos
 * included — is dropped HERE and can never reach a component: the anchor grants
 * no read, and a member's Memory is only ever an id the app turns into a link to
 * /memory/:id, where the normal Memory screen and the server's §23 ladder decide.
 */
import { freshToken } from '../../../services/apiToken.ts';
import { getUserMemories } from '../../../services/memories.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** The server's flag (3805, seeded FALSE). OFF ⇒ the app asks nothing and shows nothing. */
export const SHARED_ANCHORS_FLAG = 'memory_shared_anchors_enabled';

/** The invitations-and-anchors list (app/memory/together.tsx); the in-app notice links here. */
export const SHARED_ANCHORS_PATH = '/memory/together';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(x: unknown): x is string {
  return typeof x === 'string' && UUID_RE.test(x);
}

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface SharedAnchorPerson {
  readonly userId: string;
  readonly handle: string | null;
}

export interface SharedAnchorMember extends SharedAnchorPerson {
  readonly isYou: boolean;
  /** That member's OWN Memory, only when the server's ladder lets me read it. An id — never its content. */
  readonly memoryId: string | null;
}

export type SharedAnchor =
  | {
      readonly id: string;
      readonly yourStatus: 'accepted';
      /** The server's word: two or more accepted members I can see. */
      readonly shared: boolean;
      readonly members: readonly SharedAnchorMember[];
    }
  | {
      readonly id: string;
      readonly yourStatus: 'invited';
      readonly invitedBy: SharedAnchorPerson;
      /** The host's Memory, only when the ladder lets me read it. */
      readonly memoryId: string | null;
    };

export type AcceptedAnchor = Extract<SharedAnchor, { yourStatus: 'accepted' }>;
export type Invitation = Extract<SharedAnchor, { yourStatus: 'invited' }>;

export type AnchorsRead =
  | { readonly state: 'ok'; readonly anchors: readonly SharedAnchor[] }
  | { readonly state: 'absent' }
  | { readonly state: 'error' };

export type InvitableRead =
  | { readonly state: 'ok'; readonly people: readonly SharedAnchorPerson[] }
  | { readonly state: 'absent' }
  | { readonly state: 'error' };

/** A write's whole answer. There is deliberately no reason field. */
export interface WriteResult {
  readonly ok: boolean;
}

export interface OwnMemoryChoice {
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: string | null;
}

export type OwnMemoriesRead =
  | { readonly ok: true; readonly memories: readonly OwnMemoryChoice[] }
  | { readonly ok: false };

// ── Parsing: copy, field by field, what the screens may render ────────────────

function person(x: unknown): SharedAnchorPerson | null {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || !isUuid(o.userId)) return null;
  return { userId: o.userId, handle: typeof o.handle === 'string' && o.handle.length > 0 ? o.handle : null };
}

function member(x: unknown): SharedAnchorMember | null {
  const p = person(x);
  if (!p) return null;
  const o = x as Record<string, unknown>;
  return { userId: p.userId, handle: p.handle, isYou: o.isYou === true, memoryId: isUuid(o.memoryId) ? o.memoryId : null };
}

/** One anchor as the server described it, or null for a shape this app does not know (then it is not shown). */
export function parseAnchor(x: unknown): SharedAnchor | null {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || !isUuid(o.id)) return null;
  if (o.yourStatus === 'accepted') {
    if (typeof o.shared !== 'boolean' || !Array.isArray(o.members)) return null;
    const members = o.members.map(member);
    if (members.some((m) => m === null)) return null;
    return { id: o.id, yourStatus: 'accepted', shared: o.shared, members: members as SharedAnchorMember[] };
  }
  if (o.yourStatus === 'invited') {
    const by = person(o.invitedBy);
    if (!by) return null;
    return { id: o.id, yourStatus: 'invited', invitedBy: by, memoryId: isUuid(o.memoryId) ? o.memoryId : null };
  }
  return null;
}

// ── Transport ─────────────────────────────────────────────────────────────────

/** null = the request never got an answer. */
async function send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null } | null> {
  try {
    const token = await freshToken();
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json: json && typeof json === 'object' ? json : null };
  } catch {
    return null;
  }
}

const ok2xx = (status: number) => status >= 200 && status < 300;

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listSharedAnchors(): Promise<AnchorsRead> {
  const r = await send('GET', '/api/me/memory-shared-anchors');
  if (!r) return { state: 'error' };
  if (r.status === 404) return { state: 'absent' };
  if (!ok2xx(r.status) || !Array.isArray(r.json?.anchors)) return { state: 'error' };
  const anchors = (r.json!.anchors as unknown[]).map(parseAnchor).filter((a): a is SharedAnchor => a !== null);
  return { state: 'ok', anchors };
}

/** Who the owner of `memoryId` can invite — exactly the server's list, in its order. */
export async function listInvitable(memoryId: string): Promise<InvitableRead> {
  if (!isUuid(memoryId)) return { state: 'absent' };
  const r = await send('GET', `/api/memories/${encodeURIComponent(memoryId)}/shared-anchor/invitable`);
  if (!r) return { state: 'error' };
  if (r.status === 404) return { state: 'absent' };
  if (!ok2xx(r.status) || !Array.isArray(r.json?.people)) return { state: 'error' };
  const people = (r.json!.people as unknown[]).map(person).filter((p): p is SharedAnchorPerson => p !== null);
  return { state: 'ok', people };
}

/**
 * The viewer's OWN Memories, for the optional link on Accept. Only rows the
 * server returned for the viewer's own profile AND that name the viewer as
 * owner are offered; an id is the only thing Accept ever sends from here.
 */
export async function listOwnMemoriesForLink(viewerId: string): Promise<OwnMemoriesRead> {
  const r = await getUserMemories(viewerId);
  if (!r.ok) return { ok: false };
  const memories = (r.memories ?? [])
    .filter((m) => m && m.ownerId === viewerId && isUuid(m.id))
    .map((m) => ({ id: m.id, title: typeof m.title === 'string' && m.title.length > 0 ? m.title : null, createdAt: typeof m.createdAt === 'string' ? m.createdAt : null }));
  return { ok: true, memories };
}

// ── Writes ────────────────────────────────────────────────────────────────────

async function write(path: string, body: Record<string, unknown>): Promise<WriteResult> {
  const r = await send('POST', path, body);
  return { ok: r !== null && ok2xx(r.status) };
}

export function inviteToRemember(memoryId: string, userId: string): Promise<WriteResult> {
  if (!isUuid(memoryId) || !isUuid(userId)) return Promise.resolve({ ok: false });
  return write(`/api/memories/${encodeURIComponent(memoryId)}/shared-anchor/invites`, { userId });
}

/** `ownMemoryId`: one of the viewer's OWN Memories (from listOwnMemoriesForLink), or null to link none. */
export function acceptSharedAnchor(anchorId: string, ownMemoryId: string | null): Promise<WriteResult> {
  if (!isUuid(anchorId)) return Promise.resolve({ ok: false });
  return write(`/api/memory-shared-anchors/${encodeURIComponent(anchorId)}/accept`, isUuid(ownMemoryId) ? { memoryId: ownMemoryId } : {});
}

export function declineSharedAnchor(anchorId: string): Promise<WriteResult> {
  if (!isUuid(anchorId)) return Promise.resolve({ ok: false });
  return write(`/api/memory-shared-anchors/${encodeURIComponent(anchorId)}/decline`, {});
}

export function leaveSharedAnchor(anchorId: string): Promise<WriteResult> {
  if (!isUuid(anchorId)) return Promise.resolve({ ok: false });
  return write(`/api/memory-shared-anchors/${encodeURIComponent(anchorId)}/leave`, {});
}
