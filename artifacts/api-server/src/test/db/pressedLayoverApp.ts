/**
 * pressedLayoverApp — the layover routers exactly as routes/index.ts:240 mounts
 * them (airport, layoverEvents, layoverConstraints, layoverSimulate, plus the
 * crew-location and admin layover-metrics routers), under `/api`, on a loopback
 * port, with the route's service client injected from a `pressedLayoverDb`.
 * Not a test file. Loopback: binds 127.0.0.1 (run unsandboxed).
 */
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../lib/http.js";
import { resetSchemaCapabilityMemo } from "../../lib/capability/schemaCapability.js";
import type { PressedDb, PressedUser } from "./pressedLayoverDb.js";

export interface Reply { status: number; body: any; raw: string }

export interface PressedApp {
  base: string;
  call(method: string, path: string, user: PressedUser | null, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
  close(): Promise<void>;
}

export async function startPressedLayoverApp(db: PressedDb, opts: { extraRouters?: express.IRouter[] } = {}): Promise<PressedApp> {
  process.env["SESSION_SECRET"] ??= "pressed-layover-session-secret";
  const [airport, events, constraints, simulate, crewLocation, adminMetrics] = await Promise.all([
    import("../../routes/airport.js"), import("../../routes/layoverEvents.js"), import("../../routes/layoverConstraints.js"),
    import("../../routes/layoverSimulate.js"), import("../../routes/layoverCrewLocation.js"), import("../../routes/adminLayoverMetrics.js"),
  ]);
  resetSchemaCapabilityMemo();
  _setTestClient(db.client, true);
  const app = express(); app.use(layoverServiceAuditContext);
  app.use(express.json({ limit: "256kb" }));
  app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  for (const m of [airport, events, constraints, simulate, crewLocation, adminMetrics]) app.use("/api", (m as any).default);
  for (const router of opts.extraRouters??[]) app.use('/api',router);
  const server = await new Promise<http.Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = (method: string, path: string, user: PressedUser | null, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const url = new URL(path, base);
      const payload = body === undefined ? null : JSON.stringify(body);
      const r = http.request(
        {
          hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method,
          headers: {
            ...(user ? { authorization: `Bearer ${user.token}` } : {}),
            ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
            ...headers,
          },
        },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { raw += c; });
          res.on("end", () => {
            let parsed: any;
            try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
            resolve({ status: res.statusCode ?? 0, body: parsed, raw });
          });
        },
      );
      r.on("error", reject);
      if (payload) r.write(payload);
      r.end();
    });
  return {
    base,
    call,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); _setTestClient(null as any, false); }),
  };
}

/** A layover session the way the app starts one (POST /airport/sessions), `departsInH` hours from now. */
export async function startSession(app: PressedApp, user: PressedUser, over: Record<string, unknown> = {}, opts: { arrivedHAgo?: number; departsInH?: number } = {}): Promise<any> {
  const now = Date.now();
  const body = {
    iata: "SIN",
    arrivalTime: new Date(now - (opts.arrivedHAgo ?? 1) * 3_600_000).toISOString(),
    departureTime: new Date(now + (opts.departsInH ?? 9) * 3_600_000).toISOString(),
    flightType: "international",
    immigrationRequired: true,
    ...over,
  };
  const r = await app.call("POST", "/api/airport/sessions", user, body);
  if (r.status !== 201) throw new Error(`startSession: ${r.status} ${r.raw}`);
  return declareLikeTheApp(app, user, r.body.session, over); // census-layover §83: under PRESSED_BASE the traveller answers the constraints question, as the app asks (tail of file)
}

/**
 * Production's flag state, from the snapshot the repository holds (lib/capability/snapshots/current.ts:
 * 201 rows on 2026-09-22): every row it records is set to its recorded value. A flag it does not record is
 * absent in production; the chain seeds those (FALSE), and a press turns them on. So a case runs in
 * "production + this press", not in a hand-picked flag world. Among them: airport_mode, layover_plans,
 * layover_safety_engine, layover_compass and passport_entry_intelligence TRUE; layover_stable_recommendation_ids,
 * layover_discovery_mode, layover_safe_return_status and rent_buddy FALSE.
 */
export async function productionBaseFlags(db: PressedDb): Promise<void> {
  const { PRODUCTION_SNAPSHOT_URL } = await import("../../lib/capability/snapshots/current.js");
  const { readFileSync } = await import("node:fs");
  const snap = JSON.parse(readFileSync(PRODUCTION_SNAPSHOT_URL, "utf8")) as { flags: Record<string, boolean> };
  await db.setFlags(Object.fromEntries(Object.entries(snap.flags).map(([f, on]) => [f, on === true]))); await overlayCurrentProductionFlags(db); // census-layover §83: PRESSED_BASE=production-20261023 overlays production's flags as read on 2026-10-23 (tail of file)
}

/** A passport on file and a curated visa-free corridor, so the entry gate can CONFIRM entry (verdict `yes`, not `entry_unverified`). */
export async function seedConfirmedCorridor(db: PressedDb, userId: string, passport = "US", destination = "SG"): Promise<void> {
  await db.exec(
    `INSERT INTO public.traveler_passports (user_id, issuing_country, is_primary) VALUES ('${userId}', '${passport}', true);` +
    `INSERT INTO public.entry_requirements (passport_country, destination_country, status, allowed_stay_days, official_source_url)
       SELECT '${passport}', '${destination}', 'visa_free', 30, 'https://example.test/official'
        WHERE NOT EXISTS (SELECT 1 FROM public.entry_requirements WHERE passport_country = '${passport}' AND destination_country = '${destination}');`,
  );
}

import { layoverServiceAuditContext } from '../../lib/layoverServiceAudit.js';

/**
 * An airport curated through the real workflow (propose → validate → publish) for its timing, topology
 * and transport facts. 3874 DERIVES `airport_profiles.verified` from exactly those three published facts
 * (a bare `verified = true` lands in legacy_verified and reaches nothing), and the owner's 2026-10-18
 * decision keeps landside CLOSED (`airport_maturity_limited`) below §22's curated L1 threshold in every
 * flag state. A case that needs a landside-open layover seeds this first; values are the same fixture
 * policy layoverPressedSnapshot S8 and layoverMapPersistence publish.
 */
export async function seedCuratedAirport(app: PressedApp, db: PressedDb, iata = "SIN"): Promise<void> {
  const { proposeCuratedFact, validateProposedFact, publishValidatedFact } = await import("../../services/airport/airportCuration.js");
  const curator = await db.seedUser(`airport_curator_${iata.toLowerCase()}`);
  const find = () => db.query<{ id: string }>(`SELECT id FROM public.airport_profiles WHERE iata_code = '${iata.replace(/[^A-Z]/g, "")}'`);
  // No row yet: the first session at an airport writes it (upsertAirportProfile, from the static dataset), exactly as a traveller's would.
  let [airport] = await find();
  if (!airport) { await startSession(app, curator, { iata }); [airport] = await find(); }
  if (!airport) throw new Error(`seedCuratedAirport: no airport_profiles row for ${iata}`);
  const facts = [
    ["terminal_topology", { terminals: [{ id: "T1", name: "Terminal 1" }, { id: "T2", name: "Terminal 2" }], gates: [{ terminalId: "T1", label: "A1" }], checkpoints: [{ id: "security", terminalId: "T1", kind: "security" }], walkingLinks: [{ fromTerminalId: "T1", toTerminalId: "T2", minutes: 12, mode: "train" }] }],
    ["ground_transport", { modes: [{ mode: "rail", name: "Fixture rail", toCity: "City centre", journeyMinutes: { min: 25, max: 35 }, terminalIds: ["T1"] }] }],
    ["timing_assumptions", { domesticBufferMin: 60, domesticBufferMax: 90, internationalBufferMin: 120, internationalBufferMax: 180, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20, rationale: "Explicit integration-test timing policy" }],
  ] as const;
  for (const [kind, value] of facts) {
    const proposed = await proposeCuratedFact(db.client, { airportId: airport.id, kind, value, source: { kind: kind === "timing_assumptions" ? "curator_judgment" : "official_airport", note: "Integration-test fixture only", url: "https://example.test/airport", title: "Integration-test airport", retrievedAt: new Date().toISOString() }, proposedVia: "admin", proposedBy: curator.id }, Date.now());
    if (!proposed.ok) throw new Error(`seedCuratedAirport: propose ${kind}: ${JSON.stringify(proposed)}`);
    const validated = await validateProposedFact(db.client, proposed.fact.id, curator.id, Date.now());
    if (!validated.ok) throw new Error(`seedCuratedAirport: validate ${kind}: ${JSON.stringify(validated)}`);
    const published = await publishValidatedFact(db.client, proposed.fact.id, curator.id);
    if (!published.ok) throw new Error(`seedCuratedAirport: publish ${kind}: ${JSON.stringify(published)}`);
  }
  const [row] = await db.query<{ verified: boolean }>(`SELECT verified FROM public.airport_profiles WHERE id = '${airport.id}'`);
  if (row?.verified !== true) throw new Error(`seedCuratedAirport: ${iata} is not verified after publishing all three facts`);
}

/**
 * L273 (B2-BUDDY): the layover buddies list serves a profile only when its OWNER is a verified layover
 * specialist — a current LIVE-mode adult identity verification and an identity verification_level, a
 * verified payout recipient with charges enabled, and no hosting restriction
 * (LayoverBuddyBooking.ts verifiedLayoverSpecialists), beside `layover_buddy_specialist_enabled`. This
 * stages exactly the rows layoverBuddySpecialist.db.test.ts `identity()` + `buddy()` write; the suite
 * still inserts the rent_buddy_profiles row itself and declares the `layover` category on it.
 */
export async function seedVerifiedLayoverSpecialist(db: PressedDb, user: PressedUser): Promise<void> {
  await db.exec(
    `UPDATE public.profiles SET verification_level='id_verified', date_of_birth='1990-01-01', phone_verified_at=now() WHERE id='${user.id}';` +
    `INSERT INTO public.identity_verifications(user_id, provider, provider_session_id, provider_mode, status, is_over_18, document_country, verified_at) VALUES ('${user.id}', 'stripe', 'fixture-${user.id}', 'live', 'verified', true, 'US', now());` +
    `WITH party AS (INSERT INTO public.payment_parties(kind, profile_id) VALUES ('user', '${user.id}') RETURNING id) INSERT INTO public.rent_buddy_payment_recipients(party_id, provider, recipient_ref, country, settlement_currency, onboarding, charges_enabled, payouts_enabled, livemode) SELECT id, 'stripe', 'fixture-${user.id}', 'SG', 'SGD', 'verified', true, true, false FROM party;`,
  );
}

/**
 * census-layover §83 — "prove it under production's flag state". With PRESSED_BASE=production-20261023, every pressed
 * suite's base is production's public.feature_flags as read read-only on 2026-10-23 (382 rows, digest reproduced from
 * production's own md5; test/db/fixtures/productionFlags20261023.json), overlaid on the 09-22 capture, plus the one
 * metadata flag (layover_ranking_mode: on, cohort all). Each suite's own press is then applied on top, exactly as in the
 * default base. Unset (the default, and CI's local-db job): nothing changes. Appended at the tail so no line above moves.
 */
export const PRESSED_BASE = (process.env["PRESSED_BASE"] ?? "").trim();
async function overlayCurrentProductionFlags(db: PressedDb): Promise<void> {
  if (PRESSED_BASE === "") return;
  if (PRESSED_BASE !== "production-20261023") throw new Error(`PRESSED_BASE=${PRESSED_BASE}: the only recorded production base is production-20261023`);
  const { readFileSync } = await import("node:fs");
  const fx = JSON.parse(readFileSync(new URL("./fixtures/productionFlags20261023.json", import.meta.url), "utf8")) as {
    flags: Record<string, boolean>; metadata: Record<string, Record<string, unknown>>;
  };
  await db.setFlags({ ...fx.flags });
  for (const [flag, metadata] of Object.entries(fx.metadata)) await db.setFlag(flag, fx.flags[flag] === true, metadata);
}

/**
 * census-layover §83 — the traveller's own answers, under production's flag state. With
 * `layover_constraints_enabled` ON (production since 2026-10-23), a session whose airport change is undeclared is
 * landside-CLOSED until the traveller answers the dashboard's one question (LayoverConstraintsCard; the creation sheet
 * sends only `baggageMode`). Under PRESSED_BASE a session is therefore declared the way a traveller who answered would
 * be — carry-on only (the arithmetic of the default `checkedBags: false`), no recheck, no airport change — through the
 * real PUT /constraints, unless the case states any constraint itself (then it owns them). Unset base: unchanged.
 */
async function declareLikeTheApp(app: PressedApp, user: PressedUser, session: any, over: Record<string, unknown>): Promise<any> {
  if (PRESSED_BASE === "" || !AUTO_DECLARE) return session;
  if (["baggageMode", "recheckRequired", "airportChangeRequired"].some((k) => k in over)) return session;
  const r = await app.call("PUT", `/api/airport/sessions/${session.id}/constraints`, user, { baggageMode: "CARRY_ON_ONLY", recheckRequired: false, airportChangeRequired: false });
  if (r.status !== 200) throw new Error(`startSession (PRESSED_BASE): the constraints answer was refused: ${r.status} ${r.raw}`);
  return session;
}

let AUTO_DECLARE = true;
/** A suite that tests the constraint store itself (or edits the session booleans it governs) owns every declaration. */
export function keepConstraintsUndeclared(): void { AUTO_DECLARE = false; }
