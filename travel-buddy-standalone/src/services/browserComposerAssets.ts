/** Browser-local blobs for draft recovery. No upload, permission or analytics. */
const DB = 'rumazi-local-composer-assets-v1';
function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('assets'); };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(new Error('Local draft storage unavailable.'));
    });
}
async function access<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction('assets', mode), request = run(tx.objectStore('assets'));
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = tx.onabort = () => reject(new Error('Local draft storage unavailable.'));
        });
    }
    finally {
        db.close();
    }
}
const key = (account: string, uri: string) => `${account}:${uri}`;
export async function preserveBrowserDraftAsset(account: string, uri: string): Promise<string> {
    // Only bytes selected locally; never turn this into a remote download proxy.
    if (!uri.startsWith('blob:') && !uri.startsWith('data:'))
        throw new Error('This browser media cannot be saved locally.');
    const response = await fetch(uri);
    if (!response.ok)
        throw new Error('Selected media could not be read.');
    const blob = await response.blob();
    await access('readwrite', store => store.put(blob, key(account, uri)));
    return uri;
}
export async function restoreBrowserDraftAsset(account: string, uri: string): Promise<string> {
    const blob = await access('readonly', store => store.get(key(account, uri)));
    if (!(blob instanceof Blob))
        throw new Error('Saved media is missing on this device.');
    return URL.createObjectURL(blob);
}
export async function discardBrowserDraftAsset(account: string, uri: string): Promise<void> {
    await access('readwrite', store => store.delete(key(account, uri)));
}
