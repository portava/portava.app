import type { AVPlaybackSource } from 'expo-av';
import { freshToken } from '../apiToken.ts';

export async function resolveAdaptivePlayback(original: string, signal: AbortSignal): Promise<AVPlaybackSource | null> {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL;
  if (!base || !original || original.length > 4096) return null;
  const api = new URL(base);
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) return null;
  const token = await freshToken();
  if (!token || signal.aborted) return null;
  const endpoint = `${base.replace(/\/$/, '')}/api/media/adaptive`;
  const response = await fetch(`${endpoint}/source?source=${encodeURIComponent(original)}`, {
    signal, headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
  });
  if (!response.ok || signal.aborted) return null;
  const result = await response.json();
  if (result?.protocol !== 'hls' || !/^[0-9a-f-]{36}$/i.test(result.assetId) || !Number.isSafeInteger(result.sourceVersion) || result.sourceVersion < 1) return null;
  if (result.manifestUrl !== `${endpoint}/${result.assetId}/${result.sourceVersion}/master.m3u8`) return null;
  return { uri: result.manifestUrl, headers: { Authorization: `Bearer ${token}` }, overrideFileExtensionAndroid: 'm3u8' };
}
