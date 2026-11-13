import { captureMessagingOwnerRequest, messagingOwnerToken } from '../messagingOwnerRequest.ts';
import { requestDeadline } from '../../lib/requestDeadline.ts';
import { supabase } from '../../lib/supabase.ts';

export interface GeneratedDraft { id: string; requestId: string; kind: 'image' | 'video'; model: string; state: string; estimateUsd: number; createdAt: string; expiresAt: string; aiGenerated: true }
export interface GenerationAvailability { enabled: boolean; image: boolean; video: boolean; policyVersion: string; disclosure: string; models: Record<'image' | 'video', { id: string; label: string; estimateUsd: number }>; jobs: GeneratedDraft[] }
export interface GenerationRequest { requestId: string; kind: 'image' | 'video'; prompt: string; aspectRatio: '16:9' | '9:16' | '1:1'; consentVersion: string }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function generationRequestId(): string {
  // This is an owner-scoped deduplication token, never an authentication token.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = Math.floor(Math.random() * 16); return (c === 'x' ? n : n & 3 | 8).toString(16); });
}
async function call(suffix: string, method: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!base || /[\s\\?#@]/.test(base)) throw new Error('AI creation is unavailable.');
  const origin = new URL(base);
  if (origin.protocol !== 'https:' || origin.pathname !== '/') throw new Error('AI creation needs a secure connection.');
  const url = `${origin.origin}/api/media/generation${suffix}`;
  const owner = captureMessagingOwnerRequest();
  const budget = requestDeadline(15000, signal);
  const current = () => { if (!owner?.isCurrent()) throw new Error('Your session changed. Reopen AI creation.'); };
  const wait = async <T>(start: () => Promise<T>) => { current(); const result = await budget.wait(start); current(); return result; };
  try {
    const token = await wait(() => owner ? messagingOwnerToken(owner) : Promise.resolve(null));
    if (!token) throw new Error('Sign in to create a draft.');
    const response = await wait(() => fetch(url, { method, signal: budget.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    if (response.redirected || response.url && response.url !== url) throw new Error('AI creation connection changed.');
    if (!response.ok) throw new Error(response.status === 429 ? 'Your generation allowance has been reached. Try again later.'
      : 'Could not confirm this action. Refresh your drafts before trying again.');
    return await wait(() => response.json());
  } finally { budget.dispose(); }
}
export function validDraft(value: any): value is GeneratedDraft {
  return !!value && UUID.test(value.id) && UUID.test(value.requestId) && ['image', 'video'].includes(value.kind) &&
    ['queued', 'running', 'ready', 'failed', 'blocked', 'deleting', 'deleted'].includes(value.state) && value.aiGenerated === true &&
    typeof value.model === 'string' && Number.isFinite(value.estimateUsd) && value.estimateUsd > 0 && Number.isFinite(Date.parse(value.expiresAt));
}
export async function getGenerationDrafts(signal?: AbortSignal): Promise<GenerationAvailability> {
  const value = await call('', 'GET', undefined, signal);
  if (!value || typeof value.enabled !== 'boolean' || typeof value.image !== 'boolean' || typeof value.video !== 'boolean' ||
    typeof value.policyVersion !== 'string' || typeof value.disclosure !== 'string' || !Array.isArray(value.jobs) || value.jobs.length > 20 || !value.jobs.every(validDraft) ||
    !['image', 'video'].every(kind => typeof value.models?.[kind]?.label === 'string' && Number.isFinite(value.models[kind].estimateUsd) && value.models[kind].estimateUsd > 0)) throw new Error('AI creation status is unavailable.');
  return value;
}
export async function createGenerationDraft(body: GenerationRequest, signal?: AbortSignal): Promise<GeneratedDraft> {
  const value = await call('', 'POST', body, signal);
  if (!validDraft(value) || value.requestId !== body.requestId || value.kind !== body.kind) throw new Error('Could not confirm the draft. Refresh before trying again.');
  return value;
}
export async function previewGenerationDraft(id: string, signal?: AbortSignal): Promise<GeneratedDraft & { url: string }> {
  if (!UUID.test(id)) throw new Error('Invalid draft.');
  const value = await call(`/${id}/preview`, 'GET', undefined, signal);
  const rawUrl: unknown = value?.url;
  if (!validDraft(value) || value.id !== id || value.state !== 'ready' || typeof rawUrl !== 'string') throw new Error('The draft is not ready.');
  const url = new URL(rawUrl);
  const storage = new URL(process.env.EXPO_PUBLIC_SUPABASE_URL ?? 'https://invalid.invalid');
  if (url.protocol !== 'https:' || url.origin !== storage.origin || url.username || url.password || url.hash || !url.pathname.startsWith('/storage/v1/object/sign/generated-media-private/')) throw new Error('Preview connection is unavailable.');
  return { ...value, url: url.href };
}
export async function deleteGenerationDraft(id: string, signal?: AbortSignal) {
  if (!UUID.test(id)) throw new Error('Invalid draft.');
  await call(`/${id}`, 'DELETE', undefined, signal);
}

/** The event contains only an id; re-fetch authoritative owner-scoped state.
 * Subscription/reconnection performs one catch-up read, never a timer poll. */
export function subscribeGenerationDrafts(onChange: () => void, onUnavailable: () => void): () => void {
  const owner = captureMessagingOwnerRequest();
  if (!owner) { onUnavailable(); return () => {}; }
  let stopped = false;
  const current = () => !stopped && owner.isCurrent();
  const channel = supabase.channel(`media-generation:${owner.ownerId}`, { config: { private: true } });
  void supabase.realtime.setAuth().then(() => {
    if (!current()) return;
    channel.on('broadcast', { event: 'generation_changed' }, event => { if (current() && UUID.test(event.payload?.id ?? '')) onChange(); })
      .subscribe(status => {
        if (!current()) return;
        if (status === 'SUBSCRIBED') onChange();
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') onUnavailable();
      });
  }).catch(() => { if (current()) onUnavailable(); });
  return () => { stopped = true; void supabase.removeChannel(channel); };
}
