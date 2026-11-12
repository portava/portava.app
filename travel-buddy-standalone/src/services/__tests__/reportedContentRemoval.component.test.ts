// The test controls identity and transport without constructing a native auth client.
let mockCurrent = true;
const mockOwner = () => { let valid = true; return { ownerId: 'admin', sessionId: 'session', isCurrent: () => mockCurrent && valid, invalidate: () => { valid = false; } }; };
// NOTE: exhaustive boundary double avoids constructing native auth and controls the exact session lifetime.
jest.mock('../messagingOwnerRequest', () => ({ captureMessagingOwnerRequest: () => mockOwner(), messagingOwnerToken: async () => 'token' }));
// NOTE: only the operation ID generator is used; loading the admin HTTP module would construct native auth.
jest.mock('../reportsAdmin', () => ({ newReportedReviewOperationId: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }));
import { confirmContentRemoval, getContentRemovalContext, pendingContentRemoval, submitContentRemoval, type ContentRemovalRequest } from '../reportedContentRemoval.ts';
const target = { subjectType: 'comment' as const, subjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', reportId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const context = { ...target, contractVersion: 1 as const, reportStatus: 'open' as const, preview: 'Reported comment', effect: 'remove_content' as const, contentToken: 'a'.repeat(64), reportToken: 'b'.repeat(64) };
const receipt = { ...target, contractVersion: 1, ok: true, effect: 'remove_content', operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', auditId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', replayed: false, committedAt: '2026-11-05T07:00:00Z' };
const realFetch = globalThis.fetch;
const response = (value: unknown, status = 200) => ({ ok: status < 300, status, json: async () => value }) as Response;
let request: ContentRemovalRequest;
beforeEach(() => {
  mockCurrent = false;
  request = { owner: mockOwner(), target, signal: new AbortController().signal, isCurrent: () => mockCurrent };
  pendingContentRemoval(request);
  mockCurrent = true;
});
afterEach(() => { globalThis.fetch = realFetch; mockCurrent = false; pendingContentRemoval(request); });

it('validates context identity before allowing a confirmation', async () => {
  globalThis.fetch = jest.fn(async () => response({ ...context, subjectId: target.reportId }));
  await expect(getContentRemovalContext(request)).rejects.toMatchObject({ status: 503 });
  expect(pendingContentRemoval(request)).toBeNull();
});
it('retries an uncertain operation using exactly its original intent', async () => {
  const fetcher = jest.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(response({ ...receipt, replayed: true }));
  globalThis.fetch = fetcher;
  const intent = confirmContentRemoval(request, context, ' Reviewed conduct ');
  await expect(submitContentRemoval(request, intent)).rejects.toMatchObject({ status: 503 });
  expect(pendingContentRemoval(request)).toBe(intent);
  expect(confirmContentRemoval(request, context, 'Changed reason')).toBe(intent);
  const result = await submitContentRemoval(request, intent);
  expect(result.replayed).toBe(true);
  expect(fetcher.mock.calls[0][1].body).toEqual(fetcher.mock.calls[1][1].body);
  expect(fetcher.mock.calls[0][1].headers['Idempotency-Key']).toEqual(fetcher.mock.calls[1][1].headers['Idempotency-Key']);
  expect(pendingContentRemoval(request)).toBeNull();
});
it('clears a definitive stale-context refusal and requires another preview', async () => {
  globalThis.fetch = jest.fn(async () => response({}, 409));
  const intent = confirmContentRemoval(request, context, 'Reviewed');
  await expect(submitContentRemoval(request, intent)).rejects.toMatchObject({ status: 409 });
  expect(pendingContentRemoval(request)).toBeNull();
});
it('refuses the old account after sign-out and never sends its request', async () => {
  const fetcher = jest.fn(); globalThis.fetch = fetcher;
  const intent = confirmContentRemoval(request, context, 'Reviewed');
  mockCurrent = false;
  await expect(submitContentRemoval(request, intent)).rejects.toMatchObject({ status: 401 });
  expect(pendingContentRemoval(request)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not treat an invalid receipt as success or lose the recovery intent', async () => {
  globalThis.fetch = jest.fn(async () => response({ ...receipt, auditId: null }));
  const intent = confirmContentRemoval(request, context, 'Reviewed');
  await expect(submitContentRemoval(request, intent)).rejects.toMatchObject({ status: 503 });
  expect(pendingContentRemoval(request)).toBe(intent);
});
