import { fetchOwnedApi, type OwnedApiContext } from './ownedApiRequest.ts';
export async function readCommentTyping(postId: string, context: OwnedApiContext): Promise<number> {
  try {
    const response = await fetchOwnedApi(`/api/posts/${encodeURIComponent(postId)}/comments/typing`, context);
    if (!response.ok) return 0;
    const body = await response.json();
    return Number.isInteger(body?.typingCount) && body.typingCount >= 0 && body.typingCount <= 16 ? body.typingCount : 0;
  } catch { return 0; }
}
export async function sendCommentTyping(postId: string, typing: boolean, context: OwnedApiContext): Promise<void> {
  try { await fetchOwnedApi(`/api/posts/${encodeURIComponent(postId)}/comments/typing`, { ...context, method: 'POST', body: { typing } }); }
  catch { /* A transient hint must never block editing or publishing. */ }
}
