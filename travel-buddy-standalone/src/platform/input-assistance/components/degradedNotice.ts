/**
 * §32 / §27 / §38 — the DEGRADED state of the suggestion surface, decided in
 * one pure place (census G13, G350).
 *
 * ── THE DEFECT THIS EXISTS TO FIX ────────────────────────────────────────────
 *
 * G340 made `offlinePolicy` an enforced branch, and it is enforced correctly:
 * on an unreachable authority a field the registry marks `server_required` or
 * `unavailable` drops its retained rows rather than showing assistance nobody
 * can re-check (`hooks/useInputAssistance.ts#mayRetain` →
 * `contexts/policyFallback.ts#offlineSurfaceAllowed`). NOTHING HERE CHANGES
 * THAT, and nothing here puts a row back.
 *
 * What the user then saw was a panel with nothing in it. Worse, the sentence
 * under it — when the surface had one at all — was the container's `emptyState`
 * slot, which is §37's NO-MATCH state: the context-dependent fallback actions
 * ("Drop a pin", "Add a new Place"). So a field that was never asked, because
 * the authority is unreachable, reported that the search found nothing, and
 * offered to create a record instead. §37's own heading is "Empty AND No-Match
 * States" — two states — and §27 requires every surface to support "loading
 * states, error states, empty states" as three separate things. The panel had
 * one shape for all three.
 *
 * ── THREE FACTS, THREE SENTENCES ─────────────────────────────────────────────
 *
 *   LOADING     — "we are asking"        (the overlay's spinner; not this file)
 *   NO MATCH    — "we asked, nothing matched"    (the overlay's empty state)
 *   DEGRADED    — "we could not ask"             (this file)
 *
 * The third is the one that did not exist, and it splits in two, because the
 * reasons are genuinely different and only one of them is about the network:
 *
 *   `unassisted` — the AUTHORITY declined this field an offline surface
 *                  (`server_required` / `unavailable`). There is nothing to
 *                  show and there would be nothing to show on a device with a
 *                  full cache. The sentence says so, and says the field still
 *                  works by hand.
 *   `empty`      — the authority DOES license an offline surface for this
 *                  field, and this device has nothing to put on it (cold
 *                  start, nothing accepted, no dictionary match).
 *   `rows`       — the licensed surface produced rows. They render; this is the
 *                  line ABOVE them, and its whole job is G13's other half:
 *                  saying they are device-local and were not checked just now.
 *
 * ── WHAT THIS FILE MAY NOT DO ────────────────────────────────────────────────
 *
 *   - it never produces, restores or unhides a suggestion. It returns strings.
 *     The `server_required` path reaches `kind: 'unassisted'`, whose copy names
 *     no row and whose renderer draws no row;
 *   - it never says or implies that what is on screen is current (§31/G13). The
 *     `rows` copy states the opposite in as many words;
 *   - it never promises a retry, a refresh or a background fetch. There is no
 *     retry schedule in this layer (§30.7), so "we'll try again" would be a
 *     false statement about the system.
 *
 * Pure module — no React, no RN, no network — so the copy and the branch are
 * provable without rendering, and the renderer holds no policy.
 */

/** Which degraded sentence the surface is in. */
export type DegradedNoticeKind = 'unassisted' | 'empty' | 'rows';

export interface DegradedNotice {
  kind: DegradedNoticeKind;
  /** Short heading. */
  title: string;
  /** One explanatory sentence. Never a promise, never a row. */
  detail: string;
  /**
   * What a screen reader hears in the overlay's polite live region. Distinct
   * from the no-match and loading announcements by construction — §46 asks for
   * the state to be announced, and "nothing" is not an announcement.
   */
  a11y: string;
}

export interface DegradedNoticeParams {
  /** The hook's `unavailable`: the authority could not be reached. */
  unavailable: boolean;
  /**
   * Whether the field's `offlinePolicy` licenses ANY offline surface —
   * `contexts/policyFallback.ts#offlineSurfaceAllowed` applied to the resolved
   * policy. Fail-closed: an absent policy is `false`, which is the same answer
   * `offlineSurfaceAllowed(null)` gives.
   */
  offlineSurface: boolean;
  /** How many rows the surface is about to render. */
  rowCount: number;
}

const UNASSISTED: Omit<DegradedNotice, 'kind'> = {
  title: 'Suggestions need a connection',
  // Two claims, both true of this branch: nothing is being suggested, and the
  // field is still usable. It does NOT say "try again" — see the header.
  detail: 'This field is only assisted online, so nothing is suggested right now. What you type is kept exactly as you type it.',
  a11y: 'Suggestions unavailable. This field is only assisted online.',
};

const EMPTY: Omit<DegradedNotice, 'kind'> = {
  title: "You're offline",
  detail: 'Nothing is saved on this device for this field yet, so there is nothing to suggest.',
  a11y: 'Suggestions unavailable. Offline, with nothing saved for this field.',
};

const ROWS: Omit<DegradedNotice, 'kind'> = {
  title: "You're offline",
  // G13's "must not present stale data as live", said in the surface rather
  // than only in the row's `source` field.
  detail: 'Showing what is saved on this device. Nothing here has been checked just now.',
  a11y: 'Offline. Showing saved suggestions, not checked just now.',
};

/**
 * The degraded sentence for this surface, or `null` when the surface is not
 * degraded (and the loading / no-match states own it instead).
 *
 * ORDER IS LOAD-BEARING. `rowCount > 0` is tested FIRST, ahead of the licence,
 * so the notice can never contradict the screen: if rows are visible the copy
 * is about those rows, whatever a miswired caller declared. The licence still
 * decides whether rows exist — that gate is in the hook and in
 * `services/localDictionary.ts`, and it is re-applied in both places rather
 * than trusted from here.
 */
export function degradedNotice(params: DegradedNoticeParams): DegradedNotice | null {
  if (!params.unavailable) return null;
  if (params.rowCount > 0) return { kind: 'rows', ...ROWS };
  if (params.offlineSurface) return { kind: 'empty', ...EMPTY };
  return { kind: 'unassisted', ...UNASSISTED };
}
