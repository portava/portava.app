import type { MessagingOwnerRequest } from '../observedOwnerSnapshot.ts';

/** One job's lifetime. Account changes pause recovery; explicit cancellation is terminal. */
export interface UploadLifetime {
  readonly owner: MessagingOwnerRequest;
  readonly signal: AbortSignal;
  readonly key: string;
  isCurrent(): boolean;
  cancel(): void;
  dispose(): void;
}
let sequence = 0;
export function createUploadLifetime(owner: MessagingOwnerRequest, observe?: (check: () => void) => () => void, jobId?: string): UploadLifetime {
  const controller = new AbortController();
  const check = () => { if (!owner.isCurrent()) controller.abort('session'); };
  const unsubscribe = observe?.(check);
  // Session and scope subscriptions invoke check; stage boundaries also verify
  // the owner. Never run an idle polling timer for an upload lifetime.
  check();
  return {
    owner, signal: controller.signal,
    key: jobId ? `upload_${jobId}` : `upload_${Date.now().toString(36)}_${++sequence}`,
    isCurrent: () => owner.isCurrent(),
    cancel: () => controller.abort(owner.isCurrent() ? 'user' : 'session'),
    dispose: () => { unsubscribe?.(); controller.abort('disposed'); },
  };
}
