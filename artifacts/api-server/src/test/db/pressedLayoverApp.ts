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
  return r.body.session;
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
  await db.setFlags(Object.fromEntries(Object.entries(snap.flags).map(([f, on]) => [f, on === true])));
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
