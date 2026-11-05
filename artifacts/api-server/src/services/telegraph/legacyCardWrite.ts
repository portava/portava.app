import { normalizeSourceId, parseCardBody, sharedCardKindOf, SHARED_CARD_REGISTRY } from './sharedCardTruth.js';
import { encodeObjectReference } from './objectReference.js';

export function prepareLegacyCardWrite(row: { body: string | null; msg_type: string; subtype?: string | null }) {
  const kind = sharedCardKindOf(row);
  const parsed = kind ? parseCardBody(row.body) : null;
  if (!kind || !parsed) return { body: row.body, contentRef: null };
  const ref = SHARED_CARD_REGISTRY[kind].refOf(parsed, row);
  const id = ref ? normalizeSourceId(ref.objectId) : null;
  return { body: JSON.stringify({ ...parsed, cardSchemaVersion: 1 }),
    contentRef: ref && id ? encodeObjectReference({ objectType: ref.objectType, objectId: id }) : null };
}
