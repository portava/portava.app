import { z } from 'zod';
import { captureMessagingOwnerRequest, messagingOwnerToken, type MessagingOwnerRequest } from './messagingOwnerRequest.ts';
import { newReportedReviewOperationId } from './reportsAdmin.ts';

const id = z.string().uuid().transform(value => value.toLowerCase());
const token = z.string().regex(/^[0-9a-f]{64}$/);
export const removalTarget = z.object({ subjectType: z.enum(['post', 'comment', 'message', 'buddy_listing', 'media', 'event']), subjectId: id, reportId: id });
const contextSchema = removalTarget.extend({ contractVersion: z.literal(1), reportStatus: z.enum(['open', 'reviewing']),
  preview: z.string().nullable(), effect: z.enum(['remove_content', 'suspend_listing']), contentToken: token, reportToken: token });
const intentSchema = removalTarget.extend({ operationId: id, contentToken: token, reportToken: token,
  reason: z.string().trim().refine(value => Array.from(value).length > 0 && Array.from(value).length <= 1000) });
const receiptSchema = removalTarget.extend({ ok: z.literal(true), contractVersion: z.literal(1), operationId: id,
  auditId: id, effect: z.enum(['remove_content', 'suspend_listing']), replayed: z.boolean(),
  committedAt: z.string().refine(value => Number.isFinite(Date.parse(value))) });
export type ContentRemovalTarget = z.infer<typeof removalTarget>;
export type ContentRemovalContext = z.infer<typeof contextSchema>;
export type ContentRemovalIntent = Readonly<z.infer<typeof intentSchema>>;
export interface ContentRemovalRequest {
  owner: MessagingOwnerRequest;
  signal: AbortSignal;
  isCurrent: () => boolean;
  target: ContentRemovalTarget;
}
export class ContentRemovalError extends Error {
  constructor(readonly status: number) {
    super(status === 409 ? 'Content or report changed. Reload before confirming a new removal.'
      : status === 400 ? 'Enter a reason of 1–1000 characters.'
      : status === 401 || status === 403 ? 'A current admin session is required.'
      : status === 404 ? 'The reported content is no longer available.'
      : 'Result unavailable. A sent removal may have committed. Retry the same operation to recover its result.');
  }
}
// Preserve an uncertain operation across navigation, scoped to the exact signed-in
// session. No content snapshot, reporter data or credential is retained here.
const pending = new Map<string, { owner: MessagingOwnerRequest; intent: ContentRemovalIntent }>();
function key(request: ContentRemovalRequest) { return `${request.owner.sessionId}:${request.target.reportId}`; }
export function pendingContentRemoval(request: ContentRemovalRequest): ContentRemovalIntent | null {
  for (const [id, entry] of pending) if (!entry.owner.isCurrent()) { entry.owner.invalidate(); pending.delete(id); }
  const entry = pending.get(key(request));
  return entry?.owner.ownerId === request.owner.ownerId ? entry.intent : null;
}
function assertCurrent(request: ContentRemovalRequest) {
  if (request.signal.aborted || !request.isCurrent() || !request.owner.isCurrent()) throw new ContentRemovalError(401);
}
function sameTarget(a: ContentRemovalTarget, b: ContentRemovalTarget) {
  return a.subjectType === b.subjectType && a.subjectId === b.subjectId && a.reportId === b.reportId;
}
async function fetchRemoval(request: ContentRemovalRequest, init: RequestInit = {}): Promise<unknown> {
  assertCurrent(request);
  const controller = new AbortController();
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => { abort = () => { controller.abort(); reject(new ContentRemovalError(503)); }; });
  request.signal.addEventListener('abort', abort);
  const timer = setTimeout(abort, 7000);
  try {
    const accessToken = await Promise.race([messagingOwnerToken(request.owner), interrupted]);
    assertCurrent(request);
    if (!accessToken || controller.signal.aborted) throw new ContentRemovalError(503);
    const { subjectType, subjectId, reportId } = request.target;
    const response = await Promise.race([fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL ?? ''}/api/admin/moderation/reports/${reportId}/content/${subjectType}/${subjectId}/removal`, {
      ...init, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...init.headers },
    }), interrupted]);
    assertCurrent(request);
    if (!response.ok) throw new ContentRemovalError(response.status);
    const value: unknown = await Promise.race([response.json(), interrupted]);
    assertCurrent(request);
    if (controller.signal.aborted) throw new ContentRemovalError(503);
    return value;
  } catch (error) { throw error instanceof ContentRemovalError ? error : new ContentRemovalError(503); }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
}
export async function getContentRemovalContext(request: ContentRemovalRequest): Promise<ContentRemovalContext> {
  if (!removalTarget.safeParse(request.target).success) throw new ContentRemovalError(400);
  const result = contextSchema.safeParse(await fetchRemoval(request));
  if (!result.success || !sameTarget(result.data, request.target)
    || result.data.effect !== (request.target.subjectType === 'buddy_listing' ? 'suspend_listing' : 'remove_content')) throw new ContentRemovalError(503);
  return result.data;
}
export function confirmContentRemoval(request: ContentRemovalRequest, context: ContentRemovalContext, reason: string): ContentRemovalIntent {
  assertCurrent(request);
  const prior = pendingContentRemoval(request);
  if (prior) return prior;
  const result = intentSchema.safeParse({ ...context, operationId: newReportedReviewOperationId(), reason });
  if (!result.success || !sameTarget(context, request.target)) throw new ContentRemovalError(400);
  const owner = captureMessagingOwnerRequest();
  if (!owner || owner.ownerId !== request.owner.ownerId || owner.sessionId !== request.owner.sessionId) {
    owner?.invalidate(); throw new ContentRemovalError(401);
  }
  const intent = Object.freeze(result.data);
  pending.set(key(request), { owner, intent });
  return intent;
}
export async function submitContentRemoval(request: ContentRemovalRequest, intent: ContentRemovalIntent) {
  assertCurrent(request);
  if (!sameTarget(request.target, intent) || pendingContentRemoval(request) !== intent) throw new ContentRemovalError(400);
  try {
    const result = receiptSchema.safeParse(await fetchRemoval(request, { method: 'POST', headers: { 'Idempotency-Key': intent.operationId },
      body: JSON.stringify({ reason: intent.reason, expected_content_token: intent.contentToken, expected_report_token: intent.reportToken }) }));
    if (!result.success || !sameTarget(result.data, intent) || result.data.operationId !== intent.operationId
      || result.data.effect !== (intent.subjectType === 'buddy_listing' ? 'suspend_listing' : 'remove_content')) throw new ContentRemovalError(503);
    pending.get(key(request))?.owner.invalidate(); pending.delete(key(request));
    return result.data;
  } catch (error) {
    if (error instanceof ContentRemovalError && [400, 404, 409].includes(error.status)) {
      pending.get(key(request))?.owner.invalidate(); pending.delete(key(request));
    }
    throw error;
  }
}
