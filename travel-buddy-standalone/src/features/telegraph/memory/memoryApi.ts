/**
 * Telegraph §10 API client — save-to-Memory and the end-of-night recap.
 *
 *   POST /api/me/memory-drafts          §10.2, ONE message at a time.
 *   GET  /api/threads/:id/recap         §10.3, a READ that writes nothing.
 *
 * §10.2's prohibition is visible in this module's SHAPE as well as on the
 * server: `saveMessageAsMemoryDraft` takes a single `messageId: string`. There
 * is no array form, no thread form and no "save this conversation" helper for a
 * screen to reach for, so a caller cannot accidentally build the bulk path the
 * spec forbids. The server refuses `threadId` / `messageIds` / `conversationId`
 * / `all` by name as well, because a client-only guarantee is not one.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { captureMessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import { fetchOwnedApi, type OwnedApiContext } from '../../../services/ownedApiRequest.ts';
import { telegraphIndexHeaders } from '../negotiation/clientCapabilities.ts';

export const RECAP_CURATE_ACTIONS = [
  'CREATE_MEMORY',
  'SHARE_PHOTOS',
  'FOLLOW_PEOPLE_YOU_MET',
  'DONE',
] as const;
export type RecapCurateAction = (typeof RECAP_CURATE_ACTIONS)[number];

export interface RecapCounts {
  places: number;
  people: number;
  photos: number;
  videos: number;
}

export interface SessionRecap {
  threadId: string;
  planId: string | null;
  windowStartsAt: string | null;
  windowEndsAt: string | null;
  counts: RecapCounts;
  sourceMessageIds: string[];
  curateActions: RecapCurateAction[];
  invitation: true;
  empty: boolean;
}

export interface RecapResponse {
  recap: SessionRecap | null;
  headline: string;
  /** Present only when there is nothing to recap. */
  reason?: string;
  /**
   * §10.3 said out loud by the server: the read created nothing. The sheet
   * shows it so a user is not left guessing whether opening a recap already
   * made a Memory.
   */
  wrote?: 'nothing';
  choices?: RecapChoices;
}

export type RecapMode = 'memory' | 'photos' | 'people';
export interface RecapChoices {
  mode: RecapMode;
  items: Array<{ messageId: string; kind: string; label: string; createdAt: string }>;
  people: Array<{ userId: string; label: string; deepLink: string }>;
  sharingEnabled?: boolean;
  memoryEnabled?: boolean;
  preview?: MessageMemorySource | null;
  truncated: boolean;
}

export interface MessageMemorySource {
  messageId: string; threadId: string; createdAt: string; body: string | null;
  media: Array<{ url: string; mediaType: string }>; label: string;
}

export interface MemoryDraft {
  id: string;
  ownerId: string;
  state: string;
  visibility: string;
  title: string | null;
  occurredAt: string | null;
  fromMessageId: string;
  source: string;
}

export type MemoryResult<T> = { ok: true; data: T } | { ok: false; error: string; message?: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function call<T>(path: string, init?: OwnedApiContext & { method?: string; body?: object; headers?: Record<string,string> }): Promise<MemoryResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const owner = init?.owner ?? captureMessagingOwnerRequest();
  if (!owner) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetchOwnedApi(path, { ...init, owner, headers: { ...telegraphIndexHeaders(), ...init?.headers } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      return { ok: false, error: String(body?.error ?? res.status), message: body?.message };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, error: owner.isCurrent() ? 'network' : 'unauthenticated', message: e instanceof Error ? e.message : undefined };
  }
}

/**
 * §10.2 — promote ONE message into a PRIVATE Memory draft.
 *
 * Singular by construction. A screen that wants to save five things calls this
 * five times, each an explicit user action, which is the difference between
 * "a user may explicitly save" and "Telegraph automatically converts".
 */
export async function saveMessageAsMemoryDraft(
  messageId: string,
  extra?: { title?: string | null; caption?: string | null },
  context?: OwnedApiContext,
): Promise<MemoryResult<{ draft: MemoryDraft }>> {
  return call<{ draft: MemoryDraft }>(`/api/me/memory-drafts`, {
    ...context,
    method: 'POST',
    headers: { 'Idempotency-Key': `telegraph-memory:${messageId}` },
    body: { messageId, ...(extra ?? {}) },
  });
}

/** §10.3 — the recap for a thread's most recent COMPLETED plan. A read. */
export async function fetchRecap(
  threadId: string,
  planId?: string | null,
  context?: OwnedApiContext,
): Promise<MemoryResult<RecapResponse>> {
  const qs = planId ? `?planId=${encodeURIComponent(planId)}` : '';
  return call<RecapResponse>(`/api/threads/${encodeURIComponent(threadId)}/recap${qs}`, context);
}

export function fetchRecapChoices(threadId: string, mode: RecapMode, planId?: string | null, context?: OwnedApiContext) {
  return call<RecapResponse>(`/api/threads/${encodeURIComponent(threadId)}/recap?curation=${mode}${planId ? `&planId=${encodeURIComponent(planId)}` : ''}`, context);
}

export function fetchRecapPreview(threadId: string, mode: RecapMode, planId: string | null | undefined, messageId: string, context?: OwnedApiContext) {
  return call<RecapResponse>(`/api/threads/${encodeURIComponent(threadId)}/recap?curation=${mode}&sourceMessageId=${encodeURIComponent(messageId)}${planId ? `&planId=${encodeURIComponent(planId)}` : ''}`, context);
}

export function fetchMemoryMessageSource(memoryId: string, context?: OwnedApiContext) {
  return call<{ source: MessageMemorySource | null }>(`/api/me/memory-drafts/${encodeURIComponent(memoryId)}/source`, context);
}

/**
 * §10.3's headline, rendered client-side from the counts.
 *
 * "4 places · 6 people · 18 photos · 2 videos" — a zero count is omitted rather
 * than printed as "0 videos", because a recap that reports absences reads as an
 * accusation instead of an invitation.
 */
export function recapHeadline(counts: RecapCounts): string {
  const parts: string[] = [];
  const push = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  push(counts.places, 'place', 'places');
  push(counts.people, 'person', 'people');
  push(counts.photos, 'photo', 'photos');
  push(counts.videos, 'video', 'videos');
  return parts.join(' · ');
}

/**
 * What to tell a user after a save, read back from what the SERVER returned.
 *
 * §10.2 promises a PRIVATE draft. This function does not assert that promise —
 * it reports the `state` and `visibility` the server actually wrote, so a
 * deployment that ever returned a published or visible Memory would be
 * described as such rather than as "saved privately". Asserting the promise
 * would make the confirmation a wish; reading it back makes it evidence.
 */
export function draftSavedMessage(draft: MemoryDraft): string {
  if (draft.state === 'draft' && draft.visibility === 'only_me') {
    return 'Saved to your private Memory drafts. Only you can see it.';
  }
  return `Saved as a ${draft.state} Memory, visible to ${draft.visibility}.`;
}

/** §10.3's four buttons, in the spec's order, with the spec's labels. */
export function curateActionLabel(action: RecapCurateAction): string {
  switch (action) {
    case 'CREATE_MEMORY':
      return 'Create Memory';
    case 'SHARE_PHOTOS':
      return 'Share Photos';
    case 'FOLLOW_PEOPLE_YOU_MET':
      return 'Follow People You Met';
    case 'DONE':
      return 'Done';
    default:
      return action;
  }
}

export function fetchRecapAvailability(threadId: string, context?: OwnedApiContext) {
  return call<{available:boolean;planId:string|null}>(`/api/threads/${encodeURIComponent(threadId)}/recap?availability=1`,context);
}
export type OutcomeResponse = 'met' | 'did_not_meet';
export interface OutcomeContext {enabled:boolean;retentionDays?:number;response?:OutcomeResponse|null;evidence?:'self_reported'}
const outcomePath=(threadId:string,planId:string)=>`/api/threads/${encodeURIComponent(threadId)}/plans/${encodeURIComponent(planId)}/outcome`;
export function fetchOutcomeContext(threadId:string,planId:string,context?:OwnedApiContext){return call<OutcomeContext>(outcomePath(threadId,planId),context);}
export function saveOutcomeResponse(threadId:string,planId:string,response:OutcomeResponse,context?:OwnedApiContext){return call<{response:OutcomeResponse}>(outcomePath(threadId,planId),{...context,method:'PUT',body:{response}});}
export function removeOutcomeResponse(threadId:string,planId:string,context?:OwnedApiContext){return call<{response:null}>(outcomePath(threadId,planId),{...context,method:'DELETE'});}

export function removeAllOutcomeResponses(context?:OwnedApiContext){return call<{removed:true}>('/api/me/coordination-feedback',{...context,method:'DELETE'});}
