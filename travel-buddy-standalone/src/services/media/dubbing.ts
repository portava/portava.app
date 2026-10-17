import { z } from 'zod';
import type { AVPlaybackSourceObject } from 'expo-av';
import { freshToken } from '../apiToken.ts';
import { supabase } from '../../lib/supabase.ts';

export const DUBBING_LABEL = 'AI-generated translated audio';
export const DUBBING_DISCLOSURE_VERSION = 'synthetic-dubbing-v1';
export interface DubbingIdentity { assetId: string; userId: string }
const uuid = z.string().uuid();
const language = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).max(35);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const consentSchema = z.object({ consentRevision: revision, optedIn: z.boolean(), label: z.literal(DUBBING_LABEL), disclosureVersion: z.literal(DUBBING_DISCLOSURE_VERSION) }).strict();
const queuedSchema = z.object({ jobId: uuid, status: z.literal('queued'), label: z.literal(DUBBING_LABEL), originalPreserved: z.literal(true) }).strict();
export type DubbingConsent = z.infer<typeof consentSchema>;
const optionsSchema = z.object({
  assetId: uuid, sourceVersion: z.number().int().positive(), sourceKey: revision,
  canEdit: z.boolean(), enabled: z.boolean(),
  languages: z.array(z.object({ code: language, label: z.string().min(1).max(64), ready: z.boolean() }).strict()).max(32),
  disclosure: z.object({ version: z.literal(DUBBING_DISCLOSURE_VERSION), text: z.string().min(1).max(2000), approved: z.literal(true) }).strict().optional(),
}).strict();
export type DubbingOptions = z.infer<typeof optionsSchema>;

export class DubbingRequestError extends Error {
  constructor(readonly code: 'unavailable' | 'invalid_input' | 'authentication_required' | 'cancelled' | 'cleanup_failed' | 'stale_consent', readonly status = 0) { super(code); this.name = 'DubbingRequestError'; }
}

function endpoint(identity: DubbingIdentity, targetLanguage?: string, audio = false): string {
  if (!uuid.safeParse(identity.assetId).success || !uuid.safeParse(identity.userId).success || (targetLanguage !== undefined && !language.safeParse(targetLanguage).success)) throw new DubbingRequestError('invalid_input');
  let base: URL;
  try { base = new URL(process.env.EXPO_PUBLIC_API_BASE_URL ?? ''); } catch { throw new DubbingRequestError('unavailable'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new DubbingRequestError('unavailable');
  return `${base.origin}/api/media/${identity.assetId}/dubbing${audio ? '/audio' : ''}${targetLanguage ? `?language=${encodeURIComponent(targetLanguage)}` : ''}`;
}

async function currentUser(identity: DubbingIdentity, signal?: AbortSignal) {
  if (signal?.aborted) throw new DubbingRequestError('cancelled');
  const { data, error } = await supabase.auth.getSession();
  if (signal?.aborted) throw new DubbingRequestError('cancelled');
  if (error || data.session?.user.id !== identity.userId) throw new DubbingRequestError('authentication_required');
}

async function request(identity: DubbingIdentity, uri: string, method: string, body?: unknown, signal?: AbortSignal) {
  await currentUser(identity, signal);
  const token = await freshToken();
  if (!token) throw new DubbingRequestError('authentication_required');
  await currentUser(identity, signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 15_000);
  const headers = { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-store', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
  try {
    const response = await fetch(uri, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit' });
    if (controller.signal.aborted) throw new DubbingRequestError('cancelled');
    await currentUser(identity, signal);
    if (response.redirected || (response.url && response.url !== uri)) throw new DubbingRequestError('unavailable');
    if (!response.ok) {
      let code: unknown;
      try { code = (await response.json()).error; } catch {}
      if (method === 'DELETE' && code === 'cleanup_failed') throw new DubbingRequestError('cleanup_failed', response.status);
      throw new DubbingRequestError(response.status === 409 ? 'stale_consent' : 'unavailable', response.status);
    }
    return { response, headers };
  } catch (error) {
    if (error instanceof DubbingRequestError) throw error;
    throw new DubbingRequestError(controller.signal.aborted ? 'cancelled' : 'unavailable');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export async function getDubbingConsent(identity: DubbingIdentity, targetLanguage: string, signal?: AbortSignal): Promise<DubbingConsent> {
  const { response } = await request(identity, endpoint(identity, targetLanguage), 'GET', undefined, signal);
  const parsed = consentSchema.safeParse(await response.json());
  if (!parsed.success) throw new DubbingRequestError('unavailable');
  await currentUser(identity, signal);
  return parsed.data;
}

export async function getDubbingOptions(identity: DubbingIdentity, signal?: AbortSignal): Promise<DubbingOptions> {
  const { response } = await request(identity, `${endpoint(identity)}/options`, 'GET', undefined, signal);
  const parsed = optionsSchema.safeParse(await response.json());
  if (!parsed.success || parsed.data.assetId !== identity.assetId) throw new DubbingRequestError('unavailable');
  await currentUser(identity, signal);
  return parsed.data;
}

export async function requestDubbing(identity: DubbingIdentity, targetLanguage: string, expectedConsentRevision: string, explicitOptIn: boolean, signal?: AbortSignal) {
  if (explicitOptIn !== true || !revision.safeParse(expectedConsentRevision).success || !language.safeParse(targetLanguage).success) throw new DubbingRequestError('invalid_input');
  const { response } = await request(identity, endpoint(identity), 'POST', { targetLanguage, expectedConsentRevision, explicitOptIn: true, disclosureVersion: DUBBING_DISCLOSURE_VERSION }, signal);
  const parsed = queuedSchema.safeParse(await response.json());
  if (response.status !== 202 || !parsed.success) throw new DubbingRequestError('unavailable');
  await currentUser(identity, signal);
  return parsed.data;
}

export async function revokeDubbing(identity: DubbingIdentity, signal?: AbortSignal): Promise<void> {
  const { response } = await request(identity, endpoint(identity), 'DELETE', undefined, signal);
  if (response.status !== 204) throw new DubbingRequestError('unavailable');
}

export async function dubbingAudioSource(identity: DubbingIdentity, targetLanguage: string, signal?: AbortSignal): Promise<AVPlaybackSourceObject> {
  const uri = endpoint(identity, targetLanguage, true);
  const { response, headers } = await request(identity, uri, 'HEAD', undefined, signal);
  const cache = response.headers.get('cache-control')?.toLowerCase() ?? '';
  const bytes = Number(response.headers.get('content-length'));
  if (response.url !== uri || response.headers.get('x-ai-generated') !== 'synthetic-dubbing' || !response.headers.get('content-type')?.toLowerCase().startsWith('audio/wav') || !cache.includes('private') || !cache.includes('no-store') || !Number.isSafeInteger(bytes) || bytes < 44 || bytes > 14_400_044) throw new DubbingRequestError('unavailable');
  return { uri, headers, overrideFileExtensionAndroid: 'wav' };
}

export function subscribeDubbingAuth(listener: () => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((event) => { if (event !== 'INITIAL_SESSION') listener(); });
  return () => data.subscription.unsubscribe();
}
