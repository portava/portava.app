import { Platform } from 'react-native';
/** Send local picker files as raw bytes. Native file URLs are streamed by the
 * OS; browser blob URLs use fetch, preserving the browser's binary body. */
export class LocalMediaReadError extends Error {}

export async function postLocalBinary(url: string, uri: string, headers: Record<string, string>, options: {
  signal?: AbortSignal; isCurrent?: () => boolean;
} = {}): Promise<Pick<Response, 'ok' | 'status' | 'json'>> {
  const current = () => !options.signal?.aborted && options.isCurrent?.() !== false;
  const check = () => { if (!current()) throw new Error('Upload cancelled.'); };
  check();
  const local = /^(file|content|ph|assets-library):\/\//i.test(uri);
  if (local && Platform.OS !== 'web') {
    const fs = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    let staged: string | null = null;
    let file = uri;
    try {
      try {
        if (!uri.startsWith('file://')) {
          if (!fs.cacheDirectory) throw new Error('The device file cache is unavailable.');
          staged = fs.cacheDirectory + 'portava-upload-' + Date.now() + '-' + Math.random().toString(36).slice(2);
          await fs.copyAsync({ from: uri, to: staged });
          file = staged;
        }
        const info = await fs.getInfoAsync(file);
        if (!info.exists || info.isDirectory || info.size <= 0) throw new Error('The selected file is unavailable or empty. Choose it again.');
      } catch (error) {
        throw new LocalMediaReadError(error instanceof Error ? error.message : 'Could not read the selected file.');
      }
      check();
      const task = fs.createUploadTask(url, file, {
        httpMethod: 'POST', uploadType: fs.FileSystemUploadType.BINARY_CONTENT,
        sessionType: fs.FileSystemSessionType.FOREGROUND, headers,
      });
      const cancel = () => { void task.cancelAsync().catch(() => {}); };
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        const response = await task.uploadAsync();
        check();
        if (!response) throw new Error('The upload was interrupted.');
        return { ok: response.status >= 200 && response.status < 300, status: response.status,
          json: async () => JSON.parse(response.body) };
      } finally { options.signal?.removeEventListener('abort', cancel); }
    } finally { if (staged) await fs.deleteAsync(staged, { idempotent: true }).catch(() => {}); }
  }

  let blob: Blob;
  try {
    const source = await fetch(uri, { signal: options.signal });
    blob = await source.blob();
    if (!blob.size) throw new Error('The selected file is empty.');
  } catch (error) { throw new LocalMediaReadError(error instanceof Error ? error.message : 'Could not read the selected file.'); }
  check();
  return fetch(url, { method: 'POST', headers, body: blob, signal: options.signal });
}
