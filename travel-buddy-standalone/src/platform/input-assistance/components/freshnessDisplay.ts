/**
 * freshnessDisplay — pure projection of a server-provided `FreshnessState` into
 * the strings the entity-row freshness chip renders (spec §31 Live Intelligence,
 * §8 Freshness, §28 entity-preview freshness badge).
 *
 * THE ONE HARD RULE (§2/§31 anti-fabrication). The client is a PURE RENDERER of
 * server-provided freshness. Every string returned here is copied VERBATIM from
 * the server's `FreshnessState` (`label` and `updatedAtLabel`). This function
 * NEVER manufactures a live label — there is no branch that turns `state` (or
 * anything else) into a "busy now" / "Live" / "Recently confirmed" string the
 * server did not send. When the server attached no freshness (the common,
 * pre-launch case), or the state is not currently live, nothing is shown.
 *
 * §31 degradation:
 *   - no freshness / `unavailable`  ⇒ show NOTHING (remove the live label);
 *   - `stale`                       ⇒ drop the state label, show ONLY the
 *                                     last-updated age if the server sent one;
 *   - `fresh` / `recently_confirmed`⇒ show the server label and/or age, joined
 *                                     "Getting busier · Updated 4m ago" (§31).
 *
 * MUTATION-PROOF: make any branch emit a label the server did not provide (e.g.
 * default `text` to 'Busy now' / 'Live' when `label`/`updatedAtLabel` are
 * absent) and the "no fabricated freshness" assertions in the test go RED.
 */
import type { FreshnessState } from '../types/inputContext.ts';

export interface FreshnessDisplay {
  /** The server's current-state/trend label ("Getting busier"), or null. Never synthesized. */
  label: string | null;
  /** The server's pre-formatted "Updated 4m ago" age, or null. Never synthesized. */
  age: string | null;
  /**
   * Single-line chip text ("Getting busier · Updated 4m ago"), or null when there
   * is nothing server-provided to show (⇒ render NO badge).
   */
  text: string | null;
}

const EMPTY: FreshnessDisplay = { label: null, age: null, text: null };

/** A non-empty server string, or null. Guards against `""`/non-string payloads. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

export function freshnessDisplay(f: FreshnessState | null | undefined): FreshnessDisplay {
  // No projection attached, or the server said live state is not available at all
  // ⇒ the suggestion carries no live label (§31 "remove the live label"). Common case.
  if (!f || f.state === 'unavailable') return EMPTY;

  const age = str(f.updatedAtLabel);

  // Stale: the live claim is no longer current. Drop the state label entirely and
  // show at most the last-updated age (§31) — never carry a "busy now" label forward.
  if (f.state === 'stale') {
    return { label: null, age, text: age };
  }

  // fresh / recently_confirmed: echo the server's label and age VERBATIM. No
  // fallback label — if the server sent none, none is shown.
  const label = str(f.label);
  const parts = [label, age].filter((p): p is string => p != null);
  return { label, age, text: parts.length > 0 ? parts.join(' · ') : null };
}
