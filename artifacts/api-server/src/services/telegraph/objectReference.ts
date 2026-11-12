import { isTelegraphObjectType, type TelegraphObjectType } from './vocabulary.js';
/** Versioned pointer to the canonical source, not a cached source projection. */
export function encodeObjectReference(ref: { objectType: TelegraphObjectType; objectId: string }): string {
  return `portava-object.v1:${ref.objectType}:${encodeURIComponent(ref.objectId)}`;
}
export function decodeObjectReference(value: unknown): { objectType: TelegraphObjectType; objectId: string } | null {
  if (typeof value !== 'string' || value.length > 800) return null;
  // The 3936 database trigger derives this spelling from the stored body.
  const original = /^portava:([A-Z][A-Z_]{0,31}):([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(value);
  if (original && isTelegraphObjectType(original[1])) {
    return { objectType: original[1], objectId: original[2] };
  }
  const match = /^portava-object\.v1:([A-Z_]+):(.+)$/.exec(value);
  if (!match || !isTelegraphObjectType(match[1])) return null;
  try {
    const objectId = decodeURIComponent(match[2]);
    if (!objectId || objectId.length > 200 || /[\u0000-\u001f\u007f]/.test(objectId)) return null;
    return { objectType: match[1], objectId };
  } catch { return null; }
}
