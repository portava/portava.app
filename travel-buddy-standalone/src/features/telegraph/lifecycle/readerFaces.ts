/**
 * The receipt chips' faces, as the SERVER answered them (census-telegraph T295).
 *
 * `GET /api/threads/:id/receipts` answers `readerFaces` with the receipt — the
 * avatar for each reader id, or `null` where the server withholds it (a block
 * either way, a private profile that is not the viewer's friend, a read that
 * failed). `useThreadReadState` publishes each answer here and `useReaderAvatars`
 * looks faces up; nothing on the conversation surface reads `profiles` itself.
 *
 * An id the newest answer withheld is overwritten with `null`, so a face the
 * server stopped sending (a block made since) is not kept from an older answer.
 */

const faces = new Map<string, string | null>();
const listeners = new Set<() => void>();
let version = 0;

/** Record one receipts answer's faces. Ids it names replace what was held for them. */
export function publishReaderFaces(answer: Readonly<Record<string, string | null>> | null | undefined): void {
  if (!answer) return;
  let changed = false;
  for (const [id, url] of Object.entries(answer)) {
    const next = typeof url === 'string' && url.length > 0 ? url : null;
    if (faces.get(id) !== next || !faces.has(id)) { faces.set(id, next); changed = true; }
  }
  if (!changed) return;
  version += 1;
  for (const l of listeners) l();
}

/** The face the server last answered for `userId`; null when withheld or never answered. */
export function readerFace(userId: string): string | null {
  return faces.get(userId) ?? null;
}

export function subscribeReaderFaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readerFacesVersion(): number {
  return version;
}

/** Tests only. */
export function _resetReaderFaces(): void {
  faces.clear();
  version += 1;
  for (const l of listeners) l();
}
