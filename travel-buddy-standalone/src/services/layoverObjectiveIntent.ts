import { z } from 'zod';
import { freshToken } from './apiToken.ts';
const schema = z.object({
  socialPreference: z.enum(['quiet', 'social', 'either']).nullable(), availableEnergy: z.enum(['low', 'medium', 'high']).nullable(),
  budget: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amountMinor: z.number().int().min(0).max(100_000_000) }).strict().nullable(),
  meaningfulPlaces: z.array(z.object({ placeId: z.string().uuid(), importance: z.enum(['some', 'high']) }).strict()).max(100),
}).strict();
export type ObjectiveIntent = z.infer<typeof schema>;
export const emptyObjectiveIntent = (): ObjectiveIntent => ({ socialPreference: null, availableEnergy: null, budget: null, meaningfulPlaces: [] });
export async function objectiveIntentRequest(sessionId: string, intent?: ObjectiveIntent): Promise<{ ok: true; intent: ObjectiveIntent } | { ok: false; reason: string }> {
  try {
    const token = await freshToken();
    const res = await fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL ?? ''}/api/airport/sessions/${encodeURIComponent(sessionId)}/objective-intent`, { method: intent ? 'PUT' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(intent ? { body: JSON.stringify(intent) } : {}) });
    const body = await res.json();
    if (!res.ok || body?.ok !== true) return { ok: false, reason: body?.reason ?? body?.error ?? 'unavailable' };
    const parsed = schema.safeParse(body.intent); return parsed.success ? { ok: true, intent: parsed.data } : { ok: false, reason: 'intent_unreadable' };
  } catch { return { ok: false, reason: 'unavailable' }; }
}
export function budgetAmount(currency: string, text: string): { currency: string; amountMinor: number } | null {
  if (!/^[A-Z]{3}$/.test(currency) || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    if (digits === undefined) return null;
    if ((text.split('.')[1]?.length ?? 0) > digits) return null;
    const amountMinor = Math.round(Number(text) * 10 ** digits);
    return Number.isSafeInteger(amountMinor) && amountMinor >= 0 && amountMinor <= 100_000_000 ? { currency, amountMinor } : null;
  } catch { return null; }
}
export function displayBudget(budget: NonNullable<ObjectiveIntent['budget']>): string {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: budget.currency }).resolvedOptions().maximumFractionDigits;
  if (digits === undefined) return '';
  return (budget.amountMinor / 10 ** digits).toFixed(digits);
}
