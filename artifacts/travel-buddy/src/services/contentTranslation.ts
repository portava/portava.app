/**
 * Content translation client service.
 *
 * Calls GET /api/content/:entityType/:entityId/translation?lang=<code>
 * to fetch on-demand translations for posts, comments, events, trips, and bios.
 */
import { freshToken as freshApiToken } from './apiToken.ts';

export type ContentEntityType = 'post' | 'comment' | 'event' | 'trip' | 'bio';

export interface TranslatedFields {
  content?: string;
  body?: string;
  title?: string;
  description?: string;
  trip_notes?: string;
  bio?: string;
}

export interface ContentTranslationResponse {
  ok: boolean;
  skipped?: boolean;
  sourceLanguage?: string;
  targetLanguage?: string;
  translatedFields?: TranslatedFields;
  translationLabel?: string;
  status?: 'translated' | 'failed' | 'skipped';
  error?: string;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

/**
 * Fetch (or compute) a translation for any content entity.
 *
 * @param entityType  - 'post' | 'comment' | 'event' | 'trip' | 'bio'
 * @param entityId    - UUID of the entity (or userId for 'bio')
 * @param targetLang  - ISO 639-1 target language code, e.g. 'es'
 */
export async function fetchContentTranslation(
  entityType: ContentEntityType,
  entityId: string,
  targetLang: string,
): Promise<ContentTranslationResponse> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'api_not_configured' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'not_authenticated' };

  try {
    const url = `${base}/api/content/${entityType}/${entityId}/translation?lang=${encodeURIComponent(targetLang)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any)?.message ?? `http_${res.status}` };
    }
    return await res.json() as ContentTranslationResponse;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network_error' };
  }
}
