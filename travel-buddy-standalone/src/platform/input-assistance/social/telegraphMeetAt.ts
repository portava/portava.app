/**
 * Global Input Intelligence — §54 "meet at" in a Telegraph message, the pure
 * half (census G133, G362; flow GII-F10).
 *
 * The server decides the candidates and their eligibility
 * (`artifacts/api-server/src/lib/inputAssistance/telegraphActions.ts`). This
 * module decides only two things on the device:
 *
 *   1. WHAT LEAVES THE PHONE. `telegraph_message` is a private_message field.
 *      Only the trailing "meet at …" fragment is sent — never the rest of the
 *      message — and nothing is sent at all unless the draft ends in that
 *      phrase.
 *   2. WHAT A CANDIDATE IS. Rows are parsed defensively into a closed shape; a
 *      row this build cannot read is dropped rather than rendered half-known.
 *
 * Pure module — no React, no network, no RN. node:test-safe.
 */
import type { ClientCapabilities } from '../contexts/clientCapabilities.ts';
import { CLIENT_SCHEMA_VERSION } from '../contexts/clientCapabilities.ts';
import type { InputSuggestion } from '../types/inputSuggestion.ts';

export const TELEGRAPH_MESSAGE_FIELD_ID = 'telegraph.message';

/**
 * The composer renders ACTION rows and resolves exactly one action type:
 * `set_structured_value`, whose value is the §6.2 LOCATION draft it opens.
 * §54's "no aggressive text autocomplete" is this declaration: no completion
 * or entity rows are asked for.
 */
export const TELEGRAPH_COMPOSER_CAPABILITIES: ClientCapabilities = {
  schemaVersion: CLIENT_SCHEMA_VERSION,
  suggestionTypes: ['action'],
  // census G303: `share_entity` — "Share Event: …", sent through the §5
  // share route (POST /threads/:id/share) after the sender confirms.
  actionTypes: ['set_structured_value', 'share_entity'],
};

const MEET_AT_TAIL =
  /(?:^|[\s,;])((?:let'?s\s+|we\s+(?:can|could|should)\s+|shall\s+we\s+)?meet(?:\s+(?:me|us|up|you|them))?\s+(?:at|@|outside|by|near|in\s+front\s+of)(?:\s+[^\n.!?]*)?)$/i;

/** The trailing "meet at …" fragment to send, or null to send nothing. */
export function meetAtFragment(draft: string): string | null {
  const lastLine = (draft ?? '').split('\n').pop() ?? '';
  const m = lastLine.match(MEET_AT_TAIL);
  if (!m) return null;
  return m[1]!.replace(/\s+/g, ' ').trim().slice(0, 120);
}

export type MeetAtShare = 'meeting_point' | 'trip_stop' | 'current_place' | 'event';

/** A §5 Portava object a `share_entity` candidate shares (census G303). Events only, today. */
export interface MeetAtSharedObject {
  objectType: 'EVENT';
  objectId: string;
}

export interface TelegraphLocationDraft {
  label: string;
  placeId: string | null;
  precision: 'area' | 'venue' | 'exact';
}

export interface MeetAtCandidate {
  id: string;
  label: string;
  subtitle: string | null;
  share: MeetAtShare;
  eligible: boolean;
  ineligibleReason: string | null;
  requires: 'device_location' | null;
  draft: TelegraphLocationDraft | null;
  /** Set only on a `share_entity` candidate: what the confirmed tap shares. */
  object?: MeetAtSharedObject | null;
}

const SHARES: ReadonlySet<string> = new Set(['meeting_point', 'trip_stop', 'current_place']);
const PRECISIONS: ReadonlySet<string> = new Set(['area', 'venue', 'exact']);

function parseDraft(raw: unknown): TelegraphLocationDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.label !== 'string' || !d.label.trim()) return null;
  return {
    label: d.label.trim().slice(0, 200),
    placeId: typeof d.placeId === 'string' && d.placeId ? d.placeId.slice(0, 200) : null,
    precision: typeof d.precision === 'string' && PRECISIONS.has(d.precision) ? (d.precision as TelegraphLocationDraft['precision']) : 'area',
  };
}

/** The §54 candidates in a serve, in the server's order. */
export function parseMeetAtCandidates(rows: readonly InputSuggestion[]): MeetAtCandidate[] {
  const out: MeetAtCandidate[] = [];
  for (const r of rows) {
    if (r.type === 'action' && r.action?.type === 'share_entity') {
      // census G303: only an EVENT, only with an id — anything else this build cannot share.
      const a = r.action as { entityType?: unknown; entityId?: unknown };
      if (a.entityType !== 'event' || typeof a.entityId !== 'string' || !a.entityId || !r.label) continue;
      out.push({
        id: r.id, label: r.label, subtitle: r.subtitle ?? null, share: 'event', eligible: true,
        ineligibleReason: null, requires: null, draft: null, object: { objectType: 'EVENT', objectId: a.entityId.slice(0, 200) },
      });
      continue;
    }
    if (r.type !== 'action' || r.action?.type !== 'set_structured_value') continue;
    const v = r.structuredValue as Record<string, unknown> | null | undefined;
    if (!v || typeof v.telegraphShare !== 'string' || !SHARES.has(v.telegraphShare) || v.kind !== 'LOCATION') continue;
    out.push({
      id: r.id,
      label: r.label,
      subtitle: r.subtitle ?? null,
      share: v.telegraphShare as MeetAtShare,
      eligible: v.eligible === true,
      ineligibleReason: typeof v.ineligibleReason === 'string' ? v.ineligibleReason : null,
      requires: v.requires === 'device_location' ? 'device_location' : null,
      draft: parseDraft(v.draft),
    });
  }
  return out;
}
