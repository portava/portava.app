/**
 * The SECOND PROCESS of telegraphSafetySignalRedrive.test.ts's restart case. It never ran the door: it starts with an
 * empty in-process memo, is handed only the database (a JSON file: the fake's tables), runs re-drive passes at the
 * given instants through the REAL NotificationService, and writes the database back. Whatever it tells, it learned
 * from the rows alone — which is the claim "the re-drive survives a restart".
 *
 * usage: node --import tsx/esm src/test/helpers/safetyRedriveRestartChild.ts <state.json>
 *   state.json: { db: Record<table, Row[]>, passesAtMs: number[] } → rewritten as { db, results }
 */
import fs from "node:fs";

import { fakeSafetyDb } from "./fakeSafetyRedriveDb.js";
import { NotificationService } from "../../services/notifications/NotificationService.js";
import { runSafetySignalRedrivePass } from "../../lib/safetySignalRedriveScheduler.js";

const file = process.argv[2];
if (!file) { console.error("usage: safetyRedriveRestartChild.ts <state.json>"); process.exit(2); }
const state = JSON.parse(fs.readFileSync(file, "utf8")) as { db: Record<string, Array<Record<string, unknown>>>; passesAtMs: number[] };
const sc = fakeSafetyDb(state.db);
const ns = new NotificationService(sc as any);
const quiet = { warn: () => undefined, error: () => undefined };
const results = [];
for (const nowMs of state.passesAtMs) {
  results.push(await runSafetySignalRedrivePass({ client: sc, nowMs, deps: { create: (i) => ns.create(i), route: async () => undefined }, log: quiet }));
}
fs.writeFileSync(file, JSON.stringify({ db: sc.db, results, pid: process.pid }));
