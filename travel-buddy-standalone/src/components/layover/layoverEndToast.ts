/**
 * The ONE sentence the layover dashboard shows when a layover is closed.
 *
 * Closing carries two independent elections — the Passport stamp (census L19,
 * L162) and, since census-layover L275, a private Memory of the layover. Both
 * answers come from the server, and either can fail on its own. A toast slot
 * holds one sentence, so two separate `showToast` calls would let the second
 * silently overwrite a failure the traveller needed to hear about. This decides
 * the sentence once, from both answers, and a failure always outranks a
 * success.
 */
import type { LayoverMemoryResult } from '../../services/layover.ts';

export function endLayoverToast(stampRefused: boolean, memory: LayoverMemoryResult | null): string | null {
  const memoryFailed = memory !== null && !memory.ok;
  if (stampRefused && memoryFailed) return 'Layover ended — neither the Passport stamp nor the Memory could be saved';
  if (stampRefused) return 'Layover ended — the Passport stamp could not be saved';
  if (memory && !memory.ok) return `Layover ended — the Memory could not be saved. ${memory.message}`;
  if (memory && memory.ok) return 'Layover ended — kept as a private Memory';
  return null;
}
