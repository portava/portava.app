import { freshToken } from '../apiToken.ts';
import type { CaptionSource } from './captions.ts';
import type { CaptionTranslationStatus, CaptionTranslationEnqueueResponse, CaptionTranslationDraftDto, CaptionTranslationPublishResponse, CaptionTranslationRevokeResponse } from '../../../../artifacts/api-server/src/lib/media/captions/subtitleTranslationContract.ts';

export type { CaptionTranslationStatus, CaptionTranslationDraftDto, CaptionTranslationPublishResponse };

const revision = /^[a-f0-9]{64}$/;
const language = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const maxVttLength = 262144;
const states = ['not_requested', 'pending', 'processing', 'retrying', 'completed', 'failed'];

function assertSource(source: CaptionSource) {
  if (!source.canEdit || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(source.assetId) || !Number.isSafeInteger(source.version) || source.version < 1 || source.version > 2147483647 || !revision.test(source.revisionKey)) throw new Error('A current creator-owned video is required.');
}

function validLanguage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35 && language.test(value);
}

function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseStatus(value: CaptionTranslationStatus): CaptionTranslationStatus {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.cleanupPending !== 'boolean' || typeof value.canRevoke !== 'boolean' || typeof value.current !== 'boolean' || !Number.isSafeInteger(value.sourceVersion) || value.sourceVersion < 1 || !revision.test(value.revisionKey) || !validEpoch(value.consentEpoch) || !states.includes(value.state) || !Array.isArray(value.allowedPairs) || value.allowedPairs.length > 100 || !value.allowedPairs.every((pair) => pair && validLanguage(pair.source) && validLanguage(pair.target) && pair.source !== pair.target)) throw new Error('Invalid subtitle translation status.');
  return value;
}

async function call(source: CaptionSource, suffix = '', method = 'GET', body?: unknown, signal?: AbortSignal) {
  assertSource(source);
  const base = process.env.EXPO_PUBLIC_API_BASE_URL;
  let endpoint: string;
  try {
    if (!base || /[\s\\?#@]/.test(base)) throw new Error();
    const origin = new URL(base);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    endpoint = `${origin.origin}/api/media/caption-translations/${encodeURIComponent(source.assetId)}${suffix}`;
  } catch { throw new Error('A secure subtitle translation API origin is required.'); }
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Subtitle translation request cancelled.'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Subtitle translation request timed out.')), 10000);
  const requireActive = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  let refuse = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    refuse = () => reject(controller.signal.reason);
    if (controller.signal.aborted) refuse();
    else controller.signal.addEventListener('abort', refuse, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      requireActive();
      const token = await freshToken();
      requireActive();
      if (!token) throw new Error('Sign in to manage subtitle translation.');
      const response = await fetch(endpoint, { method, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      requireActive();
      if (response.redirected || response.url && new URL(response.url).href !== endpoint) throw new Error('Subtitle translation request redirected.');
      if (!response.ok) throw new Error(response.status === 409 ? 'Consent, video or captions changed. Close and reopen before trying again.' : 'Subtitle translation unavailable. Check access and reopen to refresh.');
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 2_000_000)) throw new Error('Subtitle translation response is too large.');
      const text = await response.text();
      requireActive();
      if (text.length > 2_000_000) throw new Error('Subtitle translation response is too large.');
      return JSON.parse(text);
    })()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', refuse);
  }
}

export async function getCaptionTranslationStatus(source: CaptionSource, signal?: AbortSignal): Promise<CaptionTranslationStatus> {
  return parseStatus(await call(source, '', 'GET', undefined, signal));
}

export async function requestCaptionTranslation(source: CaptionSource, sourceLanguage: string, targetLanguage: string, consent: boolean, expectedConsentEpoch: number, signal?: AbortSignal): Promise<CaptionTranslationEnqueueResponse> {
  if (consent !== true || !validEpoch(expectedConsentEpoch) || !validLanguage(sourceLanguage) || !validLanguage(targetLanguage) || sourceLanguage === targetLanguage) throw new Error('Explicit translation permission and a validated language pair are required.');
  const response = await call(source, '', 'POST', { version: source.version, revisionKey: source.revisionKey, sourceLanguage, targetLanguage, consent: true, expectedConsentEpoch }, signal);
  parseStatus(response);
  if (typeof response.jobId !== 'string' || !/^[a-f0-9-]{36}$/i.test(response.jobId)) throw new Error('Invalid subtitle translation job.');
  return response;
}

export async function revokeCaptionTranslation(source: CaptionSource, signal?: AbortSignal): Promise<CaptionTranslationRevokeResponse> {
  const response = await call(source, '', 'DELETE', undefined, signal);
  if (!response || response.revoked !== true || !validEpoch(response.consentEpoch) || typeof response.cleanupPending !== 'boolean') throw new Error('Translation withdrawal could not be confirmed.');
  return response;
}

export async function readCaptionTranslationDraft(source: CaptionSource, signal?: AbortSignal): Promise<CaptionTranslationDraftDto | null> {
  const response = await call(source, `/draft?version=${source.version}`, 'GET', undefined, signal);
  if (response?.draft === null) return null;
  const draft: CaptionTranslationDraftDto = response?.draft;
  if (!draft || !revision.test(draft.draftId) || draft.version !== source.version || draft.revisionKey !== source.revisionKey || typeof draft.vtt !== 'string' || !draft.vtt || draft.vtt.length > maxVttLength || !validLanguage(draft.language) || !validLanguage(draft.sourceLanguage) || draft.language === draft.sourceLanguage || draft.aiLabel !== 'AI translation · needs creator review' || typeof draft.modelVersion !== 'string' || !draft.modelVersion || draft.modelVersion.length > 200) throw new Error('Invalid or stale translation draft. Close and reopen to refresh.');
  return draft;
}

export async function publishCaptionTranslation(source: CaptionSource, draft: CaptionTranslationDraftDto, vtt: string, reviewed: boolean, signal?: AbortSignal): Promise<CaptionTranslationPublishResponse> {
  if (reviewed !== true || draft.version !== source.version || draft.revisionKey !== source.revisionKey || !revision.test(draft.draftId) || typeof vtt !== 'string' || !vtt || vtt.length > maxVttLength) throw new Error('Review the current translation draft before publishing.');
  const response = await call(source, '/draft/publish', 'POST', { version: source.version, revisionKey: source.revisionKey, draftId: draft.draftId, reviewed: true, vtt }, signal);
  if (!response || response.assetId !== source.assetId || response.version !== source.version || !revision.test(response.revisionKey) || response.revisionKey === source.revisionKey || response.language !== draft.language || response.sourceKind !== 'translation' || response.aiLabel !== 'AI translation · creator reviewed' || typeof response.cleanupPending !== 'boolean' || !Array.isArray(response.availableLanguages) || response.availableLanguages.length > 8 || !response.availableLanguages.every(validLanguage) || !response.availableLanguages.includes(draft.language)) throw new Error('Publication could not be confirmed. Refresh the authoritative captions before retrying.');
  return response;
}
