import type { SupabaseClient } from '@supabase/supabase-js';
import { SelfHostedTranslationProvider } from '../../selfHostedTranslation.js';
import { readCaptionSnapshot } from '../../../services/media/AuthoredCaptionsService.js';
import { readSubtitleTranslationConsent, validTranslationPairs } from '../../../services/media/CaptionTranslationService.js';
import { createSubtitleTranslationMediaJobHandler } from './subtitleTranslationHandler.js';

export function createConfiguredSubtitleTranslationHandler(sc: SupabaseClient,
  jobError: (code: string, retryable: boolean) => Error, env: NodeJS.ProcessEnv = process.env) {
  const activation = env.MEDIA_SUBTITLE_TRANSLATION_ENABLED;
  if (activation === undefined || activation === '' || activation === 'false') return null;
  const invalid = () => jobError('invalid_subtitle_configuration', false);
  if (activation !== 'true') throw invalid();
  const modelVersion = env.MEDIA_SUBTITLE_TRANSLATION_MODEL_VERSION ?? '';
  const configVersion = env.MEDIA_SUBTITLE_TRANSLATION_CONFIG_VERSION ?? '';
  let allowedPairs: unknown;
  let endpoint: URL;
  try {
    allowedPairs = JSON.parse(env.MEDIA_SUBTITLE_TRANSLATION_ALLOWED_PAIRS ?? '');
    endpoint = new URL(env.TRANSLATION_SELF_HOSTED_URL ?? '');
  } catch { throw invalid(); }
  const token = env.TRANSLATION_SELF_HOSTED_TOKEN ?? '';
  const timeout = env.MEDIA_SUBTITLE_TRANSLATION_TIMEOUT_MS ?? '120000';
  if (!/^[A-Za-z0-9._:/@+\-]{1,160}$/.test(modelVersion) || !configVersion || configVersion.length > 200
    || !validTranslationPairs(allowedPairs) || !/^\d+$/.test(timeout) || Number(timeout) < 1000 || Number(timeout) > 120000
    || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.protocol !== 'http:' || endpoint.pathname !== '/'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || token.length < 32) throw invalid();
  return createSubtitleTranslationMediaJobHandler(sc, { enabled: true, modelVersion, configVersion, allowedPairs, timeoutMs: Number(timeout) }, {
    jobError, readCaptionSnapshot, readConsent: job => readSubtitleTranslationConsent(sc, job),
    provider: () => new SelfHostedTranslationProvider({ url: endpoint.origin, token, timeoutMs: 5000 }),
  });
}
