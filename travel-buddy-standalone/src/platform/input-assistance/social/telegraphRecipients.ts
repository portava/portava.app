/**
 * Global Input Intelligence — Phase 4 (Social Identity): Telegraph recipient mapping.
 *
 * The recipient picker for STARTING a new Telegraph conversation is backed by
 * the `telegraph_recipient` InputContext (§5) through the P1 gateway
 * (`useInputAssistance`). This module maps the canonical `InputSuggestion`
 * projection (§8) into the compact recipient rows the picker screen renders —
 * mirroring `search/globalSearch.ts` (the Phase 3 gateway ⇄ row bridge), so the
 * screen never reconstructs identity from gateway internals.
 *
 * PRIVACY / ELIGIBILITY (§29, §47): the backend resolves viewer eligibility
 * FIRST — blocked relationships, privacy, and account-enumeration protection are
 * applied server-side before projection. This mapper therefore TRUSTS the
 * returned list: it does not re-fetch, re-rank by identity, or re-filter around
 * the backend. It only drops rows that carry no resolvable user id (a row the
 * picker could not act on — never rendered as a dead row).
 *
 * Pure module — no React, no network — unit-testable under node:test.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';

/** A recipient row the picker renders + can start a conversation from. */
export interface RecipientRow {
  /** Canonical user id — the argument to `openDirectThread`. */
  userId: string;
  /** Display name (falls back to the handle when the label is empty). */
  name: string;
  /** @handle without the leading `@`, when the projection carried one. */
  handle: string | null;
  avatarUrl: string | null;
  /** Secondary line — "@handle", "Trip Crew", "Recent", etc. (§28). */
  subtitle: string | null;
  /** "Why this is suggested" (§28), when the gateway provided a reason. */
  reason: string | null;
  /** Provenance, so the row can badge Recent / Trip Crew groupings (§9, §35). */
  source: InputSuggestion['source'];
}

/**
 * The user identity a recipient suggestion carries. Prefers the top-level
 * entity fields, falling back to an `open_entity` action's identity (the same
 * dual shape `globalSearch.entityIdentity` handles), and to `canonicalUri` as a
 * last resort. Only `user` entities are eligible recipients.
 */
function recipientUserId(s: InputSuggestion): string | null {
  if (s.entityType === 'user' && s.entityId) return s.entityId;

  const action = s.action;
  if (action && action.type === 'open_entity' && action.entityType === 'user' && action.entityId) {
    return action.entityId;
  }
  return null;
}

/** Extract a bare handle (no leading `@`) from a suggestion's subtitle/label. */
function extractHandle(s: InputSuggestion): string | null {
  const fromSubtitle = s.subtitle?.trim();
  if (fromSubtitle && fromSubtitle.startsWith('@')) return fromSubtitle.slice(1);
  const fromLabel = s.label?.trim();
  if (fromLabel && fromLabel.startsWith('@')) return fromLabel.slice(1);
  return null;
}

/** Read an optional string field off a projection's structuredValue bag. */
function structuredString(s: InputSuggestion, key: string): string | null {
  const bag = s.structuredValue;
  if (bag && typeof bag === 'object' && key in (bag as Record<string, unknown>)) {
    const v = (bag as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Project a single suggestion to a recipient row, or `null` when it has no
 * resolvable user id (dropped rather than rendered inert). Trusts the backend's
 * eligibility filtering — no re-filtering here.
 */
export function suggestionToRecipient(s: InputSuggestion): RecipientRow | null {
  const userId = recipientUserId(s);
  if (!userId) return null;

  const handle = extractHandle(s);
  const label = (s.label ?? '').trim();
  const name = label || (handle ? `@${handle}` : userId);

  return {
    userId,
    name,
    handle,
    avatarUrl: structuredString(s, 'avatarUrl'),
    subtitle: s.subtitle?.trim() || (handle ? `@${handle}` : null),
    reason: s.reason?.trim() || null,
    source: s.source,
  };
}

/**
 * Map a flat, already-ranked `InputSuggestion[]` (as returned by
 * `useInputAssistance` for the `telegraph_recipient` context) into recipient
 * rows the picker renders. Drops non-user / id-less rows, and de-duplicates by
 * userId keeping the first (highest-ranked) occurrence (§9 canonical-first).
 */
export function mapRecipientSuggestions(
  suggestions: InputSuggestion[] | null | undefined,
): RecipientRow[] {
  const seen = new Set<string>();
  const rows: RecipientRow[] = [];
  for (const s of suggestions ?? []) {
    const row = suggestionToRecipient(s);
    if (!row) continue;
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    rows.push(row);
  }
  return rows;
}
