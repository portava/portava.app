/**
 * airportCurationPolicy — what a curated airport fact IS, how long it lives,
 * and the quality checks it must pass before a human curator may validate it.
 * Pure: no I/O, no clock (every function takes `nowMs`).
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §3    "Airport Intelligence — airport operational facts + provenance + TTL"
 *   §10   fact classes and typical freshness:
 *           Static topology        terminal, gate, checkpoint, walking link —
 *                                  "weeks/months; invalidate on authoritative change"
 *           Operational semi-live  security layout, lounge hours, transport
 *                                  schedules — "hours/days"
 *   §22   L1 Mapped: "Terminal/topology and known transport modeled"
 *   Owner decision 2026-10-18: build the curation and validation workflow —
 *   topology, terminal information, transport availability, entry
 *   restrictions, travel-time assumptions, provenance, timestamps, expiration
 *   rules, quality validation, recalibration. "Do not fabricate information to
 *   make airports appear curated."
 *
 * The storage is migration 3874 (`airport_curated_facts`); its CHECKs restate
 * the class TTL bounds below so the database refuses what this module would.
 */

/** §10's two classes a CURATOR supplies. The live classes come from feeds and travellers, never from curation. */
export const CURATED_FACT_CLASSES = ["STATIC_TOPOLOGY", "OPERATIONAL_SEMI_LIVE"] as const;
export type CuratedFactClass = (typeof CURATED_FACT_CLASSES)[number];

/** Every kind of curated fact, bound to exactly one class (3874's `airport_curated_facts_kind_class`). */
export const CURATED_FACT_KINDS = {
  terminal_topology: "STATIC_TOPOLOGY",
  ground_transport: "STATIC_TOPOLOGY",
  timing_assumptions: "STATIC_TOPOLOGY",
  entry_restrictions: "STATIC_TOPOLOGY",
  security_layout: "OPERATIONAL_SEMI_LIVE",
  lounge_hours: "OPERATIONAL_SEMI_LIVE",
  transport_schedules: "OPERATIONAL_SEMI_LIVE",
  overnight_lodging: "OPERATIONAL_SEMI_LIVE",
} as const satisfies Record<string, CuratedFactClass>;
export type CuratedFactKind = keyof typeof CURATED_FACT_KINDS;
export const CURATED_FACT_KIND_NAMES = Object.keys(CURATED_FACT_KINDS) as CuratedFactKind[];

export function isCuratedFactKind(v: unknown): v is CuratedFactKind {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(CURATED_FACT_KINDS, v);
}

export function curatedFactClassOf(kind: CuratedFactKind): CuratedFactClass {
  return CURATED_FACT_KINDS[kind];
}

/**
 * The TTL POLICY per class — §10's "weeks/months" and "hours/days", made
 * computable. The default is what a proposal gets when the curator states no
 * expiry; the maximum is what the database accepts (3874 `ttl_class_bound`).
 * Measured from `retrieved_at`: the freshness of a fact is the freshness of the
 * reading of its source, not of the moment someone clicked "validate".
 */
export const CURATED_TTL_MS: Record<CuratedFactClass, { default: number; max: number }> = {
  STATIC_TOPOLOGY: { default: 30 * 86_400_000, max: 180 * 86_400_000 },
  OPERATIONAL_SEMI_LIVE: { default: 72 * 3_600_000, max: 7 * 86_400_000 },
};

/** Who said so. `curator_*` sources carry no URL; every official one must. */
export const CURATED_SOURCE_KINDS = [
  "official_airport", "official_operator", "official_government", "curator_survey", "curator_judgment",
] as const;
export type CuratedSourceKind = (typeof CURATED_SOURCE_KINDS)[number];
const OFFICIAL_SOURCE_KINDS: ReadonlySet<string> = new Set(["official_airport", "official_operator", "official_government"]);

export interface CuratedSource {
  kind: CuratedSourceKind;
  url: string | null;
  title: string | null;
  note: string | null;
  /** When the source was read. ISO-8601. */
  retrievedAt: string;
}

/** One quality check's result. `ok: false` with a reason a curator can act on. */
export interface QualityIssue {
  path: string;
  problem: string;
}

/** The validation report 3874 stores. `ok` is what the database's transition guard reads. */
export interface ValidationReport {
  ok: boolean;
  policyVersion: string;
  kind: CuratedFactKind;
  checkedAt: string;
  issues: QualityIssue[];
  /** The checks that ran, by name, so a passing report says WHAT passed. */
  checks: string[];
}

/** Version of the checks below. A report produced under another version was decided by other rules. */
export const AIRPORT_CURATION_POLICY_VERSION = "2026.10.19-2";

// ── shape helpers ────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9 _.\-/]{0,39}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown, max = 120): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

class Checker {
  readonly issues: QualityIssue[] = [];
  readonly checks = new Set<string>();
  check(name: string, ok: boolean, path: string, problem: string): boolean {
    this.checks.add(name);
    if (!ok) this.issues.push({ path, problem });
    return ok;
  }
  /** Keys outside the schema are refused: an unknown field is data nobody validated. */
  onlyKeys(o: Obj, allowed: readonly string[], path: string): void {
    for (const k of Object.keys(o)) {
      this.check("no_unknown_fields", allowed.includes(k), `${path}.${k}`, "is not a field of this kind");
    }
  }
  hours(v: unknown, path: string): void {
    if (v === "24h") { this.checks.add("hours_shape"); return; }
    if (!this.check("hours_shape", isObj(v), path, 'must be "24h" or { open: "HH:MM", close: "HH:MM" }')) return;
    const h = v as Obj;
    this.onlyKeys(h, ["open", "close"], path);
    this.check("hours_shape", typeof h.open === "string" && HHMM.test(h.open), `${path}.open`, "must be HH:MM (24h)");
    this.check("hours_shape", typeof h.close === "string" && HHMM.test(h.close), `${path}.close`, "must be HH:MM (24h)");
    this.check("hours_not_empty", h.open !== h.close, path, "opens and closes at the same minute — state 24h or the real hours");
  }
  list(v: unknown, path: string, min: number, max: number): unknown[] | null {
    const ok = this.check("list_shape", Array.isArray(v) && v.length >= min && v.length <= max, path,
      `must be a list of ${min}..${max} entries`);
    return ok ? (v as unknown[]) : null;
  }
}

// ── per-kind schemas ─────────────────────────────────────────────────────────

const TERMINAL_SERVES = ["international", "domestic"] as const;
const LINK_MODES = ["walk", "train", "bus", "shuttle"] as const;
const CHECKPOINT_KINDS = ["security", "immigration", "customs"] as const;
const TRANSPORT_MODES = ["rail", "metro", "bus", "taxi", "rideshare", "shuttle", "ferry"] as const;
const SIDES = ["airside", "landside"] as const;
const LODGING_KINDS = ["transit_hotel", "airport_hotel", "sleep_pods", "rest_area"] as const;
const LANDSIDE_EXIT = ["requires_entry", "not_permitted"] as const;

/** Terminal ids a published topology declares; the cross-fact consistency checks read them. */
export function terminalIdsOf(topology: unknown): Set<string> {
  const ids = new Set<string>();
  if (isObj(topology) && Array.isArray(topology.terminals)) {
    for (const t of topology.terminals) if (isObj(t) && typeof t.id === "string") ids.add(t.id);
  }
  return ids;
}

function checkTopology(c: Checker, v: Obj): void {
  c.onlyKeys(v, ["terminals", "gates", "checkpoints", "walkingLinks"], "value");
  const terminals = c.list(v.terminals, "value.terminals", 1, 30);
  const ids = new Set<string>();
  terminals?.forEach((t, i) => {
    const p = `value.terminals[${i}]`;
    if (!c.check("entry_shape", isObj(t), p, "must be an object")) return;
    const o = t as Obj;
    c.onlyKeys(o, ["id", "name", "serves", "landsideExit", "point"], p);
    if (c.check("id_shape", typeof o.id === "string" && SLUG.test(o.id), `${p}.id`, "must be a short id (letters, digits, - _ . /)")) {
      c.check("ids_unique", !ids.has(o.id as string), `${p}.id`, "is declared twice");
      ids.add(o.id as string);
    }
    c.check("text_shape", isText(o.name), `${p}.name`, "must be a name (1..120 chars)");
    if (o.serves !== undefined) {
      c.check("enum_values", Array.isArray(o.serves) && o.serves.length > 0
        && o.serves.every((s) => (TERMINAL_SERVES as readonly string[]).includes(s as string)), `${p}.serves`, "must list international and/or domestic");
    }
    if (o.landsideExit !== undefined) c.check("bool_shape", typeof o.landsideExit === "boolean", `${p}.landsideExit`, "must be true or false");
  });
  const ref = (path: string, id: unknown) =>
    c.check("terminal_refs_exist", typeof id === "string" && ids.has(id), path, `names terminal ${JSON.stringify(id)}, which this topology does not declare`);
  if (v.gates !== undefined) {
    c.list(v.gates, "value.gates", 1, 200)?.forEach((g, i) => {
      const p = `value.gates[${i}]`;
      if (!c.check("entry_shape", isObj(g), p, "must be an object")) return;
      const o = g as Obj;
      c.onlyKeys(o, ["terminalId", "label", "point"], p);
      ref(`${p}.terminalId`, o.terminalId);
      c.check("text_shape", isText(o.label), `${p}.label`, "must be a label (1..120 chars)");
    });
  }
  const checkpointIds = new Set<string>();
  if (v.checkpoints !== undefined) {
    c.list(v.checkpoints, "value.checkpoints", 1, 100)?.forEach((k, i) => {
      const p = `value.checkpoints[${i}]`;
      if (!c.check("entry_shape", isObj(k), p, "must be an object")) return;
      const o = k as Obj;
      c.onlyKeys(o, ["id", "terminalId", "kind", "point"], p);
      if (c.check("id_shape", typeof o.id === "string" && SLUG.test(o.id), `${p}.id`, "must be a short id")) {
        c.check("ids_unique", !checkpointIds.has(o.id as string), `${p}.id`, "is declared twice");
        checkpointIds.add(o.id as string);
      }
      ref(`${p}.terminalId`, o.terminalId);
      c.check("enum_values", (CHECKPOINT_KINDS as readonly string[]).includes(o.kind as string), `${p}.kind`, "must be security, immigration or customs");
    });
  }
  if (v.walkingLinks !== undefined) {
    c.list(v.walkingLinks, "value.walkingLinks", 1, 100)?.forEach((l, i) => {
      const p = `value.walkingLinks[${i}]`;
      if (!c.check("entry_shape", isObj(l), p, "must be an object")) return;
      const o = l as Obj;
      c.onlyKeys(o, ["fromTerminalId", "toTerminalId", "minutes", "mode", "path"], p);
      ref(`${p}.fromTerminalId`, o.fromTerminalId);
      ref(`${p}.toTerminalId`, o.toTerminalId);
      c.check("link_distinct_ends", o.fromTerminalId !== o.toTerminalId, p, "links a terminal to itself");
      // §10 / LayoverAirportTruth PLAUSIBLE_RANGE.walking_link_minutes: 0..90. OPTIONAL: a link whose time the
      // source does not state is still connectivity, and a guessed time would be the fabrication this refuses.
      if (o.minutes !== undefined) c.check("plausible_range", isInt(o.minutes, 1, 90), `${p}.minutes`, "must be a whole number of minutes, 1..90");
      c.check("enum_values", (LINK_MODES as readonly string[]).includes(o.mode as string), `${p}.mode`, "must be walk, train, bus or shuttle");
    });
  }
}

function checkGroundTransport(c: Checker, v: Obj, publishedTerminals: Set<string> | null): void {
  c.onlyKeys(v, ["modes"], "value");
  c.list(v.modes, "value.modes", 1, 30)?.forEach((m, i) => {
    const p = `value.modes[${i}]`;
    if (!c.check("entry_shape", isObj(m), p, "must be an object")) return;
    const o = m as Obj;
    c.onlyKeys(o, ["mode", "name", "toCity", "journeyMinutes", "terminalIds"], p);
    c.check("enum_values", (TRANSPORT_MODES as readonly string[]).includes(o.mode as string), `${p}.mode`, `must be one of ${TRANSPORT_MODES.join(", ")}`);
    c.check("text_shape", isText(o.name), `${p}.name`, "must be a name (1..120 chars)");
    c.check("text_shape", isText(o.toCity), `${p}.toCity`, "must name where it goes (1..120 chars)");
    if (o.journeyMinutes !== undefined) {
      const j = o.journeyMinutes;
      if (c.check("entry_shape", isObj(j), `${p}.journeyMinutes`, "must be { min, max }")) {
        const jj = j as Obj;
        c.onlyKeys(jj, ["min", "max"], `${p}.journeyMinutes`);
        c.check("plausible_range", isInt(jj.min, 1, 240) && isInt(jj.max, 1, 240), `${p}.journeyMinutes`, "min and max must be whole minutes, 1..240");
        c.check("range_ordered", typeof jj.min === "number" && typeof jj.max === "number" && jj.min <= jj.max, `${p}.journeyMinutes`, "min is above max");
      }
    }
    if (o.terminalIds !== undefined) {
      const ids = Array.isArray(o.terminalIds) ? o.terminalIds : null;
      if (c.check("list_shape", ids !== null && ids.length > 0, `${p}.terminalIds`, "must be a non-empty list")) {
        // CROSS-FACT CONSISTENCY: a transport mode may only name terminals the PUBLISHED topology declares.
        // With no topology published there is nothing to resolve them against, and that is a failure, not a pass.
        ids!.forEach((id, k) => c.check(
          "terminal_refs_exist",
          publishedTerminals !== null && typeof id === "string" && publishedTerminals.has(id),
          `${p}.terminalIds[${k}]`,
          publishedTerminals === null
            ? "names a terminal, but no topology is published for this airport — publish the topology first"
            : `names terminal ${JSON.stringify(id)}, which the published topology does not declare`,
        ));
      }
    }
  });
}

/** 3874 projects these onto airport_profiles; the bounds are the admin PATCH schema's own (routes/airport.ts). */
export const TIMING_ASSUMPTION_FIELDS = {
  domesticBufferMin: { min: 0, max: 240 },
  domesticBufferMax: { min: 0, max: 360 },
  internationalBufferMin: { min: 0, max: 360 },
  internationalBufferMax: { min: 0, max: 480 },
  immigrationExtraMin: { min: 0, max: 120 },
  checkedBagsExtraMin: { min: 0, max: 60 },
  trafficExtraMin: { min: 0, max: 60 },
} as const;

function checkTiming(c: Checker, v: Obj): void {
  const names = Object.keys(TIMING_ASSUMPTION_FIELDS) as Array<keyof typeof TIMING_ASSUMPTION_FIELDS>;
  c.onlyKeys(v, [...names, "rationale", "timingEvidence"], "value");
  for (const n of names) {
    const b = TIMING_ASSUMPTION_FIELDS[n];
    c.check("required_fields", v[n] !== undefined, `value.${n}`, "is required — every buffer the engine reads must be stated");
    if (v[n] !== undefined) c.check("plausible_range", isInt(v[n], b.min, b.max), `value.${n}`, `must be whole minutes, ${b.min}..${b.max}`);
  }
  const ordered = (lo: keyof typeof TIMING_ASSUMPTION_FIELDS, hi: keyof typeof TIMING_ASSUMPTION_FIELDS) =>
    c.check("range_ordered", !(typeof v[lo] === "number" && typeof v[hi] === "number") || (v[lo] as number) <= (v[hi] as number),
      `value.${lo}`, `is above ${hi}`);
  ordered("domesticBufferMin", "domesticBufferMax");
  ordered("internationalBufferMin", "internationalBufferMax");
  // A curator's buffer is a JUDGMENT about an airport; it must say why.
  c.check("rationale_present", isText(v.rationale, 2000), "value.rationale", "must state why these buffers (1..2000 chars)");
}

function checkEntryRestrictions(c: Checker, v: Obj): void {
  c.onlyKeys(v, ["landsideExitForTransit", "transitSummary"], "value");
  c.check("enum_values", (LANDSIDE_EXIT as readonly string[]).includes(v.landsideExitForTransit as string),
    "value.landsideExitForTransit", "must be requires_entry or not_permitted");
  if (v.transitSummary !== undefined) c.check("text_shape", isText(v.transitSummary, 300), "value.transitSummary", "must be 1..300 chars");
}

function checkSecurityLayout(c: Checker, v: Obj, publishedTerminals: Set<string> | null): void {
  c.onlyKeys(v, ["checkpoints"], "value");
  c.list(v.checkpoints, "value.checkpoints", 1, 100)?.forEach((k, i) => {
    const p = `value.checkpoints[${i}]`;
    if (!c.check("entry_shape", isObj(k), p, "must be an object")) return;
    const o = k as Obj;
    c.onlyKeys(o, ["id", "terminalId", "name", "kind", "hours", "fastTrack"], p);
    c.check("id_shape", typeof o.id === "string" && SLUG.test(o.id), `${p}.id`, "must be a short id");
    c.check("text_shape", isText(o.name), `${p}.name`, "must be a name");
    c.check("enum_values", o.kind === "security" || o.kind === "immigration", `${p}.kind`, "must be security or immigration");
    c.hours(o.hours, `${p}.hours`);
    if (o.fastTrack !== undefined) c.check("bool_shape", typeof o.fastTrack === "boolean", `${p}.fastTrack`, "must be true or false");
    if (o.terminalId !== undefined) terminalRef(c, publishedTerminals, `${p}.terminalId`, o.terminalId);
  });
}

function terminalRef(c: Checker, published: Set<string> | null, path: string, id: unknown): void {
  c.check("terminal_refs_exist", published !== null && typeof id === "string" && published.has(id), path,
    published === null ? "names a terminal, but no topology is published for this airport" : `names terminal ${JSON.stringify(id)}, which the published topology does not declare`);
}

function checkLounges(c: Checker, v: Obj, publishedTerminals: Set<string> | null): void {
  c.onlyKeys(v, ["lounges"], "value");
  c.list(v.lounges, "value.lounges", 1, 100)?.forEach((l, i) => {
    const p = `value.lounges[${i}]`;
    if (!c.check("entry_shape", isObj(l), p, "must be an object")) return;
    const o = l as Obj;
    c.onlyKeys(o, ["name", "terminalId", "side", "hours", "access"], p);
    c.check("text_shape", isText(o.name), `${p}.name`, "must be a name");
    c.check("enum_values", (SIDES as readonly string[]).includes(o.side as string), `${p}.side`, "must be airside or landside");
    c.hours(o.hours, `${p}.hours`);
    if (o.access !== undefined) c.check("text_shape", isText(o.access, 300), `${p}.access`, "must be 1..300 chars");
    if (o.terminalId !== undefined) terminalRef(c, publishedTerminals, `${p}.terminalId`, o.terminalId);
  });
}

function checkSchedules(c: Checker, v: Obj): void {
  c.onlyKeys(v, ["services"], "value");
  c.list(v.services, "value.services", 1, 50)?.forEach((s, i) => {
    const p = `value.services[${i}]`;
    if (!c.check("entry_shape", isObj(s), p, "must be an object")) return;
    const o = s as Obj;
    c.onlyKeys(o, ["mode", "name", "firstDeparture", "lastDeparture", "frequencyMinutes", "journeyMinutes"], p);
    c.check("enum_values", (TRANSPORT_MODES as readonly string[]).includes(o.mode as string), `${p}.mode`, `must be one of ${TRANSPORT_MODES.join(", ")}`);
    c.check("text_shape", isText(o.name), `${p}.name`, "must be a name");
    c.check("required_fields", typeof o.firstDeparture === "string" && HHMM.test(o.firstDeparture), `${p}.firstDeparture`, "must be HH:MM (24h)");
    c.check("required_fields", typeof o.lastDeparture === "string" && HHMM.test(o.lastDeparture), `${p}.lastDeparture`, "must be HH:MM (24h)");
    // §10 / LayoverAirportTruth PLAUSIBLE_RANGE.transport_schedule: 0..1440 minutes.
    if (o.frequencyMinutes !== undefined) c.check("plausible_range", isInt(o.frequencyMinutes, 1, 1440), `${p}.frequencyMinutes`, "must be whole minutes, 1..1440");
    if (o.journeyMinutes !== undefined) c.check("plausible_range", isInt(o.journeyMinutes, 1, 240), `${p}.journeyMinutes`, "must be whole minutes, 1..240");
  });
}

function checkLodging(c: Checker, v: Obj, publishedTerminals: Set<string> | null): void {
  c.onlyKeys(v, ["options"], "value");
  c.list(v.options, "value.options", 1, 50)?.forEach((l, i) => {
    const p = `value.options[${i}]`;
    if (!c.check("entry_shape", isObj(l), p, "must be an object")) return;
    const o = l as Obj;
    c.onlyKeys(o, ["name", "kind", "side", "terminalId", "hours"], p);
    c.check("text_shape", isText(o.name), `${p}.name`, "must be a name");
    c.check("enum_values", (LODGING_KINDS as readonly string[]).includes(o.kind as string), `${p}.kind`, `must be one of ${LODGING_KINDS.join(", ")}`);
    c.check("enum_values", (SIDES as readonly string[]).includes(o.side as string), `${p}.side`, "must be airside or landside");
    c.hours(o.hours, `${p}.hours`);
    if (o.terminalId !== undefined) terminalRef(c, publishedTerminals, `${p}.terminalId`, o.terminalId);
  });
}

// ── provenance and TTL ───────────────────────────────────────────────────────

function checkProvenance(c: Checker, kind: CuratedFactKind, source: CuratedSource, expiresAtMs: number, nowMs: number): void {
  const cls = curatedFactClassOf(kind);
  c.check("source_kind", (CURATED_SOURCE_KINDS as readonly string[]).includes(source.kind), "source.kind", "is not a known source kind");
  if (OFFICIAL_SOURCE_KINDS.has(source.kind)) {
    c.check("official_source_url", typeof source.url === "string" && /^https:\/\/[^\s]+$/.test(source.url) && source.url.length <= 2048,
      "source.url", "an official source needs the https URL it was read from");
  } else {
    // A curator's own survey or judgment is allowed, and must say what it rests on.
    c.check("curator_source_note", isText(source.note, 2000), "source.note", "a curator source must state what was checked, and how");
  }
  const retrievedMs = Date.parse(source.retrievedAt);
  const retrievedOk = c.check("retrieved_at", Number.isFinite(retrievedMs), "source.retrievedAt", "must be an ISO-8601 instant");
  if (retrievedOk) {
    c.check("retrieved_not_future", retrievedMs <= nowMs + 60_000, "source.retrievedAt", "is in the future");
    c.check("ttl_forward", expiresAtMs > retrievedMs, "expiresAt", "must be after retrievedAt");
    c.check("ttl_class_bound", expiresAtMs - retrievedMs <= CURATED_TTL_MS[cls].max, "expiresAt",
      `is beyond the ${cls} maximum (${Math.round(CURATED_TTL_MS[cls].max / 3_600_000)} h after retrieval)`);
  }
  c.check("not_stale", expiresAtMs > nowMs, "expiresAt", "has already passed — re-read the source and propose a new version");
}

/** The expiry a proposal gets when the curator states none: the class default from retrieval. */
export function defaultExpiryMs(kind: CuratedFactKind, retrievedAtMs: number): number {
  return retrievedAtMs + CURATED_TTL_MS[curatedFactClassOf(kind)].default;
}

export interface CurationContext {
  /** Terminal ids of the PUBLISHED, unexpired topology for this airport, or null when none is published. */
  publishedTerminals: Set<string> | null; airportPoint?: { lat: number; lng: number } | null;
}

/**
 * Every quality check for one proposed fact: required fields per kind,
 * plausibility ranges, internal consistency (ids unique, references resolve,
 * ranges ordered), cross-fact consistency against the published topology,
 * provenance (an official source has its URL; a curator source says what it
 * rests on) and freshness (TTL forward, within its class bound, not stale).
 *
 * A report is `ok` only when every check passed. It never repairs a value.
 */
export function validateCuratedFact(
  kind: CuratedFactKind,
  value: unknown,
  source: CuratedSource,
  expiresAtMs: number,
  nowMs: number,
  ctx: CurationContext,
): ValidationReport {
  const c = new Checker();
  if (c.check("value_shape", isObj(value), "value", "must be an object")) {
    const v = value as Obj;
    switch (kind) {
      case "terminal_topology": checkTopology(c, v); for (const issue of topologyGeometryIssues(v, ctx.airportPoint ?? null, source.kind)) c.check("geometry_quality", false, issue.path, issue.problem); break;
      case "ground_transport": checkGroundTransport(c, v, ctx.publishedTerminals); break;
      case "timing_assumptions": checkTiming(c, v); if (v.timingEvidence !== undefined) for (const issue of timingEvidenceIssues(v.timingEvidence, source.kind, nowMs, new Date(expiresAtMs).toISOString())) c.check("sourced_timing_observations", false, "value.timingEvidence", issue); break;
      case "entry_restrictions": checkEntryRestrictions(c, v); break;
      case "security_layout": checkSecurityLayout(c, v, ctx.publishedTerminals); break;
      case "lounge_hours": checkLounges(c, v, ctx.publishedTerminals); break;
      case "transport_schedules": checkSchedules(c, v); break;
      case "overnight_lodging": checkLodging(c, v, ctx.publishedTerminals); break;
    }
    c.check("size_bound", JSON.stringify(v).length <= 60_000, "value", "is larger than 60 kB");
  }
  checkProvenance(c, kind, source, expiresAtMs, nowMs);
  return {
    ok: c.issues.length === 0,
    policyVersion: AIRPORT_CURATION_POLICY_VERSION,
    kind,
    checkedAt: new Date(nowMs).toISOString(),
    issues: c.issues,
    checks: [...c.checks].sort(),
  };
}

// ── what the engine and the surfaces read ────────────────────────────────────

/** A published curated fact as `airport_profiles` projects it (3874). */
export interface CuratedRef {
  factId: string;
  expiresAt: string;
}

/**
 * The curation projection an `AirportProfile` carries. `null` members are
 * "not curated"; a member whose `expiresAt` has passed is curated-and-EXPIRED,
 * which every reader treats exactly as not curated (fail closed).
 */
export interface AirportCurationProjection {
  timing: CuratedRef | null;
  topology: CuratedRef | null;
  transport: CuratedRef | null;
  /** Moves on every authoritative change of a curated static fact (3874's trigger). */
  topologyVersion: number;
  /** §10 historical model, recalibrated (3880): local hour → extra minutes, when unexpired. */
  calibration: { version: number; expiresAt: string } | null;
}

/** Is this curated reference present and unexpired at `nowMs`? */
export function curatedLive(ref: CuratedRef | null | undefined, nowMs: number): boolean {
  if (!ref) return false;
  const exp = Date.parse(ref.expiresAt);
  return Number.isFinite(exp) && exp > nowMs;
}

/** Project an `airport_profiles` row's 3874/3880 columns. Absent columns (an unmigrated database) are "not curated". */
export function curationProjectionFromRow(row: Record<string, unknown> | null | undefined): AirportCurationProjection {
  const ref = (id: unknown, exp: unknown): CuratedRef | null =>
    typeof id === "string" && id.length > 0 && exp !== null && exp !== undefined && Number.isFinite(Date.parse(String(exp)))
      ? { factId: id, expiresAt: new Date(Date.parse(String(exp))).toISOString() }
      : null;
  const r = row ?? {};
  const calVersion = Number(r.calibration_version ?? 0);
  const calExp = r.calibration_expires_at;
  return {
    timing: ref(r.curated_timing_fact_id, r.curated_timing_expires_at),
    topology: ref(r.curated_topology_fact_id, r.curated_topology_expires_at),
    transport: ref(r.curated_transport_fact_id, r.curated_transport_expires_at),
    topologyVersion: Number.isInteger(Number(r.topology_version)) ? Number(r.topology_version) : 0,
    calibration: Number.isInteger(calVersion) && calVersion > 0 && calExp && Number.isFinite(Date.parse(String(calExp)))
      ? { version: calVersion, expiresAt: new Date(Date.parse(String(calExp))).toISOString() }
      : null,
  };
}

/** The projection of an airport nobody has curated (the static dataset, the manual fallback). */
export const UNCURATED_PROJECTION: AirportCurationProjection = Object.freeze({
  timing: null, topology: null, transport: null, topologyVersion: 0, calibration: null,
}) as AirportCurationProjection;

/**
 * The calibrated extra minutes per local hour (3880's projection), or null.
 * Every value is a finite, non-negative number of minutes; anything else in the
 * column is dropped rather than coerced, and an expired calibration is null.
 */
export function calibratedExtraFromRow(row: Record<string, unknown> | null | undefined, nowMs: number): number[] | null {
  const r = row ?? {};
  const raw = r.calibrated_checkpoint_extra;
  const exp = Date.parse(String(r.calibration_expires_at ?? ""));
  if (!isObj(raw) || !Number.isFinite(exp) || exp <= nowMs) return null;
  const out = new Array<number>(24).fill(0);
  let any = false;
  for (const [k, v] of Object.entries(raw)) {
    const h = Number(k);
    const m = Number(v);
    if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isFinite(m) || m < 0 || m > 240) continue;
    out[h] = Math.round(m);
    if (out[h] > 0) any = true;
  }
  return any ? out : null;
}

import { topologyGeometryIssues } from './airportTopologyGeometry.js';
import { timingEvidenceIssues } from './layoverTimingEvidence.js';
