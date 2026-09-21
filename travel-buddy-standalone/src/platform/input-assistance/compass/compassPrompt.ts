/**
 * Global Input Intelligence — Phase 7 (Compass + AI): the compass-prompt
 * starters (spec §56, §14), as the SHARED LAYER serves them.
 *
 * census-compass CG-01 / census-input-intelligence G359: this module used to
 * carry its own curated starter list and its own builder, a second assistance
 * engine beside the server's (`lib/inputAssistance/projection.ts`). The list
 * now lives ONLY on the server (`COMPASS_STARTER_SET`), served through the ordinary gateway
 * (`POST /input-assistance/suggest`, context `compass_prompt`, zero-state at
 * 0 characters — the field's policy has `minChars: 0`), and this module is
 * the thin adapter from `InputSuggestion` rows to the chip shape
 * `CompassStarters` renders. Pure: no React, no network, no list of its own.
 */
import type { InputContext } from '../types/inputContext.ts';
import type { InputSuggestion } from '../types/inputSuggestion.ts';

/** A single tappable starter prompt (§56). `prompt` is the full text to seed. */
export interface CompassStarter {
  id: string;
  /** Short chip label. */
  label: string;
  /** The full, well-formed prompt the tap seeds into the field. */
  prompt: string;
}

/**
 * The server's `ai_suggestion` rows for the compass prompt, as starters.
 * Only rows that carry a replacement text become chips; anything else the
 * gateway served for the field (an entity, a completion) is not a starter and
 * is left to its own renderer. Order is the server's. A stable `id` comes
 * from the server's `starterId` where it named one.
 */
export function startersFromSuggestions(suggestions: readonly InputSuggestion[] | null | undefined): CompassStarter[] {
  const out: CompassStarter[] = [];
  const seen = new Set<string>();
  for (const s of suggestions ?? []) {
    if (s.type !== 'ai_suggestion') continue;
    const prompt = typeof s.replacementText === 'string' ? s.replacementText.trim() : '';
    if (prompt.length === 0) continue;
    const sv = (s.structuredValue ?? null) as { starterId?: unknown } | null;
    const id = typeof sv?.starterId === 'string' && sv.starterId.length > 0 ? sv.starterId : s.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : prompt, prompt });
  }
  return out;
}

/** True for the compass prompt context. */
export function isCompassPromptContext(context: InputContext): boolean {
  return context === 'compass_prompt';
}
