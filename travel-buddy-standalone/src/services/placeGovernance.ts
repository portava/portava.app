import { z } from 'zod';
import { captureMessagingOwnerRequest, messagingOwnerToken, type MessagingOwnerRequest } from './messagingOwnerRequest.ts';
import { newReportedReviewOperationId } from './reportsAdmin.ts';

const id = z.string().uuid().transform(value => value.toLowerCase());
const token = z.string().regex(/^[0-9a-f]{64}$/);
export const placeTarget = z.object({ placeId:id, reportId:id, action:z.enum(['withhold','restore','merge','unmerge']), intoId:id.optional() });
const contextSchema = z.object({contractVersion:z.literal(1),placeId:id,reportId:id,action:z.enum(['withhold','restore','merge','unmerge']),intoId:id.nullable(),
  name:z.string(),status:z.string(),moderationStatus:z.enum(['visible','withheld']),mergedIntoId:id.nullable(),restoreStatus:z.string(),
  destinationName:z.string().nullable(),contextToken:token});
const intentSchema=placeTarget.extend({operationId:id,contextToken:token,reason:z.string().trim().min(1).max(1000)});
const receiptSchema=placeTarget.omit({intoId:true}).extend({intoId:id.nullable(),ok:z.literal(true),contractVersion:z.literal(1),operationId:id,auditId:id,
  replayed:z.boolean(),committedAt:z.string().refine(value=>Number.isFinite(Date.parse(value)))});
export type PlaceGovernanceTarget = z.infer<typeof placeTarget>;
export type PlaceGovernanceContext = z.infer<typeof contextSchema>;
export type PlaceGovernanceIntent = Readonly<z.infer<typeof intentSchema>>;
export interface PlaceGovernanceRequest {
  owner: MessagingOwnerRequest;
  signal: AbortSignal;
  isCurrent: () => boolean;
  target: PlaceGovernanceTarget;
}
export class PlaceGovernanceError extends Error {
  constructor(readonly status: number) {
    super(status === 409 ? 'Place or report changed. Reload before confirming a new place action.'
      : status === 400 ? 'Enter a reason of 1–1000 characters.'
      : status === 401 || status === 403 ? 'A current admin session is required.'
      : status === 404 ? 'The canonical place is no longer available.'
      : 'Result unavailable. A sent place action may have committed. Retry the same operation to recover its result.');
  }
}
// Preserve an uncertain operation across navigation, scoped to the exact signed-in
// session. No content snapshot, reporter data or credential is retained here.
const pending = new Map<string, { owner: MessagingOwnerRequest; intent: PlaceGovernanceIntent }>();
function key(request: PlaceGovernanceRequest) { return `${request.owner.sessionId}:${request.target.reportId}`; }
export function pendingPlaceGovernance(request: PlaceGovernanceRequest): PlaceGovernanceIntent | null {
  for (const [id, entry] of pending) if (!entry.owner.isCurrent()) { entry.owner.invalidate(); pending.delete(id); }
  const entry = pending.get(key(request));
  return entry?.owner.ownerId === request.owner.ownerId ? entry.intent : null;
}
function assertCurrent(request: PlaceGovernanceRequest) {
  if (request.signal.aborted || !request.isCurrent() || !request.owner.isCurrent()) throw new PlaceGovernanceError(401);
}
function sameTarget(a: {placeId:string;action:string;reportId:string;intoId?:string|null}, b: {placeId:string;action:string;reportId:string;intoId?:string|null}) {
  return a.placeId === b.placeId && a.action === b.action && a.reportId === b.reportId && (a.intoId ?? null) === (b.intoId ?? null);
}
async function fetchGovernance(request: PlaceGovernanceRequest, init: RequestInit = {}): Promise<unknown> {
  assertCurrent(request);
  const controller = new AbortController();
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => { abort = () => { controller.abort(); reject(new PlaceGovernanceError(503)); }; });
  request.signal.addEventListener('abort', abort);
  const timer = setTimeout(abort, 7000);
  try {
    const accessToken = await Promise.race([messagingOwnerToken(request.owner), interrupted]);
    assertCurrent(request);
    if (!accessToken || controller.signal.aborted) throw new PlaceGovernanceError(503);
    const { placeId, reportId, action, intoId } = request.target;
    const query=new URLSearchParams({action,reportId,...(intoId?{intoId}:{})});
    const response = await Promise.race([fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL ?? ''}/api/admin/places/${placeId}/governance${init.method ? '' : `?${query}`}`, {
      ...init, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...init.headers },
    }), interrupted]);
    assertCurrent(request);
    if (!response.ok) throw new PlaceGovernanceError(response.status);
    const value: unknown = await Promise.race([response.json(), interrupted]);
    assertCurrent(request);
    if (controller.signal.aborted) throw new PlaceGovernanceError(503);
    return value;
  } catch (error) { throw error instanceof PlaceGovernanceError ? error : new PlaceGovernanceError(503); }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
}
export async function getPlaceGovernanceContext(request: PlaceGovernanceRequest): Promise<PlaceGovernanceContext> {
  if (!placeTarget.safeParse(request.target).success) throw new PlaceGovernanceError(400);
  const result = contextSchema.safeParse(await fetchGovernance(request));
  if (!result.success || !sameTarget(result.data, request.target)) throw new PlaceGovernanceError(503);
  return result.data;
}
export function confirmPlaceGovernance(request: PlaceGovernanceRequest, context: PlaceGovernanceContext, reason: string): PlaceGovernanceIntent {
  assertCurrent(request);
  const prior = pendingPlaceGovernance(request);
  if (prior) return prior;
  const result = intentSchema.safeParse({ ...context, intoId:context.intoId??undefined, operationId: newReportedReviewOperationId(), reason });
  if (!result.success || !sameTarget(context, request.target)) throw new PlaceGovernanceError(400);
  const owner = captureMessagingOwnerRequest();
  if (!owner || owner.ownerId !== request.owner.ownerId || owner.sessionId !== request.owner.sessionId) {
    owner?.invalidate(); throw new PlaceGovernanceError(401);
  }
  const intent = Object.freeze(result.data);
  pending.set(key(request), { owner, intent });
  return intent;
}
export async function submitPlaceGovernance(request: PlaceGovernanceRequest, intent: PlaceGovernanceIntent) {
  assertCurrent(request);
  if (!sameTarget(request.target, intent) || pendingPlaceGovernance(request) !== intent) throw new PlaceGovernanceError(400);
  try {
    const result = receiptSchema.safeParse(await fetchGovernance(request, { method: 'POST', headers: { 'Idempotency-Key': intent.operationId },
      body: JSON.stringify({ action:intent.action,reportId:intent.reportId,intoId:intent.intoId,reason:intent.reason,contextToken:intent.contextToken }) }));
    if (!result.success || !sameTarget(result.data, intent) || result.data.operationId !== intent.operationId) throw new PlaceGovernanceError(503);
    pending.get(key(request))?.owner.invalidate(); pending.delete(key(request));
    return result.data;
  } catch (error) {
    if (error instanceof PlaceGovernanceError && [400, 404, 409].includes(error.status)) {
      pending.get(key(request))?.owner.invalidate(); pending.delete(key(request));
    }
    throw error;
  }
}
