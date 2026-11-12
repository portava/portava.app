import type { FsLike, FsUploadResult } from './backgroundTransfer.ts';
import type { UploadLifetime } from './uploadLifetime.ts';

type Progress = { id: string; totalBytesSent: number; totalBytesExpectedToSend: number };
export interface AndroidUploadModule {
  bindAsync(owner: string, origin: string): Promise<void>;
  wasCancelledAsync(owner: string): Promise<boolean>;
  cancelOwnerAsync(owner: string): Promise<void>;
  clearAsync(owner: string): Promise<void>;
  cancelAsync(id: string, owner: string): Promise<void>;
  uploadAsync(id: string, owner: string, url: string, uri: string, mime: string): Promise<FsUploadResult>;
  addListener(event: 'onUploadProgress', listener: (p: Progress) => void): { remove(): void };
  addListener(event: 'onUploadCancelled', listener: (p: { owner: string }) => void): { remove(): void };
}
let serial = 0;
/** Native bridge adapter is pure/injectable so races are exercised without RN. */
export async function androidUploadTasks(native: AndroidUploadModule, lifetime: UploadLifetime, storageOrigin: string): Promise<FsLike['createUploadTask']> {
  const assertCurrent = () => {
    if (!lifetime.isCurrent() || lifetime.signal.aborted) throw new Error('Upload session changed');
  };
  assertCurrent();
  const cancelled = native.addListener('onUploadCancelled', (p) => { if (p.owner === lifetime.key) lifetime.cancel(); });
  const clear = () => {
    cancelled.remove();
    const stop = lifetime.signal.reason === 'user' ? native.cancelOwnerAsync(lifetime.key) : native.clearAsync(lifetime.key);
    void stop.catch(() => {});
  };
  lifetime.signal.addEventListener('abort', clear);
  try {
    if (await native.wasCancelledAsync(lifetime.key)) { lifetime.cancel(); throw new Error('Upload cancelled'); }
    assertCurrent();
    await native.bindAsync(lifetime.key, new URL(storageOrigin).origin);
    assertCurrent();
  } catch (error) {
    lifetime.signal.removeEventListener('abort', clear);
    clear();
    throw error;
  }
  return (url, uri, options, callback) => {
    const id = `put_${Date.now().toString(36)}_${++serial}`;
    let started = false;
    return {
      async uploadAsync() {
        if (started) throw new Error('Upload task already started');
        started = true;
        assertCurrent();
        const subscription = native.addListener('onUploadProgress', (p) => {
          if (p.id === id && lifetime.isCurrent() && !lifetime.signal.aborted) callback?.(p);
        });
        try {
          const result = await native.uploadAsync(id, lifetime.key, url, uri, options.headers['Content-Type'] ?? 'application/octet-stream');
          assertCurrent();
          return result;
        } finally { subscription.remove(); }
      },
      cancelAsync: () => native.cancelAsync(id, lifetime.key),
    };
  };
}
