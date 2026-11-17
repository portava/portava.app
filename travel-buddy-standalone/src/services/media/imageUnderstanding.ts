import { captureMessagingOwnerRequest, messagingOwnerToken } from '../messagingOwnerRequest.ts';
import { requestDeadline } from '../../lib/requestDeadline.ts';

export interface ImageUnderstandingStatus {
  postMediaId: string; sourceVersion: number; mediaType: 'image' | 'video';
  processing: { enabled: boolean; provider: 'local' | 'huggingface'; policyVersion: string | null; disclosure: string };
  consent: 'none' | 'granted' | 'revoked' | 'unavailable';
}
export interface ImageUnderstandingResult { tags: string[]; processedAt: string }
const travelTags = new Set(['beach', 'ocean', 'mountain', 'architecture', 'food', 'sunset', 'forest', 'snow', 'desert', 'waterfall', 'lake', 'garden', 'boat', 'market']);
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function endpoint(id: string, suffix: string): string {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!idPattern.test(id) || !base || /[\s\\?#@]/.test(base)) throw new Error('Image understanding is unavailable.');
  const origin = new URL(base);
  if (origin.protocol !== 'https:' || origin.pathname !== '/') throw new Error('A secure media connection is required.');
  return `${origin.origin}/api/media/image-understanding/${id}${suffix}`;
}

async function call(id: string, suffix: string, method: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const url = endpoint(id, suffix);
  const owner = captureMessagingOwnerRequest();
  const budget = requestDeadline(10000, signal);
  const current = () => { if (!owner?.isCurrent()) throw new Error('Your session changed. Reopen image understanding.'); };
  const wait = async <T>(start: () => Promise<T>) => { current(); const value = await budget.wait(start); current(); return value; };
  try {
    const token = await wait(() => owner ? messagingOwnerToken(owner) : Promise.resolve(null));
    if (!token) throw new Error('Sign in to manage image understanding.');
    const response = await wait(() => fetch(url, { method, signal: budget.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    if (response.redirected || response.url && response.url !== url) throw new Error('Image understanding request redirected.');
    if (response.status === 204 && method === 'DELETE') return null;
    if (!response.ok) throw new Error(response.status === 404 ? 'No result is available. Refresh to check availability and consent.' : 'Image understanding could not be confirmed. Refresh to try again.');
    return await wait(() => response.json());
  } finally { budget.dispose(); }
}

export async function getImageUnderstandingStatus(id: string, signal?: AbortSignal): Promise<ImageUnderstandingStatus> {
  const result = await call(id, '/consent', 'GET', undefined, signal);
  const p = result?.processing;
  if (result?.postMediaId !== id || !Number.isSafeInteger(result.sourceVersion) || result.sourceVersion < 1
    || !['image', 'video'].includes(result.mediaType) || !['none', 'granted', 'revoked', 'unavailable'].includes(result.consent)
    || !p || typeof p.enabled !== 'boolean' || !['local', 'huggingface'].includes(p.provider) || typeof p.disclosure !== 'string' || !p.disclosure.trim() || p.disclosure.length > 2000
    || p.policyVersion !== null && (typeof p.policyVersion !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(p.policyVersion))
    || p.enabled && (!p.policyVersion || (p.provider === 'huggingface') !== p.policyVersion.startsWith('hf-siglip-v1-'))) throw new Error('Unrecognized image processing disclosure.');
  return result;
}

export async function requestImageUnderstanding(status: ImageUnderstandingStatus, signal?: AbortSignal): Promise<void> {
  if (!status.processing.enabled || !status.processing.policyVersion || status.consent !== 'none') throw new Error('Refresh and review processing before requesting suggestions.');
  const result = await call(status.postMediaId, '/consent', 'POST', { sourceVersion: status.sourceVersion, policyVersion: status.processing.policyVersion,
    scope: 'media_image_understanding', ...(status.processing.provider === 'huggingface' ? { processingProvider: 'huggingface' } : {}) }, signal);
  if (result?.accepted !== true || result.state !== 'queued' || result.verified !== false) throw new Error('The request could not be confirmed. Refresh its status.');
}

export async function revokeImageUnderstanding(id: string, signal?: AbortSignal): Promise<void> {
  await call(id, '/consent', 'DELETE', undefined, signal);
}

export async function readImageUnderstanding(status: ImageUnderstandingStatus, signal?: AbortSignal): Promise<ImageUnderstandingResult> {
  const result = await call(status.postMediaId, '', 'GET', undefined, signal);
  if (result?.source?.postMediaId !== status.postMediaId || result.source.sourceVersion !== status.sourceVersion || result.verified !== false
    || result.eligibleAsObservation !== false || result.confidenceKind !== 'uncalibrated_similarity' || !Number.isFinite(Date.parse(result.processedAt))
    || !Array.isArray(result.candidates) || result.candidates.length > 6
    || result.candidates.some((row: any) => !travelTags.has(row?.tag) || row.verified !== false || row.eligibleAsObservation !== false || row.basis !== 'visual_inference' || !Number.isFinite(row.confidence) || row.confidence < 0.5 || row.confidence > 1)) throw new Error('The media or its suggestions changed. Refresh to continue.');
  return { tags: result.candidates.map((row: { tag: string }) => row.tag), processedAt: result.processedAt };
}
