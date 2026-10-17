import { freshToken } from '../apiToken.ts';

export interface TimedCaptionCue { startMs: number; endMs: number; text: string }
export interface CaptionAsrStatus { enabled: boolean; languages: string[]; sourceVersion: number; revisionKey: string; consentEpoch: string; state: string; canRevoke: boolean; current: boolean }
export interface CaptionSource { assetId: string; version: number; revisionKey: string; durationMs: number; canEdit: boolean }
export interface CaptionTrackResult {
  assetId: string;
  version: number;
  revisionKey: string;
  cues: TimedCaptionCue[];
  vtt: string | null;
  cleanupPending?: boolean;
  language?: string;
  availableLanguages?: string[];
  sourceKind?: 'manual' | 'asr' | 'translation';
  aiLabel?: string | null;
  draftId?: string;
}

function captionEndpoint(path: string): string {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL;
  try {
    if (!base || /[\s\\?#@]/.test(base)) throw new Error();
    const api = new URL(base);
    if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash || api.pathname !== '/') throw new Error();
    const endpoint = new URL(`${api.origin}/api/media/captions${path}`);
    if (endpoint.origin !== api.origin || !endpoint.pathname.startsWith('/api/media/captions/') || endpoint.hash) throw new Error();
    return endpoint.href;
  } catch { throw new Error('A secure captions API origin is required.'); }
}

async function call(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const endpoint = captionEndpoint(path);
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Caption request cancelled.'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Caption request timed out.')), 10000);
  const abortError = () => controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Caption request cancelled.');
  const requireActive = () => { if (controller.signal.aborted) throw abortError(); };
  let refuse: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    refuse = () => reject(abortError());
    if (controller.signal.aborted) refuse();
    else controller.signal.addEventListener('abort', refuse, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      requireActive();
      const token = await freshToken();
      requireActive();
      if (!token) throw new Error('Sign in to use captions.');
      const response = await fetch(endpoint, {
        method, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      requireActive();
      if (response.redirected || response.url && new URL(response.url).href !== endpoint) throw new Error('Caption request redirected.');
      const result = await response.json();
      requireActive();
      if (!response.ok) throw new Error(response.status === 409 ? 'The video changed. Close and reopen captions before editing.' : 'Captions unavailable. Check access and try again.');
      return result;
    })()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', refuse);
  }
}

export async function resolveCaptionSource(source: string, signal?: AbortSignal, options?: { forDubbingManagement: true }): Promise<CaptionSource> {
  const result = await call(`/source?source=${encodeURIComponent(source)}${options?.forDubbingManagement ? '&manageDubbing=1' : ''}`, 'GET', undefined, signal);
  if (typeof result.assetId !== 'string' || !/^[a-f0-9]{64}$/.test(result.revisionKey) || !Number.isSafeInteger(result.version) || result.version <= 0 || !Number.isSafeInteger(result.durationMs) || result.durationMs <= 0 || typeof result.canEdit !== 'boolean') throw new Error('Invalid caption source.');
  return result;
}

function trackResult(result: CaptionTrackResult, assetId: string): CaptionTrackResult {
  if (result.assetId !== assetId || !/^[a-f0-9]{64}$/.test(result.revisionKey) || !Number.isSafeInteger(result.version) || !Array.isArray(result.cues) || result.cues.length > 2000 || !result.cues.every((cue) => Number.isSafeInteger(cue.startMs) && Number.isSafeInteger(cue.endMs) && cue.startMs >= 0 && cue.endMs > cue.startMs && typeof cue.text === 'string')) throw new Error('Invalid caption track.');
  return result;
}

export async function readCaptionTrack(source: CaptionSource, signal?: AbortSignal, language?: string): Promise<CaptionTrackResult> {
  const result = trackResult(await call(`/${encodeURIComponent(source.assetId)}?version=${source.version}${language ? `&language=${encodeURIComponent(language)}` : ''}`, 'GET', undefined, signal), source.assetId);
  if (result.version !== source.version || result.cues.some((cue) => cue.endMs > source.durationMs + 1000)) throw new Error('Stale caption track.');
  return result;
}

export async function saveCaptionTrack(source: CaptionSource, vtt: string, consent: boolean, language = 'und'): Promise<CaptionTrackResult> {
  return trackResult(await call(`/${encodeURIComponent(source.assetId)}`, 'PUT', { version: source.version, revisionKey: source.revisionKey, vtt, consent, language }), source.assetId);
}

export async function deleteCaptionTrack(source: CaptionSource): Promise<CaptionTrackResult> {
  return trackResult(await call(`/${encodeURIComponent(source.assetId)}`, 'DELETE', { version: source.version, revisionKey: source.revisionKey }), source.assetId);
}

export async function readCaptionDraft(source: CaptionSource, signal?: AbortSignal): Promise<CaptionTrackResult> {
  const draft = await call(`/${encodeURIComponent(source.assetId)}/draft?version=${source.version}`, 'GET', undefined, signal);
  if (!draft || typeof draft.draftId !== 'string' || typeof draft.vtt !== 'string') throw new Error('No generated caption draft is ready.');
  return { assetId: source.assetId, version: source.version, revisionKey: draft.revisionKey, cues: [], vtt: draft.vtt, language: draft.language, sourceKind: 'asr', aiLabel: draft.aiLabel, draftId: draft.draftId };
}

export async function publishCaptionDraft(source: CaptionSource, draftId: string, vtt: string, consent: boolean): Promise<CaptionTrackResult> {
  return trackResult(await call(`/${encodeURIComponent(source.assetId)}/draft/publish`, 'POST', { version: source.version, revisionKey: source.revisionKey, draftId, vtt, consent }), source.assetId);
}

function asrStatus(result: CaptionAsrStatus): CaptionAsrStatus {
  if (!result || typeof result.enabled !== 'boolean' || !Array.isArray(result.languages) || !result.languages.every((language: unknown) => typeof language === 'string') || !Number.isSafeInteger(result.sourceVersion) || !/^[a-f0-9]{64}$/.test(result.revisionKey) || typeof result.consentEpoch !== 'string' || !/^[a-f0-9]{64}$/.test(result.consentEpoch) || typeof result.state !== 'string' || typeof result.canRevoke !== 'boolean' || typeof result.current !== 'boolean') throw new Error('Invalid transcription state.');
  return result;
}

export async function getCaptionAsrStatus(source: CaptionSource, signal?: AbortSignal): Promise<CaptionAsrStatus> {
  return asrStatus(await call(`/${encodeURIComponent(source.assetId)}/asr`, 'GET', undefined, signal));
}

export async function requestCaptionAsr(source: CaptionSource, targetLanguage: string, consent: boolean, expectedConsentEpoch: string): Promise<CaptionAsrStatus> {
  if (typeof expectedConsentEpoch !== 'string' || !/^[a-f0-9]{64}$/.test(expectedConsentEpoch)) throw new Error('Refresh transcription consent status before requesting a draft.');
  return asrStatus(await call(`/${encodeURIComponent(source.assetId)}/asr`, 'POST', { version: source.version, revisionKey: source.revisionKey, expectedConsentEpoch, targetLanguage, consent }));
}

export async function revokeCaptionAsr(source: CaptionSource): Promise<{ revoked: true; cleanupPending: boolean }> {
  return call(`/${encodeURIComponent(source.assetId)}/asr`, 'DELETE');
}
