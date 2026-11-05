/**
 * "Download your data" (Settings → Account) — GET /api/me/export, written to a
 * JSON file and handed to the share sheet, so the person can save it to Files,
 * mail it to themselves, or AirDrop it.
 *
 * The server builds the file all-or-nothing (api-server lib/personalDataExport.ts):
 * a 200 is the whole export, anything else is no export. This module keeps that
 * line: it never writes or shares a file from a failed response.
 */
import { Share } from 'react-native';
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken } from './apiToken.ts';

export type DataExportError = 'not_configured' | 'unauthenticated' | 'rate_limited' | 'network' | 'server' | 'share_failed';

export type DataExportResult =
  | { ok: true; sections: number; complete: boolean }
  | { ok: false; error: DataExportError };

/** The device seams, injected so the flow runs under jest without native modules. */
export interface DataExportDeps {
  fetch: typeof fetch;
  token: () => Promise<string | null>;
  apiBase: () => string;
  configured: () => boolean;
  /** Write `text` to a new file named `filename`; returns its uri. */
  writeFile: (filename: string, text: string) => Promise<string>;
  /** Open the share sheet for a file; false when this device has no file sharing. */
  shareFile: (uri: string) => Promise<boolean>;
  /** Fallback where file sharing is unavailable (web). */
  shareText: (title: string, text: string) => Promise<void>;
}

const defaultDeps: DataExportDeps = {
  fetch: (input, init) => fetch(input, init),
  token: freshToken,
  apiBase: () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '',
  configured: () => isSupabaseConfigured,
  writeFile: async (filename, text) => {
    const fs = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    const uri = `${fs.cacheDirectory ?? ''}${filename}`;
    await fs.writeAsStringAsync(uri, text);
    return uri;
  },
  shareFile: async (uri) => {
    const Sharing = require('expo-sharing') as typeof import('expo-sharing');
    if (!(await Sharing.isAvailableAsync())) return false;
    await Sharing.shareAsync(uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'Your Portava data' });
    return true;
  },
  shareText: async (title, text) => { await Share.share({ title, message: text }); },
};

/** `portava-data-2026-11-04.json`, from the file's own generatedAt. */
export function exportFilename(generatedAt: unknown): string {
  const day = typeof generatedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(generatedAt)
    ? generatedAt.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  return `portava-data-${day}.json`;
}

export async function downloadMyData(deps: DataExportDeps = defaultDeps): Promise<DataExportResult> {
  if (!deps.configured() || !deps.apiBase()) return { ok: false, error: 'not_configured' };
  const token = await deps.token();
  if (!token) return { ok: false, error: 'unauthenticated' };

  let body: { generatedAt?: unknown; sections?: unknown; complete?: unknown; format?: unknown };
  try {
    const res = await deps.fetch(`${deps.apiBase()}/api/me/export`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) return { ok: false, error: 'unauthenticated' };
    if (res.status === 429) return { ok: false, error: 'rate_limited' };
    if (!res.ok) return { ok: false, error: 'server' };
    body = await res.json();
  } catch {
    return { ok: false, error: 'network' };
  }
  // A 200 that is not the export (a proxy page, a truncated body) is not a file to hand over.
  if (body?.format !== 'portava.personal-data-export' || !Array.isArray(body.sections)) return { ok: false, error: 'server' };

  const filename = exportFilename(body.generatedAt);
  const pretty = JSON.stringify(body, null, 2);
  try {
    const uri = await deps.writeFile(filename, pretty);
    const shared = await deps.shareFile(uri);
    if (!shared) await deps.shareText(filename, pretty);
  } catch {
    return { ok: false, error: 'share_failed' };
  }
  return { ok: true, sections: body.sections.length, complete: body.complete === true };
}

/** What the person is told when the download did not happen. */
export function dataExportErrorMessage(error: DataExportError): string {
  switch (error) {
    case 'rate_limited': return 'You have downloaded your data a few times this hour. Please try again later.';
    case 'unauthenticated': return 'Please sign in again, then download your data.';
    case 'network': return 'Could not reach Portava. Check your connection and try again.';
    case 'share_failed': return 'Your data was ready, but it could not be saved or shared on this device. Please try again.';
    case 'not_configured': return 'Downloading your data is not available in this build.';
    default: return 'Your data could not be gathered right now. Nothing was sent; please try again.';
  }
}
