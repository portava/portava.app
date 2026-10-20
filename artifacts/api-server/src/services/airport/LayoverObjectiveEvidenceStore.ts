/** Authorized producers for L78. No provider calls, category inference, presence or private memory reads. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { logger } from "../../lib/logger.js";
import { objectiveFactInputSchema, objectiveIntentSchema, emptyObjectiveIntent, type ObjectiveFact, type ObjectiveEvidence, type ObjectiveIntent } from "./layoverObjectiveEvidence.js";
type Refusal = { ok: false; reason: string };
const uuid = z.string().uuid();
async function enabled(db: SupabaseClient) { return isFlagEnabled(db, "layover_objective_evidence_enabled"); }
async function owned(db: SupabaseClient, userId: string, sessionId: string) {
  const { data, error } = await db.from("layover_sessions").select("id,user_id,status,departure_time").eq("id", sessionId).eq("user_id", userId).maybeSingle();
  if (error) { logger.warn({ err: error, sessionId }, "Objective intent session unreadable"); return { ok: false as const, reason: "session_unreadable" }; }
  return data ? { ok: true as const, value: data } : { ok: false as const, reason: "not_found" };
}
export async function readObjectiveIntent(db: SupabaseClient, userId: string, sessionId: string): Promise<{ ok: true; intent: ObjectiveIntent } | Refusal> {
  if (!(await enabled(db))) return { ok: false, reason: "feature_disabled" };
  const session = await owned(db, userId, sessionId); if (!session.ok) return session;
  const { data, error } = await db.from("layover_objective_intents").select("intent").eq("session_id", sessionId).eq("user_id", userId).maybeSingle();
  if (error) { logger.warn({ err: error, sessionId }, "Objective intent unreadable"); return { ok: false, reason: "intent_unreadable" }; }
  if (!data) return { ok: true, intent: emptyObjectiveIntent() };
  const parsed = objectiveIntentSchema.safeParse(data.intent);
  return parsed.success ? { ok: true, intent: parsed.data } : { ok: false, reason: "intent_unreadable" };
}
export async function saveObjectiveIntent(db: SupabaseClient, userId: string, sessionId: string, value: unknown): Promise<{ ok: true; intent: ObjectiveIntent } | Refusal> {
  if (!(await enabled(db))) return { ok: false, reason: "feature_disabled" };
  const parsed = objectiveIntentSchema.safeParse(value); if (!parsed.success) return { ok: false, reason: "invalid_intent" };
  const session = await owned(db, userId, sessionId); if (!session.ok) return session;
  if (session.value.status !== "active" || Date.parse(session.value.departure_time) <= Date.now()) return { ok: false, reason: "session_not_active" };
  const ids = parsed.data.meaningfulPlaces.map(p => p.placeId);
  if (ids.length) {
    const { data, error } = await db.from("discovery_places").select("id").in("id", ids).eq("status", "active");
    if (error) { logger.warn({ err: error, sessionId }, "Meaningful place validation unreadable"); return { ok: false, reason: "place_unreadable" }; }
    if (!data || new Set(data.map(r => r.id)).size !== ids.length) return { ok: false, reason: "place_not_found" };
  }
  const { error } = await db.from("layover_objective_intents").upsert({ session_id: sessionId, user_id: userId, intent: parsed.data, updated_at: new Date().toISOString() }, { onConflict: "session_id" });
  if (error) { logger.warn({ err: error, sessionId }, "Objective intent write failed"); return { ok: false, reason: "intent_write_unavailable" }; }
  return { ok: true, intent: parsed.data };
}
function factFromRow(raw: unknown): ObjectiveFact | null {
  const row = z.object({ id: uuid, airport_id: uuid, place_id: uuid, kind: z.string(), value: z.unknown(), source_class: z.string(), source_url: z.string(), source_note: z.string(), observed_at: z.string(), expires_at: z.string() }).safeParse(raw);
  if (!row.success) return null;
  const r = row.data;
  if (!Number.isFinite(Date.parse(r.observed_at)) || !Number.isFinite(Date.parse(r.expires_at))) return null;
  const parsed = objectiveFactInputSchema.safeParse({ fact: { kind: r.kind, value: r.value }, source: { sourceClass: r.source_class, sourceUrl: r.source_url, sourceNote: r.source_note, observedAt: new Date(r.observed_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(), confirmedSource: true } });
  return parsed.success ? { ...parsed.data, id: r.id, placeId: r.place_id, airportId: r.airport_id } : null;
}
export async function publishObjectiveFact(db: SupabaseClient, curatorId: string, airportId: string, placeId: string, value: unknown): Promise<{ ok: true; fact: ObjectiveFact } | Refusal> {
  if (!(await enabled(db))) return { ok: false, reason: "feature_disabled" };
  const parsed = objectiveFactInputSchema.safeParse(value);
  if (!parsed.success || !uuid.safeParse(airportId).success || !uuid.safeParse(placeId).success) return { ok: false, reason: "invalid_evidence" };
  if(parsed.data.fact.kind==='activity_commitment' && !await isFlagEnabled(db,'layover_activity_commitment_enabled')) return {ok:false,reason:'activity_commitment_disabled'};
  const source = parsed.data.source, now = Date.now(), observed = Date.parse(source.observedAt), expiry = Date.parse(source.expiresAt);
  if (observed > now || expiry <= now || expiry <= observed || expiry - observed > 90 * 86_400_000) return { ok: false, reason: "invalid_freshness" };
  const [airport, place] = await Promise.all([db.from("airport_profiles").select("id").eq("id", airportId).maybeSingle(), db.from("discovery_places").select("id").eq("id", placeId).eq("status", "active").maybeSingle()]);
  if (airport.error || place.error) { logger.warn({ err: airport.error ?? place.error, airportId, placeId }, "Objective subject unreadable"); return { ok: false, reason: "subject_unreadable" }; }
  if (!airport.data || !place.data) return { ok: false, reason: "subject_not_found" };
  const { data, error } = await db.from("layover_objective_facts").insert({ airport_id: airportId, place_id: placeId, kind: parsed.data.fact.kind, value: parsed.data.fact.value, source_class: source.sourceClass, source_url: source.sourceUrl, source_note: source.sourceNote, observed_at: source.observedAt, expires_at: source.expiresAt, stated_by: curatorId }).select("*").single();
  if (error) { logger.warn({ err: error, airportId, placeId }, "Objective evidence publish failed"); return { ok: false, reason: "evidence_write_unavailable" }; }
  const fact = factFromRow(data);
  return fact ? { ok: true, fact } : { ok: false, reason: "evidence_result_unreadable" };
}
export async function retractObjectiveFact(db: SupabaseClient, id: string): Promise<{ ok: true } | Refusal> {
  if (!(await enabled(db))) return { ok: false, reason: "feature_disabled" };
  if (!uuid.safeParse(id).success) return { ok: false, reason: "invalid_evidence" };
  const { data, error } = await db.from("layover_objective_facts").update({ retracted_at: new Date().toISOString() }).eq("id", id).is("retracted_at", null).select("id").maybeSingle();
  if (error) { logger.warn({ err: error, factId: id }, "Objective fact retraction failed"); return { ok: false, reason: "evidence_write_unavailable" }; }
  return data ? { ok: true } : { ok: false, reason: "fact_not_found" };
}
export async function loadObjectiveEvidence<T extends { placeId?: string | null }>(db: SupabaseClient, session: { id: string; userId: string }, airportId: string | null, cards: readonly T[], keyOf: (card: T) => string, nowMs: number): Promise<ReadonlyMap<string, ObjectiveEvidence>> {
  const result = new Map<string, ObjectiveEvidence>();
  try {
  if (!(await enabled(db)) || !airportId) return result;
  const ids = [...new Set(cards.flatMap(c => c.placeId && uuid.safeParse(c.placeId).success ? [c.placeId] : []))];
  if (!ids.length) return result;
  const [intent, rows] = await Promise.all([
    readObjectiveIntent(db, session.userId, session.id),
    db.from("layover_objective_facts").select("*").eq("airport_id", airportId).in("place_id", ids).is("retracted_at", null).gt("expires_at", new Date(nowMs).toISOString()).lte("observed_at", new Date(nowMs).toISOString()).limit(501),
  ]);
  const facts = rows.error ? [] : (rows.data ?? []).map(factFromRow);
  const unreadable = !intent.ok || !!rows.error || facts.length > 500 || facts.some(f => f === null);
  if (rows.error) logger.warn({ err: rows.error, sessionId: session.id }, "Objective place evidence unreadable");
  for (const card of cards) result.set(keyOf(card), { intent: intent.ok ? intent.intent : emptyObjectiveIntent(), facts: unreadable ? [] : facts.filter((f): f is ObjectiveFact => f !== null && f.placeId === card.placeId), nowMs, state: unreadable ? "unreadable" : "read" });
  return result;
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "Objective evidence read failed");
    return new Map(cards.map(card => [keyOf(card), { intent: emptyObjectiveIntent(), facts: [], nowMs, state: "unreadable" as const }]));
  }
}
