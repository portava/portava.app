/** L78: only explicit intent and fresh sourced facts may fill these five objective terms. */
import { z } from "zod";
import type { ObjectiveTerm, TermValue } from "./layoverObjective.js";
import type { RoutedCardContract } from "./LayoverRoutedFeasibility.js";
const minor = z.number().int().min(0).max(100_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/);
export const objectiveIntentSchema = z.object({
  socialPreference: z.enum(["quiet", "social", "either"]).nullable(),
  availableEnergy: z.enum(["low", "medium", "high"]).nullable(),
  budget: z.object({ currency, amountMinor: minor }).strict().nullable(),
  meaningfulPlaces: z.array(z.object({ placeId: z.string().uuid(), importance: z.enum(["some", "high"]) }).strict()).max(100),
}).strict().refine(v => new Set(v.meaningfulPlaces.map(p => p.placeId)).size === v.meaningfulPlaces.length, "place intents must be unique");
export type ObjectiveIntent = z.infer<typeof objectiveIntentSchema>;
export const emptyObjectiveIntent = (): ObjectiveIntent => ({ socialPreference: null, availableEnergy: null, budget: null, meaningfulPlaces: [] });
const source = z.object({
  sourceClass: z.enum(["venue_operator", "official_tourism", "curator_observed"]),
  sourceUrl: z.string().url().max(1000).refine(v => v.startsWith("https://")), sourceNote: z.string().trim().min(10).max(1000),
  observedAt: z.string().datetime(), expiresAt: z.string().datetime(), confirmedSource: z.literal(true),
}).strict();
const variants = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal('activity_commitment'), value: z.object({interruptibility:z.enum(['interruptible','committed']),minimumCommitmentMinutes:z.number().int().min(0).max(720),exitDelayMinutes:z.number().int().min(0).max(120)}).strict() }).strict(),
  z.object({ kind: z.literal("local_distinctiveness"), value: z.object({ extent: z.enum(["city_only", "regional", "widely_available"]) }).strict() }).strict(),
  z.object({ kind: z.literal("social_format"), value: z.object({ format: z.enum(["interactive", "independent", "mixed"]) }).strict() }).strict(),
  z.object({ kind: z.literal("exertion"), value: z.object({ level: z.enum(["light", "moderate", "strenuous"]) }).strict() }).strict(),
  z.object({ kind: z.literal("quoted_cost"), value: z.object({
    currency, venueMinor: minor.nullable(), roundTripTransportMinor: minor.nullable(), otherRequiredMinor: minor.nullable(),
    transportMode: z.enum(["none", "walk", "drive", "transit"]).nullable(), complete: z.boolean(),
  }).strict() }).strict(),
]);
export const objectiveFactInputSchema = z.object({ fact: variants, source }).strict().refine(v=>v.fact.kind!=='activity_commitment'||v.fact.value.interruptibility!=='committed'||v.fact.value.minimumCommitmentMinutes>0,'a committed activity must state its minimum commitment');
export type ObjectiveFactInput = z.infer<typeof objectiveFactInputSchema>;
export type ObjectiveFact = ObjectiveFactInput & { id: string; placeId: string; airportId: string };
export interface ObjectiveEvidence { intent: ObjectiveIntent; facts: ObjectiveFact[]; nowMs: number; state: "read" | "unreadable" }
type NewTerm = Extract<ObjectiveTerm, "local_uniqueness" | "social_value" | "memory_value" | "monetary_cost" | "energy_cost">;
const unknown = (reason: string): TermValue => ({ state: "UNKNOWN", reason });
const known = (value: number, provenance: string): TermValue => ({ state: "KNOWN", value: Math.max(-1, Math.min(1, value)), provenance });
function factFor(evidence: ObjectiveEvidence, kind: ObjectiveFact["fact"]["kind"]): ObjectiveFact | null {
  const fresh = evidence.facts.filter(f => f.fact.kind === kind && Date.parse(f.source.observedAt) <= evidence.nowMs && Date.parse(f.source.expiresAt) > evidence.nowMs);
  if (!fresh.length || new Set(fresh.map(f => JSON.stringify(f.fact.value))).size !== 1) return null;
  return fresh[0]!;
}
const provenance = (f: ObjectiveFact) => `sourced ${f.fact.kind}; fact=${f.id}; source=${f.source.sourceClass}; observed=${f.source.observedAt}; expires=${f.source.expiresAt}`;
/** Cost is comparable only for an explicitly complete quote in the traveller's budget currency and actual travel mode. */
export function statedObjectiveTerms(placeId: string | null | undefined, insideAirport: boolean, evidence: ObjectiveEvidence | undefined, routing?: RoutedCardContract | null): Record<NewTerm, TermValue> {
  const missing = evidence?.state === "unreadable" ? "objective source or own intent could not be read" : "no fresh, nonconflicting source plus explicit traveller intent";
  const result: Record<NewTerm, TermValue> = { local_uniqueness: unknown(missing), social_value: unknown(missing), memory_value: unknown(missing), monetary_cost: unknown(missing), energy_cost: unknown(missing) };
  if (!evidence || evidence.state !== "read" || !placeId) return result;
  evidence = { ...evidence, facts: evidence.facts.filter(f => f.placeId === placeId) };
  const unique = factFor(evidence, "local_distinctiveness");
  if (unique?.fact.kind === "local_distinctiveness") result.local_uniqueness = known({ city_only: 1, regional: 0, widely_available: -1 }[unique.fact.value.extent], provenance(unique));
  const social = factFor(evidence, "social_format"), preference = evidence.intent.socialPreference;
  if (social?.fact.kind === "social_format" && preference !== null) result.social_value = known(preference === "either" || social.fact.value.format === "mixed" ? 0 : (preference === "social") === (social.fact.value.format === "interactive") ? 1 : -1, `${provenance(social)}; own stated social preference=${preference}; no presence data`);
  const meaningful = evidence.intent.meaningfulPlaces.find(p => p.placeId === placeId);
  if (meaningful) result.memory_value = known(meaningful.importance === "high" ? 1 : .5, `own explicit personally meaningful place intent=${meaningful.importance}; prospective preference, not a past memory`);
  const exertion = factFor(evidence, "exertion"), energy = evidence.intent.availableEnergy;
  if (exertion?.fact.kind === "exertion" && energy !== null) {
    const effort = { light: .2, moderate: .6, strenuous: 1 }[exertion.fact.value.level], capacity = { low: .4, medium: .7, high: 1 }[energy];
    result.energy_cost = known(2 * Math.min(1, effort / capacity) - 1, `${provenance(exertion)}; own available energy=${energy}; categorical effort/capacity, no category-default minutes`);
  }
  const quote = factFor(evidence, "quoted_cost"), budget = evidence.intent.budget;
  if (quote?.fact.kind === "quoted_cost") {
    const cost = quote.fact.value;
    const routeMode = insideAirport ? "none" : routing?.state === "FEASIBLE" && routing.returnContract?.route.forecast ? routing.mode?.toLowerCase() : null;
    const returnMode = insideAirport ? "none" : routing?.returnContract?.route.mode.toLowerCase();
    if (cost.complete && cost.venueMinor !== null && cost.roundTripTransportMinor !== null && cost.otherRequiredMinor !== null && budget && cost.currency === budget.currency && cost.transportMode === routeMode && cost.transportMode === returnMode && (!insideAirport || cost.roundTripTransportMinor === 0)) {
      const total = cost.venueMinor + cost.roundTripTransportMinor + cost.otherRequiredMinor;
      result.monetary_cost = known(total === 0 ? -1 : budget.amountMinor === 0 ? 1 : 2 * Math.min(1, total / budget.amountMinor) - 1, `${provenance(quote)}; complete quoted out-of-pocket cost=${total} minor ${cost.currency}; own budget=${budget.amountMinor}; includes venue, round-trip transport and other required charges`);
    } else result.monetary_cost = unknown("complete current quote, matching actual travel mode and matching budget currency required; no currency conversion or missing-fare default");
  }
  return result;
}
