/**
 * Global Input Intelligence — the RN wiring for the explicit-selection recorder
 * (Phase 8, spec §35). Supplies the real apiBase + refresh-first token + global
 * fetch to the pure `recordSelectionWith` core and exposes the two entry points
 * the SDK accept handler uses.
 *
 * This module imports the Supabase-backed token helper (apiToken.ts), so — like
 * inputAssistance.ts — it must NOT be imported by node:test files. The pure,
 * testable logic lives in selectBody.ts; this file is only the thin RN adapter.
 *
 * Both entry points are FIRE-AND-FORGET and FAIL-SOFT: they return synchronously
 * (or a boolean), never await, never throw, and swallow every error so a failed
 * record can never block or break the selection the user just made.
 */
import { freshToken as freshApiToken } from '../../../services/apiToken.ts';
import type { InputFieldPolicy } from '../types/fieldPolicy.ts';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import {
  recordSelectionWith,
  selectionFromSuggestion,
  type SelectRequest,
} from './selectBody.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  try {
    return await freshApiToken();
  } catch {
    return null;
  }
}

/**
 * Fire the explicit-select record for an already-derived payload. Non-blocking:
 * kicks off the request and returns immediately; any failure is swallowed.
 */
export function recordExplicitSelection(req: SelectRequest): void {
  try {
    void recordSelectionWith({ apiBase, getToken: freshToken, fetchImpl: fetch }, req).catch(() => {
      /* fail-soft — never surfaces */
    });
  } catch {
    /* fail-soft — a synchronous throw must never reach the accept path */
  }
}

/**
 * The one call the SDK accept handler makes: derive the select payload from an
 * EXPLICITLY ACCEPTED suggestion and fire it. Returns whether a record was fired
 * (false when the accept is not a recordable real-entity selection, e.g. an
 * action row or a personalization-disabled context) — purely informational; the
 * caller must not gate the selection on it.
 */
export function recordSuggestionSelection(
  suggestion: InputSuggestion,
  opts: { policy: InputFieldPolicy | null | undefined; query?: string | null },
): boolean {
  const req = selectionFromSuggestion(suggestion, opts);
  if (!req) return false;
  recordExplicitSelection(req);
  return true;
}
