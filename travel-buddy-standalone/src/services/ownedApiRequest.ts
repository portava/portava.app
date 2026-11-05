import { captureMessagingOwnerRequest, messagingOwnerToken, type MessagingOwnerRequest } from './messagingOwnerRequest.ts';

export interface OwnedApiContext {
  owner?: MessagingOwnerRequest;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

/** One initiating session and deadline for token, headers and body decoding. */
export async function fetchOwnedApi(path: string, options: OwnedApiContext & { method?: string; body?: object; headers?: Record<string, string> } = {}): Promise<Pick<Response, 'ok' | 'status' | 'json'> & { headers?: Pick<Headers, 'get'> }> {
  const owner = options.owner ?? captureMessagingOwnerRequest();
  const controller = new AbortController();
  const deadline = Date.now() + 10_000;
  const current = () => {
    if (!owner?.isCurrent() || options.isCurrent?.() === false || options.signal?.aborted || controller.signal.aborted || Date.now() >= deadline) {
      controller.abort();
      throw new Error('This request ended. Reopen the item and try again.');
    }
  };
  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    current();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectCancelled: (reason: Error) => void = () => {};
    const cancel = () => { controller.abort(); rejectCancelled(new Error('Request cancelled.')); };
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectCancelled = reject;
        options.signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(new Error('Request timed out. Try again.')); }, Math.max(1, deadline - Date.now()));
      });
      const result = await Promise.race([cancelled, work()]);
      current();
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
  current();
  const raw = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!raw || /[\s\\?#@]/.test(raw)) throw new Error('A secure API origin is required.');
  const base = new URL(raw);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || !path.startsWith('/api/')) throw new Error('Invalid API endpoint.');
  const endpoint = new URL(path, base);
  if (endpoint.origin !== base.origin || endpoint.hash || /[\\]/.test(path)) throw new Error('Invalid API endpoint.');
  const token = await bounded(() => messagingOwnerToken(owner!));
  if (!token) throw new Error('Sign in again to continue.');
  const response = await bounded(() => fetch(endpoint.href, {
    method: options.method ?? 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
    headers: { ...options.headers, Authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }));
  if (response.redirected || response.url && new URL(response.url).href !== endpoint.href) throw new Error('API request redirected.');
  return { ok: response.ok, status: response.status, headers: response.headers, json: () => bounded(() => response.json()) };
}
