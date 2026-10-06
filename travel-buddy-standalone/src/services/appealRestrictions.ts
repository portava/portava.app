/**
 * The person's own active Trust restrictions, as GET /api/appeals/me/restrictions
 * returns them (OD-TRUST-4: what is restricted, for how long, and how to appeal;
 * lead ruling D-24: `summary` is the sentence that names everything the
 * restriction stops — the server owns it, this module never rewrites it).
 *
 * Kept import-free so it runs under node:test.
 */

export interface MyRestriction {
  id: string;
  type: string;
  /** The server's sentence, shown verbatim. */
  summary: string;
  since: string | null;
  /** null = no end date: until it is reviewed or lifted. */
  until: string | null;
}

/** Thrown when the payload is not the shape the server promises. Never read as "no restrictions". */
export class RestrictionsPayloadError extends Error {
  readonly code = 'restrictions_payload_invalid' as const;
  constructor(detail: string) {
    super(`restrictions payload invalid: ${detail}`);
    this.name = 'RestrictionsPayloadError';
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/**
 * Validate and project the payload. A malformed body THROWS: an empty list is a
 * claim ("you have no restrictions") this client may only make from a payload
 * that says so.
 */
export function parseMyRestrictions(json: unknown): MyRestriction[] {
  const list = json !== null && typeof json === 'object' ? (json as { restrictions?: unknown }).restrictions : undefined;
  if (!Array.isArray(list)) {
    throw new RestrictionsPayloadError('no restrictions array');
  }
  return (list as unknown[]).map((r, i) => {
    const o = r as Record<string, unknown>;
    if (!o || !isStr(o.id) || !isStr(o.type) || !isStr(o.summary) || !isStrOrNull(o.since ?? null) || !isStrOrNull(o.until ?? null)) {
      throw new RestrictionsPayloadError(`entry ${i}`);
    }
    return { id: o.id, type: o.type, summary: o.summary, since: (o.since as string | null) ?? null, until: (o.until as string | null) ?? null };
  });
}

/** "Until 14 Oct 2026" or, with no end date, "Until it is reviewed". */
export function restrictionUntilLabel(until: string | null, locale?: string): string {
  if (until === null) return 'Until it is reviewed';
  const d = new Date(until);
  if (Number.isNaN(d.getTime())) return 'Until it is reviewed';
  return `Until ${d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
