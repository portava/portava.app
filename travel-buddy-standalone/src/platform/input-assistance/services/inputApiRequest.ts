import { viewerKeyForToken, viewerKeyForUser } from '../../../services/discoveryViewerScope.ts';
import { freshToken } from '../../../services/apiToken.ts';
import { withInputBudget } from './requestBudget.ts';

/** One account and five-second budget, from token lookup through body parsing.
 * The caller retains its own failure wording and consent semantics. */
export async function withInputApiResponse<T>(
  path: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  signal?: AbortSignal,
  expectedAccount?: string | null,
): Promise<T> {
  const budget = withInputBudget(signal);
  try {
    const token = await budget.wait(freshToken);
    if (!token) throw new Error('Sign in to continue');
    if (expectedAccount !== undefined && (!expectedAccount
      || viewerKeyForToken(token) !== viewerKeyForUser(expectedAccount))) throw new Error('Input account changed');
    const response = await budget.fetch(process.env.EXPO_PUBLIC_API_BASE_URL ?? '', path, token, init);
    return await budget.wait(() => consume(response));
  } finally {
    budget.done();
  }
}
