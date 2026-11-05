import { z } from 'zod';
import { captureMessagingOwnerRequest, messagingOwnerToken } from './messagingOwnerRequest.ts';

const uuid = z.string().uuid();
const cursor = z.object({ createdAt: z.string().datetime({ offset: true }), id: uuid });
const trail = z.object({ id: uuid, title: z.string(), description: z.string().nullable(), destination: z.string().nullable(),
  createdBy: uuid, createdAt: z.string(), lifecycle: z.string(), slug: z.string().nullable() });
const page = z.object({ trails: z.array(trail), next: cursor.nullable() });
const decisionReceipt = z.object({ trail: z.object({ id: uuid, reviewState: z.enum(['approved', 'rejected']),
  reviewReason: z.string().nullable(), lifecycle: z.string() }) });
export type PendingTrailReview = z.infer<typeof trail>;
export type TrailReviewCursor = z.infer<typeof cursor>;
export type TrailReviewPage = z.infer<typeof page>;

export class TrailReviewError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? 'A current admin session is required.'
      : status === 409 ? 'This Trail has already been reviewed. Refresh the queue.'
      : status === 404 ? 'This Trail is no longer available. Refresh the queue.'
      : status === 400 ? 'Enter a rejection reason of 1–500 characters.'
      : 'The request could not be confirmed. Refresh the queue before trying the decision again.');
  }
}

async function request(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
  const owner = captureMessagingOwnerRequest();
  const base = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!owner || !base) { owner?.invalidate(); throw new TrailReviewError(401); }
  const controller = new AbortController();
  let cancel!: () => void;
  const interrupted = new Promise<never>((_, reject) => { cancel = () => { controller.abort(); reject(new TrailReviewError(503)); }; });
  const current = () => {
    if (signal.aborted || controller.signal.aborted || !owner.isCurrent()) throw new TrailReviewError(401);
  };
  signal.addEventListener('abort', cancel);
  const timer = setTimeout(cancel, 8000);
  try {
    current();
    const token = await Promise.race([messagingOwnerToken(owner), interrupted]);
    current();
    if (!token) throw new TrailReviewError(401);
    const response = await Promise.race([fetch(`${base}/api/admin/discovery/${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), interrupted]);
    current();
    if (!response.ok) throw new TrailReviewError(response.status);
    const value: unknown = await Promise.race([response.json(), interrupted]);
    current();
    return value;
  } catch (error) { throw error instanceof TrailReviewError ? error : new TrailReviewError(503); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); owner.invalidate(); }
}

export async function getPendingTrailReviews(signal: AbortSignal, after: TrailReviewCursor | null = null): Promise<TrailReviewPage> {
  const params = new URLSearchParams();
  if (after) { params.set('afterCreatedAt', after.createdAt); params.set('afterId', after.id); }
  const parsed = page.safeParse(await request(`trail-reviews/pending${after ? `?${params.toString()}` : ''}`, signal));
  if (!parsed.success) throw new TrailReviewError(503);
  return parsed.data;
}

export async function decidePendingTrailReview(id: string, decision: 'approve' | 'reject', reason: string, signal: AbortSignal) {
  if (!uuid.safeParse(id).success || reason.trim().length > 500 || (decision === 'reject' && !reason.trim())) throw new TrailReviewError(400);
  const parsed = decisionReceipt.safeParse(await request(`trails/${id}/review`, signal, { decision, reason: reason.trim() || null }));
  if (!parsed.success || parsed.data.trail.id !== id || parsed.data.trail.reviewState !== (decision === 'approve' ? 'approved' : 'rejected')) throw new TrailReviewError(503);
  return parsed.data.trail;
}
