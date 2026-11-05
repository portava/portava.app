import { fetchOwnedApi } from '../../../services/ownedApiRequest.ts';
import type { MessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import type { CarryForwardSelection } from '../../../services/messaging.ts';

export interface CarryForwardCandidate extends CarryForwardSelection { title: string }
export interface CarryForwardCursor { createdAt: string; sequence?: number }
export interface CarryForwardPage { items: CarryForwardCandidate[]; next: CarryForwardCursor | null }
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
const key = (kind: string, id: string) => `${kind}:${id}`;

/** Only references from readable messages; never a transcript or copied title. */
function reference(value: unknown) {
  const message = record(value);
  if (!message || message.deleted || typeof message.id !== 'string') return null;
  const card = record(message.card);
  let source: RecordValue | null = null;
  if (card) {
    if (card.state !== 'live') return null;
    source = card;
  } else if (message.msgType === 'portava_object' && typeof message.body === 'string') {
    try {
      const body = record(JSON.parse(message.body));
      if (body?.kind === 'PORTAVA_OBJECT' && body.shareProjectionVersion === '1') source = body;
    } catch { return null; }
  }
  if (!source || (source.objectType !== 'PLAN' && source.objectType !== 'PLACE')
    || typeof source.objectId !== 'string' || !source.objectId || source.objectId.length > 200) return null;
  return { objectType: source.objectType, objectId: source.objectId, messageId: message.id };
}

/** Bounded page reads, then fresh source projections. Formation rechecks every recipient. */
export async function fetchCarryForwardPage(threadId: string, owner: MessagingOwnerRequest, signal: AbortSignal, before?: CarryForwardCursor | null): Promise<CarryForwardPage> {
  const path = `/api/threads/${encodeURIComponent(threadId)}`;
  const params = new URLSearchParams({ withSequence: '1', limit: '50' });
  if (before) {
    params.set('before', before.createdAt);
    if (before.sequence !== undefined) params.set('beforeSequence', String(before.sequence));
  }
  const response = await fetchOwnedApi(`${path}/messages?${params}`, { owner, signal });
  if (!response.ok) throw new Error('Plans and places could not be loaded. Try again.');
  const page = record(await response.json());
  if (!page || page.threadId !== threadId || !Array.isArray(page.messages)) throw new Error('Conversation content is unavailable. Try again.');
  const messages = page.messages.slice(0, 50);
  const refs = messages.flatMap(message => { const ref = reference(message); return ref ? [ref] : []; });
  const items: CarryForwardCandidate[] = [];
  if (refs.length) {
    const resolved = await fetchOwnedApi(`${path}/share-projections`, { owner, signal, method: 'POST', body: { refs } });
    if (!resolved.ok) throw new Error('The current sharing rules could not be checked. Try again.');
    const body = record(await resolved.json());
    if (body?.threadId !== threadId || !Array.isArray(body.projections)) throw new Error('Current plans and places are unavailable. Try again.');
    const requested = new Set(refs.map(ref => key(ref.objectType, ref.objectId)));
    const seen = new Set<string>();
    for (const value of body.projections) {
      const result = record(value);
      if (result?.available === false && result.reason === 'unknown') throw new Error('The current sharing rules could not be checked. Try again.');
      if (!result || result.available !== true || (result.objectType !== 'PLAN' && result.objectType !== 'PLACE') || typeof result.objectId !== 'string') continue;
      const id = key(result.objectType, result.objectId);
      const projection = record(result.projection);
      if (!requested.has(id) || seen.has(id) || typeof projection?.title !== 'string') continue;
      seen.add(id);
      items.push({ kind: result.objectType, objectId: result.objectId, title: projection.title.slice(0, 200) });
    }
  }
  // The API renders messages in chronological order. Derive the oldest cursor
  // explicitly so a renderer order change cannot make pagination loop forever.
  const rows = messages.map(record).filter((row): row is RecordValue => !!row && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt)));
  rows.sort((a, b) => Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt)));
  const oldest = rows[0];
  const sequences = rows.map(row => row.sequence).filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
  const sequence = sequences.length === rows.length && rows.length ? Math.min(...sequences) : undefined;
  const next = oldest && (before?.sequence !== undefined && sequence !== undefined ? sequence < before.sequence : !before || String(oldest.createdAt) < before.createdAt)
    ? { createdAt: String(oldest.createdAt), ...(sequence === undefined ? {} : { sequence }) } : null;
  if (!owner.isCurrent() || signal.aborted) throw new Error('This conversation changed. Reopen it to continue.');
  return { items, next };
}
