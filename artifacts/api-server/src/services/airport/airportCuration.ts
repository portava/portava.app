/**
 * airportCuration — the server-authoritative curation workflow for airport
 * facts (census-layover L14, L79, L80, L120, L143, L220, L223; owner decision
 * 2026-10-18 "Build the required airport-data curation and validation
 * workflow"). LAYOVER 165, lane B2-CURATE.
 *
 *   propose   any admin, or a packet import: a NEW VERSION of one fact, with its
 *             provenance (source kind, URL, retrieved_at) and TTL. Never trusted.
 *   validate  a HUMAN curator (an admin, named): every quality check in
 *             `airportCurationPolicy.validateCuratedFact` runs against the
 *             CURRENT published topology; only a passing report moves the fact,
 *             and the report is stored with it.
 *   publish   `airport_curation_publish()` (3874): supersedes the previous
 *             version, projects the fact onto airport_profiles, and — for a
 *             static fact — moves `topology_version`: an AUTHORITATIVE CHANGE,
 *             which every derivation reads (the certified record's maturity
 *             input carries the version, so the record's hash moves and
 *             every card cited under the old snapshot is stale).
 *   reject / retract   with a reason, stamped.
 *
 * History is kept: rows are versioned and immutable (3874's trigger), the
 * service_role cannot delete them, and the admin read returns every version.
 *
 * Nothing here fabricates a fact: a value enters only through a proposal that
 * names its source, and reaches a traveller only after a named human validated
 * it and it has not expired.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  CURATED_SOURCE_KINDS,
  curatedFactClassOf,
  defaultExpiryMs,
  isCuratedFactKind,
  terminalIdsOf,
  validateCuratedFact,
  type CuratedFactKind,
  type CuratedSource,
  type CuratedSourceKind,
  type ValidationReport,
} from "./airportCurationPolicy.js";

const logger = rootLogger.child({ service: "airportCuration" });

export const CURATED_FACTS_TABLE = "airport_curated_facts";

export interface CuratedFact {
  id: string;
  airportId: string;
  kind: CuratedFactKind;
  factClass: string;
  version: number;
  value: Record<string, unknown>;
  source: CuratedSource;
  expiresAt: string;
  state: "proposed" | "validated" | "published" | "rejected" | "superseded";
  proposedVia: "admin" | "packet_import";
  proposedBy: string | null;
  proposedAt: string;
  validationReport: ValidationReport | null;
  validatedBy: string | null;
  validatedAt: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  supersededAt: string | null;
  supersededByFactId: string | null;
  retractedBy: string | null;
  retractionReason: string | null;
}

const COLUMNS =
  "id,airport_id,fact_kind,fact_class,version,value,source_kind,source_url,source_title,source_note,retrieved_at,expires_at," +
  "state,proposed_via,proposed_by,proposed_at,validation_report,validated_by,validated_at,published_by,published_at," +
  "rejected_by,rejected_at,rejection_reason,superseded_at,superseded_by_fact_id,retracted_by,retraction_reason";

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function rowToFact(r: Record<string, any>): CuratedFact {
  return {
    id: String(r.id),
    airportId: String(r.airport_id),
    kind: r.fact_kind as CuratedFactKind,
    factClass: String(r.fact_class),
    version: Number(r.version),
    value: (r.value ?? {}) as Record<string, unknown>,
    source: {
      kind: r.source_kind as CuratedSourceKind,
      url: r.source_url ?? null,
      title: r.source_title ?? null,
      note: r.source_note ?? null,
      retrievedAt: iso(r.retrieved_at) ?? String(r.retrieved_at),
    },
    expiresAt: iso(r.expires_at) ?? String(r.expires_at),
    state: r.state,
    proposedVia: r.proposed_via,
    proposedBy: r.proposed_by ?? null,
    proposedAt: iso(r.proposed_at) ?? String(r.proposed_at),
    validationReport: (r.validation_report ?? null) as ValidationReport | null,
    validatedBy: r.validated_by ?? null,
    validatedAt: iso(r.validated_at),
    publishedBy: r.published_by ?? null,
    publishedAt: iso(r.published_at),
    rejectedBy: r.rejected_by ?? null,
    rejectedAt: iso(r.rejected_at),
    rejectionReason: r.rejection_reason ?? null,
    supersededAt: iso(r.superseded_at),
    supersededByFactId: r.superseded_by_fact_id ?? null,
    retractedBy: r.retracted_by ?? null,
    retractionReason: r.retraction_reason ?? null,
  };
}

export type CurationRefusal =
  | "invalid_kind" | "invalid_source" | "invalid_expiry" | "no_airport" | "no_fact" | "conflict"
  | "quality_failed" | "not_proposed" | "not_validated" | "expired" | "not_published" | "no_reason"
  | "storage_unavailable" | "read_failed" | "write_failed";

export type CurationResult<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: CurationRefusal; message: string; report?: ValidationReport };

const fail = (reason: CurationRefusal, message: string, report?: ValidationReport): { ok: false; reason: CurationRefusal; message: string; report?: ValidationReport } =>
  report ? { ok: false, reason, message, report } : { ok: false, reason, message };

function isMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  const code = err?.code ?? "";
  return code === "42P01" || code === "PGRST205" || code === "42883" || code === "PGRST202" || /does not exist|schema cache/i.test(err?.message ?? "");
}

// ── reads ────────────────────────────────────────────────────────────────────

/** Every version of every curated fact for one airport, newest version first per kind. */
export async function readCurationHistory(db: SupabaseClient, airportId: string): Promise<CurationResult<{ facts: CuratedFact[] }>> {
  const ready = await airportCurationSchemaReadiness(db); if (ready.state !== "ready") return fail(ready.state === "missing" ? "storage_unavailable" : "read_failed", "Airport curation schema readiness could not be confirmed; migrations 3874 through 3881 are required.");
  const { data, error } = await db.from("airport_curated_facts").select(COLUMNS).eq("airport_id", airportId)
    .order("fact_kind", { ascending: true }).order("version", { ascending: false });
  if (error) return fail(isMissing(error) ? "storage_unavailable" : "read_failed", String(error.message ?? "airport_curated_facts unreadable"));
  return { ok: true, facts: (data ?? []).map((r) => rowToFact(r as Record<string, any>)) };
}

export async function readCuratedFact(db: SupabaseClient, factId: string): Promise<CurationResult<{ fact: CuratedFact }>> {
  const ready = await airportCurationSchemaReadiness(db); if (ready.state !== "ready") return fail(ready.state === "missing" ? "storage_unavailable" : "read_failed", "Airport curation schema readiness could not be confirmed; migrations 3874 through 3881 are required.");
  const { data, error } = await db.from("airport_curated_facts").select(COLUMNS).eq("id", factId).maybeSingle();
  if (error) return fail(isMissing(error) ? "storage_unavailable" : "read_failed", String(error.message ?? "airport_curated_facts unreadable"));
  if (!data) return fail("no_fact", "No such curated fact");
  return { ok: true, fact: rowToFact(data as Record<string, any>) };
}

/**
 * The PUBLISHED, UNEXPIRED facts of the given kinds for one airport — what a
 * traveller-facing surface may read. An expired publication is ABSENT here
 * (fail closed), and an unreadable store is a refusal, never an empty airport.
 */
export async function readPublishedFacts(
  db: SupabaseClient,
  airportId: string,
  kinds: readonly CuratedFactKind[],
  nowMs: number,
): Promise<CurationResult<{ facts: Partial<Record<CuratedFactKind, CuratedFact>> }>> {
  if (kinds.length === 0) return { ok: true, facts: {} }; const ready = await airportCurationSchemaReadiness(db); if (ready.state !== "ready") return fail(ready.state === "missing" ? "storage_unavailable" : "read_failed", "Airport curation schema readiness could not be confirmed; migrations 3874 through 3881 are required.");
  const { data, error } = await db.from("airport_curated_facts").select(COLUMNS)
    .eq("airport_id", airportId).eq("state", "published").in("fact_kind", [...kinds])
    .gt("expires_at", new Date(nowMs).toISOString());
  if (error) return fail(isMissing(error) ? "storage_unavailable" : "read_failed", String(error.message ?? "airport_curated_facts unreadable"));
  const facts: Partial<Record<CuratedFactKind, CuratedFact>> = {};
  for (const r of data ?? []) {
    const f = rowToFact(r as Record<string, any>);
    if (isCuratedFactKind(f.kind)) facts[f.kind] = f;
  }
  return { ok: true, facts };
}

/** The terminal ids of the airport's published, unexpired topology, or null when none is published. */
async function publishedTerminals(db: SupabaseClient, airportId: string, nowMs: number): Promise<CurationResult<{ terminals: Set<string> | null }>> {
  const read = await readPublishedFacts(db, airportId, ["terminal_topology"], nowMs);
  if (!read.ok) return read;
  const topo = read.facts.terminal_topology;
  return { ok: true, terminals: topo ? terminalIdsOf(topo.value) : null };
}

// ── propose ──────────────────────────────────────────────────────────────────

export interface ProposeInput {
  airportId: string;
  kind: unknown;
  value: unknown;
  source: { kind?: unknown; url?: unknown; title?: unknown; note?: unknown; retrievedAt?: unknown };
  /** Optional; the class default from `retrievedAt` when absent. */
  expiresAt?: unknown;
  proposedVia: "admin" | "packet_import";
  proposedBy: string | null;
}

function sourceOf(s: ProposeInput["source"]): CuratedSource | null {
  if (!s || typeof s !== "object") return null;
  if (!(CURATED_SOURCE_KINDS as readonly unknown[]).includes(s.kind)) return null;
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, max) : null);
  const retrieved = iso(s.retrievedAt);
  if (!retrieved) return null;
  return { kind: s.kind as CuratedSourceKind, url: text(s.url, 2048), title: text(s.title, 300), note: text(s.note, 2000), retrievedAt: retrieved };
}

/**
 * Store a proposal. The quality checks run now as a PREVIEW (returned, not
 * stored): a proposal is allowed to be incomplete — a curator fixes it with a
 * new version — but the curator sees at once what would fail. Nothing about a
 * proposal reaches a traveller.
 */
export async function proposeCuratedFact(
  db: SupabaseClient,
  input: ProposeInput,
  nowMs: number,
): Promise<CurationResult<{ fact: CuratedFact; preview: ValidationReport }>> {
  if (!isCuratedFactKind(input.kind)) return fail("invalid_kind", "kind is not a curated fact kind");
  const kind = input.kind;
  const source = sourceOf(input.source);
  if (!source) return fail("invalid_source", "source needs a known kind and an ISO-8601 retrievedAt");
  const expiresMs = input.expiresAt === undefined || input.expiresAt === null
    ? defaultExpiryMs(kind, Date.parse(source.retrievedAt))
    : Date.parse(String(input.expiresAt));
  if (!Number.isFinite(expiresMs)) return fail("invalid_expiry", "expiresAt must be an ISO-8601 instant");
  if (typeof input.value !== "object" || input.value === null || Array.isArray(input.value)) {
    return fail("quality_failed", "value must be an object");
  }

  const ready = await airportCurationSchemaReadiness(db); if (ready.state !== "ready") return fail(ready.state === "missing" ? "storage_unavailable" : "read_failed", "Airport curation schema readiness could not be confirmed; migrations 3874 through 3881 are required."); const airport = await db.from("airport_profiles").select("id,lat,lng").eq("id", input.airportId).maybeSingle();
  if (airport.error) return fail("read_failed", String(airport.error.message ?? "airport_profiles unreadable"));
  if (!airport.data) return fail("no_airport", "No airport profile with that id");

  const terms = await publishedTerminals(db, input.airportId, nowMs);
  if (!terms.ok) return terms;
  const preview = validateCuratedFact(kind, input.value, source, expiresMs, nowMs, { publishedTerminals: terms.terminals, airportPoint: topologyGeoPoint({ lat: airport.data.lat, lng: airport.data.lng }) });

  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await db.from("airport_curated_facts").select("version").eq("airport_id", input.airportId).eq("fact_kind", kind)
      .order("version", { ascending: false }).limit(1);
    if (latest.error) return fail(isMissing(latest.error) ? "storage_unavailable" : "read_failed", String(latest.error.message));
    const version = Number((latest.data?.[0] as { version?: number } | undefined)?.version ?? 0) + 1;
    const { data, error } = await db.from("airport_curated_facts").insert({
      airport_id: input.airportId,
      fact_kind: kind,
      fact_class: curatedFactClassOf(kind),
      version,
      value: input.value,
      source_kind: source.kind,
      source_url: source.url,
      source_title: source.title,
      source_note: source.note,
      retrieved_at: source.retrievedAt,
      expires_at: new Date(expiresMs).toISOString(),
      proposed_via: input.proposedVia,
      proposed_by: input.proposedBy,
    }).select(COLUMNS).maybeSingle();
    if (!error && data) return { ok: true, fact: rowToFact(data as Record<string, any>), preview };
    if (error?.code === "23505" && attempt === 0) continue; // another proposal took the version: re-read and retry once
    if (error?.code === "23514") return fail("quality_failed", `the database refused the proposal: ${error.message}`, preview);
    logger.warn({ err: error?.message, airportId: input.airportId, kind }, "curated fact proposal not stored");
    return fail(isMissing(error) ? "storage_unavailable" : error?.code === "23505" ? "conflict" : "write_failed", String(error?.message ?? "not stored"));
  }
  return fail("conflict", "another proposal took this version twice; try again");
}

// ── validate / reject ────────────────────────────────────────────────────────

/**
 * A human curator validates a proposal. Every quality check runs AGAIN, now,
 * against the topology published NOW: a proposal that passed its preview last
 * week may reference a terminal a later topology removed. Only a passing
 * report moves the fact; a failing one is returned and nothing is written.
 */
export async function validateProposedFact(
  db: SupabaseClient,
  factId: string,
  curatorId: string,
  nowMs: number,
): Promise<CurationResult<{ fact: CuratedFact; report: ValidationReport }>> {
  const read = await readCuratedFact(db, factId);
  if (!read.ok) return read;
  const f = read.fact;
  if (f.state !== "proposed") return fail("not_proposed", `the fact is ${f.state}, not proposed`);
  const terms = await publishedTerminals(db, f.airportId, nowMs);
  if (!terms.ok) return terms;
  const geo = await topologyValidationOrigin(db, f); if (!geo.ok) return geo; const report = validateCuratedFact(f.kind, f.value, f.source, Date.parse(f.expiresAt), nowMs, { publishedTerminals: terms.terminals, airportPoint: geo.point });
  if (!report.ok) return fail("quality_failed", "the fact fails its quality checks", report);
  const { data, error } = await db.from("airport_curated_facts")
    .update({ state: "validated", validated_by: curatorId, validated_at: new Date(nowMs).toISOString(), validation_report: report })
    .eq("id", factId).eq("state", "proposed").select(COLUMNS).maybeSingle();
  if (error) return fail(error.code === "23514" ? "expired" : "write_failed", String(error.message ?? "not validated"), report);
  if (!data) return fail("conflict", "the fact changed state while it was being validated");
  return { ok: true, fact: rowToFact(data as Record<string, any>), report };
}

export async function rejectCuratedFact(
  db: SupabaseClient,
  factId: string,
  curatorId: string,
  reason: unknown,
  nowMs: number,
): Promise<CurationResult<{ fact: CuratedFact }>> {
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1000) return fail("no_reason", "a rejection needs a reason (1..1000 chars)");
  const { data, error } = await db.from("airport_curated_facts")
    .update({ state: "rejected", rejected_by: curatorId, rejected_at: new Date(nowMs).toISOString(), rejection_reason: reason.trim() })
    .eq("id", factId).in("state", ["proposed", "validated"]).select(COLUMNS).maybeSingle();
  if (error) return fail("write_failed", String(error.message ?? "not rejected"));
  if (!data) return fail("conflict", "only a proposed or validated fact can be rejected");
  return { ok: true, fact: rowToFact(data as Record<string, any>) };
}

// ── publish / retract (3874's functions: atomic, locked per airport) ─────────

export interface PublishOutcome {
  factId: string;
  airportId: string;
  kind: CuratedFactKind;
  version: number;
  supersededFactId: string | null;
  topologyVersion: number;
}

export async function publishValidatedFact(
  db: SupabaseClient,
  factId: string,
  publisherId: string,
): Promise<CurationResult<{ published: PublishOutcome }>> {
  const { data, error } = await db.rpc("airport_curation_publish", { p_fact_id: factId, p_actor: publisherId });
  if (error) return fail(isMissing(error) ? "storage_unavailable" : "write_failed", String(error.message ?? "not published"));
  const out = (data ?? {}) as Record<string, any>;
  switch (out.outcome) {
    case "published":
      return { ok: true, published: {
        factId: String(out.factId), airportId: String(out.airportId), kind: out.kind as CuratedFactKind, version: Number(out.version),
        supersededFactId: out.supersededFactId ?? null, topologyVersion: Number(out.topologyVersion),
      } };
    case "no_fact": return fail("no_fact", "No such curated fact");
    case "not_validated": return fail("not_validated", `only a validated fact can be published (it is ${out.state})`);
    case "expired": return fail("expired", "the fact has expired — re-read the source and propose a new version");
    default: return fail("write_failed", `unexpected publish outcome ${String(out.outcome)}`);
  }
}

export async function retractPublishedFact(
  db: SupabaseClient,
  factId: string,
  actorId: string,
  reason: unknown,
): Promise<CurationResult<{ retracted: { factId: string; airportId: string; kind: CuratedFactKind; topologyVersion: number } }>> {
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1000) return fail("no_reason", "a retraction needs a reason (1..1000 chars)");
  const { data, error } = await db.rpc("airport_curation_retract", { p_fact_id: factId, p_actor: actorId, p_reason: reason.trim() });
  if (error) return fail(isMissing(error) ? "storage_unavailable" : "write_failed", String(error.message ?? "not retracted"));
  const out = (data ?? {}) as Record<string, any>;
  if (out.outcome === "retracted") {
    return { ok: true, retracted: { factId: String(out.factId), airportId: String(out.airportId), kind: out.kind as CuratedFactKind, topologyVersion: Number(out.topologyVersion) } };
  }
  if (out.outcome === "no_fact") return fail("no_fact", "No such curated fact");
  if (out.outcome === "not_published") return fail("not_published", `only a published fact can be retracted (it is ${out.state})`);
  return fail("write_failed", `unexpected retract outcome ${String(out.outcome)}`);
}

// ── packet import (docs/ops/airport-curation/<IATA>.json) ────────────────────

export interface CurationPacket {
  packetVersion: 1;
  iata: string;
  facts: Array<{ kind: unknown; value: unknown; source: ProposeInput["source"]; evidence?: unknown; notes?: unknown }>;
}

export function isCurationPacket(v: unknown): v is CurationPacket {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return p.packetVersion === 1 && typeof p.iata === "string" && /^[A-Z]{3}$/.test(p.iata) && Array.isArray(p.facts);
}

/**
 * Load a curation packet as PROPOSALS — never validated, never published.
 * Each fact keeps its source URL and retrievedAt; the packet's evidence and
 * notes become the source note. The airport must already have a profile row.
 */
export async function importCurationPacket(
  db: SupabaseClient,
  packet: CurationPacket,
  importerId: string,
  nowMs: number,
): Promise<CurationResult<{ airportId: string; results: Array<{ kind: string; ok: boolean; factId?: string; reason?: string; previewOk?: boolean }> }>> {
  const airport = await db.from("airport_profiles").select("id").ilike("iata_code", packet.iata).maybeSingle();
  if (airport.error) return fail("read_failed", String(airport.error.message ?? "airport_profiles unreadable"));
  if (!airport.data) return fail("no_airport", `No airport profile for ${packet.iata}`);
  const airportId = String((airport.data as { id: string }).id);
  const results: Array<{ kind: string; ok: boolean; factId?: string; reason?: string; previewOk?: boolean }> = [];
  for (const f of packet.facts) {
    const note = [typeof f.evidence === "string" ? `evidence: ${f.evidence}` : null, typeof f.notes === "string" ? `notes: ${f.notes}` : null,
      "imported from a machine-prepared packet; NOT validated"].filter(Boolean).join(" | ").slice(0, 2000);
    const r = await proposeCuratedFact(db, {
      airportId, kind: f.kind, value: f.value, source: { ...(f.source ?? {}), note }, proposedVia: "packet_import", proposedBy: importerId,
    }, nowMs);
    results.push(r.ok
      ? { kind: String(f.kind), ok: true, factId: r.fact.id, previewOk: r.preview.ok }
      : { kind: String(f.kind), ok: false, reason: r.reason });
  }
  return { ok: true, airportId, results };
}

// ── §21.1 "Overnight → overnight state / expanded options" (census L223) ─────

export interface OvernightOptionCard {
  recType: "rest" | "inside_airport";
  title: string;
  description: string;
  travelTimeMin: number;
  travelTimeSource: "inside_airport";
  activityTimeMin: number;
  insideAirport: true;
  locationLabel: string;
}

function hoursText(h: unknown): string | null {
  if (h === "24h") return "open 24 hours";
  if (h && typeof h === "object" && typeof (h as any).open === "string" && typeof (h as any).close === "string") {
    return `open ${(h as any).open}–${(h as any).close} local time`;
  }
  return null;
}

/**
 * The EXPANDED overnight options an overnight layover gets — only from the
 * airport's PUBLISHED, UNEXPIRED curated lodging and lounge facts, and only the
 * AIRSIDE ones (a landside hotel needs the traveller to leave, which the
 * certified gate decides elsewhere). No curated data → no expanded option: a
 * generic "find a hotel" card would be fabricated certainty, not an option.
 */
export function overnightOptionCards(
  facts: Partial<Record<CuratedFactKind, CuratedFact>>,
): OvernightOptionCard[] {
  const cards: OvernightOptionCard[] = [];
  const lodging = facts.overnight_lodging?.value?.options;
  if (Array.isArray(lodging)) {
    for (const o of lodging as Array<Record<string, unknown>>) {
      if (o.side !== "airside" || typeof o.name !== "string") continue;
      const hours = hoursText(o.hours);
      cards.push({
        recType: "rest",
        title: o.name,
        description: `${o.kind === "transit_hotel" ? "Transit hotel" : o.kind === "sleep_pods" ? "Sleep pods" : o.kind === "airport_hotel" ? "Airport hotel" : "Rest area"} airside${hours ? `, ${hours}` : ""}. Checked against the airport's official information.`,
        travelTimeMin: 0, travelTimeSource: "inside_airport", activityTimeMin: 240, insideAirport: true,
        locationLabel: typeof o.terminalId === "string" ? `Terminal ${o.terminalId}` : "Inside airport",
      });
    }
  }
  const lounges = facts.lounge_hours?.value?.lounges;
  if (Array.isArray(lounges)) {
    for (const l of lounges as Array<Record<string, unknown>>) {
      if (l.side !== "airside" || typeof l.name !== "string") continue;
      const hours = hoursText(l.hours);
      cards.push({
        recType: "inside_airport",
        title: l.name,
        description: `Airside lounge${hours ? `, ${hours}` : ""}${typeof l.access === "string" ? ` — ${l.access}` : ""}.`,
        travelTimeMin: 0, travelTimeSource: "inside_airport", activityTimeMin: 120, insideAirport: true,
        locationLabel: typeof l.terminalId === "string" ? `Terminal ${l.terminalId}` : "Inside airport",
      });
    }
  }
  return cards;
}

/**
 * The overnight expansion for one session: empty unless the certified window
 * is OVERNIGHT and the airport has published, unexpired lodging or lounge
 * facts. A failed read is logged and yields nothing — the base airside cards
 * still stand — rather than inventing an option.
 */
export async function curatedOvernightCandidates(
  db: SupabaseClient,
  airport: { id: string | null },
  overnight: boolean,
  nowMs: number,
): Promise<OvernightOptionCard[]> {
  if (!overnight || !airport.id) return [];
  try {
    const read = await readPublishedFacts(db, airport.id, ["overnight_lodging", "lounge_hours"], nowMs);
    if (!read.ok) {
      logger.warn({ airportId: airport.id, reason: read.reason }, "overnight options: curated facts unreadable — no expanded option is offered");
      return [];
    }
    return overnightOptionCards(read.facts);
  } catch (err) {
    logger.warn({ err, airportId: airport.id }, "overnight options: curated read threw — no expanded option is offered");
    return [];
  }
}

import { airportCurationSchemaReadiness } from "./airportCurationSchema.js";
import { topologyGeoPoint, topologyHasGeometry } from './airportTopologyGeometry.js';
async function topologyValidationOrigin(db: SupabaseClient, fact: CuratedFact): Promise<CurationResult<{ point: { lat: number; lng: number } | null }>> {
  if (fact.kind !== 'terminal_topology' || !topologyHasGeometry(fact.value)) return { ok: true, point: null };
  try {
    const { data, error } = await db.from('airport_profiles').select('lat,lng').eq('id', fact.airportId).maybeSingle();
    if (error) { logger.warn({ err: error, airportId: fact.airportId }, 'airport topology geometry origin unavailable'); return fail('read_failed', 'Airport coordinate could not be read for geometry validation'); }
    return { ok: true, point: topologyGeoPoint(data) };
  } catch (err) { logger.warn({ err, airportId: fact.airportId }, 'airport topology geometry origin read threw'); return fail('read_failed', 'Airport coordinate could not be read for geometry validation'); }
}
